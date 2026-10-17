/**
 * dsh-douyin-publish · attach —— 把本地视频"交到"网页的那个 `<input type=file>` 里。
 *
 * 两条路子，**先走后一条**（注入），因为它不碰桌面、不弹对话框、不挡人：
 *
 *   ① **inject**：本机临时小服务（见 serve.js）→ 页面里 fetch 回字节 → 用 `DataTransfer`
 *      造一个真 `File` → 塞进页面的 input → 派发 input/change。上传控件是页面自己的 JS
 *      在跑，所以后面的流程与"人手选文件"完全一样。
 *   ② **dialog**：真点上传按钮 → 等系统"打开文件"对话框 → 交给 handover.ps1 填路径并回读。
 *      注入被拦（CSP/CORS）、或文件大到不适合塞进渲染进程时，才走这条。
 *
 * 诚实边界：注入会把整个文件读进浏览器渲染进程的内存里（页面要发它上去），所以
 * **大文件不适合**；默认超过 `maxInjectBytes` 就退回对话框。
 *
 * @module dsh-douyin-publish/attach
 */

import { runHandover } from './handover.js';

/** 注入方式的默认体积上限：512MB。超过就退回系统对话框。 */
export const DEFAULT_MAX_INJECT_BYTES = 512 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 在页面里把一个 URL 取回来并塞进 input。
 *
 * 页面里那段脚本是**自包含**的（不引用任何外部变量），返回的字段也只用 JSON 能表达的值。
 *
 * @param {object} browser 浏览器服务
 * @param {object} opts 参数
 * @param {string} opts.session 会话
 * @param {string} opts.url 本机小服务上的文件地址
 * @param {string} opts.fileName 给 File 用的文件名
 * @param {string} [opts.mime] MIME
 * @param {string} [opts.inputSelector] input 选择器
 * @param {AbortSignal} [opts.signal] 取消
 * @returns {Promise<{ok:boolean, attached:number, bytes:number, inputs:number, candidates:number, reason?:string, error?:string}>} 结果
 */
export async function injectFile(browser, opts = {}) {
  const inputSelector = opts.inputSelector ?? 'input[type=file]';
  const script = `return fetch(${JSON.stringify(String(opts.url))}).then(function(res){
    if (!res.ok) { throw new Error('http-' + res.status); }
    return res.blob();
  }).then(function(blob){
    var file = new File([blob], ${JSON.stringify(String(opts.fileName ?? 'video.mp4'))}, { type: ${JSON.stringify(String(opts.mime ?? 'video/mp4'))} });
    var dt = new DataTransfer();
    dt.items.add(file);
    var inputs = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(inputSelector)}));
    var video = inputs.filter(function(el){
      var a = String(el.accept || '');
      return a === '' || /video|mp4|m4v|flv/i.test(a);
    });
    if (video.length === 0) {
      return { attached: 0, bytes: blob.size, inputs: inputs.length, candidates: 0, reason: 'no-video-input' };
    }
    var visible = video.filter(function(el){
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    var ordered = visible.concat(video.filter(function(el){ return visible.indexOf(el) < 0; }));
    var el = ordered[0];
    try { el.files = dt.files; } catch (e) {
      return { attached: 0, bytes: blob.size, inputs: inputs.length, candidates: ordered.length, reason: 'assign-failed', error: String(e) };
    }
    var count = el.files ? el.files.length : -1;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { attached: count, bytes: blob.size, inputs: inputs.length, candidates: ordered.length };
  })`;
  try {
    const res = await browser.execute(opts.session, { script }, opts.signal);
    const value = res?.value ?? null;
    if (value === null || typeof value !== 'object') {
      return { ok: false, attached: 0, bytes: 0, inputs: 0, candidates: 0, reason: 'no-result' };
    }
    return {
      ok: value.attached === 1,
      attached: Number(value.attached) || 0,
      bytes: Number(value.bytes) || 0,
      inputs: Number(value.inputs) || 0,
      candidates: Number(value.candidates) || 0,
      reason: value.reason,
      error: value.error,
    };
  } catch (err) {
    return {
      ok: false,
      attached: 0,
      bytes: 0,
      inputs: 0,
      candidates: 0,
      reason: 'execute-failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 老办法：真点上传按钮，把路径交给系统对话框。
 *
 * @param {object} browser 浏览器服务
 * @param {object} deps 依赖（spawnImpl / scriptPath / powershell）
 * @param {object} opts 参数 `{ session, filePath, dialogText, timeoutSec, signal }`
 * @returns {Promise<{ok:boolean, result:object|null, error?:string}>} 结果
 */
export async function attachViaDialog(browser, deps, opts = {}) {
  try {
    await browser.click(opts.session, { target: { by: 'text', value: String(opts.dialogText ?? '上传视频') } }, opts.signal);
  } catch (err) {
    return { ok: false, result: null, error: `click-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await sleep(600);
  const hs = await runHandover({ path: opts.filePath, timeoutSec: opts.timeoutSec ?? 30 }, deps);
  // 关键：**没能回读校验**的填充不算成功 —— 否则就是"看到像成功的痕迹就当成功"。
  const verified = hs.result?.fillVerified === true;
  if (hs.ok !== true || verified !== true) {
    return {
      ok: false,
      result: hs.result ?? null,
      error: hs.result?.error ?? (hs.ok === true ? 'fill-unverified: 路径填进去了但回读不到，不能确认对话框收到了文件' : 'handover 失败'),
      stderr: hs.stderr,
    };
  }
  return { ok: true, result: hs.result };
}
