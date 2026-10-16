/**
 * dsh-douyin-publish · video —— 发布前先看清手里这段视频是什么。
 *
 * 只读：查文件、问 ffprobe 要时长与分辨率。**不做转码、不改文件** ——
 * "把视频做好看"是内容管线的事，这个插件只负责把它送上去。
 *
 * @module dsh-douyin-publish/video
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

/** ffprobe 在哪：显式参数 → 环境变量 → PATH。 */
export function resolveFfprobe(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof process.env.DSH_FFPROBE_PATH === 'string' && process.env.DSH_FFPROBE_PATH !== '') {
    return process.env.DSH_FFPROBE_PATH;
  }
  return 'ffprobe';
}

/**
 * 跑一个进程并收全输出。
 * @param {Function} spawnImpl spawn
 * @param {string} command 命令
 * @param {string[]} args 参数
 * @param {number} timeoutMs 上限
 * @returns {Promise<{code:number, stdout:string, stderr:string}>} 结果
 */
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
 * 问 ffprobe 要视频的基本信息。**失败不致命** —— 拿不到元信息也照样能发，
 * 所以这里返回 null 而不是抛错。
 * @param {Function} spawnImpl spawn
 * @param {string} ffprobe 可执行
 * @param {string} path 视频路径
 * @returns {Promise<object|null>} `{width, height, durationSec, codec}` 或 null
 */
export async function probeWithFfprobe(spawnImpl, ffprobe, path) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration,codec_name',
    '-of', 'json',
    path,
  ];
  const res = await collect(spawnImpl, ffprobe, args, 20000);
  if (res.code !== 0 || res.stdout.trim() === '') return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
    if (stream === null || stream === undefined) return null;
    const duration = Number(stream.duration);
    return {
      width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : undefined,
      height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : undefined,
      durationSec: Number.isFinite(duration) ? duration : undefined,
      codec: typeof stream.codec_name === 'string' ? stream.codec_name : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 检查一个视频文件：在不在、多大、多长、什么分辨率。
 * @param {string} path 绝对路径
 * @param {object} [deps] 依赖 `{ statImpl, spawnImpl, ffprobe }`
 * @returns {Promise<object>} `{ ok, path, size, width?, height?, durationSec?, codec?, error? }`
 */
export async function inspectVideo(path, deps = {}) {
  const statImpl = deps.statImpl ?? stat;
  let info;
  try {
    info = await statImpl(path);
  } catch (err) {
    return { ok: false, path, error: `视频读不到：${err instanceof Error ? err.message : String(err)}` };
  }
  if (info.isFile() !== true) return { ok: false, path, error: '这个路径不是文件' };

  const out = { ok: true, path, size: info.size };
  const probed = await probeWithFfprobe(deps.spawnImpl ?? nodeSpawn, deps.ffprobe ?? resolveFfprobe(), path);
  if (probed !== null) {
    out.width = probed.width;
    out.height = probed.height;
    out.durationSec = probed.durationSec;
    out.codec = probed.codec;
  } else {
    out.probeSkipped = true; // 没有 ffprobe 也不拦着发布
  }
  return out;
}
