/**
 * dsh-douyin-publish · plan —— 纯逻辑：参数体检、结果渲染、失败归类。
 *
 * **两条默认值是刻意的，也是这个插件最重要的设计**：
 *   - `visibility` 默认 **private（仅自己可见）**；
 *   - `mode` 默认 **draft（只填好、不点发布）**。
 * 发布是"不可逆且对外可见"的动作 —— 默认必须保守，要发就得显式说。
 *
 * @module dsh-douyin-publish/plan
 */

import { isAbsolute } from 'node:path';

/** 投稿页。 */
export const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';

/** 上传完成后的编辑页 URL 特征。 */
export const EDIT_URL_MARK = '/content/post/video';

/** 可见性选项（中文标签是页面上实际存在的文案）。 */
export const VISIBILITY = {
  public: { label: '公开', note: '所有人可见' },
  friends: { label: '好友可见', note: '仅互相关注的人可见' },
  private: { label: '仅自己可见', note: '只有自己能看到（默认）' },
};

/** 发布模式。 */
export const MODES = ['draft', 'publish'];

/** 视频文件后缀白名单（照投稿页 accept 属性列出的格式）。 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.flv', '.avi', '.wmv', '.webm', '.ts', '.mpeg4', '.mpg', '.mkv'];

/** 默认标题框提示文本（页面上实际用的 placeholder）。 */
export const TITLE_PLACEHOLDER = '填写作品标题，为作品获得更多流量';

/**
 * 校验输入。必填项一个都不能少；**不给默认值以外的"发挥空间"**。
 * @param {object} input 参数
 * @returns {string[]} 错误列表
 */
export function validateInput(input = {}) {
  const errors = [];
  const videoPath = input.videoPath;
  if (typeof videoPath !== 'string' || videoPath.trim() === '') {
    errors.push('videoPath 必填：要发布的视频**绝对路径**');
  } else if (!isAbsolute(videoPath)) {
    errors.push(`videoPath 必须是绝对路径（不许靠当前目录猜）：${videoPath}`);
  } else {
    const lower = videoPath.toLowerCase();
    if (!VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      errors.push(`videoPath 的后缀不在投稿页接受的格式里（${VIDEO_EXTENSIONS.join(' ')}）：${videoPath}`);
    }
  }
  if (input.visibility !== undefined && !Object.hasOwn(VISIBILITY, String(input.visibility))) {
    errors.push(`visibility 只能是 ${Object.keys(VISIBILITY).join(' / ')}（默认 private）`);
  }
  if (input.mode !== undefined && !MODES.includes(String(input.mode))) {
    errors.push(`mode 只能是 ${MODES.join(' / ')}（默认 draft）`);
  }
  if (input.title !== undefined && typeof input.title !== 'string') {
    errors.push('title 必须是字符串');
  }
  if (input.topics !== undefined && typeof input.topics !== 'string') {
    errors.push('topics 必须是逗号分隔的字符串');
  }
  if (input.timeoutSec !== undefined && (!Number.isFinite(input.timeoutSec) || input.timeoutSec <= 0)) {
    errors.push('timeoutSec 必须是正数（秒）');
  }
  if (input.coverTime !== undefined && (!Number.isFinite(input.coverTime) || input.coverTime < 0)) {
    errors.push('coverTime 必须是非负数（秒；0 = 不动封面）');
  }
  return errors;
}

/** 把 `a,b` 解析成数组。 */
export function parseTopics(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * 生效参数（把默认值补齐，便于渲染与断言）。
 * @param {object} input 参数
 * @returns {object} 生效值
 */
export function effectiveOptions(input = {}) {
  return {
    visibility: String(input.visibility ?? 'private'),
    mode: String(input.mode ?? 'draft'),
    title: typeof input.title === 'string' ? input.title : '',
    topics: parseTopics(input.topics),
    /**
     * 封面取哪一帧。默认 **1 秒** —— 第 0 帧常常是黑场/淡入，做封面很难看。
     * 给 0 = 不动封面（保留页面默认）。
     */
    coverTime: Number.isFinite(input.coverTime) ? Math.max(0, Number(input.coverTime)) : 1,
    timeoutSec: Number.isFinite(input.timeoutSec) ? input.timeoutSec : 60,
  };
}

/** 小时/秒 → 人话（视频时长）。 */
export function durationText(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

/** 把失败归类成人话。 */
export function classifyFailure(result) {
  if (result === null || result === undefined) return { kind: 'no-result', hint: '没有拿到结果' };
  if (result.ok === true) return { kind: 'ok', hint: '' };
  const error = String(result.error ?? '');
  if (error.startsWith('no-browser')) {
    return { kind: 'no-browser', hint: '这台机器上没有可用的浏览器服务（需要浏览器插件），这一步做不了' };
  }
  if (error.startsWith('no-dialog')) {
    return { kind: 'no-dialog', hint: '上传按钮点了，但系统的"打开文件"对话框没出现（或没被识别）' };
  }
  if (error.startsWith('handover')) {
    return { kind: 'handover', hint: '文件没能交给对话框 —— 详见递文件那一步的现场' };
  }
  if (error.startsWith('edit-page-timeout')) {
    return { kind: 'edit-page-timeout', hint: '文件交出去了，但页面迟迟没进入编辑页（上传可能被拒：格式/时长/风控）' };
  }
  if (error.startsWith('layout-changed')) {
    return { kind: 'layout-changed', hint: '抖音投稿页版式变了：关键控件没找到 —— 需要更新选择器（插件里已经先自检，没有硬着头皮往下跑）' };
  }
  if (error.startsWith('title')) {
    return { kind: 'title', hint: '编辑页里没找到标题输入框（版式变了？）' };
  }
  if (error.startsWith('visibility')) {
    return { kind: 'visibility', hint: '可见性选项没点中' };
  }
  if (error.startsWith('publish')) {
    return { kind: 'publish', hint: '点发布后没看到成功迹象' };
  }
  return { kind: 'other', hint: error };
}

/**
 * 把一次运行渲染成给模型看的话。
 * @param {object} result 运行结果
 * @returns {string} 文本
 */
export function renderResult(result) {
  if (result === null || result === undefined) return 'douyin_upload：**没有拿到结果**。';
  const lines = [];
  const head = result.dryRun === true ? '🧪 只检查（不动手）' : '📤 抖音投稿';
  lines.push(`${head}｜${result.ok === true ? (result.published === true ? '已发布' : '已就绪（未发布）') : '未完成'}`);
  if (result.video) {
    const v = result.video;
    lines.push(`  · 视频：${v.path ?? '?'}（${v.size ?? '?'} 字节${v.width ? `，${v.width}x${v.height}` : ''}${v.durationSec ? `，${durationText(v.durationSec)}` : ''}）`);
  }
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    const mark = { ok: '✅', warn: '⚠️', error: '❌', skipped: '⏭️' };
    lines.push('  · 步骤：');
    for (const step of result.steps) {
      lines.push(`      ${mark[step.status] ?? '·'} ${step.name}：${step.detail}`);
    }
  }
  if (result.pageUrl) lines.push(`  · 页面：${result.pageUrl}`);
  if (result.title !== undefined) lines.push(`  · 标题：${result.title === '' ? '（没填）' : result.title}`);
  if (Array.isArray(result.topics) && result.topics.length > 0) {
    const filled = result.topicFill && Number.isFinite(result.topicFill.filled) ? result.topicFill.filled : 0;
    const verified = result.topicFill && Number.isFinite(result.topicFill.verified) ? result.topicFill.verified : 0;
    lines.push(`  · 话题：${result.topics.join('、')}（代填 ${filled} 个｜回读到 ${verified} 个）`);
  }
  if (Number.isFinite(result.coverTime)) {
    lines.push(`  · 封面帧：第 ${result.coverTime} 秒${result.coverSet === true ? '（已设）' : result.coverTime > 0 ? '（没设上，保留页面默认）' : '（不动封面）'}`);
  }
  const vis = result.visibility && VISIBILITY[result.visibility];
  if (vis) lines.push(`  · 可见性：${vis.label}（${vis.note}）`);
  if (result.published === true) lines.push(`  · 已点发布，回执时间：${result.finishedAt ?? '?'}`);
  if (result.ok === true && result.published !== true && result.dryRun !== true) {
    lines.push('  · **停在发布前**：视频、标题、可见性都填好了，**发布按钮没点** —— 要发就显式再说一次（mode=publish）。');
  }
  if (result.ok !== true) {
    const { kind, hint } = classifyFailure(result);
    lines.push(`  · 卡在哪：${kind}${hint ? ` —— ${hint}` : ''}`);
  }
  if (result.dryRun === true) {
    lines.push('  · 只检查模式：没开页面、没点按钮、没交文件。确认无误后再不带 dryRun 调一次。');
  }
  return lines.join('\n');
}
