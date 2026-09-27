# hexo-post-manager

> 给 Hexo 博客加一个网页版「⚙️ 文章管理」：**新建/重命名/删除分类（文件夹）、把文章移到别的分类、随意调整文章顺序**。全程不碰终端。
>
> 需要密钥验证身份；密钥由 Cloudflare Function **服务端**校验，PAT 不进浏览器。

## 已验证

本项目代码在作者站点（<https://entropyqwe.github.io>）的真实文章上做过单元测试：
**35 项断言全部通过**，包括 front-matter 往返一致、改分类不丢字段、改日期后旧链接仍然有效。

```bash
node test/manage.test.mjs /path/to/hexo-site/source/_posts
```

## 解决的两件事

| 需求 | Hexo 里对应什么 | 面板里怎么做 |
|---|---|---|
| 增加文件夹 / 把文章换到别的文件夹 | front-matter 的 `categories`（`技术/前端` = 两级分类） | 「📁 分类 / 文件夹」页：新建分类 → 在「文章归属」下拉选它 |
| 随意调整文章先后位置 | 首页/归档都是 `order_by: -date`，**`date` 是唯一决定顺序的字段** | 「🔀 文章顺序」页：拖动或 ▲▼ 排好 → 保存 |

### 关键细节：改日期不会让旧链接失效

`_config.yml` 里通常是 `permalink: :year/:month/:day/:title/`，**日期是 URL 的一部分**。
直接改日期会把 `/2026/09/06/xxx/` 变成 `/2025/09/01/xxx/`，旧链接全 404。

本插件在改日期时会自动把**原 URL 写进 front-matter 的 `permalink`** 钉死：

```yaml
date: 2025-09-01 10:00:00                 # 用来调顺序
permalink: /2026/09/06/kirin9020-scan/    # 旧地址永久有效
```

已有 `permalink` 的文章不会被覆盖（幂等），反复调顺序也不会漂移。

## 架构

```
浏览器「⚙️ 管理面板」 ──POST /manage──▶ Cloudflare Pages Function
                                            ├─ 服务端校验 ADMIN_KEY（Secret，前端拿不到）
                                            └─ 用服务端 GITHUB_TOKEN 调 GitHub API 改 .md
GitHub Actions ──▶ hexo 构建 ──▶ GitHub Pages 上线（1~3 分钟）
```

## 目录

- `cloudflare-pages/functions/manage.js` —— `/manage` 端点（自包含，不依赖其它插件文件）
- `theme-files/layout/_partials/post-manager.ejs` —— 验证界面 + 管理面板
- `install.sh` —— 一键安装到 Hexo 工程
- `deploy.sh` —— 部署云函数并写入密钥
- `test/manage.test.mjs` —— 用真实文章做的单元测试
- `docs/原理与部署全流程.md` —— **原理讲解 + 完整步骤**（推荐先读）

## 安装

```bash
git clone https://github.com/Entropyqwe/hexo-post-manager.git
cd hexo-post-manager

./install.sh /path/to/你的hexo工程 themes/firefly

# 主题 _config.yml 加：
#   manage:
#     enabled: true          # endpoint 省略则复用 upload.endpoint

cp .env.example .env && vi .env
./deploy.sh
```

**必须和已有的发布/相册插件用同一个 Pages 项目**（`CF_PROJECT` 保持一致），这样 `/manage`
才会和 `/publish` 挂在同一域名下。

## env 变量

| 变量 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 部署用，Cloudflare 令牌 |
| `CF_PROJECT` | Pages 项目名，需与已有插件一致 |
| `REPO` | **Hexo 源码仓库**（不是 `Entropyqwe.github.io` 构建产物仓库） |
| `BRANCH` | 默认 `main` |
| `ADMIN_KEY` | 管理密钥，写入 Cloudflare Secret |
| `GITHUB_TOKEN` | 仅需 Contents 读写；同一项目已配过可留空 |

## 支持的接口

`POST /manage`，body 里 `{ key, action, ... }`：

| action | 作用 |
|---|---|
| `verify` | 仅校验密钥（验证界面用） |
| `list` | 列出全部文章与分类统计 |
| `setCategory` | `{ path, categories: "技术/前端" }` 把文章移到分类 |
| `renameCategory` | `{ from, to }` 重命名分类（含后代） |
| `deleteCategory` | `{ name, moveTo? }` 删除分类 |
| `setDate` | `{ path, date }` 单篇改发布时间（自动护住旧链接） |
| `reorder` | `{ order: [{path}...] }` 按顺序整体重排 |

## 安全

- 管理密钥只存 Cloudflare Secret，**不要**写进前端/仓库；
- PAT 只给目标仓库 **Contents: Read and write**，别用全权限 token；
- 口令在请求体里传输，依赖 HTTPS；
- 想更稳可以再套一层 Cloudflare Access 挡在 `/manage` 前面。

## License

MIT

## 附：列表卡片被极端长图撑爆的修复（站点侧 CSS）

若首页卡片长度差异巨大，通常是**封面图本身比例极端**（例如 126×2560，高宽比 20:1）。
主题原本的 `aspect-ratio: auto; height: 100%` 会让封面列按图片自身比例撑高，
300px 宽的列可被撑到约 6000px。

修法（`themes/<主题>/source/css/cards.css`）：

```css
.post-list-container[data-layout="list"] .post-card-item[data-has-cover="true"] .post-card-cover {
  aspect-ratio: 16 / 9;   /* 固定比例，不再由图片决定 */
  height: auto;
  max-height: 190px;      /* 高度上限 */
  min-height: 0;
  align-self: center;     /* 不再随行高拉伸 */
}
```

纯 CSS，之后上传的任何文章都自动遵循。实测：卡片高低差从 5884px（25.0×）降到 25px（1.1×）。
