#!/usr/bin/env python3
"""Local cached faster-whisper only. Never download a model or call a cloud API.

Decoding goes through ffmpeg into a mono 16 kHz float32 numpy array because the
installed PyAV (19.x) rejects the `metadata_errors` argument used by
faster-whisper 1.2.1's own `decode_audio`, so `model.transcribe(path)` fails.
The ffmpeg -> numpy route is the one verified on this machine; see
docs/review/AI_VIDEO_20261116/local-tools/ASR_ADAPTER.md.

Output: one JSON document on stdout (schema dsh.ai-video-local-asr/2). Usage or
missing-input errors exit 2 via argparse; runtime problems are reported inside
the JSON with a non-empty `status` and `error` so a caller can keep partial
evidence instead of guessing.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = 'dsh.ai-video-local-asr/2'
SAMPLE_RATE = 16000
SILENCE_THRESHOLD_DBFS = -50.0
MODEL_FILES = ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'preprocessor_config.json')


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def model_fingerprint(model_dir: Path) -> dict:
    """Cheap, stable fingerprint: stat manifest for the files that define the model.

    Hashing the ~460 MB model.bin on every ASR call would be wasteful; the stat
    manifest (name/bytes/mtime) plus a sha256 of that manifest identifies the
    snapshot well enough to detect a swap, without downloading anything.
    """
    files = []
    for name in MODEL_FILES:
        p = model_dir / name
        if p.is_file():
            st = p.stat()
            files.append({'name': name, 'bytes': st.st_size, 'mtime_ns': st.st_mtime_ns})
    payload = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
    return {'method': 'files-stat-sha256-of-manifest', 'sha256': hashlib.sha256(payload).hexdigest(), 'files': files}


def decode_audio_ffmpeg(path: Path) -> tuple:
    """Return (float32 mono 16k samples, duration_sec) or raise RuntimeError with code."""
    import numpy as np
    try:
        proc = subprocess.run(
            ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path),
             '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE),
             '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
            capture_output=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError('ffmpeg is not installed or not on PATH') from exc
    if proc.returncode != 0:
        tail = proc.stderr.decode('utf-8', 'replace')[-2000:]
        raise RuntimeError(f'ffmpeg failed to decode audio (exit {proc.returncode}): {tail}')
    raw = proc.stdout
    if not raw:
        return np.zeros(0, dtype=np.float32), 0.0
    audio = np.frombuffer(raw, dtype='<f4').copy()
    return audio, float(audio.shape[0]) / SAMPLE_RATE


def audio_stats(audio) -> dict:
    import numpy as np
    if audio.size == 0:
        return {'rms_dbfs': None, 'peak_dbfs': None, 'silence_threshold_dbfs': SILENCE_THRESHOLD_DBFS,
                'silence_suspected': True, 'samples': 0}
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    peak = float(np.max(np.abs(audio)))
    rms_db = 20.0 * float(np.log10(max(rms, 1e-12)))
    peak_db = 20.0 * float(np.log10(max(peak, 1e-12)))
    return {'rms_dbfs': round(rms_db, 2), 'peak_dbfs': round(peak_db, 2),
            'silence_threshold_dbfs': SILENCE_THRESHOLD_DBFS,
            'silence_suspected': rms_db < SILENCE_THRESHOLD_DBFS, 'samples': int(audio.shape[0])}


def normalize(text: str) -> str:
    return re.sub(r'[^\w\u4e00-\u9fff]', '', text or '')


def report(**fields) -> dict:
    base = {
        'schema': SCHEMA,
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'limits': [
            'ASR proves approximate words in the audio only; it does not prove lip sync, timbre, acting, delivery or listener approval.',
            'Word timestamps are decoder estimates, not frame-accurate speech boundaries.',
            'Homophones and near-homophones may be substituted by the model; a mismatch is a review hint, not proof the take is wrong.',
            'A silent or mostly-silent clip must not be forced into text; silence detection is a coarse RMS signal.',
        ],
    }
    base.update(fields)
    return base


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--file', required=True, type=Path)
    p.add_argument('--model', required=True, type=Path)
    p.add_argument('--language', default='zh')
    p.add_argument('--expected')
    p.add_argument('--expect-sha256', help='caller-supplied source sha256; mismatch is reported, never silently accepted')
    p.add_argument('--vad', action='store_true', help='enable faster-whisper VAD (local model only, no download)')
    p.add_argument('--vad-min-silence-ms', type=int, default=300)
    args = p.parse_args()

    if not args.file.is_file():
        p.error(f'input media does not exist: {args.file}')
    if not args.model.is_dir():
        p.error(f'model directory does not exist: {args.model}')
    if args.expect_sha256 and not re.fullmatch(r'[a-f0-9]{64}', args.expect_sha256.lower()):
        p.error('--expect-sha256 must be a 64-character hex digest')

    file = args.file.resolve()
    model_dir = args.model.resolve()
    source = {'path': str(file), 'sha256': sha256_file(file), 'bytes': file.stat().st_size}
    fingerprint = model_fingerprint(model_dir)

    if args.expect_sha256 and source['sha256'] != args.expect_sha256.lower():
        print(json.dumps(report(status='source_hash_mismatch', source=source,
                                expected_sha256=args.expect_sha256.lower(),
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                expected=args.expected, normalized_text_match=None,
                                error={'code': 'SOURCE_HASH_MISMATCH',
                                       'message': 'the file changed after the caller hashed it'}),
                         ensure_ascii=False))
        return 0

    try:
        import numpy as np  # noqa: F401  (imported for the decode path)
    except ImportError:
        print(json.dumps(report(status='error', source=source,
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                error={'code': 'NUMPY_UNAVAILABLE', 'message': 'numpy is not available in this Python'}),
                         ensure_ascii=False))
        return 0
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps(report(status='error', source=source,
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                error={'code': 'FASTER_WHISPER_UNAVAILABLE',
                                       'message': 'faster_whisper is not available in this Python; point --asr-python at the project ASR environment'}),
                         ensure_ascii=False))
        return 0

    try:
        audio, decoded_duration = decode_audio_ffmpeg(file)
    except RuntimeError as exc:
        message = str(exc)
        code = 'FFMPEG_UNAVAILABLE' if 'not installed' in message else 'AUDIO_DECODE_FAILED'
        print(json.dumps(report(status='error', source=source,
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                error={'code': code, 'message': message[-2000:]}), ensure_ascii=False))
        return 0

    stats = audio_stats(audio)
    decode = {'tool': 'ffmpeg', 'sample_rate': SAMPLE_RATE, 'channels': 1, 'dtype': 'float32',
              'samples': int(audio.shape[0]), 'duration_sec': round(decoded_duration, 3)}
    if audio.size == 0 or decoded_duration == 0.0:
        print(json.dumps(report(status='no_audio', source=source, decoding=decode, audio=stats,
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                expected=args.expected, normalized_text_match=None,
                                segments=[], text='',
                                limits=['No audio samples were decoded; an ASR result cannot be produced.'],
                                warnings=['no_audio_stream_or_empty_decode']), ensure_ascii=False))
        return 0

    try:
        model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', local_files_only=True)
        segments_iter, info = model.transcribe(
            audio,
            language=args.language,
            task='transcribe',
            beam_size=5,
            word_timestamps=True,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=None,
            vad_filter=bool(args.vad),
            vad_parameters={'min_silence_duration_ms': args.vad_min_silence_ms} if args.vad else None,
        )
        segments = []
        for segment in segments_iter:
            segments.append({
                'start': round(float(segment.start), 3),
                'end': round(float(segment.end), 3),
                'text': segment.text,
                'avg_logprob': round(float(segment.avg_logprob), 3),
                'no_speech_prob': round(float(segment.no_speech_prob), 3),
                'words': [{'start': round(float(w.start), 3), 'end': round(float(w.end), 3),
                           'word': w.word, 'probability': round(float(w.probability), 3)}
                          for w in (segment.words or [])],
            })
        text = ''.join(s['text'] for s in segments).strip()
        language = getattr(info, 'language', args.language)
    except Exception as exc:  # model/transcribe runtime problem: keep the evidence report
        print(json.dumps(report(status='error', source=source, decoding=decode, audio=stats,
                                model={'path': str(model_dir), 'fingerprint': fingerprint},
                                error={'code': 'ASR_RUNTIME_ERROR', 'type': type(exc).__name__, 'message': str(exc)[:2000]}),
                         ensure_ascii=False))
        return 0

    warnings = []
    if args.vad:
        warnings.append('vad_enabled_local_only')
    match = None
    if args.expected is not None:
        match = normalize(text) == normalize(args.expected)
        if match is False:
            warnings.append('homophone_or_substitution_possible')

    if stats['silence_suspected'] and not text:
        status = 'no_speech_detected'
        warnings.append('silence_suspected_no_text_emitted')
    elif stats['silence_suspected']:
        status = 'silence_suspected'
        warnings.append('text_emitted_on_suspected_silence_review_required')
    elif args.expected is not None:
        status = 'match' if match else 'mismatch'
    elif text:
        status = 'transcribed'
    else:
        status = 'review_required'
        warnings.append('no_text_emitted')

    payload = report(
        status=status,
        source=source,
        expected_sha256=args.expect_sha256.lower() if args.expect_sha256 else None,
        model={'path': str(model_dir), 'name': model_dir.name, 'fingerprint': fingerprint},
        decoding=decode,
        audio=stats,
        vad={'enabled': bool(args.vad), 'min_silence_ms': args.vad_min_silence_ms if args.vad else None},
        language=language,
        duration=round(decoded_duration, 3),
        text=text,
        segments=segments,
        expected=args.expected,
        normalized_text_match=match,
        warnings=warnings,
        limits=[
            'ASR proves approximate words in the audio only; it does not prove lip sync, timbre, acting, delivery or listener approval.',
            'Word timestamps are decoder estimates, not frame-accurate speech boundaries.',
            'A mismatch can be a homophone/substitution; review the audio and approved line before rejecting a take.',
            'Silence detection is a coarse RMS threshold; it is not a speech/non-speech classifier.',
        ],
    )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
