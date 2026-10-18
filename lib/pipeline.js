/**
 * dsh-douyin-publish · pipeline —— 编排：开投稿页 → 把文件交给页面 → 等编辑页 → 填表 → 停在发布前。
 *
 * 平台差异全部走 `platforms.js` 的档案，这里只负责"顺序、校验、失败归类"。
 *
 * 依赖全部**注入**（`browser` / `spawnImpl` / `sleepMs` / `now`），所以整条链路能在沙箱里用
 * 假的浏览器跑测试，不用真开页面。
 *
 * 两条默认值是设计核心：
 *   - `visibility` 默认 **private**（仅自己可见）；
 *   - `mode` 默认 **draft** —— 表填好就停手，**发布必须显式说**。
 *
 * @module dsh-douyin-publish/pipeline
 */

import { PLATFORMS, platformOf } from './platforms.js';
import { VISIBILITY, effectiveOptions, validateInput } from './plan.js';
import { inspectVideo } from './video.js';
import { mixBgm } from './bgm.js';
import { startFileServer, mimeOf } from './serve.js';
import { DEFAULT_MAX_INJECT_BYTES, attachViaDialog, injectFile } from './attach.js';

/** 借浏览器服务的会话键（每个插件用自己的）。 */
export const BROWSER_KEY = 'dsh-douyin-publish';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等页面上的某个条件成立（轮询执行一小段脚本）。
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {string} expression 返回布尔值的 JS 表达式
 * @param {number} timeoutMs 上限
 * @param {string} [label] 标签（写进步骤）
 * @returns {Promise<{ok:boolean, waitedMs:number, lastValue:any}>} 结果
 */
async function waitFor(browser, deps, expression, timeoutMs, label = '') {
  const started = Date.now();
  const stepMs = Number.isFinite(deps.pollMs) ? deps.pollMs : 800;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await browser.execute(deps.session, { script: `return (${expression})` }, deps.signal);
      last = res?.value ?? null;
      if (res?.ok === true && res.value === true) {
        return { ok: true, waitedMs: Date.now() - started, lastValue: last };
      }
    } catch {
      /* 页面还没就绪：继续等 */
    }
    await sleep(stepMs);
  }
  return { ok: false, waitedMs: Date.now() - started, lastValue: last, label };
}

/**
 * 读当前页面 URL。
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @returns {Promise<string|null>} URL
 */
async function readUrl(browser, deps) {
  try {
    const res = await browser.execute(deps.session, { script: 'return location.href' }, deps.signal);
    return typeof res?.value === 'string' ? res.value : null;
  } catch {
    return null;
  }
}

/**
 * 版式自检：这个平台的投稿页 / 编辑页关键控件还在不在。
 *
 * 改版是常态，选择器一失效就会"跑到一半停住"。所以先**点名**：
 * 少哪个就报哪个，然后直接给 `layout-changed` —— 至少知道该更新什么。
 *
 * 探不到（页面还没渲染完 / 服务拒绝执行）时返回 `known:false`：
 * **不能把"没探到"当成"没有"**，否则一次抖动就误报改版。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @param {'upload'|'edit'} stage 阶段
 * @returns {Promise<{known:boolean, missing:string[], raw:object|null}>} 结果
 */
async function probeControls(browser, deps, platform, stage) {
  const script = `return (()=>{
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : '');
    const hasText = (want) => Array.from(document.querySelectorAll('button,div,span,a')).some((el) => txt(el) === want);
    const sel = ${JSON.stringify(platform.selectors ?? {})};
    const hit = (s) => (typeof s === 'string' && s !== '' ? !!document.querySelector(s) : true);
    const checks = {
      fileInput: !!document.querySelector('input[type=file]'),
      uploadText: hasText('上传视频') || hasText('点击上传或将视频拖拽到此区域'),
      titleInput: hit(sel.title),
      publishButton: typeof sel.submitText === 'string' ? hasText(sel.submitText) : true,
      captionEditor: hit(sel.caption),
      tagInput: hit(sel.tagInput),
      coverEntry: typeof sel.coverEntry === 'string' ? hasText(sel.coverEntry) : true
    };
    return Object.assign({ __dsh_publish_controls: true, stage: ${JSON.stringify(stage)}, platform: ${JSON.stringify(platform.key)} }, checks);
  })()`;
  let raw = null;
  try {
    const res = await browser.execute(deps.session, { script }, deps.signal);
    raw = res?.value ?? null;
  } catch {
    return { known: false, missing: [], raw: null };
  }
  if (raw === null || typeof raw !== 'object' || raw.__dsh_publish_controls !== true) {
    return { known: false, missing: [], raw };
  }
  const missing = [];
  if (stage === 'upload') {
    if (raw.fileInput !== true) missing.push('上传控件（input[type=file]）');
    if (raw.uploadText !== true) missing.push('「上传视频」区域');
  } else {
    if (raw.titleInput !== true) missing.push('标题输入框');
    if (raw.publishButton !== true) missing.push('投稿按钮');
  }
  return { known: true, missing, raw };
}

/**
 * 填标题：先整段写入（清掉页面预填的文件名），再回读确认。
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @param {string} title 标题
 * @returns {Promise<{ok:boolean, readback:string, cleared:boolean}>} 结果
 */
async function fillTitle(browser, deps, platform, title) {
  const selector = platform.selectors.title;
  const target = { by: 'css', value: selector };
  let cleared = false;

  /** 读一次标题框当前的值。 */
  const readTitle = async () => {
    try {
      const res = await browser.execute(deps.session, {
        script: `return (()=>{ const el = document.querySelector(${JSON.stringify(selector)}); return el ? String(el.value || '') : ''; })()`,
      }, deps.signal);
      return typeof res?.value === 'string' ? res.value : '';
    } catch {
      return '';
    }
  };

  // 第一选择：整段写入（B站那种预填文件名的场景最合适）
  try {
    if (typeof browser.setValue === 'function') {
      await browser.setValue(deps.session, { target, value: title }, deps.signal);
      cleared = true;
    }
  } catch {
    /* 掉到下面的"先清空再打字" */
  }
  let readback = await readTitle();
  if (readback === title) return { ok: true, readback, cleared, method: 'setValue' };

  // 第二选择：先清空、再聚焦打字 —— 抖音的输入框是受控组件，直接写 value 有时不触发更新
  try {
    if (typeof browser.clearField === 'function') {
      await browser.clearField(deps.session, { target }, deps.signal);
    }
    await browser.type(deps.session, { text: title, target }, deps.signal);
    cleared = true;
  } catch {
    /* 打字也失败：把读到的 readback 如实返回 */
  }
  readback = await readTitle();
  return { ok: readback === title, readback, cleared, method: 'clear+type' };
}

/**
 * 填文案与话题。
 *
 * 两种落地方式（见平台档案的 `topicMode`）：
 *   - `inline`（抖音）：文案与 `#话题 ` 都写进简介的可编辑区；
 *   - `tags`（B站）：文案写进简介（Quill），话题逐个进"标签"输入框并按回车。
 *
 * 填完都**回读**：能读到几条就报几条，读不到就说清楚，不假装成功。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @param {{description?:string, topics:string[]}} options 文案与话题
 * @returns {Promise<{ok:boolean, filled:number, verified:number, descriptionFilled:boolean, detail:string}>} 结果
 */
async function fillCaptionAndTopics(browser, deps, platform, options) {
  const topics = Array.isArray(options?.topics) ? options.topics : [];
  const description = typeof options?.description === 'string' ? options.description.trim() : '';
  if (topics.length === 0 && description === '') {
    return { ok: true, filled: 0, verified: 0, descriptionFilled: false, detail: '没给文案也没给话题' };
  }
  const captionSelector = platform.selectors.caption;
  const captions = [];
  if (typeof captionSelector === 'string' && captionSelector !== '') captions.push(captionSelector);

  let descriptionFilled = false;
  if (description !== '') {
    let focus = null;
    for (const selector of captions) {
      try {
        const res = await browser.execute(deps.session, {
          script: `return (()=>{ const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {found:false}; el.focus(); return {found:true}; })()`,
        }, deps.signal);
        if (res?.value?.found === true) { focus = selector; break; }
      } catch {
        /* 换下一个候选 */
      }
    }
    if (focus === null) {
      return { ok: false, filled: 0, verified: 0, descriptionFilled: false, detail: '没找到简介编辑框（contenteditable / ql-editor）' };
    }
    try {
      await browser.type(deps.session, { text: `${description}\n`, target: { by: 'css', value: focus } }, deps.signal);
      descriptionFilled = true;
    } catch {
      descriptionFilled = false;
    }
    await sleep(200);
  }

  let filled = 0;
  let tagLimited = false;
  if (platform.topicMode === 'tags' && typeof platform.selectors.tagInput === 'string') {
    const tagTarget = { by: 'css', value: platform.selectors.tagInput };
    for (const topic of topics) {
      const text = String(topic).replace(/^#/, '');
      if (text.length > 20) { tagLimited = true; }
      try {
        // 实测（2026-10-17 真机）：B站的标签框只认"先聚焦再打字 + 回车"。
        // 直接写 value 不会聚焦，随后的回车就落到了页面上 —— 所以这里必须是 type。
        if (typeof browser.clearField === 'function') {
          try {
            await browser.clearField(deps.session, { target: tagTarget }, deps.signal);
          } catch {
            /* 清不掉就打字覆盖，回车后页面上会看出多出来的字符 */
          }
        }
        await browser.type(deps.session, { text, target: tagTarget }, deps.signal);
        filled += 1;
      } catch {
        /* 单条失败不拖垮整条链路 */
      }
      await sleep(150);
      try {
        if (typeof browser.key === 'function') {
          await browser.key(deps.session, { key: 'Enter' }, deps.signal);
        }
      } catch {
        /* 回车没按上也照样往下走，回读会说 */
      }
      await sleep(300);
    }
  } else {
    for (const topic of topics) {
      const text = String(topic).startsWith('#') ? String(topic) : `#${topic}`;
      try {
        await browser.type(deps.session, { text: `${text} `, target: { by: 'css', value: captionSelector } }, deps.signal);
        filled += 1;
      } catch {
        /* 单条失败不拖垮整条链路 */
      }
      await sleep(250);
    }
  }

  let verified = 0;
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{ const el = document.querySelector(${JSON.stringify(platform.selectors.caption)}); return String((el && el.textContent) || ''); })()`,
    }, deps.signal);
    const body = typeof res?.value === 'string' ? res.value : '';
    verified = topics.filter((t) => body.includes(String(t).replace(/^#/, ''))).length;
  } catch {
    verified = 0;
  }

  const parts = [];
  if (description !== '') parts.push(descriptionFilled ? '文案已填' : '文案没填进去');
  if (topics.length > 0) {
    if (platform.topicMode === 'tags') {
      parts.push(`已代填 ${filled} 个标签（回车确认）`);
      if (tagLimited) parts.push('有话题超过 20 字，B站的标签会截断');
    } else if (verified >= filled) {
      parts.push(`已代填 ${filled} 个话题`);
    } else {
      parts.push(`已代填 ${filled} 个、回读到 ${verified} 个 —— 没读到的可能还没成标签，请在页面上看一眼`);
    }
  }
  // B站的话题落在标签框里，简介里读不到，所以 tags 模式下不拿简介回读去判成败
  const aligned = platform.topicMode === 'tags' ? true : verified >= filled;
  return {
    ok: filled > 0 || descriptionFilled,
    filled,
    verified,
    descriptionFilled,
    aligned,
    detail: parts.join('｜'),
  };
}

/**
 * 设可见性（各平台的控件形态不同）。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @param {string} visibility 可见性键
 * @returns {Promise<{ok:boolean, unsupported?:boolean, detail:string}>} 结果
 */
async function setVisibility(browser, deps, platform, visibility) {
  const label = platform.visibility?.[visibility] ?? '';
  if (label === '') {
    return { ok: false, unsupported: true, detail: `${platform.label} 没有「${visibility}」这个可见性选项` };
  }
  if (platform.key === 'bilibili') {
    // 可见范围在「更多设置」折叠面板里：先展开，再点，再回读选中态。
    try {
      await browser.execute(deps.session, {
        script: `return (()=>{
          const span = Array.from(document.querySelectorAll('span.label')).find((el) => (el.textContent || '').trim().indexOf('更多设置') === 0);
          if (!span) return { found: false };
          span.click();
          return { found: true, expanded: document.body.innerText.indexOf('可见范围') >= 0 };
        })()`,
      }, deps.signal);
    } catch {
      /* 展开失败：下面点的时候会暴露 */
    }
    await sleep(400);
    try {
      await browser.execute(deps.session, {
        script: `return (()=>{
          const want = ${JSON.stringify(label)};
          const span = Array.from(document.querySelectorAll('span.check-radio-v2-name')).find((el) => (el.textContent || '').trim() === want);
          if (!span) return { found: false, checked: false };
          span.click();
          const box = span.parentElement ? span.parentElement.querySelector('.check-radio-v2-box') : null;
          return { found: true, checked: !!(box && box.className.indexOf('checked') >= 0) };
        })()`,
      }, deps.signal);
    } catch (err) {
      return { ok: false, detail: `点「${label}」时出错：${err instanceof Error ? err.message : String(err)}` };
    }
    await sleep(300);
    try {
      const res = await browser.execute(deps.session, {
        script: `return (()=>{
          const want = ${JSON.stringify(label)};
          const span = Array.from(document.querySelectorAll('span.check-radio-v2-name')).find((el) => (el.textContent || '').trim() === want);
          const box = span && span.parentElement ? span.parentElement.querySelector('.check-radio-v2-box') : null;
          return { checked: !!(box && box.className.indexOf('checked') >= 0) };
        })()`,
      }, deps.signal);
      const checked = res?.value?.checked === true;
      return { ok: checked, detail: checked ? `已选「${label}」` : `没选中「${label}」` };
    } catch {
      return { ok: false, detail: `点过「${label}」但回读不到选中态` };
    }
  }

  // 抖音：三个 checkbox，按它旁边那段中文文案找
  const script = `return (()=>{
    const want = ${JSON.stringify(label)};
    const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
    for (const box of boxes) {
      const text = (box.closest('label')?.textContent || box.parentElement?.parentElement?.textContent || '');
      if (text.indexOf(want) >= 0) {
        if (!box.checked) { box.click(); }
        return { found: true, checked: box.checked };
      }
    }
    return { found: false, checked: false };
  })()`;
  try {
    const res = await browser.execute(deps.session, { script }, deps.signal);
    const value = res?.value ?? null;
    const ok = res?.ok === true && value?.found === true && value?.checked === true;
    return { ok, detail: ok ? `已选「${label}」` : `没点中「${label}」` };
  } catch (err) {
    return { ok: false, detail: `点可见性时出错：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 把封面停在指定秒（默认第 1 秒 —— 第 0 帧常常是黑场）。只有声明支持的平台才做。
 *
 * 这是**尽力而为**：封面弹窗里如果没有时间轴（改版/换了实现），
 * 就如实回报"没设上、保留默认"，绝不假装设好了。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @param {number} seconds 秒
 * @returns {Promise<{ok:boolean, applied:boolean, detail:string}>} 结果
 */
async function setCoverFrame(browser, deps, platform, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: true, applied: false, detail: 'coverTime=0：不动封面' };
  }
  if (platform.supports?.cover !== true) {
    return { ok: true, applied: false, detail: `${platform.label} 的封面帧还没核对过选择器：不动封面` };
  }
  try {
    await browser.click(deps.session, { target: { by: 'text', value: platform.selectors.coverEntry } }, deps.signal);
  } catch {
    return { ok: false, applied: false, detail: `页面上没找到「${platform.selectors.coverEntry}」入口` };
  }
  await sleep(700);
  let applied = false;
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{
        const range = document.querySelector('input[type=range]');
        if (!range) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(range, String(${Number(seconds)}));
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: range.value };
      })()`,
    }, deps.signal);
    applied = res?.value?.found === true;
  } catch {
    applied = false;
  }
  if (applied) {
    try {
      await browser.click(deps.session, { target: { by: 'text', value: '确定' } }, deps.signal);
    } catch {
      /* 没点到确定：弹窗还开着，下面照实回报 */
    }
  }
  return {
    ok: applied,
    applied,
    detail: applied ? `封面停在 ${seconds} 秒` : '封面弹窗里没有时间轴 —— 保留页面默认封面',
  };
}

/**
 * 关掉"本地还有 N 个没提交的稿，继续编辑 / 不用了"的提示。
 *
 * 自动化发布**不该接管别人的旧草稿**：点「不用了」，从新稿开始（旧稿原样留着）。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {object} platform 平台档案
 * @returns {Promise<{found:boolean, clicked:boolean, detail:string}>} 结果
 */
async function dismissResumePrompt(browser, deps, platform) {
  const cfg = platform.resumePrompt;
  if (!cfg || typeof cfg.selector !== 'string') return { found: false, clicked: false, detail: '' };
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{
        const tip = document.querySelector(${JSON.stringify(cfg.selector)});
        if (!tip) return { found: false };
        const want = ${JSON.stringify(cfg.dismissText)};
        const btn = Array.from(tip.querySelectorAll('*')).find((el) => (el.textContent || '').trim() === want && el.children.length === 0);
        if (!btn) return { found: true, clicked: false };
        btn.click();
        return { found: true, clicked: true };
      })()`,
    }, deps.signal);
    const value = res?.value ?? null;
    if (value?.found !== true) return { found: false, clicked: false, detail: '' };
    return value.clicked === true
      ? { found: true, clicked: true, detail: '看到上次没提交的稿：选了「不用了」，从新稿开始（没动旧稿）' }
      : { found: true, clicked: false, detail: '看到"未提交的视频"提示，但没找到「不用了」按钮' };
  } catch {
    return { found: false, clicked: false, detail: '' };
  }
}

/**
 * 走一条完整链路。
 * @param {object} input 参数（见 README）
 * @param {object} deps 依赖 `{ browser, spawnImpl, statImpl, ffprobe, signal, pollMs }`
 * @returns {Promise<object>} 结果
 */
export async function uploadVideo(input = {}, deps = {}) {
  const steps = [];
  const options = effectiveOptions(input);
  const platform = platformOf(options.platform);
  const push = (name, status, detail, extra = {}) => steps.push({ name, status, detail, ...extra });

  const errors = validateInput(input);
  if (errors.length > 0) return { ok: false, error: errors[0], errors, steps };

  // 平台：只做**真机核对过**的；其余的明确拒绝（不假装能用）
  if (platform.verified !== true) {
    push('平台', 'error', `${platform.label} 尚未真机核对`);
    return {
      ok: false,
      steps,
      error: `platform-unsupported: ${platform.label} 的投稿页还没真机核对过选择器，不敢硬发。现在可用：${Object.values(PLATFORMS).filter((p) => p.verified).map((p) => p.label).join('、')}。`,
    };
  }
  // 可见性：平台没有这个选项时**当场拒绝**，绝不"默认当你没说过"（更不能偷偷按公开发出去）
  if (platform.supports?.visibility !== true || platform.visibility?.[options.visibility] === undefined) {
    const wanted = VISIBILITY[options.visibility]?.label ?? options.visibility;
    const available = Object.keys(platform.visibility ?? {});
    return {
      ok: false,
      steps,
      error: `visibility-unsupported: ${platform.label} 的投稿页没有「${wanted}」这个选项（它只有 ${available.length > 0 ? available.join(' / ') : '无'}）；要发到 ${platform.label} 请显式给一个它有的可见性。`,
    };
  }

  // ① 先看清手里的是什么视频
  const video = await inspectVideo(input.videoPath, deps);
  if (video.ok !== true) {
    push('检查视频', 'error', video.error ?? '读不到');
    return { ok: false, video, error: `video: ${video.error ?? '读不到'}`, steps };
  }
  const shape = [
    `${video.size} 字节`,
    video.width && video.height ? `${video.width}x${video.height}` : null,
    Number.isFinite(video.durationSec) ? `${video.durationSec.toFixed(1)} 秒` : null,
    video.codec ?? null,
  ].filter(Boolean).join('，');
  push('检查视频', 'ok', shape);

  const maxInjectBytes = Number.isFinite(options.maxInjectBytes) ? options.maxInjectBytes : DEFAULT_MAX_INJECT_BYTES;

  let bgmSource = options.bgmPath;

  if (input.dryRun === true) {
    push('开页面/交文件', 'skipped', '只检查模式：都没做');
    return {
      ok: true,
      dryRun: true,
      video,
      steps,
      platform: platform.key,
      title: options.title,
      visibility: options.visibility,
      mode: options.mode,
      plan: {
        platform: platform.label,
        url: platform.uploadUrl,
        visibility: platform.visibility?.[options.visibility] ?? VISIBILITY[options.visibility]?.label,
        willPublish: options.mode === 'publish',
        topics: options.topics,
        description: options.description,
        bgm: bgmSource === null ? null : { path: bgmSource, volume: options.bgmVolume },
        coverTime: options.coverTime,
        attach: video.size > maxInjectBytes ? 'dialog（文件超过注入上限）' : 'inject（本机小服务 + DataTransfer）',
      },
    };
  }

  // ①' 配乐：给了 BGM 就先混一段新视频（不动原文件），后面上传的是混好的那份
  let uploadPath = video.path;
  let bgm = null;
  if (bgmSource !== null) {
    bgm = await mixBgm({
      videoPath: video.path,
      bgmPath: bgmSource,
      volume: options.bgmVolume,
      ffmpeg: deps.ffmpeg,
      ffprobe: deps.ffprobe,
      spawnImpl: deps.spawnImpl,
      tmpDir: deps.tmpDir,
    });
    if (bgm.ok !== true) {
      push('配乐', 'error', bgm.error ?? '混音失败');
      return { ok: false, video, steps, error: `bgm: ${bgm.error ?? '混音失败'}`, bgm };
    }
    uploadPath = bgm.outputPath;
    push('配乐', 'ok', `${bgmSource}（音量 ${options.bgmVolume}${bgm.videoHadAudio ? '，与原声混合' : '，原视频无声' }）`);
  }

  const browser = deps.browser;
  if (browser === null || browser === undefined || typeof browser.open !== 'function') {
    push('浏览器', 'error', '这台机器没有可用的浏览器服务');
    return { ok: false, video, steps, error: 'no-browser: 没有可用的浏览器服务（需要浏览器插件）' };
  }

  // ② 借一个浏览器会话（每个插件用自己的键，不会和别的任务串台）
  let session;
  try {
    session = await browser.open(BROWSER_KEY);
  } catch (err) {
    push('浏览器', 'error', err instanceof Error ? err.message : String(err));
    return { ok: false, video, steps, error: `no-browser: ${err instanceof Error ? err.message : String(err)}` };
  }
  const localDeps = { ...deps, session };

  let server = null;
  try {
    // ③ 打开投稿页
    await browser.openUrl(session, { url: platform.uploadUrl }, deps.signal);
    push('打开投稿页', 'ok', `${platform.label}：${platform.uploadUrl}`);

    // ④ 等上传控件出现
    const ready = await waitFor(browser, localDeps, "!!document.querySelector('input[type=file]')", 30000);
    if (!ready.ok) {
      push('等页面就绪', 'error', `等了 ${Math.round(ready.waitedMs / 1000)} 秒，上传控件没出现`);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: 'upload-page-timeout: 投稿页没就绪（上传控件没出现）' };
    }
    push('等页面就绪', 'ok', `上传控件已出现（等了 ${Math.round(ready.waitedMs / 1000)} 秒）`);

    // ④'' 还有个"上次没提交的稿"提示时，选「不用了」——不接管别人的旧草稿
    const prompt = await dismissResumePrompt(browser, localDeps, platform);
    if (prompt.found) push('上次未提交的稿', prompt.clicked ? 'warn' : 'warn', prompt.detail);

    // ④''' 等上传区真的长出来（B站的上传按钮比 file input 晚渲染：实测要等一会儿）
    const areaText = platform.attach?.dialogText ?? '上传视频';
    const areaExpr = `Array.from(document.querySelectorAll('button,div,span,a')).some((el) => (el.textContent || '').trim() === ${JSON.stringify(areaText)})`;
    const areaTimeoutMs = Number.isFinite(deps.areaTimeoutMs) ? deps.areaTimeoutMs : 15000;
    const area = await waitFor(browser, localDeps, areaExpr, areaTimeoutMs);
    if (!area.ok) {
      // 编辑表单先出现 = 页面把旧稿恢复成了编辑态，不是"改版"
      const resumed = await waitFor(browser, localDeps, platform.editReady, 1200);
      const pageUrl = await readUrl(browser, localDeps);
      if (resumed.ok) {
        push('等上传区', 'error', '页面直接进了编辑态（旧稿被恢复）');
        return {
          ok: false,
          platform: platform.key,
          video,
          steps,
          pageUrl,
          error: 'resumed-draft: 页面把上次没提交的稿直接恢复成了编辑态 —— 这次没有动它。请在浏览器里把它处理掉（存草稿或删掉）再重跑。',
        };
      }
      push('等上传区', 'error', `等了 15 秒「${areaText}」没出现`);
      return {
        ok: false,
        platform: platform.key,
        video,
        steps,
        pageUrl,
        error: `layout-changed: ${platform.label} 投稿页版式变了（「${areaText}」区域没出现）—— 需要更新选择器`,
      };
    }

    // ④' 版式自检（投稿页）：关键控件缺了就**现在**说，别跑到一半停住
    const upCheck = await probeControls(browser, localDeps, platform, 'upload');
    if (upCheck.known && upCheck.missing.length > 0) {
      push('版式自检', 'error', `缺：${upCheck.missing.join('、')}`);
      return {
        ok: false,
        platform: platform.key,
        video,
        steps,
        pageUrl: await readUrl(browser, localDeps),
        error: `layout-changed: ${platform.label} 投稿页版式变了（缺 ${upCheck.missing.join('、')}）—— 需要更新选择器`,
      };
    }
    push('版式自检', 'ok', upCheck.known ? '上传控件与「上传视频」区域都在' : '探不到（当作未知，继续）');

    // ⑤ 交文件：优先"注入"（不弹系统对话框、不挡人），大文件或注入失败再退回对话框
    let attachMode = 'inject';
    let inject = { ok: false, reason: 'skipped' };
    /** 交完文件后**页面有没有真的往前走**（出现编辑表单）。 */
    let advanced = false;
    const probeMs = Number.isFinite(deps.injectProbeMs) ? deps.injectProbeMs : 20000;
    if (video.size > maxInjectBytes) {
      push('选交文件方式', 'warn', `文件 ${video.size} 字节超过注入上限 ${maxInjectBytes}，改走系统对话框`);
    } else {
      try {
        server = await startFileServer({ filePath: uploadPath });
      } catch (err) {
        inject = { ok: false, reason: 'server-failed', error: err instanceof Error ? err.message : String(err) };
      }
      if (server !== null) {
        // 页面上可能有不止一个 input（B站藏着的是真上传口、看得见的反而没用）：
        // 逐个试，**只要页面往前走了就停**；每个候选给一段有限的等待。
        const candidates = Number.isFinite(deps.injectCandidates) ? deps.injectCandidates : 3;
        for (let index = 0; index < candidates; index += 1) {
          const attempt = await injectFile(browser, {
            session,
            url: server.url,
            fileName: fileNameOf(uploadPath),
            mime: mimeOf(uploadPath),
            inputSelector: platform.attach.inputSelector,
            candidateIndex: index,
            signal: deps.signal,
          });
          inject = attempt;
          if (attempt.ok !== true) break;
          push('交文件', 'ok', `注入方式：页面取回 ${attempt.bytes} 字节，塞进第 ${index + 1} 个上传控件（不弹系统对话框）`);
          const moved = await waitFor(browser, localDeps, platform.editReady, probeMs);
          if (moved.ok) { advanced = true; break; }
          if (index + 1 >= (attempt.candidates || 1)) {
            push('交文件', 'warn', `第 ${index + 1} 个上传控件塞进去后页面没往前走（共 ${attempt.candidates} 个候选）`);
            break;
          }
          push('换上传控件', 'warn', `第 ${index + 1} 个控件没反应，换下一个试`);
        }
        if (inject.ok !== true) {
          push('交文件', 'warn', `注入没成（${inject.reason ?? inject.error ?? '未知'}）`);
          attachMode = 'dialog';
        }
      } else {
        push('交文件', 'warn', `注入没成（${inject.reason ?? inject.error ?? '未知'}）`);
        attachMode = 'dialog';
      }
    }
    if (attachMode === 'inject' && inject.ok !== true) {
      attachMode = 'dialog';
      push('交文件', 'warn', '改用系统对话框');
    }
    if (attachMode === 'dialog') {
      const dialog = await attachViaDialog(browser, deps, {
        session,
        filePath: uploadPath,
        dialogText: platform.attach.dialogText,
        timeoutSec: Math.min(options.timeoutSec, 30),
        signal: deps.signal,
      });
      if (dialog.ok !== true) {
        push('交文件（对话框）', 'error', dialog.error ?? '失败');
        return { ok: false, video, steps, error: `handover: ${dialog.error ?? '失败'}`, handover: dialog.result };
      }
      push('交文件（对话框）', 'ok', `${dialog.result.fillMethod ?? '?'}，回读一致`);
    }

    // ⑥ 等编辑页就绪（B站不换 URL，所以用"编辑控件出现"判，URL 只当旁证）
    const editExpr = platform.editReady;
    const edit = advanced ? { ok: true, waitedMs: 0 } : await waitFor(browser, localDeps, editExpr, options.timeoutSec * 1000);
    if (!edit.ok) {
      push('等编辑页', 'error', `等了 ${Math.round(edit.waitedMs / 1000)} 秒编辑表单没出来`);
      return {
        ok: false,
        video,
        steps,
        pageUrl: await readUrl(browser, localDeps),
        error: 'edit-page-timeout: 文件交出去了，但页面没进入编辑状态（上传可能被拒：格式/时长/风控）',
      };
    }
    push('等编辑页', 'ok', `编辑表单已出现（等了 ${Math.round(edit.waitedMs / 1000)} 秒）`);

    // ⑥' 版式自检（编辑页）：标题框、投稿按钮还在不在
    const edCheck = await probeControls(browser, localDeps, platform, 'edit');
    if (edCheck.known && edCheck.missing.length > 0) {
      push('版式自检', 'error', `缺：${edCheck.missing.join('、')}`);
      return {
        ok: false,
        video,
        steps,
        pageUrl: await readUrl(browser, localDeps),
        error: `layout-changed: ${platform.label} 编辑页版式变了（缺 ${edCheck.missing.join('、')}）—— 需要更新选择器`,
      };
    }

    // ⑦ 填标题（B站会预填文件名，所以要整段覆盖再回读）
    let titleFill = null;
    if (options.title !== '') {
      titleFill = await fillTitle(browser, localDeps, platform, options.title);
      push('填标题', titleFill.ok ? 'ok' : 'warn', titleFill.ok
        ? options.title
        : `写进去了但回读是「${titleFill.readback}」`);
    } else {
      push('填标题', 'skipped', '没给标题');
    }

    // ⑦' 文案 + 话题（代填 + 回读）
    const topicFill = await fillCaptionAndTopics(browser, localDeps, platform, {
      description: options.description,
      topics: options.topics,
    });
    if (options.topics.length === 0 && options.description === '') {
      push('填文案/话题', 'skipped', '没给文案也没给话题');
    } else if (topicFill.ok) {
      const aligned = topicFill.aligned === true && (options.description === '' || topicFill.descriptionFilled);
      push('填文案/话题', aligned ? 'ok' : 'warn', topicFill.detail);
    } else {
      push('填文案/话题', 'warn', topicFill.detail);
    }

    // ⑧ 设可见性（默认仅自己可见）
    const vis = await setVisibility(browser, localDeps, platform, options.visibility);
    if (vis.ok !== true) {
      push('设可见性', 'error', vis.detail);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: `visibility: ${vis.detail}` };
    }
    push('设可见性', 'ok', vis.detail);

    // ⑧' 封面（默认第 1 秒；尽力而为，设不上如实说）
    const cover = await setCoverFrame(browser, localDeps, platform, options.coverTime);
    if (options.coverTime > 0) {
      push('设封面', cover.applied ? 'ok' : 'warn', cover.detail);
    } else {
      push('设封面', 'skipped', cover.detail);
    }

    // ⑧'' 配乐：打开平台的曲库面板，让**用户自己**在里面挑（不自动选、不发布）
    let musicPicker = false;
    if (options.pickMusic === true) {
      if (platform.key !== 'douyin') {
        push('打开配乐面板', 'warn', `${platform.label} 的曲库面板还没核对，跳过`);
      } else if (options.mode === 'publish') {
        push('打开配乐面板', 'warn', 'mode=publish 时不打开（避免和发布撞在一起）');
      } else {
        const panel = platform.selectors.musicPanel ?? null;
        const entries = Array.isArray(platform.selectors.musicEntry)
          ? platform.selectors.musicEntry
          : [platform.selectors.musicEntry];
        let opened = false;
        // 优先按选择器点（右侧那颗「添加音乐」标签），失败再退回按文案点
        if (panel?.entrySelector) {
          try {
            await browser.click(session, { target: { by: 'css', value: panel.entrySelector } }, deps.signal);
            opened = true;
          } catch {
            /* 退回文案 */
          }
        }
        if (!opened) {
          for (const text of entries) {
            try {
              await browser.click(session, { target: { by: 'text', value: text } }, deps.signal);
              opened = true;
              break;
            } catch {
              /* 试下一个文案 */
            }
          }
        }
        if (!opened) {
          push('打开配乐面板', 'warn', `没找到「${entries.join(' / ')}」入口（抖音改版了？）`);
        } else if (panel?.searchInput) {
          // 等面板真的长出来（侧边面板叫「选择音乐」，里面有个「搜索音乐」框）
          const ready = await waitFor(browser, localDeps, `!!document.querySelector(${JSON.stringify(panel.searchInput)})`, 8000);
          if (!ready.ok) {
            push('打开配乐面板', 'warn', '点了入口但配乐面板没出现（版式变了？）');
          } else {
            musicPicker = true;
            // 再往前一步：把搜索框聚焦（用 el.focus()，比点更可靠 —— 点它可能被遮罩吃掉）
            let focused = false;
            try {
              const focus = await browser.execute(deps.session, {
                script: `(()=>{ const el = document.querySelector(${JSON.stringify(panel.searchInput)}); if (!el) return 'missing'; el.focus(); return document.activeElement === el ? 'focused' : 'not-focused'; })()`,
              }, deps.signal);
              focused = focus?.value === 'focused';
            } catch {
              focused = false;
            }
            if (!focused) {
              // 退一步：真点一下再试
              try {
                await browser.click(deps.session, { target: { by: 'css', value: panel.searchInput } }, deps.signal);
                const again = await browser.execute(deps.session, {
                  script: `(()=>{ const el = document.querySelector(${JSON.stringify(panel.searchInput)}); return el && document.activeElement === el ? 'focused' : 'not-focused'; })()`,
                }, deps.signal);
                focused = again?.value === 'focused';
              } catch {
                /* 聚焦失败不阻断，面板已经打开了 */
              }
            }
            let searched = false;
            if (options.musicSearch !== null && focused) {
              try {
                await new Promise((resolve) => setTimeout(resolve, 200));
                await browser.type(deps.session, { text: options.musicSearch }, deps.signal);
                const readback = await browser.execute(deps.session, {
                  script: `return (()=>{ const el = document.querySelector(${JSON.stringify(panel.searchInput)}); return el ? String(el.value || '') : ''; })()`,
                }, deps.signal);
                searched = typeof readback?.value === 'string' && readback.value.trim() !== '';
              } catch {
                searched = false;
              }
            }
            push('打开配乐面板', 'ok', searched
              ? `面板已打开，已搜「${options.musicSearch}」—— 结果都在，请你点「使用」`
              : (options.musicSearch !== null
                ? '面板已打开，但搜索词没打进去 —— 请手动在搜索框里输（面板已经开着）'
                : (focused
                  ? '面板已打开、搜索框已聚焦 —— 请你输入歌名或直接挑一首'
                  : '面板已打开 —— 请你点搜索框输入歌名，或直接挑一首')));
          }
        } else {
          musicPicker = true;
          push('打开配乐面板', 'ok', '已点开配乐面板 —— 请你选一首');
        }
      }
    }

    // ⑨ 发布，或者**故意停在发布前**
    let published = false;
    if (options.mode === 'publish') {
      await browser.click(session, { target: { by: 'text', value: platform.selectors.submitText } }, deps.signal);
      published = true;
      push('点发布', 'ok', `已点「${platform.selectors.submitText}」（mode=publish 是显式要求的）`);
    } else {
      push('发布', 'skipped', `mode=draft：**故意没点「${platform.selectors.submitText}」**`);
    }

    return {
      ok: true,
      published,
      platform: platform.key,
      platformLabel: platform.label,
      attachMode,
      video,
      steps,
      pageUrl: await readUrl(browser, localDeps),
      title: options.title,
      titleFill,
      description: options.description,
      topics: options.topics,
      topicFill,
      bgm: bgm === null ? null : { path: bgmSource, volume: options.bgmVolume, videoHadAudio: bgm.videoHadAudio === true },
      coverTime: options.coverTime,
      coverSet: cover.applied === true,
      musicPicker,
      visibility: options.visibility,
      mode: options.mode,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    push('异常', 'error', message);
    return { ok: false, video, steps, error: message };
  } finally {
    if (server !== null) {
      try {
        await server.close();
      } catch {
        /* 关不掉也不影响结果 */
      }
    }
  }
}

/** 文件名（不 import path 也能用；只取最后一段）。 */
function fileNameOf(filePath) {
  const s = String(filePath).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
