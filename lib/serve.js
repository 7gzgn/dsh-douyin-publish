/**
 * dsh-douyin-publish · serve —— 在 127.0.0.1 上把一个文件临时"递"给页面。
 *
 * 为什么需要它：网页的 `<input type=file>` 只认**本地文件路径**或**系统对话框**，
 * 而"系统对话框"这条路要靠 UI 自动化去填另一个进程的窗口 —— 脆、会挡人、要 PowerShell。
 * 换成这条路：本机起一个**只读、只服务这一个文件、带随机令牌**的小服务，页面自己
 * fetch 回来再塞进 input，全程不碰桌面。
 *
 * 三条硬约束（都是安全）：
 *   1. 只绑 127.0.0.1 —— 局域网够不着；
 *   2. 只服务 `/f/<随机令牌>/<文件名>` 这一条路由，别的路径一律 404，不列目录；
 *   3. 用完就关（`close()`），另外带空闲超时兜底，不会留下一个长期开着的小服务器。
 *
 * @module dsh-douyin-publish/serve
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 后缀 → MIME（只列投稿页会收的那些）。 */
export const MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mpeg4': 'video/mp4',
});

/** 默认空闲上限：10 分钟没请求就自己关。 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 按后缀取 MIME。
 * @param {string} filePath 路径
 * @returns {string} MIME
 */
export function mimeOf(filePath) {
  return MIME[extname(String(filePath)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 起一个小服务，只把**一个文件**递给页面。
 *
 * @param {object} [options] 参数
 * @param {string} options.filePath 要递的文件（绝对路径）
 * @param {string} [options.host] 绑定地址（默认 127.0.0.1，别改）
 * @param {number} [options.port] 端口（默认 0 = 系统分配）
 * @param {number} [options.ttlMs] 空闲自动关闭（默认 10 分钟）
 * @returns {Promise<{url:string, port:number, bytes:number, route:string, close:()=>Promise<void>}>} 句柄
 */
export async function startFileServer(options = {}) {
  const filePath = String(options.filePath ?? '');
  if (filePath === '') throw new Error('startFileServer: filePath 必填');
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`startFileServer: 不是文件：${filePath}`);
  const host = options.host ?? '127.0.0.1';
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const token = randomBytes(9).toString('hex');
  const route = `/f/${token}/${encodeURIComponent(basename(filePath))}`;
  const type = mimeOf(filePath);

  let timer = null;
  const armTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      server.close(() => {});
    }, ttlMs);
    timer.unref?.();
  };

  const server = createServer((req, res) => {
    armTimer();
    const url = String(req.url ?? '');
    const path = url.split('?')[0];
    if (path !== route) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('not found');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('method not allowed');
      return;
    }
    const headers = {
      'Content-Type': type,
      'Content-Length': String(stat.size),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
      'Cache-Control': 'no-store',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* 连接已经断了 */
      }
    });
    stream.pipe(res);
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(Number.isFinite(options.port) ? options.port : 0, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  armTimer();

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://${host}:${port}${route}`;

  return {
    url,
    port,
    bytes: stat.size,
    route,
    downMs: 0,
    close() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
