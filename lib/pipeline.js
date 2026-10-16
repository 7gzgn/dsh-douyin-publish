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
      plan: { url: UPLOAD_URL, visibility: VISIBILITY[options.visibility]?.label, willPublish: options.mode === 'publish' },
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

    // ⑨ 设可见性（默认仅自己可见）
    const vis = await setVisibility(browser, localDeps, options.visibility);
    if (vis.ok !== true) {
      push('设可见性', 'error', `没点中「${VISIBILITY[options.visibility]?.label}」`);
      return { ok: false, video, steps, pageUrl: await readUrl(browser, localDeps), error: 'visibility: 可见性选项没点中' };
    }
    push('设可见性', 'ok', VISIBILITY[options.visibility]?.label ?? options.visibility);

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
