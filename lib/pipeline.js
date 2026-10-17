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
  try {
    if (typeof browser.setValue === 'function') {
      await browser.setValue(deps.session, { target, value: title }, deps.signal);
      cleared = true;
    } else {
      await browser.type(deps.session, { text: title, target }, deps.signal);
    }
  } catch {
    try {
      await browser.type(deps.session, { text: title, target }, deps.signal);
    } catch {
      return { ok: false, readback: '', cleared };
    }
  }
  let readback = '';
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{ const el = document.querySelector(${JSON.stringify(selector)}); return el ? String(el.value || '') : ''; })()`,
    }, deps.signal);
    readback = typeof res?.value === 'string' ? res.value : '';
  } catch {
    readback = '';
  }
  return { ok: readback === title, readback, cleared };
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
        bgm: options.bgmPath === null ? null : { path: options.bgmPath, volume: options.bgmVolume },
        coverTime: options.coverTime,
        attach: video.size > maxInjectBytes ? 'dialog（文件超过注入上限）' : 'inject（本机小服务 + DataTransfer）',
      },
    };
  }

  // ①' 配乐：给了 BGM 就先混一段新视频（不动原文件），后面上传的是混好的那份
  let uploadPath = video.path;
  let bgm = null;
  if (options.bgmPath !== null) {
    bgm = await mixBgm({
      videoPath: video.path,
      bgmPath: options.bgmPath,
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
    push('配乐', 'ok', `${options.bgmPath}（音量 ${options.bgmVolume}${bgm.videoHadAudio ? '，与原声混合' : '，原视频无声' }）`);
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

    // ④' 版式自检（投稿页）：关键控件缺了就**现在**说，别跑到一半停住
    const upCheck = await probeControls(browser, localDeps, platform, 'upload');
    if (upCheck.known && upCheck.missing.length > 0) {
      push('版式自检', 'error', `缺：${upCheck.missing.join('、')}`);
      return {
        ok: false,
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
    if (video.size > maxInjectBytes) {
      push('选交文件方式', 'warn', `文件 ${video.size} 字节超过注入上限 ${maxInjectBytes}，改走系统对话框`);
    } else {
      let bytes = 0;
      try {
        server = await startFileServer({ filePath: uploadPath });
        inject = await injectFile(browser, {
          session,
          url: server.url,
          fileName: fileNameOf(uploadPath),
          mime: mimeOf(uploadPath),
          inputSelector: platform.attach.inputSelector,
          signal: deps.signal,
        });
        bytes = inject.bytes;
      } catch (err) {
        inject = { ok: false, reason: 'server-failed', error: err instanceof Error ? err.message : String(err) };
      }
      if (inject.ok) {
        push('交文件', 'ok', `注入方式：页面取回 ${bytes} 字节并塞进上传控件（不弹系统对话框）`);
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
    const edit = await waitFor(browser, localDeps, editExpr, options.timeoutSec * 1000);
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
      bgm: bgm === null ? null : { path: options.bgmPath, volume: options.bgmVolume, videoHadAudio: bgm.videoHadAudio === true },
      coverTime: options.coverTime,
      coverSet: cover.applied === true,
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
