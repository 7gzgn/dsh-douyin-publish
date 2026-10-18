/**
 * dsh-douyin-publish —— 宿主入口。
 *
 * 一句话：**把一段本地视频一路送到抖音投稿页的"待发布"状态** ——
 * 开投稿页、真实点上传、把文件交给系统对话框（含回读校验）、填标题、设可见性，
 * 然后**默认停手**：发布按钮不点。
 *
 * 两条默认值是刻意的：
 *   - 可见性默认 **仅自己可见**；要公开得显式说；
 *   - 模式默认 **draft**：填好就停，要真发得显式说 `mode=publish`。
 * 发布是不可逆且对外可见的动作 —— 默认必须保守。
 *
 * @module dsh-douyin-publish
 */

import { PLATFORMS, VISIBILITY, renderResult } from './plan.js';
import { uploadVideo } from './pipeline.js';

/** 插件身份。 */
export const name = 'dsh-douyin-publish';

/** 需要宿主提供的服务（browser 用 ctx.get 拿 —— 拿不到就给出明确错误，而不是让插件加载失败）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 209;
const TOOL_TIMEOUT_MS = 300000;

/** 面向模型的公告（常驻那一段）。 */
export const DOUYIN_GUIDANCE = [
  '本机已安装 **dsh-douyin-publish（视频发布器 · 抖音 / B站）**：`douyin_upload` 把一段本地视频送到投稿页 —— 打开投稿页 → 版式自检 → **把文件塞进页面自己的上传控件**（本机临时小服务 + DataTransfer，不弹系统对话框；大文件或注入被拦时才退回对话框）→ 填标题 → 代填文案/话题 → 设可见性 → **默认停在投稿前**。',
  `**两条默认值是刻意的**：可见性默认 \`private\`（${VISIBILITY.private.label}）、模式默认 \`draft\`（**不点投稿**）。要真发必须显式 `+"`mode: 'publish'`"+`，要公开必须显式 `+"`visibility: 'public'`"+`。`,
  '**平台**：`platform` 可给 `douyin`（默认）或 `bilibili` —— 这两个都在真机上核对过。B站的**话题会进"标签"**（回车确认），可见范围在「更多设置 → 可见范围」里；`coverTime` 只对抖音生效。小红书 / X 还没核对，传了会明确拒绝。',
  '**封面默认取第 1 秒**（第 0 帧常是黑场）；`coverTime: 0` 不动封面。',
  '**配乐**：`bgmPath` 给一段本地音频就会先用 ffmpeg 混好再上传（原视频不动），`bgmVolume` 默认 0.35；**文案**：`description` 填进简介。',
  '**版式自检**：投稿页/编辑页的关键控件缺一个就直接报 `layout-changed`（并点名缺什么），不会跑到一半停住。',
  '**它需要浏览器插件**（借 `ctx.browser` 服务）；没有时会给明确错误，不会假装能用。',
  `投稿页：抖音 ${PLATFORMS.douyin.uploadUrl}；B站 ${PLATFORMS.bilibili.uploadUrl}。它自己开一个浏览器会话，登录态与其它会话共享。`,
  '典型用法：`douyin_upload videoPath=<绝对路径> platform="bilibili" title=…` → 看一眼回执与页面 → 确认无误后再 `mode: "publish"` 投出去。',
  '遇到验证码/风控：它不会硬试 —— 请你到浏览器窗口里点一下，再让它继续。',
].join('\n');

/** 动态取 defineTool：宿主里有就用真的，单测/CLI 场景退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 取浏览器服务。官方的做法是 `ctx.get('browser')` —— 它不会因为"没 inject"而抛，
 * 拿不到就是 undefined，这正是我们要的降级姿势。
 * @param {object} ctx 宿主上下文
 * @returns {object|null} 服务或 null
 */
export function browserOf(ctx) {
  try {
    const browser = typeof ctx?.get === 'function' ? ctx.get('browser') : undefined;
    if (browser !== null && browser !== undefined && typeof browser.open === 'function') return browser;
  } catch {
    /* 没有浏览器插件：当作没有 */
  }
  return null;
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'douyin_upload',
      description: [
        '把本地视频送到投稿页：开页面 → **先自检版式（缺控件就当场报"改版了"）** → **把文件塞进页面自己的上传控件**（本机临时只读小服务 + DataTransfer，不弹系统对话框、不挡人；大文件或注入被拦才退回系统对话框+UI 自动化）→ 填标题 → **填文案 + 代填话题并回读** → 设可见性 → **按 coverTime 设封面帧（仅抖音，默认第 1 秒）** → **默认停在投稿前**。',
        '**平台**：`douyin`（默认）与 `bilibili` 都在真机上核对过；B站的话题进「标签」（回车确认），可见范围在「更多设置 → 可见范围」。小红书 / X 未核对，传了会明确拒绝（不假装能用）。',
        '**配乐**：默认不碰。想让**用户自己在抖音平台曲库里挑**，传 `pickMusic: true` —— 填完内容后它会把「添加音乐」面板打开然后停在发布前，由人点（不自动选、不发布，`mode=publish` 时忽略）。',
        '**本地混音（可选）**：`bgmPath` 给一段本地音频就先用 ffmpeg 混好再上传（原视频不动），`bgmVolume` 默认 0.35 —— 这是"不想用平台曲库"时的另一条路。',
        '**文案**：`description` 填进简介框，话题接在后面（B站进标签框）。',
        '**默认保守**：可见性默认 private（仅自己可见）、模式默认 draft（**不点投稿**）。要真发必须显式 mode="publish"；平台没有你要的可见性选项时会当场拒绝，不会偷偷按公开发出去。',
        '需要浏览器插件（借 ctx.browser 服务）；没有时会明确报错。',
        'dryRun=true 时只检查视频与计划，不打开页面、不点按钮、不交文件。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        videoPath: { type: 'string', description: '要发布的视频**绝对路径**（必填）' },
        title: { type: 'string', description: '作品标题（不填就留空，由你在页面上补）' },
        description: { type: 'string', description: '作品文案/简介（填进简介编辑框，话题接在后面）' },
        topics: { type: 'string', description: '话题，逗号分隔（会代填进简介编辑框，并回读确认；没读到的会如实说）' },
        bgmPath: { type: 'string', description: '可选：背景音乐文件的**绝对路径**（给了就先混音再上传，原视频不动）' },
        pickMusic: { type: 'boolean', description: '可选：true = 填完内容后打开抖音的「添加音乐」面板并停在发布前，由用户自己在平台曲库里挑（不自动选、不发布）' },
        musicSearch: { type: 'string', description: '可选：打开配乐面板后顺手在「搜索音乐」里搜这个词（不给就只把搜索框聚焦，由人自己输）' },
        bgmVolume: { type: 'number', description: '配乐音量 0~2（默认 0.35；原视频有声则与原声混合）' },
        platform: { type: 'string', description: '发布平台：douyin（默认）/ bilibili（这两个真机核对过）；xiaohongshu / x 会明确拒绝' },
        coverTime: { type: 'number', description: '封面取第几秒的画帧（默认 1 —— 第 0 帧常是黑场；0 = 不动封面；仅抖音生效）' },
        visibility: { type: 'string', description: `可见性：${Object.keys(VISIBILITY).join(' / ')}（默认 private = ${VISIBILITY.private.label}；B站只有 private→仅自己可见 / public→公开可见）` },
        mode: { type: 'string', description: 'draft（默认，停在投稿前）| publish（显式点投稿）' },
        dryRun: { type: 'boolean', description: 'true = 只检查视频与计划，不动手' },
        timeoutSec: { type: 'number', description: '等编辑页的上限秒数（默认 60）' },
        maxInjectBytes: { type: 'number', description: '注入上限字节数（默认 512MB）：超过就退回系统对话框那条路' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: renderResult(value.data ?? null, args?.platform ?? cfg.platform) }],
      },
      async execute(args) {
        const a = args ?? {};
        try {
          const data = await uploadVideo({
            videoPath: a.videoPath,
            title: a.title ?? cfg.title,
            description: a.description,
            topics: a.topics,
            bgmPath: a.bgmPath,
            bgmVolume: a.bgmVolume,
            pickMusic: a.pickMusic === true,
            musicSearch: a.musicSearch,
            platform: a.platform ?? cfg.platform,
            coverTime: a.coverTime ?? cfg.coverTime,
            visibility: a.visibility ?? cfg.visibility,
            mode: a.mode ?? cfg.mode,
            dryRun: a.dryRun === true,
            timeoutSec: a.timeoutSec ?? cfg.timeoutSec,
            maxInjectBytes: a.maxInjectBytes ?? cfg.maxInjectBytes,
          }, {
            browser: browserOf(ctx),
            ffprobe: cfg.ffprobe,
          });
          // **不能**写 `error: undefined`：宿主用 lossless-JSON 校验返回对象，
          // JSON.stringify 会悄悄丢掉 undefined，校验器不会 —— 会被判 "invalid output"。
          const out = { ok: data.ok === true, data };
          if (out.ok !== true) out.error = String(data.error ?? '未完成');
          return out;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:douyin-publish',
      order: SECTION_ORDER,
      text: DOUYIN_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-douyin-publish: teardown');
  }
}
