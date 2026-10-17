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

import { VISIBILITY, UPLOAD_URL, renderResult } from './plan.js';
import { uploadVideo } from './pipeline.js';

/** 插件身份。 */
export const name = 'dsh-douyin-publish';

/** 需要宿主提供的服务（browser 用 ctx.get 拿 —— 拿不到就给出明确错误，而不是让插件加载失败）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 209;
const TOOL_TIMEOUT_MS = 300000;

/** 面向模型的公告（常驻那一段）。 */
export const DOUYIN_GUIDANCE = [
  '本机已安装 **dsh-douyin-publish（抖音发布器）**：`douyin_upload` 把一段本地视频送到抖音投稿页 —— 打开投稿页 → 版式自检 → 真实点上「上传视频」→ 把文件交给系统对话框（回读校验）→ 填标题 → 代填话题 → 设可见性 → 设封面帧 → **默认停在发布前**。',
  `**两条默认值是刻意的**：可见性默认 \`private\`（${VISIBILITY.private.label}）、模式默认 \`draft\`（**不点发布**）。要真发必须显式 `+"`mode: 'publish'`"+`，要公开必须显式 `+"`visibility: 'public'`"+`。`,
  '**封面默认取第 1 秒**（第 0 帧常是黑场）；`coverTime: 0` 不动封面。话题会代填进简介并回读，读不到会明说。',
  '**配乐**：`bgmPath` 给一段本地音频就会先用 ffmpeg 混好再上传（原视频不动），`bgmVolume` 默认 0.35；**文案**：`description` 填进作品简介。',
  '**平台**：目前只有抖音真机核对过；传 `platform="bilibili"` 之类会被明确拒绝（不假装能用）。',
  '**版式自检**：投稿页/编辑页的关键控件缺一个就直接报 `layout-changed`（并点名缺什么），不会跑到一半停住。',
  '**它需要浏览器插件**（借 `ctx.browser` 服务）；没有时会给明确错误，不会假装能用。',
  `投稿页：${UPLOAD_URL}；它自己开一个浏览器会话，登录态与其它会话共享。`,
  '典型用法：`douyin_upload videoPath=<绝对路径> title=…` → 看一眼回执与页面 → 确认无误后再 `mode: "publish"` 发出去。',
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
        '把本地视频送到抖音投稿页：开页面 → **先自检版式（缺控件就当场报"改版了"）** → 真实点上「上传视频」→ 把文件交给系统对话框（含回读校验）→ 填标题 → **填文案 + 代填话题并回读** → 设可见性 → **按 coverTime 设封面帧（默认第 1 秒）** → **默认停在发布前**。',
        '**配乐**：给 `bgmPath`（本地音频绝对路径）会先用 ffmpeg 混一段新视频再上传（原视频不动）；`bgmVolume` 默认 0.35，原视频有声就与原声混合、无声就铺满。',
        '**文案**：`description` 填进作品简介框，话题接在后面。',
        '**平台**：目前只有 `platform="douyin"` 是真机核对过的；B站/小红书/X 只留了位置，传别的会明确拒绝（不假装能用）。',
        '**默认保守**：可见性默认 private（仅自己可见）、模式默认 draft（**不点发布**）。要真发必须显式 mode="publish"。',
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
        bgmVolume: { type: 'number', description: '配乐音量 0~2（默认 0.35；原视频有声则与原声混合）' },
        platform: { type: 'string', description: '发布平台（目前只有 douyin 真机核对过；bilibili / xiaohongshu / x 会被明确拒绝）' },
        coverTime: { type: 'number', description: '封面取第几秒的画帧（默认 1 —— 第 0 帧常是黑场；0 = 不动封面）' },
        visibility: { type: 'string', description: `可见性：${Object.keys(VISIBILITY).join(' / ')}（默认 private = ${VISIBILITY.private.label}）` },
        mode: { type: 'string', description: 'draft（默认，停在发布前）| publish（显式点发布）' },
        dryRun: { type: 'boolean', description: 'true = 只检查视频与计划，不动手' },
        timeoutSec: { type: 'number', description: '等编辑页的上限秒数（默认 60）' },
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
        render: (_args, value) => [{ type: 'text', text: renderResult(value.data ?? null) }],
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
            platform: a.platform ?? cfg.platform,
            coverTime: a.coverTime ?? cfg.coverTime,
            visibility: a.visibility ?? cfg.visibility,
            mode: a.mode ?? cfg.mode,
            dryRun: a.dryRun === true,
            timeoutSec: a.timeoutSec ?? cfg.timeoutSec,
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
