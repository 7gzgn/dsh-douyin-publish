#!/usr/bin/env node
/**
 * dsh-douyin-publish · CLI —— 只做"动手前能做的事"。
 *
 *   dsh-douyin-publish check --video <绝对路径>     # 检查视频（时长/分辨率/编码）
 *   dsh-douyin-publish help
 *
 * 为什么 CLI 不带完整链路：整条链路要借 DSH 的浏览器服务（`ctx.browser`），
 * 那是宿主里的东西，命令行拿不到。CLI 只提供不依赖浏览器的那一半 —— 检查视频。
 *
 * 退出码：0 = 通过；1 = 检查不通过；2 = 用法错误。
 *
 * @module dsh-douyin-publish/bin
 */

import { PLATFORMS, VISIBILITY, durationText, effectiveOptions, validateInput } from '../lib/plan.js';
import { inspectVideo } from '../lib/video.js';

/** 极简参数解析。 */
function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(token);
    }
  }
  return out;
}

const USAGE = `dsh-douyin-publish —— 把本地视频送到投稿页的"待发布"状态（抖音 / B站）

用法：
  dsh-douyin-publish check --video <绝对路径>     # 检查视频（时长/分辨率/编码/大小）

在 DSH 里用工具（完整链路，需要浏览器插件）：
  douyin_upload videoPath=<绝对路径> [platform=douyin|bilibili] title=… [visibility=private|friends|public] [mode=draft|publish] [dryRun]

两条默认值是刻意的：
  · 可见性默认 private（${VISIBILITY.private.label}）
  · 模式默认 draft（**不点投稿**）

投稿页：抖音 ${PLATFORMS.douyin.uploadUrl}
        B站 ${PLATFORMS.bilibili.uploadUrl}
`;

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0] ?? 'help';

  if (cmd === 'help' || argv.help === true) {
    console.log(USAGE);
    return 0;
  }

  if (cmd !== 'check') {
    console.error(`未知子命令：${cmd}\n\n${USAGE}`);
    return 2;
  }

  if (typeof argv.video !== 'string' || argv.video === '') {
    console.error(`❌ --video 必填（视频绝对路径）\n\n${USAGE}`);
    return 2;
  }

  const errors = validateInput({ videoPath: argv.video, visibility: argv.visibility, mode: argv.mode });
  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ ${e}`);
    return 2;
  }

  const info = await inspectVideo(argv.video, { ffprobe: argv.ffprobe });
  if (info.ok !== true) {
    console.error(`❌ ${info.error}`);
    return 1;
  }

  const options = effectiveOptions({ visibility: argv.visibility, mode: argv.mode, title: argv.title });
  console.log(`✅ 视频可用：${info.path}`);
  console.log(`   · 体积：${(info.size / 1024).toFixed(1)}KB`);
  if (info.width && info.height) console.log(`   · 画面：${info.width}x${info.height}`);
  if (Number.isFinite(info.durationSec)) console.log(`   · 时长：${durationText(info.durationSec)}`);
  if (info.codec) console.log(`   · 编码：${info.codec}`);
  if (info.probeSkipped === true) console.log('   · （ffprobe 不可用，元信息没拿到 —— 不影响发布）');
  console.log(`   · 若现在发：可见性 ${VISIBILITY[options.visibility]?.label}、模式 ${options.mode === 'publish' ? '会点投稿' : '停在投稿前'}`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
