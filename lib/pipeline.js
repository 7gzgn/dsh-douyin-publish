/**
 * dsh-douyin-publish · pipeline —— 编排：打开投稿页 → 点上传 → 递文件 → 填表 → 停在发布前。
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

import {
  EDIT_URL_MARK,
  TITLE_PLACEHOLDER,
  UPLOAD_URL,
  VISIBILITY,
  effectiveOptions,
  validateInput,
} from './plan.js';
import { inspectVideo } from './video.js';
import { runHandover } from './handover.js';

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

// 等待期间用的 session 由调用方通过 deps.session 传入。

/**
 * 把可见性点成想要的那个（按页面上真实的中文标签找）。
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {string} visibility 可见性键
 * @returns {Promise<{ok:boolean, checked:boolean}>} 结果
 */
async function setVisibility(browser, deps, visibility) {
  const label = VISIBILITY[visibility]?.label ?? '';
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
    return { ok: res?.ok === true && value?.found === true && value?.checked === true, checked: value?.checked === true };
  } catch (err) {
    return { ok: false, checked: false, error: err instanceof Error ? err.message : String(err) };
  }
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
 * 版式自检：投稿页 / 编辑页的关键控件还在不在。
 *
 * 抖音改版是常态，选择器一失效就会"跑到一半停住"。所以先**点名**：
 * 少哪个就报哪个，然后直接给 `layout-changed` —— 至少知道该更新什么。
 *
 * 探不到（页面还没渲染完 / 服务拒绝执行）时返回 `known:false`：
 * **不能把"没探到"当成"没有"**，否则一次抖动就误报改版。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {'upload'|'edit'} stage 阶段
 * @returns {Promise<{known:boolean, missing:string[], raw:object|null}>} 结果
 */
async function probeControls(browser, deps, stage) {
  const script = `return (()=>{
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : '');
    const hasText = (want) => Array.from(document.querySelectorAll('button,div,span,a')).some((el) => txt(el) === want);
    return {
      __dsh_douyin_controls: true,
      stage: ${JSON.stringify(stage)},
      fileInput: !!document.querySelector('input[type=file]'),
      uploadText: hasText('上传视频'),
      titleInput: !!document.querySelector('input[placeholder*="作品标题"]'),
      publishButton: hasText('发布'),
      captionEditor: !!document.querySelector('[contenteditable="true"]'),
      coverEntry: hasText('选择封面')
    };
  })()`;
  let raw = null;
  try {
    const res = await browser.execute(deps.session, { script }, deps.signal);
    raw = res?.value ?? null;
  } catch {
    return { known: false, missing: [], raw: null };
  }
  if (raw === null || typeof raw !== 'object' || raw.__dsh_douyin_controls !== true) {
    return { known: false, missing: [], raw };
  }
  const missing = [];
  if (stage === 'upload') {
    if (raw.fileInput !== true) missing.push('上传控件（input[type=file]）');
    if (raw.uploadText !== true) missing.push('「上传视频」按钮');
  } else {
    if (raw.titleInput !== true) missing.push('标题输入框');
    if (raw.publishButton !== true) missing.push('「发布」按钮');
  }
  return { known: true, missing, raw };
}

/**
 * 把话题代填进简介编辑框（每段以 `#` 开头，末尾补空格让它有机会成标签）。
 *
 * 诚实边界：抖音的话题是**联想式**的 —— 真正的"标签化"可能要靠下拉里点选。
 * 所以这里填完会**回读**：文本里能读到几条就报几条，读不到就明说"请在页面上看一眼"。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {string[]} topics 话题（不带 #）
 * @returns {Promise<{ok:boolean, filled:number, verified:number, detail:string}>} 结果
 */
async function fillTopics(browser, deps, topics) {
  if (!Array.isArray(topics) || topics.length === 0) {
    return { ok: true, filled: 0, verified: 0, detail: '没给话题' };
  }
  const selector = '[contenteditable="true"]';
  let focused = false;
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{ const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {found:false}; el.focus(); return {found:true}; })()`,
    }, deps.signal);
    focused = res?.value?.found === true;
  } catch {
    focused = false;
  }
  if (!focused) return { ok: false, filled: 0, verified: 0, detail: '没找到简介编辑框（contenteditable）' };

  let filled = 0;
  for (const topic of topics) {
    const text = topic.startsWith('#') ? topic : `#${topic}`;
    try {
      await browser.type(deps.session, { text: `${text} `, target: { by: 'css', value: selector } }, deps.signal);
      filled += 1;
    } catch {
      /* 单条失败不拖垮整条链路 */
    }
    await sleep(300);
  }

  let verified = 0;
  try {
    const res = await browser.execute(deps.session, {
      script: `return (()=>{ const el = document.querySelector(${JSON.stringify(selector)}); return String((el && el.textContent) || ''); })()`,
    }, deps.signal);
    const body = typeof res?.value === 'string' ? res.value : '';
    verified = topics.filter((t) => body.includes(t.replace(/^#/, ''))).length;
  } catch {
    verified = 0;
  }
  return {
    ok: filled > 0,
    filled,
    verified,
    detail: verified >= filled
      ? `已代填 ${filled} 个话题`
      : `已代填 ${filled} 个、回读到 ${verified} 个 —— 没读到的可能还没成标签，请在页面上看一眼`,
  };
}

/**
 * 把封面停在指定秒（默认第 1 秒 —— 第 0 帧常常是黑场）。
 *
 * 这是**尽力而为**：封面弹窗里如果没有时间轴（抖音改版/换了实现），
 * 就如实回报"没设上、保留默认"，绝不假装设好了。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖
 * @param {number} seconds 秒
 * @returns {Promise<{ok:boolean, applied:boolean, detail:string}>} 结果
 */
async function setCoverFrame(browser, deps, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: true, applied: false, detail: 'coverTime=0：不动封面' };
  }
  try {
    await browser.click(deps.session, { target: { by: 'text', value: '选择封面' } }, deps.signal);
  } catch {
    return { ok: false, applied: false, detail: '页面上没找到「选择封面」入口' };
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
  const push = (name, status, detail, extra = {}) => steps.push({ name, status, detail, ...extra });

  const errors = validateInput(input);
  if (errors.length > 0) return { ok: false, error: errors[0], errors, steps };

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

  if (input.dryRun === true) {
    push('开页面/点上传/递文件', 'skipped', '只检查模式：都没做');
    return {
      ok: true,
      dryRun: true,
      video,
      steps,
      title: options.title,
      visibility: options.visibility,
      mode: options.mode,
      plan: {
        url: UPLOAD_URL,
        visibility: VISIBILITY[options.visibility]?.label,
        willPublish: options.mode === 'publish',
        topics: options.topics,
        coverTime: options.coverTime,
      },
    };
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

  try {
    // ③ 打开投稿页
    await browser.openUrl(session, { url: UPLOAD_URL }, deps.signal);
    push('打开投稿页', 'ok', UPLOAD_URL);

    // ④ 等上传控件出现
    const ready = await waitFor(browser, localDeps, "!!document.querySelector('input[type=file]')", 30000);
    if (!ready.ok) {
      push('等页面就绪', 'error', `等了 ${Math.round(ready.waitedMs / 1000)} 秒，上传控件没出现`);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: 'edit-page-timeout: 投稿页没就绪（上传控件没出现）' };
    }
    push('等页面就绪', 'ok', `上传控件已出现（等了 ${Math.round(ready.waitedMs / 1000)} 秒）`);

    // ④' 版式自检（投稿页）：关键控件缺了就**现在**说，别跑到一半停住
    const upCheck = await probeControls(browser, localDeps, 'upload');
    if (upCheck.known && upCheck.missing.length > 0) {
      push('版式自检', 'error', `缺：${upCheck.missing.join('、')}`);
      return {
        ok: false,
        video,
        steps,
        pageUrl: await readUrl(browser, localDeps),
        error: `layout-changed: 投稿页版式变了（缺 ${upCheck.missing.join('、')}）—— 需要更新选择器`,
      };
    }
    push('版式自检', 'ok', upCheck.known ? '上传控件与「上传视频」按钮都在' : '探不到（当作未知，继续）');

    // ⑤ 真实点击"上传视频"——程序化 click 不会弹系统对话框
    await browser.click(session, { target: { by: 'text', value: '上传视频' } }, deps.signal);
    push('点上传按钮', 'ok', '真实点击（这一下才会弹系统对话框）');

    // ⑥ 递文件（含"等对话框 + 回读校验 + 点确认"）
    const hs = await runHandover({ path: video.path, timeoutSec: Math.min(options.timeoutSec, 30) }, deps);
    if (hs.ok !== true) {
      push('递文件', 'error', hs.result?.error ?? hs.stderr?.slice(0, 200) ?? '失败');
      return { ok: false, video, steps, error: `handover: ${hs.result?.error ?? '失败'}`, handover: hs.result };
    }
    push('递文件', 'ok', `${hs.result.fillMethod ?? '?'}${hs.result.fillVerified === true ? '，回读一致' : '，未能回读'}`);

    // ⑦ 等进入编辑页
    const edit = await waitFor(browser, localDeps, `location.href.indexOf(${JSON.stringify(EDIT_URL_MARK)}) >= 0`, options.timeoutSec * 1000);
    if (!edit.ok) {
      push('等编辑页', 'error', `等了 ${Math.round(edit.waitedMs / 1000)} 秒没进编辑页`);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: 'edit-page-timeout: 文件交出去了，但页面没进编辑页' };
    }
    push('等编辑页', 'ok', `已进入编辑页（等了 ${Math.round(edit.waitedMs / 1000)} 秒）`);

    // ⑦' 版式自检（编辑页）：标题框、发布按钮还在不在
    const edCheck = await probeControls(browser, localDeps, 'edit');
    if (edCheck.known && edCheck.missing.length > 0) {
      push('版式自检', 'error', `缺：${edCheck.missing.join('、')}`);
      return {
        ok: false,
        video,
        steps,
        pageUrl: await readUrl(browser, localDeps),
        error: `layout-changed: 编辑页版式变了（缺 ${edCheck.missing.join('、')}）—— 需要更新选择器`,
      };
    }

    // ⑧ 填标题
    if (options.title !== '') {
      await browser.type(session, {
        text: options.title,
        target: { by: 'css', value: `input[placeholder="${TITLE_PLACEHOLDER}"]` },
      }, deps.signal);
      push('填标题', 'ok', options.title);
    } else {
      push('填标题', 'skipped', '没给标题');
    }

    // ⑧' 话题（代填 + 回读；回读不齐就说清楚，不假装成功）
    const topicFill = await fillTopics(browser, localDeps, options.topics);
    if (options.topics.length === 0) {
      push('填话题', 'skipped', '没给话题');
    } else if (topicFill.ok) {
      push('填话题', topicFill.verified >= topicFill.filled ? 'ok' : 'warn', topicFill.detail);
    } else {
      push('填话题', 'warn', topicFill.detail);
    }

    // ⑨ 设可见性（默认仅自己可见）
    const vis = await setVisibility(browser, localDeps, options.visibility);
    if (vis.ok !== true) {
      push('设可见性', 'error', `没点中「${VISIBILITY[options.visibility]?.label}」`);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: 'visibility: 可见性选项没点中' };
    }
    push('设可见性', 'ok', VISIBILITY[options.visibility]?.label ?? options.visibility);

    // ⑨' 封面（默认第 1 秒；尽力而为，设不上如实说）
    const cover = await setCoverFrame(browser, localDeps, options.coverTime);
    if (options.coverTime > 0) {
      push('设封面', cover.ok ? 'ok' : 'warn', cover.detail);
    } else {
      push('设封面', 'skipped', cover.detail);
    }

    // ⑩ 发布，或者**故意停在发布前**
    let published = false;
    if (options.mode === 'publish') {
      await browser.click(session, { target: { by: 'text', value: '发布' } }, deps.signal);
      published = true;
      push('点发布', 'ok', '已点（mode=publish 是显式要求的）');
    } else {
      push('发布', 'skipped', 'mode=draft：**故意没点发布**');
    }

    return {
      ok: true,
      published,
      video,
      steps,
      pageUrl: await readUrl(browser, localDeps),
      title: options.title,
      topics: options.topics,
      topicFill,
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
  }
}
