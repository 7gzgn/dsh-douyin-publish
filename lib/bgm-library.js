/**
 * dsh-douyin-publish · bgm-library —— 本地配乐库（让"选一首配乐"变成一句话）。
 *
 * 设计：**不内置任何曲子**（版权在用户那儿）。插件只提供目录与检索：
 *   `<DSH_HOME>/dsh-douyin-publish/bgm/` 下（递归找 mp3/wav/m4a/flac/ogg/opus/aac）
 * 用户往里丢歌，agent 就能用 `bgm: "轻快"` 这种模糊名字挑中它。
 *
 * 为什么不做"平台曲库"：抖音的音乐选择是页面 UI，搜索框/结果列表/授权弹窗都会变，
 * 而且点选之后平台还会改视频——风险高、不可预期。本地混音是我们能保证的那条路。
 *
 * @module dsh-douyin-publish/bgm-library
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/** 认的音频后缀（ffmpeg 都能读）。 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'];

/** 默认配乐目录。 */
export function defaultBgmDir(env = process.env, home = homedir()) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'dsh-douyin-publish', 'bgm');
}

/**
 * 列出配乐库里所有曲子（递归）。
 * @param {{bgmDir?:string, env?:Record<string,string>, home?:string}} [options] 选项
 * @returns {Array<{name:string, file:string, path:string, bytes:number}>} 曲子列表（按名字排序）
 */
export function listBgm(options = {}) {
  const dir = options.bgmDir ?? defaultBgmDir(options.env, options.home);
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!AUDIO_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
      let bytes = 0;
      try {
        bytes = statSync(full).size;
      } catch {
        continue;
      }
      out.push({ name: basename(entry.name, extname(entry.name)), file: entry.name, path: full, bytes });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按名字从配乐库里挑一首。
 *
 * 匹配顺序：**文件名完全相同** → **文件名包含**（忽略大小写）→ **路径包含**。
 * 命中多首时**不猜**，把候选交回调用方（让它去问用户）。
 *
 * @param {string} query 名字（如 "轻快" 或 "bgm1"）
 * @param {{bgmDir?:string, env?:Record<string,string>, home?:string}} [options] 选项
 * @returns {{ok:true, track:object} | {ok:false, reason:'empty'|'not-found'|'ambiguous', matches:Array<object>, dir:string}} 结果
 */
export function pickBgm(query, options = {}) {
  const dir = options.bgmDir ?? defaultBgmDir(options.env, options.home);
  const all = listBgm({ ...options, bgmDir: dir });
  const needle = String(query ?? '').trim().toLowerCase();
  const base = { dir, matches: all };
  if (all.length === 0) return { ok: false, reason: 'empty', ...base };
  if (needle === '') return { ok: false, reason: 'not-found', ...base };

  const exact = all.filter((t) => t.name.toLowerCase() === needle || t.file.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, track: exact[0] };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', ...base, matches: exact };

  const partial = all.filter((t) => t.name.toLowerCase().includes(needle) || t.file.toLowerCase().includes(needle));
  const pool = partial.length > 0 ? partial : all.filter((t) => t.path.toLowerCase().includes(needle));
  if (pool.length === 1) return { ok: true, track: pool[0] };
  if (pool.length > 1) return { ok: false, reason: 'ambiguous', ...base, matches: pool };
  return { ok: false, reason: 'not-found', ...base };
}

/**
 * 把 `bgm` 参数解析成文件路径：绝对路径直接用，否则当名字去库里挑。
 * @param {string} value 参数值
 * @param {{bgmDir?:string, env?:Record<string,string>, home?:string}} [options] 选项
 * @returns {{ok:true, path:string, track?:object} | {ok:false, error:string, hint:string, matches?:Array<object>}} 结果
 */
export function resolveBgm(value, options = {}) {
  const text = String(value ?? '').trim();
  if (text === '') return { ok: false, error: 'bgm-empty', hint: 'bgm 给的是空字符串' };
  // 绝对路径（Windows 盘符或 UNC）直接用
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) {
    if (!existsSync(text)) return { ok: false, error: 'bgm-not-found', hint: `这个路径不存在：${text}` };
    return { ok: true, path: text };
  }
  const picked = pickBgm(text, options);
  if (picked.ok === true) return { ok: true, path: picked.track.path, track: picked.track };
  if (picked.reason === 'empty') {
    return { ok: false, error: 'bgm-library-empty', hint: `配乐库还是空的：${picked.dir}\n把歌丢进去（mp3/wav/m4a/flac/ogg 都行），再用名字挑。` };
  }
  if (picked.reason === 'ambiguous') {
    return {
      ok: false,
      error: 'bgm-ambiguous',
      hint: `"${text}" 命中 ${picked.matches.length} 首，请说得更具体一点（或直接给绝对路径）`,
      matches: picked.matches.slice(0, 20).map((t) => t.name),
    };
  }
  return {
    ok: false,
    error: 'bgm-not-found',
    hint: `配乐库里没有 "${text}"。现有：${picked.matches.slice(0, 20).map((t) => t.name).join('、') || '（空）'}`,
    matches: picked.matches.slice(0, 20).map((t) => t.name),
  };
}
