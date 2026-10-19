/* eslint-disable */
/**
 * dsh-deliverable-download —— 浏览器半体。
 *
 * 给三个位置加「下载」，覆盖"我想把文件拿到自己机器上"的全部常见入口：
 *
 *   1. 交付卡片      `deliverables.file.actions`         —— 官方 present 卡片的动作区
 *   2. 变更文件卡片  `deliverables.review.file.actions`  —— git 变更摘要卡片的动作区
 *   3. 预览标题栏    `sidebar.right.tab.document.actions` —— 任何被预览的文件
 *
 * 1 与 2 是同一种做法：卡片自带 actionUrl 是官方 `api/<族>.open?sessionId&seq&index`，
 * 宿主半体把同坐标的路由注册成 `api/<族>.download`，这里只把末段 `.open` 换成
 * `.download`。顶层同源 GET → 会话 Cookie 会带上（这正是预览 iframe 做不到的地方）；
 * 响应带 `Content-Disposition: attachment` → 浏览器存盘，不导航、不离开应用。
 *
 * 3 不需要宿主侧新路由：文档预览的 ownerProps 直接给了 `absolutePath`，用官方
 * `/api/file?path=` 就够了（那条路由同样在认证围栏内），文件名由 `<a download>`
 * 自己带（`/api/file` 不设 Content-Disposition，所以属性值说了算）。
 *
 * 为什么用 `<a href download>` 而不是 fetch+Blob：不把整个文件读进页面内存，
 * 也不受页面内存/大文件限制，交给浏览器原生下载。
 *
 * 宿主经 /plugins/dsh-deliverable-download/client.js 提供本文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deliverable-download',
  factory: (require) => {
    const exports = {};
    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 字典命名空间（与宿主包名区分开，避免和官方命名空间撞）。 */
    const NS = 'deliverable-download';
    /** 样式标签的稳定标识，用于"只注入一次"。 */
    const CSS_TAG_ID = 'dsh-deliverable-download/action.css';
    /** 官方卡片/标题栏动作容器的取值：28×28 图标按钮，hover 用宿主语义变量。 */
    const CSS = [
      '.ddl_action{box-sizing:border-box;border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
      '.ddl_action:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.ddl_action:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
      '.ddl_action svg{width:15px;height:15px;flex:none;display:block}'
    ].join('');

    /**
     * 字典（唯一一份文案）。`locale` 是 inject 里声明的必需服务：
     * 条目一旦声明 `locale: NS`，slot 装配就会把 `t` 绑到本命名空间上，
     * 组件直接用它，不再另留一份兜底文案 —— 兜底会把"字典没注册上"
     * 这类接线错误藏起来（2026-10-19 首次验收就踩到：tooltip 显示原始 key）。
     */
    const DICT = { zh: { download: '下载', downloadNamed: '下载 {name}' }, en: { download: 'Download', downloadNamed: 'Download {name}' } };

    /** 只注入一次样式。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-deliverable-download';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 取路径最后一段（POSIX 或 Windows 拼写）。
     * @param path - 主机路径。
     * @returns 文件名。
     */
    function basenameOf(path) {
      const trimmed = String(path).replace(/[/\\]+$/u, '');
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return cut < 0 ? trimmed : trimmed.slice(cut + 1);
    }

    /**
     * 把一张卡片的原生打开地址换成同坐标的下载地址。
     * @param actionUrl - 官方给的 `api/<族>.open?sessionId=&seq=&index=`（相对或绝对）。
     * @returns 下载绝对地址；地址形状不认识时 undefined（此时不渲染按钮，不猜）。
     */
    function downloadHref(actionUrl) {
      if (typeof actionUrl !== 'string' || actionUrl === '') return undefined;
      let url;
      try {
        url = new URL(actionUrl, document.baseURI);
      } catch {
        return undefined;
      }
      const segments = url.pathname.split('/');
      const last = segments.length - 1;
      // 只认官方那族坐标路由：末段必须形如 `<族>.open`。
      if (last < 0 || !/^[a-z][a-z0-9-]*\.open$/u.test(segments[last])) return undefined;
      segments[last] = segments[last].slice(0, -'.open'.length) + '.download';
      url.pathname = segments.join('/');
      return url.href;
    }

    /**
     * 预览标题栏用：把一个主机绝对路径变成认证文件路由地址。
     * 判据与官方 `fileMediaUrl` 对齐（只收绝对路径，UNC/控制字符一律不猜）。
     * @param absolutePath - 文档预览 ownerProps 给的 `absolutePath`。
     * @returns 文件路由的绝对地址，或 undefined。
     */
    function fileHref(absolutePath) {
      if (typeof absolutePath !== 'string' || absolutePath === '') return undefined;
      const posix = absolutePath.startsWith('/');
      const win = /^[A-Za-z]:[/\\]/u.test(absolutePath);
      if (!posix && !win) return undefined;
      if (/^[/\\]{2}/u.test(absolutePath)) return undefined;
      if (/[\u0000-\u001f\u007f]/u.test(absolutePath)) return undefined;
      try {
        return new URL(`api/file?path=${encodeURIComponent(absolutePath)}`, document.baseURI).href;
      } catch {
        return undefined;
      }
    }

    /**
     * 交付卡片 / 变更文件卡片右下的下载按钮。
     * @param props - 卡片 owner 传下来的 `actionUrl`，以及 slot 注入的 `t`。
     * @returns 下载锚点，或地址无法识别时的 null。
     */
    function CardDownloadAction(props) {
      const href = downloadHref(props.actionUrl);
      if (href === undefined) return null;
      const label = props.t('download');
      return react.createElement('a', {
        className: 'ddl_action',
        href,
        // 空值即"强制存盘"；真文件名由响应头的 Content-Disposition 决定。
        download: '',
        rel: 'noopener',
        title: label,
        'aria-label': label,
        'data-deliverable-download': true,
        // 卡片整张是一个预览按钮，动作区叠在它上面：别让点击冒泡回去开预览。
        onClick: (event) => {
          event.stopPropagation();
        }
      }, react.createElement(primitives.IconDownloadOutlineRegular, { size: 15 }));
    }

    /**
     * 预览标题栏的下载按钮：任何被预览的文件（含只用「文件」面板打开的）都能存盘。
     * @param props - 文档预览 owner 的 `absolutePath`，以及 slot 注入的 `t`。
     * @returns 下载锚点，或拿不到可下载路径时的 null。
     */
    function PreviewDownloadAction(props) {
      const href = fileHref(props.absolutePath);
      if (href === undefined) return null;
      const name = basenameOf(props.absolutePath);
      const label = props.t('downloadNamed', { name });
      return react.createElement('a', {
        className: 'ddl_action',
        href,
        // 非空值即浏览器保存时用的文件名；/api/file 不设 Content-Disposition，属性说了算。
        download: name,
        rel: 'noopener',
        title: label,
        'aria-label': label,
        'data-deliverable-download': true
      }, react.createElement(primitives.IconDownloadOutlineRegular, { size: 15 }));
    }

    /**
     * 客户端插件体：注册字典与三个下载入口。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ensureStyle();

      // 字典：让按钮文案跟随界面语言。`locale` 在 inject 里声明，缺了就不该挂 —— 不吞错。
      ctx.effect(() => ctx.locale.register(NS, DICT), 'deliverable-download: locale');

      // 两个卡片动作区：官方 id 是 'open-in-app'（默认 order 0），下载排在它左边更顺手。
      for (const slot of ['deliverables.file.actions', 'deliverables.review.file.actions']) {
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          id: 'download',
          order: -10,
          locale: NS
        }, CardDownloadAction));
      }

      // 预览标题栏：排在官方那排控制之前。
      ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.document.actions',
        id: 'download',
        order: -10,
        locale: NS
      }, PreviewDownloadAction));
    }

    exports.name = 'deliverable-download';
    // locale 与 slots 都是必需服务：声明 locale 才拿得到绑定好的 t（见 DICT 上方注释）。
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;
    return exports;
  }
});
