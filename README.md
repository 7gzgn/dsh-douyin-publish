# dsh-douyin-publish（抖音发布器）

**把一段本地视频，一路送到抖音投稿页的"待发布"状态。**

打开投稿页 → 真实点上「上传视频」→ 把文件交给系统对话框（含回读校验）→ 填标题 → 设可见性 → **默认停手**。

> 这是四个作品里唯一的"功能"（前三个都是工具）：它不止给 AI 加一个动作，
> 而是替使用者跑完一条链 —— 开页面、点按钮、交文件、填表、判断该不该发。
> 也正因为如此，它的默认值必须**保守**。

---

## 两条默认值是刻意的

| 参数 | 默认 | 要改成别的必须显式说 |
| --- | --- | --- |
| `visibility` | **`private`（仅自己可见）** | `visibility: 'public'` / `'friends'` |
| `mode` | **`draft`（不点发布）** | `mode: 'publish'` |

发布是**不可逆且对外可见**的动作。所以这个插件默认只做到"表填好、停发布前"，
你要发，就再说一次。想先看看会发生什么，用 `dryRun: true`。

## 它做什么（每一步都留证据）

| 步 | 动作 | 细节 |
| --- | --- | --- |
| ① | 检查视频 | 大小 / 分辨率 / 时长 / 编码（ffprobe，拿不到也不拦） |
| ② | 借浏览器会话 | 用自己的会话键，和别的任务不串台 |
| ③ | 打开投稿页 | `creator.douyin.com/creator-micro/content/upload` |
| ④ | 等上传控件 | 轮询到 `input[type=file]` 出现为止 |
| ④' | **版式自检（投稿页）** | 上传控件 / 「上传视频」按钮缺一个 → 立刻报 `layout-changed` 并点名，不硬着头皮跑 |
| ⑤ | **真实点击**「上传视频」 | 程序化 `click()` 不会弹系统对话框，必须真点 |
| ⑥ | **递文件** | 等对话框 → 填路径（走剪贴板）→ **回读逐字比对** → 点确认 |
| ⑦ | 等编辑页 | 轮询到 URL 含 `/content/post/video` |
| ⑦' | **版式自检（编辑页）** | 标题框 / 「发布」按钮缺一个 → 同样当场报 `layout-changed` |
| ⑧ | 填标题 | 按页面上真实的 placeholder 定位 |
| ⑧' | **代填话题** | 往简介编辑框里逐条打 `#话题`，打完**回读**：读到几条报几条，读不到就明说"请在页面上看一眼" |
| ⑨ | 设可见性 | 按页面上真实的中文标签点（公开 / 好友可见 / **仅自己可见**） |
| ⑨' | **设封面帧** | 打开「选择封面」→ 把时间轴挪到 `coverTime`（**默认第 1 秒**，第 0 帧常是黑场）→ 确定；设不上只标 warn，不阻断 |
| ⑩ | 发布，或**故意不发布** | `mode=draft` 时这一步记 `skipped` |

失败会分类说清：`no-browser` / `no-dialog` / `handover` / `edit-page-timeout` / `layout-changed` / `visibility` / `publish`。

## 它依赖什么

- **浏览器插件**（借宿主的 `ctx.browser` 服务）—— 没有时**明确报错**，不会假装能用。
  这是刻意的：官方浏览器插件的工具层也是同一条路（`inject` 里带 `browser`）。
- **系统"打开文件"对话框能力**：自带 `lib/handover.ps1`（与作者的 `dsh-file-handover` 同源，
  但四个插件各自独立成仓，不互相依赖）。
- **可选**：`ffprobe`（没有也能发，只是少了元信息）。

## 安装

市场收录后在 DSH 里搜 `dsh-douyin-publish` 安装。手动安装：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-douyin-publish" -Target "D:\dsh\projects\dsh-douyin-publish"
# profile 的 package.json：dependencies 加 "dsh-douyin-publish": "link:D:/dsh/projects/dsh-douyin-publish"
# 并把 "dsh-douyin-publish" 加进 dsh.profile.bundles（漏了不加载）→ 重启 DSH
```

**发布前先做这两件事**：① 装好浏览器插件；② 在浏览器窗口里**登录抖音创作者中心**
（登录态存在浏览器 profile 里，一次登录可跨重启复用）。

## 用法

### 工具（在 DSH 里）

```
douyin_upload videoPath=D:\videos\a.mp4 title="标题" [topics="猫,狗"] [coverTime=1] [visibility=private] [mode=draft|publish] [dryRun]
```

典型流程：`dryRun: true` 看一眼 → 正式跑一次（停发布前）→ 到浏览器里核对 → `mode: 'publish'` 真发。

### 命令（不依赖浏览器的那一半）

```powershell
dsh-douyin-publish check --video "D:\videos\a.mp4"
```

## 已知限制

- **版式绑定**：选择器基于 2026-10-16 实测的创作者中心版式；抖音改版后需要同步更新。
  v0.2 起**先自检再动手**：关键控件缺一个就当场报 `layout-changed` 并点名缺什么，不会跑到一半停住。
- **话题是"联想式"的**：代填是把 `#话题` 打字进简介框，**是否被抖音转成真标签由页面决定**；
  所以填完一定回读，读不齐就明说"请在页面上看一眼"，不假装成功。
- **封面是尽力而为**：靠封面弹窗里的时间轴（`input[type=range]`）定位到 `coverTime`；
  弹窗里没有时间轴时只标 warn、保留页面默认封面，不阻断发布。
- **验证码 / 风控不硬试**：检测到就停下请人到浏览器窗口处理，再继续。
- **仅 Windows**：递文件那一段依赖 `EnumWindows` / UI Automation / PowerShell。
- **不做内容创作**：剪片、封面、文案是内容管线的事（用 ffmpeg 等），这个插件只负责"送上去"。

## 自测

```powershell
node test/smoke.mjs   # 85 项：假浏览器 + 假 spawn：断言编排序列、默认值、失败分类、版式自检、话题/封面；不碰抖音
```

## License

MIT
