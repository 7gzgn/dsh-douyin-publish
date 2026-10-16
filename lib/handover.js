/**
 * dsh-douyin-publish · handover —— 把视频交给系统"打开文件"对话框。
 *
 * 这一段与作者另一个插件 `dsh-file-handover` 同源（四个插件各自独立成仓，
 * 不互相依赖，所以这里自带一份干活脚本 `handover.ps1`）。
 * 三条规矩照抄：**不认标题只认结构**、**每步回读**、**失败带现场**。
 *
 * @module dsh-douyin-publish/handover
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包内自带的干活脚本。 */
export function defaultScriptPath() {
  return join(HERE, 'handover.ps1');
}

/** 用哪个 PowerShell（Windows 自带的即可）。 */
export function defaultPowerShell() {
  return process.env.DSH_FILE_HANDOVER_POWERSHELL ?? 'powershell.exe';
}

/** 从 stdout 里取出脚本的 JSON 结果。 */
export function parseHandoverResult(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    /* 往下找 */
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

/** 起进程收输出。 */
function collect(spawnImpl, command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, timeout: timeoutMs });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk.toString(); });
    child.on?.('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err instanceof Error ? err.message : String(err)}` }));
    child.on?.('close', (code) => resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr }));
  });
}

/**
 * 递一个文件给当前打开的系统文件对话框。
 * @param {object} input `{ path, timeoutSec, expectTitle }`
 * @param {object} [deps] 依赖 `{ spawnImpl, scriptPath, powershell }`
 * @returns {Promise<object>} `{ ok, result, code, stderr }`
 */
export async function runHandover(input = {}, deps = {}) {
  const scriptPath = deps.scriptPath ?? defaultScriptPath();
  const powershell = deps.powershell ?? defaultPowerShell();
  const timeoutSec = Number.isFinite(input.timeoutSec) ? input.timeoutSec : 30;
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Path', String(input.path),
    '-TimeoutSec', String(timeoutSec),
  ];
  if (typeof input.expectTitle === 'string' && input.expectTitle !== '') {
    args.push('-ExpectTitle', input.expectTitle);
  }
  const res = await collect(deps.spawnImpl ?? nodeSpawn, powershell, args, (timeoutSec + 20) * 1000);
  const result = parseHandoverResult(res.stdout);
  return {
    ok: res.code === 0 && result?.ok === true,
    result,
    code: res.code,
    stderr: res.stderr,
  };
}
