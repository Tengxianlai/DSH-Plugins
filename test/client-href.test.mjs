/**
 * 浏览器半体的单元测试：用假 window/document 载入 client.js，捕获它的
 * `__ModuleLoader__.load` 信封与槽位注册，再直接渲染组件断言生成的下载地址。
 * 覆盖的是最易出错的一环——URL 拼接（卡片坐标改写 / 预览标题栏的文件路由）。
 * 运行：node test/client-href.test.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** 极简 DOM 桩：client.js 只在 apply 时注入一次样式。 */
const styleTags = [];
globalThis.document = {
  baseURI: 'https://dsh.example/',
  querySelector: (selector) => styleTags.find((t) => selector.includes(t.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) }
};

/** 捕获模块信封。 */
let envelope;
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      envelope = definition;
    }
  }
};

await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname).href);
assert.ok(envelope !== undefined, 'client.js 没有调用 __ModuleLoader__.load');
assert.equal(envelope.id, 'dsh-deliverable-download');
console.log('ok  模块信封：id 与 load 调用');

/** 假 require：只给 react 与 primitives。 */
const fakeRequire = (id) => {
  if (id === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children })
    };
  }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconDownloadOutlineRegular: () => null };
  }
  throw new Error(`未预料的 require：${id}`);
};

const plugin = envelope.factory(fakeRequire);
assert.equal(plugin.name, 'deliverable-download');
assert.deepEqual(plugin.inject, ['slots', 'locale']);

/** 假 ctx：捕获每个槽位注册的组件。 */
const registered = new Map();
const localeCalls = [];
const ctx = {
  effect: (cb) => {
    cb();
    return () => {};
  },
  locale: {
    register: (ns, dicts) => localeCalls.push([ns, dicts])
  },
  slots: {
    inject: (name, register) => {
      registered.set(name, register());
    },
    register: (options, Component) => ({ options, Component })
  }
};
plugin.apply(ctx);

// 1) 三个槽位都注册了，id/order 一致
assert.deepEqual([...registered.keys()].sort(), [
  'deliverables.file.actions',
  'deliverables.review.file.actions',
  'sidebar.right.tab.document.actions'
]);
for (const [slot, entry] of registered) {
  assert.equal(entry.options.name, slot);
  assert.equal(entry.options.id, 'download');
  assert.equal(entry.options.order, -10);
}
assert.equal(localeCalls.length, 1);
assert.equal(localeCalls[0][0], 'deliverable-download');
assert.deepEqual(Object.keys(localeCalls[0][1]), ['zh', 'en']);
assert.ok(styleTags.length >= 1, '样式没有注入');
console.log('ok  三个槽位注册 + 字典 + 样式');

/**
 * 真 `t`：从插件注册的字典里取词并做 {name} 插值。
 * 任何取不到的 key 直接失败 —— 这正是首次验收踩到的坑（tooltip 显示原始 key），
 * 留兜底文案会让它再次悄悄溜过去。
 */
const zhDict = localeCalls[0][1].zh;
const t = (key, params) => {
  const value = zhDict[key];
  assert.ok(value !== undefined, `字典缺 key：${key}`);
  return params === undefined ? value : value.replace(/\{(\w+)\}/gu, (_, k) => String(params[k]));
};

/** 渲染一个槽位组件，返回 createElement 树。 */
const render = (slot, props) => registered.get(slot).Component({ t, ...props });

// 2) 交付卡片：api/present.open?... → api/present.download?...
{
  const tree = render('deliverables.file.actions', { actionUrl: 'api/present.open?sessionId=s1&seq=5&index=0' });
  assert.equal(tree.type, 'a');
  assert.equal(tree.props.href, 'https://dsh.example/api/present.download?sessionId=s1&seq=5&index=0');
  assert.equal(tree.props.download, '');
  assert.equal(tree.props['data-deliverable-download'], true);
  assert.equal(typeof tree.props.onClick, 'function');
  assert.equal(tree.props.title, '下载');
  assert.equal(tree.props['aria-label'], '下载');
  console.log('ok  交付卡片地址改写（tooltip 走字典，不是原始 key）');
}

// 3) 变更卡片：api/changes.open?... → api/changes.download?...
{
  const tree = render('deliverables.review.file.actions', { actionUrl: 'api/changes.open?sessionId=s1&seq=7&index=2' });
  assert.equal(tree.props.href, 'https://dsh.example/api/changes.download?sessionId=s1&seq=7&index=2');
  console.log('ok  变更卡片地址改写');
}

// 4) 地址形状不认识 / 空值 → 不渲染（不猜）
for (const actionUrl of [undefined, '', 'api/present.host', 'api/file?path=/a/', 'api/open', 'api/present-open?sessionId=s']) {
  assert.equal(render('deliverables.file.actions', { actionUrl }), null, `期望 null：${String(actionUrl)}`);
}
// 相对与绝对两种官方写法都认（官方地址实际总带查询串）
assert.equal(render('deliverables.file.actions', { actionUrl: '/api/present.open?sessionId=s' }).props.href,
  'https://dsh.example/api/present.download?sessionId=s');
console.log('ok  只认官方坐标路由，其余不渲染');

// 5) 预览标题栏：absolutePath → /api/file?path=（并自带文件名）
{
  const tree = render('sidebar.right.tab.document.actions', { absolutePath: '/home/me/项目/报告 v2.pdf' });
  assert.equal(tree.props.href, `https://dsh.example/api/file?path=${encodeURIComponent('/home/me/项目/报告 v2.pdf')}`);
  assert.equal(tree.props.download, '报告 v2.pdf');
  assert.equal(tree.props.title, '下载 报告 v2.pdf');
  console.log('ok  预览标题栏文件路由 + 文件名（tooltip 带文件名插值）');
}

// 6) 预览标题栏：非绝对路径 / UNC / 控制字符 → 不渲染
for (const absolutePath of [undefined, '', 'relative/x.md', '//server/share/a.md', '/a/\u0000b.md', 'C:\\Users\\me\\a.pdf']) {
  const tree = render('sidebar.right.tab.document.actions', { absolutePath });
  if (absolutePath === 'C:\\Users\\me\\a.pdf') {
    assert.equal(tree.props.download, 'a.pdf', 'Windows 路径应被接受');
  } else {
    assert.equal(tree, null, `期望 null：${String(absolutePath)}`);
  }
}
console.log('ok  预览标题栏边界（相对路径/UNC/控制字符拒绝，Windows 绝对路径接受）');

// 7) 点击不应冒泡（卡片整张是预览按钮）
{
  let stopped = false;
  render('deliverables.file.actions', {
    actionUrl: 'api/present.open?sessionId=s&seq=1&index=0'
  }).props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  console.log('ok  点击阻止冒泡');
}

console.log('\n全部通过');
