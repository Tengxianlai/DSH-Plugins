# 本地 ASR 适配：`WhisperModel.transcribe(file)` 在 av 19 上的已复现故障与最小修法

> 对象：`plugins/dsh-minimax-video/production/local_asr.py`（lead 新文件，**本次只读、未改动**）
> 结论：当前写法 `model.transcribe(str(args.file.resolve()), …)` 在本机现有环境**必然失败**；改 3 处即可跑通，模型/环境路径均已实测。

## 1. 已复现的故障（2026-11-16 18:5x，本机）

- 环境（项目 venv）：`.work/asr-venv`（Python 3.12.3）
  - `faster-whisper 1.2.1`、`ctranslate2 4.9.0`、`numpy 2.5.5`
  - `av 19.0.2`（PyAV）
  - 系统 `ffmpeg 6.1.1-3ubuntu5`
- 直接传文件路径时：

```
File ".../faster_whisper/transcribe.py", line 876, in transcribe
    audio = decode_audio(audio, sampling_rate=sampling_rate)
File ".../faster_whisper/audio.py", line 46, in decode_audio
    with av.open(input_file, mode="r", metadata_errors="ignore") as container:
TypeError: open() got an unexpected keyword argument 'metadata_errors'
```

`faster_whisper/audio.py` 内部固定调用 `av.open(..., metadata_errors="ignore")`，而 PyAV 19 的 `av.open` 已不接受该参数 → 传路径/文件对象都会在解码前失败，与模型、语言、文件内容无关。

## 2. 最小修法（推荐：ffmpeg 解码成 numpy 再转写）

这是项目里已经跑通的写法（`docs/review/MOTION_v04_ASR/tools/run_asr_blind.py` 的 `load_audio()`，注释里写明就是为绕过该不兼容）。

```python
import subprocess
from pathlib import Path
import numpy as np

def decode_audio_ffmpeg(path: Path, sample_rate: int = 16000) -> np.ndarray:
    """mp4/mov/mp3/wav -> mono 16 kHz float32 numpy (faster-whisper 直接吃 ndarray)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path),
         "-vn", "-ac", "1", "-ar", str(sample_rate),
         "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    if not raw:
        raise SystemExit(f"ffmpeg decoded no audio samples from {path}")
    return np.frombuffer(raw, dtype="<f4").copy()

# 原来的：
# segments, info = model.transcribe(str(args.file.resolve()), language=..., beam_size=5, word_timestamps=True)
# 改成：
segments, info = model.transcribe(
    decode_audio_ffmpeg(args.file.resolve()),
    language=args.language, beam_size=5, word_timestamps=True,
)
```

要点：
- 必须是 **单声道 16 kHz、float32（little-endian `<f4`）、1-D、C-contiguous**；`.copy()` 让数组拥有自己的内存（`frombuffer` 只是视图）。
- `-vn` 丢弃视频，只解音轨；`-nostdin` 防止交互；`-v error` 保持 stderr 干净。
- 没有音轨的文件会让 ffmpeg 输出 0 字节 → 显式报错，不要静默当“空转写”。
- 其余参数（`language/beam_size/word_timestamps` 等）保持你现在写法即可，模型输出结构不变。

## 3. 实测证明（本次跑过，只读项目片段）

脚本 `/tmp/asr_adapter_probe.py`（临时，不落项目），模型直接指向本地 snapshot：

| 片段 | 解码 | 转写 | 文本 |
|---|---|---|---|
| `S01_004_LADDER_FINAL`（6.59 s） | 0.06 s | 0.86 s | 「白霜是渗水带出来的盖」（期望“钙”，同音） |
| `S06_001-1_ZHOUYUAN_FINAL`（5.18 s） | 0.05 s | 0.91 s | 「老师,捷径面太糙,负压枪漏气,往上滑了。」 |

模型加载 1.28 s（CPU int8，`cpu_threads=8`）。结果与项目既有 ASR 记录（`docs/review/MOTION_v04_ASR/README.md`）逐字一致，说明适配没有改变语义/时码行为。

`WhisperModel(..., local_files_only=True)` 在本版本存在（参数表含 `local_files_only`），传 HF snapshot 目录可用；**不需要、也不应该触发下载**。

## 4. 可复现的环境与模型路径（本机实测）

- ASR Python：`<TanLu 项目>/.work/asr-venv/bin/python`（3.12.3；faster-whisper 1.2.1 / ctranslate2 4.9.0 / numpy 2.5.5 / av 19.0.2）
- 模型（完整、离线）：`~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120`
  - 目录内含 `config.json`、`model.bin`、`tokenizer.json`、`vocabulary.txt`
  - `model.bin` sha256 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`（项目 `provenance.json` 已记）
- ffmpeg：系统 PATH 的 `ffmpeg 6.1.1`（WSL）
- 运行时不联网：`local_files_only=True` + 只读本地文件；ASR 本身无付费 API。

插件侧建议：
- `--asr-python` 已存在（`local_asr.py` 的报错文案提到），默认按顺序探测：环境变量 `DSH_ASR_PYTHON` → 项目 `.work/asr-venv/bin/python` → 报错并提示“需要带 faster-whisper 的环境”，**不要自动 pip install / 自动下载模型**。
- `--model` 默认可用上面的 snapshot 路径（若存在），否则要求显式传入；缺模型时报 `model directory required; no automatic download`（现有文案已对）。
- 若传入 `--file` 是图片/无音轨，给出“ffmpeg decoded no audio samples”的可读错误，而不是空报告。

## 5. 备选修法（不推荐，仅记录）

若不想引 numpy/ffmpeg 子进程，可在进程内给 PyAV 打兼容 shim：

```python
import av
_real_open = av.open
def _open_compat(*args, metadata_errors=None, **kwargs):
    return _real_open(*args, **kwargs)
av.open = _open_compat
# 让 faster_whisper.audio.decode_audio 继续工作
```

问题：依赖 PyAV 私有行为、跨版本易碎；项目已验证且更可控的是 ffmpeg→numpy 路径，建议统一用它。

## 6. 边界（不因这次适配改变）

- ASR 只证明“音频里有没有这句话、大概几秒到几秒”（L2），**不证明口型、表演、音色、听感或客户验收**。
- 同音字/近音字（钙/盖、腔/枪、结晶/捷径、薄雾/博物、李子湖/离子湖）是模型用词选择，不能据此判真伪。
- 字级时码是估计值；句首/句尾必须用波形（`silencedetect`/RMS）复核，项目里已有做法。
- 插件现有的 `limits` 字段保持不变即可；建议把“字音 only”继续写进输出。
