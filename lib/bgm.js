/**
 * dsh-douyin-publish · bgm —— 给视频配一段背景音乐（本地文件 → ffmpeg 混音）。
 *
 * 为什么在这里做而不是"让用户自己剪"：抖音投稿页的曲库是它的，插件点不了；
 * 但**视频自带音轨**照样能发出去 —— 所以最稳的配乐方式是上传前用 ffmpeg 混好。
 *
 * 两种情形分开处理（不然 amix 会因为"没有输入流"直接失败）：
 *   - 视频**有**音轨：`amix` 把原声与 BGM 混在一起（BGM 音量可调）；
 *   - 视频**没有**音轨：直接把 BGM 当音轨铺满整段。
 *
 * 只写一个新文件到临时目录，**不动原视频**。
 *
 * @module dsh-douyin-publish/bgm
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 默认 BGM 音量（0~1）。人声为主的视频不要盖过原声。 */
export const DEFAULT_BGM_VOLUME = 0.35;

/**
 * ffmpeg 在哪：显式参数 → 环境变量 → PATH。
 * @param {string} [explicit] 显式
 * @returns {string} 路径
 */
export function resolveFfmpeg(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof process.env.DSH_FFMPEG_PATH === 'string' && process.env.DSH_FFMPEG_PATH !== '') {
    return process.env.DSH_FFMPEG_PATH;
  }
  return 'ffmpeg';
}

/**
 * 跑一个进程并收全输出（与 video.js 同款，独立一份，避免互相牵连）。
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
 * 视频里有没有音轨。
 * @param {Function} spawnImpl spawn
 * @param {string} ffprobe ffprobe
 * @param {string} path 视频
 * @returns {Promise<boolean>} 有没有
 */
export async function hasAudioTrack(spawnImpl, ffprobe, path) {
  const res = await collect(spawnImpl, ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', path,
  ], 20000);
  if (res.code !== 0) return false;
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed?.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  }
}

/**
 * 拼 ffmpeg 参数（纯函数，便于单测断言）。
 * @param {{videoPath:string,bgmPath:string,outPath:string,volume:number,videoHasAudio:boolean}} input 输入
 * @returns {string[]} 参数
 */
export function buildMixArgs({ videoPath, bgmPath, outPath, volume, videoHasAudio }) {
  const gain = Math.max(0, Math.min(2, Number(volume)));
  const base = ['-y', '-i', videoPath, '-stream_loop', '-1', '-i', bgmPath];
  if (videoHasAudio) {
    return [
      ...base,
      '-filter_complex',
      `[1:a]volume=${gain}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath,
    ];
  }
  return [
    ...base,
    '-filter_complex', `[1:a]volume=${gain}[aout]`,
    '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath,
  ];
}

/**
 * 混一段 BGM 进视频，输出到临时目录。
 * @param {{videoPath:string,bgmPath:string,volume?:number,ffmpeg?:string,ffprobe?:string,spawnImpl?:Function,tmpDir?:string}} input 输入
 * @returns {Promise<{ok:boolean, outputPath?:string, volume?:number, videoHadAudio?:boolean, error?:string, stderrTail?:string}>} 结果
 */
export async function mixBgm(input) {
  const spawnImpl = input.spawnImpl ?? nodeSpawn;
  const ffmpeg = resolveFfmpeg(input.ffmpeg);
  const ffprobe = input.ffprobe ?? 'ffprobe';
  const volume = Number.isFinite(input.volume) ? Number(input.volume) : DEFAULT_BGM_VOLUME;
  const outPath = join(input.tmpDir ?? tmpdir(), `dsh-douyin-bgm-${Date.now()}.mp4`);

  const videoHasAudio = await hasAudioTrack(spawnImpl, ffprobe, input.videoPath);
  const args = buildMixArgs({ videoPath: input.videoPath, bgmPath: input.bgmPath, outPath, volume, videoHasAudio });
  const res = await collect(spawnImpl, ffmpeg, args, 300000);
  if (res.code !== 0) {
    return {
      ok: false,
      error: `ffmpeg 混音失败（exit ${res.code}）`,
      stderrTail: res.stderr.split('\n').slice(-4).join(' | ').slice(0, 400),
      videoHadAudio: videoHasAudio,
    };
  }
  return { ok: true, outputPath: outPath, volume, videoHadAudio: videoHasAudio };
}
