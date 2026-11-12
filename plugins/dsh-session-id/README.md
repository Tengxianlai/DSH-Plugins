# dsh-session-id

在 DSH Web 的会话标题栏显示当前会话 ID，点击复制完整 id。

- **宿主半边**（`index.js`）：空实现，只提供一条 Loader 条目。存在的原因是
  dsh-client-modules 只扫描「声明了 `dsh.client` 的包」，没有宿主条目浏览器半边不会被加载。
- **浏览器半边**（`client.js`）：渲染截断后的 id 与复制交互。
- **挂载**：`cordis.patch.yml` 里一条 `insert`（`id: session-id`，`name: dsh-session-id`）。

## 测试

```sh
node --check index.js && node --check client.js
node test/host.test.mjs
```
