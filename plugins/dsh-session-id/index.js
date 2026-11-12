/**
 * dsh-session-id —— 宿主半边。
 *
 * 这个插件全部工作都在浏览器半边（client.js）。宿主这边只需要一条 Loader 条目：
 * dsh-client-modules 扫描「声明了 dsh.client 的包」来生成浏览器模块清单与
 * /plugins/<package>/client.js 路由，没有宿主条目的包不会被扫描到。
 *
 * 因此 apply 保持为空，不注册任何服务/工具/路由。
 */

export const name = 'dsh-session-id';
export const inject = [];

export function apply() {}
