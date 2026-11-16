/**
 * 浏览器半边的单元测试：用假 window/document/fetch/剪贴板载入 client.js，
 * 捕获 `__ModuleLoader__.load` 信封，再用极简 React hooks 运行时真正挂载组件，
 * 验证「点一下复制 = 完整 ID + 会话存储目录」。
 * 覆盖：路由 URL、目录三态文案、成功复制两行、拿不到目录时只复制 ID、
 * 点得太早时补查、切会话重查并取消旧请求。
 * 运行：node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** 极简 DOM 桩：client.js 只在 apply 时注入样式；复制兜底路径另有 textarea。 */
const styleTags = [];
globalThis.document = {
  baseURI: 'https://dsh.example/',
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  createElement: () => ({
    dataset: {},
    style: {},
    textContent: '',
    setAttribute() {},
    select() {},
    remove() {}
  }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: { appendChild() {} },
  execCommand: (command) => command === 'copy'
};

/** 假剪贴板：记录每次成功写入。 */
const clipboardWrites = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { clipboard: { writeText: async (text) => { clipboardWrites.push(text); } } }
});

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
assert.equal(envelope.id, 'dsh-session-id');
console.log('ok  模块信封：id 与 load 调用');

/**
 * 极简 React hooks 运行时：只实现本插件用到的 useState / useRef / useEffect / Fragment。
 * 不自动调度渲染，测试在数据落地后自己调用 update()；effect 里的 setState 会在同一次
 * 渲染提交后按 dirty 标记补渲染（有次数上限，防止测试写错导致死循环）。
 */
function createReactHarness() {
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = [];
  let cursor = 0;
  let pendingEffects = [];
  let pendingCleanups = [];
  let dirty = false;
  let component = null;
  let props = {};
  let tree;
  let translate;

  const sameDeps = (deps, previous) => Array.isArray(previous)
    && deps.length === previous.length
    && deps.every((value, index) => Object.is(value, previous[index]));

  const react = {
    Fragment: 'Fragment',
    createElement(type, elementProps, ...children) {
      return { type, props: elementProps ?? {}, children };
    },
    useState(initial) {
      const index = cursor++;
      const slot = stateSlots[index] ?? (stateSlots[index] = {
        value: typeof initial === 'function' ? initial() : initial
      });
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (refSlots[index] === undefined) refSlots[index] = { current: initial };
      return refSlots[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = effectSlots[index];
      const changed = deps === undefined || previous === undefined || !sameDeps(deps, previous.deps);
      if (!changed) return;
      if (previous?.cleanup !== undefined) pendingCleanups.push(previous.cleanup);
      effectSlots[index] = { deps, cleanup: undefined };
      pendingEffects.push({ index, callback });
    }
  };

  function commit() {
    const cleanups = pendingCleanups;
    const effects = pendingEffects;
    pendingCleanups = [];
    pendingEffects = [];
    for (const cleanup of cleanups) cleanup();
    for (const effect of effects) {
      const cleanup = effect.callback();
      effectSlots[effect.index].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  function render() {
    for (let guard = 0; guard < 20; guard += 1) {
      dirty = false;
      cursor = 0;
      tree = component({ t: translate, ...props });
      commit();
      if (!dirty) return;
    }
    throw new Error('渲染次数超限：effect 里可能无条件 setState');
  }

  return {
    react,
    mount(nextComponent, initialProps, t) {
      // 每次挂载都用全新的 hooks 槽位：不同测试之间不能串 state/ref。
      stateSlots.length = 0;
      refSlots.length = 0;
      effectSlots.length = 0;
      cursor = 0;
      pendingEffects = [];
      pendingCleanups = [];
      dirty = false;
      component = nextComponent;
      props = { ...initialProps };
      translate = t;
      render();
      return {
        get tree() {
          return tree;
        },
        update(nextProps = {}) {
          props = { ...props, ...nextProps };
          render();
        },
        unmount() {
          for (const slot of effectSlots) {
            if (slot?.cleanup !== undefined) slot.cleanup();
            if (slot !== undefined) slot.cleanup = undefined;
          }
        }
      };
    }
  };
}

const reactHarness = createReactHarness();

/** 假 require：本插件只 require('react')。 */
const plugin = envelope.factory((id) => {
  if (id === 'react') return reactHarness.react;
  throw new Error(`未预料的 require：${id}`);
});
assert.equal(plugin.name, 'session-id');
assert.deepEqual(plugin.inject, ['slots', 'locale']);

/** 假 ctx：捕获槽位注册与字典。 */
const registered = new Map();
const localeCalls = [];
const ctx = {
  effect: (cb) => {
    cb();
    return () => {};
  },
  locale: { register: (ns, dicts) => localeCalls.push([ns, dicts]) },
  slots: {
    inject: (name, register) => registered.set(name, register()),
    register: (options, Component) => ({ options, Component })
  }
};
plugin.apply(ctx);

const entry = registered.get('conversation.session.header.actions');
assert.ok(entry !== undefined, '没有注册会话标题栏槽位');
assert.equal(entry.options.id, 'session-id');
assert.equal(entry.options.order, 30);
assert.equal(entry.options.locale, 'session-id');
assert.equal(localeCalls.length, 1);
assert.deepEqual(Object.keys(localeCalls[0][1]), ['zh', 'en']);
assert.ok(styleTags.length >= 1, '样式没有注入');
console.log('ok  槽位注册 + 字典 + 样式');

/** 真 `t`：取不到 key 直接失败（兜底会藏住接线错误）。 */
const zh = localeCalls[0][1].zh;
const t = (key, params) => {
  const value = zh[key];
  assert.ok(value !== undefined, `字典缺 key：${key}`);
  return params === undefined ? value : value.replace(/\{(\w+)\}/gu, (_, name) => String(params[name]));
};

/** 让 fetch/await 链条跑完（微任务 + 一轮宏任务）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const SESSION_ID = 'session-81e19121-b2fc-4a0b-99d1-d8fc7199945d';
const LOG = '/home/me/.dsh-wsl/sessions/--home-me-proj--/session-81e19121-b2fc-4a0b-99d1-d8fc7199945d/session.v4.jsonl.zstd';
const DIR = '/home/me/.dsh-wsl/sessions/--home-me-proj--/session-81e19121-b2fc-4a0b-99d1-d8fc7199945d';
const CWD = '/home/me/proj';

/**
 * 装一个可控 fetch，记录每次请求。
 * @param {Function} handler - (url, init) => 响应桩。
 * @returns {Array<[string, object]>} 请求记录。
 */
function serveFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init ?? {}]);
    return handler(String(url), init ?? {});
  };
  return calls;
}

const okBody = (body) => ({ ok: true, status: 200, json: async () => body });
const errorStatus = (status) => ({ ok: false, status, json: async () => ({ error: 'nope' }) });

// 1) 成功路径：挂载即查一次，tooltip 与 data 属性带上目录；点击复制"ID + 目录"两行
{
  clipboardWrites.length = 0;
  const calls = serveFetch(() => okBody({ sessionId: SESSION_ID, log: LOG, dir: DIR, cwd: CWD }));
  const view = reactHarness.mount(entry.Component, { sessionId: SESSION_ID }, t);

  assert.equal(calls.length, 1, '挂载时应该查一次位置');
  assert.equal(calls[0][0], `api/session.location?sessionId=${encodeURIComponent(SESSION_ID)}`);
  assert.equal(calls[0][1].credentials, 'same-origin');

  await settle();
  view.update();

  assert.equal(view.tree.type, 'button');
  assert.equal(view.tree.props['data-dsh-session-id'], SESSION_ID);
  assert.equal(view.tree.props['data-dsh-session-dir'], DIR);
  assert.equal(view.tree.props['data-dsh-session-location'], 'ready');
  assert.ok(view.tree.props.title.includes(DIR), 'tooltip 应显示存储目录');
  assert.ok(view.tree.props.title.includes(CWD), 'tooltip 应显示工作目录');
  assert.equal(view.tree.props.title.includes('存储目录读取中'), false);

  await view.tree.props.onClick();
  assert.deepEqual(clipboardWrites, [SESSION_ID + '\n' + DIR + '\n' + CWD], '应复制三行：ID / 存储目录 / 工作目录');
  assert.equal(calls.length, 1, '目录已知时点击不再重复查询');

  view.update();
  assert.equal(view.tree.children[0].children[0], '已复制');
  view.unmount();
  console.log('ok  成功路径：复制三行（ID / 存储目录 / 工作目录）');
}

// 2) 会话没落盘（dir 为 null）：tooltip 说不可用，点击只复制 ID
{
  clipboardWrites.length = 0;
  serveFetch(() => okBody({ sessionId: SESSION_ID, log: null, dir: null, cwd: CWD }));
  const view = reactHarness.mount(entry.Component, { sessionId: SESSION_ID }, t);
  await settle();
  view.update();

  assert.equal(view.tree.props['data-dsh-session-location'], 'ready');
  assert.equal(view.tree.props['data-dsh-session-dir'], undefined);
  assert.ok(view.tree.props.title.includes('暂不可用'));

  await view.tree.props.onClick();
  assert.deepEqual(clipboardWrites, [SESSION_ID]);
  view.unmount();
  console.log('ok  未落盘会话：只复制 ID，不编造目录');
}

// 3) 路由查不到（旧宿主 / 404）：同样只复制 ID，并在点击时补查一次
{
  clipboardWrites.length = 0;
  const calls = serveFetch(() => errorStatus(404));
  const view = reactHarness.mount(entry.Component, { sessionId: SESSION_ID }, t);
  await settle();
  view.update();

  assert.equal(view.tree.props['data-dsh-session-location'], 'failed');
  assert.ok(view.tree.props.title.includes('暂不可用'));

  await view.tree.props.onClick();
  assert.deepEqual(clipboardWrites, [SESSION_ID]);
  assert.equal(calls.length, 2, '点击时应该补查一次（宿主路由可能刚上线）');
  view.unmount();
  console.log('ok  路由不可用：只复制 ID，点击补查');
}

// 4) 点得太早（查询还没回来）：先复制 ID，同时补发查询；回来后 tooltip 带目录
{
  clipboardWrites.length = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = serveFetch(() => pending);
  const view = reactHarness.mount(entry.Component, { sessionId: SESSION_ID }, t);
  assert.equal(view.tree.props['data-dsh-session-location'], 'loading');
  assert.ok(view.tree.props.title.includes('读取中'));

  await view.tree.props.onClick();
  assert.deepEqual(clipboardWrites, [SESSION_ID], '查询未返回时先复制 ID');
  assert.equal(calls.length, 2, '点击应补发一次查询（旧的被取消）');
  release(okBody({ sessionId: SESSION_ID, log: LOG, dir: DIR, cwd: null }));
  await settle();
  view.update();
  assert.equal(view.tree.props['data-dsh-session-dir'], DIR);
  await view.tree.props.onClick();
  assert.deepEqual(clipboardWrites, [SESSION_ID, SESSION_ID + '\n' + DIR], '工作目录未知时复制两行');
  view.unmount();
  console.log('ok  点得早：先复制 ID 再补查，目录回来后进 tooltip（无 cwd 时两行）');
}

// 5) 切会话：按新 ID 重查，并取消上一个会话的在途请求
{
  clipboardWrites.length = 0;
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init ?? {}]);
    return calls.length === 1 ? first : okBody({ sessionId: 'session-bbbb', log: null, dir: null, cwd: null });
  };
  const view = reactHarness.mount(entry.Component, { sessionId: SESSION_ID }, t);
  assert.equal(calls.length, 1);

  view.update({ sessionId: 'session-bbbb' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'api/session.location?sessionId=session-bbbb');
  assert.equal(calls[0][1].signal.aborted, true, '切会话必须取消旧请求');
  releaseFirst(okBody({ sessionId: SESSION_ID, log: LOG, dir: DIR, cwd: null }));
  await settle();
  view.update();
  assert.equal(view.tree.props['data-dsh-session-id'], 'session-bbbb');
  assert.equal(view.tree.props['data-dsh-session-dir'], undefined, '旧会话的目录不能串到新会话上');
  view.unmount();
  console.log('ok  切会话：重查 + 取消旧请求 + 不串目录');
}

// 6) 会话 ID 未就绪：不渲染，也不发请求
{
  const calls = serveFetch(() => okBody({}));
  for (const sessionId of [undefined, '', 42]) {
    const view = reactHarness.mount(entry.Component, { sessionId }, t);
    assert.equal(view.tree, null, `期望 null：${String(sessionId)}`);
    view.unmount();
  }
  assert.equal(calls.length, 0);
  console.log('ok  会话 ID 未就绪：不渲染、不发请求');
}

console.log('\n全部通过');
