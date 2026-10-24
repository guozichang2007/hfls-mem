# 海弗拉斯26届回忆录 · hw 也有回忆录 😋

把原 docx《海弗拉斯26届回忆录》搬成了一面**可以自由发帖 / 评论**的静态回忆墙：
原文 8 个板块、422 楼、157 张图、3 段录音作为初始内容导入，新帖子和评论另加在上面。

- 纯静态（HTML + CSS + 原生 JS），可以直接挂在 GitHub Pages
- 默认 **本地模式**：发帖 / 评论存浏览器 localStorage，本机立刻可见
- 填一个 GitHub 仓库后切换 **共享模式**：帖子 = Issues，评论 = Issue comments，所有人可见
- **读**公共帖走 GitHub Action 烘焙的同源静态文件（`docs/data/gh-posts.json`），
  墙内打不开 `api.github.com` 也能看到大家的帖子；**写**才需要访问 GitHub
- 有 GitHub 令牌时直接调 API 写入；没有令牌时自动复制内容并打开「新建 Issue」页面，
  登录粘贴提交后，这条会先在本页显示成「同步中」，约 1 分钟后变成公共帖
- 图片：GitHub 模式下在打开的 Issue 页面里**把图片拖进正文**（GitHub 自动托管），
  同步时会把图下载、压缩并存进 `docs/assets/img/gh/`，JSON 里换成本站相对路径，
  所以墙内访客也能正常看到图

## 目录

```
docs/                       ← 部署目录（GitHub Pages 直接发布这个文件夹）
  index.html
  assets/css/style.css
  assets/js/app.js
  assets/img/…              ← 原文 157 张图 + 缩略图
  assets/img/gh/…           ← Issues 里拖进去的图（Actions 搬到本站，同源加载）
  assets/audio/…            ← 原文 2 段录音
  data/posts.json           ← 原文数据（脚本生成，勿手改）
  data/config.json          ← 站点配置（GitHub 仓库、公告等）
  data/gh-posts.json        ← Issues 烘焙出来的公共帖（Actions 生成，勿手改）
scripts/build_site_data.py  ← docx → posts.json + 图片/音频
scripts/docx_dump.py        ← docx 纯文本/图片 dump（调试用）
scripts/sync_issues.py      ← Issues → docs/data/gh-posts.json（并把图片搬进 docs/assets/img/gh）
.github/workflows/pages.yml ← 推送 main 自动部署 docs/
.github/workflows/sync-issues.yml ← 有 Issue / 评论变动或每 10 分钟同步一次公共帖
```

## 本地预览

浏览器不允许 `file://` 下 fetch JSON，需要起个本地服务：

```bash
python -m http.server 8000 --directory docs
# 打开 http://localhost:8000/
```

## 部署到 GitHub Pages

站点已按 **`guozichang2007/hfls-mem`** 配好（`docs/data/config.json` 的 `repo` / `siteUrl`、
`.git` 的 origin 都指向它）。仓库已经在 GitHub 上建好（公开、空仓库、默认分支 `main`），
只剩本机推送：

```bash
git push -u origin main     # 第一次会弹出 GitHub 登录窗口
```

然后仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**，
工作流 `.github/workflows/pages.yml` 会自动把 `docs/` 发布到
**https://guozichang2007.github.io/hfls-mem/** 。

> 如果 `git push` 报 `schannel: failed to receive handshake`，说明本机配的代理没开，
> 加 `-c http.proxy=` 绕过即可：`git -c http.proxy= push -u origin main`。

想换仓库名 / 换账号，改三处即可：

```bash
git remote set-url origin https://github.com/<账号>/<仓库名>.git
# 再把 docs/data/config.json 里的 repo、siteUrl 改成新值
```

想直接占住 `https://guozichang2007.github.io/`（不带子路径），把仓库名改成
`guozichang2007.github.io` 即可，其余不变。

> 仓库里不要提交那份 220 MB 的 docx（超过 GitHub 100 MB 单文件上限），`.gitignore` 已经排除。

## 打开「所有人一起写」

1. 用一个公开仓库（就用站点这个 `guozichang2007/hfls-mem`），发帖会变成它的 Issue。
2. `docs/data/config.json` 里的 `repo` 已经填好，不需要再改：

   ```json
   {
     "repo": "guozichang2007/hfls-mem",
     "branch": "main",
     "postsLabel": "post",
     "sectionLabelPrefix": "sec-",
     "siteUrl": "https://guozichang2007.github.io/hfls-mem/",
     "notice": "想补一句、想吐槽、想表白，直接点「写一条回忆」。"
   }
   ```

3. 在仓库 **Issues → Labels** 里建 8 个板块 label（可选）：
   `sec-prelude` / `sec-scene` / `sec-story` / `sec-food` / `sec-love` / `sec-rant`
   / `sec-teacher` / `sec-classmate`。
   （不建也能用：站点会把板块同时写进正文的隐藏标记，标签被忽略也不会丢板块；
   手工在 GitHub 建的 Issue 没有 `sec-*` 标签时落到「同学」板块。`post` 标签**不再是必需的**。）
4. 想在网页里直接发帖（而不是跳转 GitHub）：点右上角「🖐 设置 / 昵称」，填一个
   fine-grained token，权限只要 **Issues: Read and write**。令牌只存在本机 localStorage。
5. 仓库 **Settings → Actions → General → Workflow permissions** 选
   **Read and write permissions**，否则同步工作流没法把 `docs/data/gh-posts.json` 提交回去。

> 访客端连不上 GitHub 接口也不会白屏：公共帖优先读同源静态文件，读不到就显示本机缓存，
> 再不行才降级成本地模式继续浏览原文，并在侧栏给一个「🔄 重试」按钮；
> 只有自己填了令牌的人才会看到具体的失败原因。

站点也可以临时覆盖仓库：设置面板里填的仓库会写进 `localStorage`（优先级高于
`config.json`），清空输入框即恢复默认。

## 同步机制（墙内也能看到公共帖）

浏览器的 `fetch` 在国内经常连不上 `api.github.com`（`TypeError: Failed to fetch`），
所以「直接读 Issues」这条路过不去，访客会看不到别人发的帖子。解决办法是把 Issue
先转成**同源静态 JSON**：

```
你发帖 → GitHub Issue ──(Actions)──> docs/data/gh-posts.json ──(Pages CDN)──> 访客浏览器
```

- `.github/workflows/sync-issues.yml`：新建/编辑/关闭 Issue、增删改评论、手动触发、
  以及每 10 分钟兜底跑一次；有变化才提交，并在同一个工作流里重新部署 Pages
  （用 `GITHUB_TOKEN` 推的 commit 不会再触发 `pages.yml`，不自己部署的话站点读到的还是旧 JSON；
  部署任务会按**本次刚推上去的 sha** 检出，默认用触发事件的 sha 会漏掉这次提交）
- `scripts/sync_issues.py`：只用标准库（压缩图片才需要 Pillow）、分页拉全部 Issue + 评论，
  映射规则和前端 `mapIssue()` 一致；内容没变化就不写文件（提交记录不会刷屏）
- 前端读取顺序：`data/gh-posts.json` → 直连 `api.github.com`（重试 2 次，成功就顺手写
  `localStorage` 缓存）→ `localStorage` 缓存
- 同步有 30 秒 ~ 1 分钟延迟（cron 兜底 10 分钟），换来的是任何网络环境都能看到帖子

### 图片怎么进公共帖

`data:` URL（浏览器里 base64 的本地图片）进不了 Issue：GitHub 的 Markdown 渲染器会丢掉它，
URL 预填有长度上限，正文也有 65536 字符的限制。所以公共帖的图片走 GitHub 自己的图床：

```
访客在 Issues 页面把图拖进正文 → GitHub 托管（user-attachments）
  → 同步脚本下载、压到长边 1280 / 缩略图 640 → docs/assets/img/gh/<hash>.jpg
  → JSON 里 src 变成 assets/img/gh/xxx.jpg → 部署后同源加载（不依赖 githubusercontent）
```

- 只搬 GitHub 域名下的图；站外图床（第三方直链）保持远端，能不能打开看那个站
- 单张上限 5MB、单帖最多搬 9 张；`docs/assets/img/gh` 总预算 200MB，超了后续图片保留远端链接
- 搬运失败只记一条 warning 并保留远端地址，不会让整次同步失败
- 相关参数：`--no-images`（只同步文字）、`--max-image-bytes`、`--repo-limit-bytes`、
  `--gc-images`（删掉 JSON 已不再引用的图片文件）

本地手动同步（匿名也能跑，限流 60 次/时；有 `GITHUB_TOKEN` 则是 5000 次/时）：

```bash
python scripts/sync_issues.py --repo guozichang2007/hfls-mem
python scripts/sync_issues.py --repo guozichang2007/hfls-mem --check   # 只比对不写盘
```

### 评论与楼中楼

GitHub 的 Issue 评论本身是**平铺**的（不像论坛有嵌套层级），站内用隐藏标记把它还原成楼中楼：

```
点「回复」→ 正文带一句 `> @某人：原文摘要`
          + 隐藏标记 <!-- hfls:{"name":"…","reply":"ghc-6381398557"} -->
  → 同步脚本把 reply 读成 replyTo → 前端按 replyTo 缩进挂在父评论下面
```

- 详情页每条评论右下角有「回复」，点完输入框上方会出现「正在回复 @某人」，可取消；
  最多缩进两级，再深的回复并到第二级（窄屏不会挤成一条）
- 在 GitHub 网页上直接用「Quote reply」也一样能显示：`>` 开头的行会渲染成引用块
- 父评论被删 / 标记里的 id 找不到时，按普通评论显示，不会丢内容
- 详情页评论右上角有「🔄 刷新」；进入详情页也会自动拉一次（60 秒内不重复请求），
  墙内拿不到就继续用烘焙 JSON 里的评论
- 评论正文（含 `>` 引用）里只会出现纯文本，不会被当成脚本执行


## 数据与备份

- 本机帖子 / 评论 / 点赞 / 昵称都存在 `localStorage`（键名以 `hfls.` 开头）；
  `hfls.pending.v1` 存「已提交 GitHub、等同步」的帖子，`hfls.ghcache.v1` 是公共帖缓存
- 「我的发帖」页可以**导出 / 导入备份**（JSON），或一键清空本地数据
- 图片在浏览器里压缩到长边 1280px、JPEG 0.72 后保存，单条最多 3 张（**只存本机**）；
  想发到公共墙的图请在 GitHub 页面里拖进正文，同步时会被搬到 `docs/assets/img/gh/`
- 仓库体积：`docs/assets/img/gh` 默认预算 200MB，超过后新图保留 GitHub 远端链接；
  删掉的帖子留下的孤儿图片用 `python scripts/sync_issues.py --gc-images` 清理

## 重新生成原文数据

需要 `python-docx` 之外的依赖 `Pillow`，docx 本体放在仓库根目录：

```bash
python -m pip install pillow
python scripts/build_site_data.py
```

脚本会重写 `docs/data/posts.json`、`docs/assets/img/`、`docs/assets/audio/`。
`docs/data/config.json` 不会被覆盖。
