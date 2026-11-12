/**
 * 对账检查（门禁的可判定部分）。检查的都是**真实失败模式**，不是形式：
 *
 *  1. 宿主半体注册的下载路由，与浏览器半体改写出来的地址，必须一一对上
 *     —— 半边改名是最容易犯、又最难在界面上看出来的漂移（按钮还在，点了 404）；
 *  2. 安装软链是否还在、是否指向本仓 —— 源码挪窝 = 静默卸载，界面不会报错；
 *  3. profile 的 bundle 通道是否真的接通：`dsh.profile.bundles` 有本包、依赖是 `link:`、
 *     profile 自己的 patch 里没有重复 `insert` 行 —— 任何一项不对，重启后插件不加载或挂两次；
 *  4. STATE.md / README.md 这类"现在时"文件里引用的仓内路径必须存在；
 *  5. drift-check 块里登记为"已停用"的术语，在现在时文件里必须带停用标记
 *     （当前没有停用项，保留机制）。
 *
 * 用法：node scripts/check-docs-drift.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 当前 profile 目录：优先环境变量（dsh 启动的会话里总是有），否则按 home 推断。 */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh-wsl'), 'profiles', process.env.DSH_PROFILE ?? 'web');
const failures = [];
const ok = (message) => console.log(`ok   ${message}`);
const bad = (message) => {
  failures.push(message);
  console.log(`FAIL ${message}`);
};

/** 解析 STATE.md 的 drift-check 块（```drift-check ... ```）。 */
function driftBlock(text, file) {
  const match = /```drift-check\n([\s\S]*?)```/u.exec(text);
  if (match === null) {
    bad(`${file} 里找不到 drift-check 块`);
    return { files: [], retired: [] };
  }
  const raw = match[1];
  const files = (/present-tense-files:\s*(.+)/u.exec(raw)?.[1] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const retired = [];
  const retiredAt = raw.indexOf('retired:');
  if (retiredAt >= 0) {
    for (const line of raw.slice(retiredAt).split('\n').slice(1)) {
      const term = /^\s*-\s*term:\s*(.+)$/u.exec(line)?.[1];
      if (term !== undefined) retired.push(term.trim().replace(/^["']|["']$/gu, ''));
      else if (/^\s*\w+:/u.test(line)) break; // 到了下一个键
    }
  }
  return { files, retired };
}

// ── 1. 宿主路由 ↔ 浏览器改写必须对上 ─────────────────────────────────────
{
  // 宿主半体：假 ctx 捕获注册的路由路径。
  const routes = new Map();
  const fsStub = {
    processPathFromHostPath: (p) => p,
    resolve: async (p) => ({ displayPath: p }),
    processPath: (t) => t.displayPath,
    readBytes: async () => new Uint8Array()
  };
  const { apply } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
  apply({
    effect: (cb) => { cb(); return () => {}; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
    sessionQuery: { readEvent: async () => ({ target: { type: 'deliverables/presented', data: { files: [] } }, session: {} }) },
    workspaceChanges: { summary: () => undefined },
    workspaceFiles: { stat: async () => ({ absolutePath: '/x' }) },
    sandboxPolicy: { workspaceRoot: '/' },
    fs: fsStub
  });
  const families = [...routes.keys()].map((p) => /^\/api\/([a-z][a-z0-9-]*)\.download$/u.exec(p)?.[1]).filter(Boolean);
  if (families.length === 0) bad('宿主半体没有注册任何 /api/<族>.download 路由');
  else ok(`宿主路由：${[...routes.keys()].join(', ')}`);

  // 浏览器半体：假 loader/document 取出组件，按官方坐标渲染。
  const styleTags = [];
  globalThis.document = {
    baseURI: 'https://dsh.example/',
    querySelector: (selector) => styleTags.find((t) => selector.includes(t.dataset.pluginCss)) ?? null,
    createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
    head: { appendChild: (tag) => styleTags.push(tag) }
  };
  let envelope;
  globalThis.window = { __ModuleLoader__: { load: (def) => { envelope = def; } } };
  await import(pathToFileURL(join(ROOT, 'client.js')).href);
  const plugin = envelope.factory((id) => {
    if (id === 'react') return { createElement: (type, props) => ({ type, props: props ?? {} }) };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconDownloadOutlineRegular: () => null };
    throw new Error(`未预料的 require：${id}`);
  });
  const registered = new Map();
  let dict;
  plugin.apply({
    effect: (cb) => { cb(); return () => {}; },
    // 字典必须真注册上：组件用 slot 绑定的 `t`，没有兜底文案（见 STATE.md 第 4 节缺陷 1）。
    locale: { register: (_ns, dicts) => { dict = dicts; } },
    slots: { inject: (name, register) => registered.set(name, register()), register: (o, C) => ({ o, C }) }
  });
  if (dict?.zh?.download === undefined) bad('浏览器半体没有注册 zh 字典（slot 的 t 会退化成原始 key）');
  const t = (key, params) => {
    const value = dict.zh[key];
    if (value === undefined) bad(`字典缺 key：${key}`);
    return params === undefined ? String(value ?? key) : String(value ?? key).replace(/\{(\w+)\}/gu, (_, k) => String(params[k]));
  };
  const card = registered.get('deliverables.file.actions').C;
  for (const family of families) {
    const tree = card({ t, actionUrl: `api/${family}.open?sessionId=s1&seq=2&index=3` });
    const expected = `https://dsh.example/api/${family}.download?sessionId=s1&seq=2&index=3`;
    if (tree === null) bad(`浏览器半体不认卡片地址：api/${family}.open`);
    else if (tree.props.href !== expected) bad(`地址改写不对：期望 ${expected}，得到 ${String(tree.props.href)}`);
    else ok(`坐标改写对上：api/${family}.open → api/${family}.download`);
  }
}

// ── 2. 安装软链 ─────────────────────────────────────────────────────────
{
  const link = join(PROFILE_DIR, 'node_modules', 'dsh-deliverable-download');
  if (!existsSync(link) && lstatSync(link, { throwIfNoEntry: false }) === undefined) {
    bad(`安装软链不存在：${link}（插件不会被加载）`);
  } else if (!lstatSync(link).isSymbolicLink()) {
    bad(`安装位不是软链而是实体：${link}（升级易漂移）`);
  } else {
    const target = resolve(dirname(link), readlinkSync(link));
    if (target !== ROOT) bad(`软链指向别处：${target} ≠ ${ROOT}`);
    else ok(`安装软链指向本仓：${link}`);
  }
}

// ── 3. profile 的 bundle 通道 ───────────────────────────────────────────
{
  const manifestPath = join(PROFILE_DIR, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('dsh-deliverable-download')) {
    bad(`${manifestPath} 的 dsh.profile.bundles 里没有 dsh-deliverable-download（重启后插件不会加载）`);
  } else {
    ok('profile 的 dsh.profile.bundles 里有本插件');
  }
  const dependency = manifest.dependencies?.['dsh-deliverable-download'];
  if (typeof dependency !== 'string' || !dependency.startsWith('link:')) {
    bad(`profile 依赖不是 link: 形态（${String(dependency)}），改代码不会同步到插件`);
  } else {
    ok(`依赖以 link: 记录：${dependency}`);
  }
  // 一个插件只挂一次：profile 自己的补丁层不得再出现本插件的 insert 行。
  const profilePatch = join(PROFILE_DIR, 'cordis.patch.yml');
  const patchText = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : '';
  if (/name:\s*['"]?dsh-deliverable-download['"]?/u.test(patchText)) {
    bad(`${profilePatch} 仍挂着 dsh-deliverable-download（与 bundle 层重复挂载）`);
  } else {
    ok('profile 自己的 patch 里没有重复挂载行');
  }
}

// ── 4/5. 现在时文件的路径与停用标记 ─────────────────────────────────────
{
  const state = readFileSync(join(ROOT, 'STATE.md'), 'utf8');
  const { files, retired } = driftBlock(state, 'STATE.md');
  if (files.length === 0) bad('STATE.md 的 drift-check 没有登记 present-tense-files');
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path)) bad(`现在时文件不存在：${file}`);
    else ok(`现在时文件在位：${file}`);
  }
  // 仓内路径引用（lib/ test/ scripts/ 前缀或所列文件名）必须存在
  const referenced = new Set();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/`((?:lib|test|scripts)\/[A-Za-z0-9._/-]+|client\.js|package\.json|STATE\.md|README\.md)`/gu)) {
      referenced.add(match[1]);
    }
  }
  for (const path of referenced) {
    if (!existsSync(join(ROOT, path))) bad(`${files.join('/')} 引用了不存在的文件：${path}`);
  }
  ok(`现在时文件里引用的仓内路径都存在（${referenced.size} 处）`);

  const markers = /(已停用|已废止|superseded|~~)/u;
  for (const term of retired) {
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const line of text.split('\n')) {
        if (line.includes(term) && !markers.test(line)) bad(`${file} 里出现已停用术语「${term}」但没有停用标记：${line.trim()}`);
      }
    }
    ok(`已停用术语「${term}」都有标记`);
  }
  if (retired.length === 0) ok('已停用术语：暂无（机制保留）');
}

console.log('');
if (failures.length > 0) {
  console.error(`对账失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('对账通过');
