# 部署拾音

拾音是纯静态网站，视频和音频在使用者的浏览器里处理。无需数据库、服务器端 FFmpeg，也无需上传课堂视频。

## GitHub Pages 免费部署

目标仓库：`yhArcadia/shiyin`。首次配置完成后，推送到 `main` 分支会自动构建和发布。

1. 将本目录的源代码放入公开 GitHub 仓库；不要提交 `node_modules/`、`.local/`、本地测试素材或 `dist/`。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 打开 **Actions → Deploy GitHub Pages**，等待成功；首次启用 Pages 后可以手动点 **Run workflow**。
4. 以 Pages 设置页显示的地址为准。该仓库的预期地址是 `https://yharcadia.github.io/shiyin/`。

自动部署配置在 `.github/workflows/pages.yml`。只发布 `dist/`，测试素材和本地草稿不会随网站发布。源代码使用相对资源路径，支持 `/shiyin/` 这样的项目站点路径。

GitHub Free 的 Pages 需要公开仓库。访问者无需 GitHub 账号。国内不同网络的实际访问速度需要试用确认；首次导出会加载约 31 MB 的音频处理引擎，后续由浏览器按缓存规则复用。

官方文档：[配置 Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[GitHub Actions 部署](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 以后迁移到其他静态托管

运行 `npm ci --ignore-scripts`，再运行 `npm run build`。把 `dist/` 内的全部内容上传到网站根目录，使根目录直接包含 `index.html`、`src/`、`vendor/` 等。

使用 HTTPS，确保 `.mjs` 返回 JavaScript 类型、`.bin` 返回二进制内容，且请求到的是文件本身而非平台的错误页。当前音频引擎不要求 COOP/COEP 等额外隔离响应头。所有资源随网站同源托管，不需要额外 CDN。

换域名后，旧域名下的浏览器草稿不会自动搬过去；原视频和已下载的音频不受影响。
