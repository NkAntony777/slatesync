#!/usr/bin/env node
/**
 * 合板校验层 CLI：node scripts/conform-check.mjs <clip-list.json> --media <dir>
 *
 * 它只做一件事：把剪辑清单里每条 clip 的「身份声明」拿去和媒体文件自己的内容证据
 * 对撞，然后给出 supported / unverified / conflict 三态之一，外加一条可复算的证据链。
 * 媒体扫描（文件系统）在这一层；判定逻辑全部在 src/conform-check.js（纯函数）。
 *
 * 退出码（契约的一部分，不可随意改）：
 *   0  全部 clip 都有独立证据支撑
 *   1  存在 conflict，或 unverified 比例超过 --max-unverified-ratio
 *   2  输入不可读 / 用法错 / schema 不符
 *
 * 用法：
 *   node scripts/conform-check.mjs clips.json --media ./media
 *     [--json]                       把机器可读报告打到 stdout
 *     [--report out.json]            另存机器可读报告
 *     [--frame-tolerance 1]          帧级容差（帧）
 *     [--duration-tolerance 1]       时长容差（帧）
 *     [--max-unverified-ratio 0]     允许的不可判定比例
 *     [--ltc auto|off|on]            LTC 扫描策略（默认 auto：没内嵌时码或已冲突才扫）
 *     [--ltc-scan-seconds 60]        每个候选文件最多扫多少秒 LTC
 *     [--quiet]                      不打人类摘要（配合 --json 用）
 *
 * 不修改任何源素材：本工具只读。
 */
import fs from "node:fs";
import path from "node:path";
import { File } from "node:buffer";

import { scanWave, readDataView } from "../src/wave.js";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { ltcFailureSummary } from "../src/ltc-signal.js";
import { detectTakeGroupKeys, takeGroupCount } from "../src/grouping.js";
import { parseFps, samplesToTimecode } from "../src/timecode.js";
import {
  ConformInputError,
  DEFAULT_DURATION_TOLERANCE_FRAMES,
  DEFAULT_FRAME_TOLERANCE_FRAMES,
  DEFAULT_LTC_POLICY,
  DEFAULT_LTC_SCAN_SECONDS,
  DEFAULT_MAX_UNVERIFIED_RATIO,
  buildConformReport,
  formatHumanReport,
  parseClipList,
} from "../src/conform-check.js";

const USAGE = `用法: node scripts/conform-check.mjs <clip-list.json> --media <dir> [--json] [--report <out.json>]
  [--frame-tolerance N] [--duration-tolerance N] [--max-unverified-ratio R]
  [--ltc auto|off|on] [--ltc-scan-seconds N] [--quiet]

退出码: 0 全部有独立证据 / 1 存在 conflict 或不可判定比例超阈值 / 2 输入不可读或用法错`;

// 与 scripts/export-sync-package.mjs 同一套自动 LTC 候选帧率，避免两处口径漂移。
const LTC_FPS_CANDIDATES = ["23.976", "24", "25", "29.97", "29.97df", "30", "48", "50", "59.94", "59.94df", "60"];
const WAVE_FILE_PATTERN = /\.(wav|wave|bwf)$/i;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = new Set(["json", "quiet"]);
  const values = new Set([
    "media", "report", "frame-tolerance", "duration-tolerance",
    "max-unverified-ratio", "ltc", "ltc-scan-seconds",
  ]);
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (flags.has(name)) {
      args[name] = true;
      continue;
    }
    if (!values.has(name)) throw new UsageError(`未知选项：${token}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`选项 ${token} 缺少取值`);
    args[name] = next;
    i += 1;
  }
  return args;
}

function parseIntegerOption(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new UsageError(`${name} 必须是 ${min}..${max} 之间的整数，收到 ${value}`);
  }
  return number;
}

/** 报告里只出现相对路径：报告会被提交/贴进 issue，不该带出本机绝对路径。 */
function displayPath(target, base = process.cwd()) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return path.basename(target);
  return relative.split(path.sep).join("/");
}

function collectMediaFiles(mediaDir, { maxDepth = 4 } = {}) {
  const waveFiles = [];
  const ignored = [];
  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new ConformInputError(`媒体目录不可读：${displayPath(current)}（${error.message}）`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (WAVE_FILE_PATTERN.test(entry.name)) waveFiles.push(full);
      else ignored.push(full);
    }
  };
  walk(mediaDir, 0);
  return { waveFiles, ignored };
}

/**
 * 把磁盘上的一个 WAV 变成判定层认识的 probe。
 * 读头失败不抛错：记 readable=false，判定层会把它当「证据不可用」而不是「证据反对」。
 */
async function probeFile(fullPath, mediaDir) {
  const relative = path.relative(mediaDir, fullPath).split(path.sep).join("/");
  let stat = null;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    stat = null;
  }
  const base = {
    path: relative,
    name: path.basename(fullPath),
    bytes: stat ? stat.size : null,
    readable: true,
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    durationSamples: null,
    bext: { present: false, timeReference: null },
    ixml: { present: false, timeReference: null },
    ltc: null,
    record: null,
    scanError: null,
  };
  try {
    const blob = await fs.openAsBlob(fullPath);
    const file = new File([blob], base.name);
    const record = await scanWave({ name: base.name, getFile: async () => file }, { relativePath: relative, parentPath: "" });
    return {
      ...base,
      sampleRate: record.sampleRate,
      channels: record.channels,
      bitsPerSample: record.bitsPerSample,
      durationSamples: record.durationSamples,
      bext: record.hasBext
        ? { present: true, timeReference: record.oldTimeReference }
        : { present: false, timeReference: null },
      // scanWave 在 bext 缺失时会回落到 iXML，两处都读，判定层需要区分来源。
      ixml: record.ixmlInfo && !record.hasBext
        ? { present: true, timeReference: record.oldTimeReference }
        : { present: false, timeReference: null },
      record,
    };
  } catch (error) {
    return { ...base, readable: false, scanError: error.message };
  }
}

async function decodeProbeLtc(probe, { scanSeconds }) {
  if (!probe.record) return { status: "error", error: probe.scanError || "文件未成功解析" };
  try {
    const decoder = createLtcDecoder({
      readDataView,
      candidateFpsValues: () => LTC_FPS_CANDIDATES,
      defaultFpsValue: () => "25",
      fpsSelectLabel: (value) => value,
    });
    const readChannel = decoder.readChannel.bind(decoder);
    decoder.readChannel = (record, channelIndex) => readChannel(record, channelIndex, scanSeconds);
    const auto = await decoder.detectAuto(probe.record, parseFps("25"));
    const best = auto.best;
    if (!best) {
      return { status: "none", failure: ltcFailureSummary([{ record: probe.record, channelReports: auto.channelReports, candidates: auto.results }]) };
    }
    return {
      status: "locked",
      // precise:false -> 取最近的整帧标签；LTC 本身是帧率的，给亚帧小数会诱使调用方
      // 以为精度更高。容差已是 1 帧，取整不会改变判定。
      timecode: samplesToTimecode(best.newTimeReference, probe.sampleRate, parseFps(best.fpsValue), { wrapDay: true, precise: false }),
      fpsValue: best.fpsValue,
      confidence: best.confidence,
      lockedFrames: best.lockedFrames,
      channelIndex: best.channelIndex,
      samples: best.newTimeReference.toString(),
    };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const listPath = args.positional[0];
  if (!listPath) throw new UsageError("缺少剪辑清单路径（第一个位置参数）");
  if (args.positional.length > 1) throw new UsageError(`多余的参数：${args.positional.slice(1).join(" ")}`);
  if (!args.media) throw new UsageError("缺少 --media <媒体目录>");
  const ltcPolicy = args.ltc === undefined ? DEFAULT_LTC_POLICY : String(args.ltc);
  if (!["auto", "off", "on"].includes(ltcPolicy)) throw new UsageError(`--ltc 只能是 auto / off / on，收到 ${args.ltc}`);
  const options = {
    frameTolerance: parseIntegerOption(args["frame-tolerance"], "--frame-tolerance", { min: 0, max: 10000 }) ?? DEFAULT_FRAME_TOLERANCE_FRAMES,
    durationTolerance: parseIntegerOption(args["duration-tolerance"], "--duration-tolerance", { min: 0, max: 10000 }) ?? DEFAULT_DURATION_TOLERANCE_FRAMES,
    maxUnverifiedRatio: args["max-unverified-ratio"] === undefined
      ? DEFAULT_MAX_UNVERIFIED_RATIO
      : parseFloat(args["max-unverified-ratio"]),
    ltcPolicy,
    ltcScanSeconds: parseIntegerOption(args["ltc-scan-seconds"], "--ltc-scan-seconds", { min: 1, max: 3600 }) ?? DEFAULT_LTC_SCAN_SECONDS,
  };
  if (!Number.isFinite(options.maxUnverifiedRatio) || options.maxUnverifiedRatio < 0 || options.maxUnverifiedRatio > 1) {
    throw new UsageError(`--max-unverified-ratio 必须是 0..1 之间的小数，收到 ${args["max-unverified-ratio"]}`);
  }

  const mediaDir = path.resolve(args.media);
  if (!fs.existsSync(mediaDir) || !fs.statSync(mediaDir).isDirectory()) {
    throw new ConformInputError(`媒体目录不存在或不是目录：${args.media}`);
  }
  let listText;
  try {
    listText = fs.readFileSync(path.resolve(listPath), "utf8");
  } catch (error) {
    throw new ConformInputError(`读不到剪辑清单：${listPath}（${error.message}）`);
  }
  const clipList = parseClipList(listText);

  const { waveFiles, ignored } = collectMediaFiles(mediaDir);
  const probes = [];
  for (const full of waveFiles) probes.push(await probeFile(full, mediaDir));

  const mediaRoot = displayPath(mediaDir);
  let report = buildConformReport({ clipList, probes, options, mediaRoot });

  // 两趟判定：第一趟先拿到「谁需要 LTC」，只对那些文件解 LTC，再重判一次。
  // 这样大目录上不会为了每条 clip 把所有文件都解一遍。
  if (report.ltcRequests.length) {
    const byPath = new Map(probes.map((probe) => [probe.path, probe]));
    const attempted = new Set();
    for (const request of report.ltcRequests) {
      if (attempted.has(request.probePath)) continue;
      attempted.add(request.probePath);
      const probe = byPath.get(request.probePath);
      if (!probe) continue;
      probe.ltc = await decodeProbeLtc(probe, { scanSeconds: options.ltcScanSeconds });
    }
    report = buildConformReport({ clipList, probes, options, mediaRoot });
  }

  report.run = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    nodeVersion: process.version,
    ignoredNonWaveFiles: ignored.length,
    takesDetected: takeGroupCount(detectTakeGroupKeys(probes.filter((probe) => probe.record).map((probe) => probe.record))),
  };

  if (args.report) {
    const outPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  if (!args.quiet && !args.json) {
    process.stdout.write(formatHumanReport(report) + "\n");
    process.stdout.write(`耗时 ${report.run.durationMs} ms（媒体 ${report.media.filesSeen} 个文件 / LTC 扫描 ${report.media.ltcScanned} 个）\n`);
  }
  if (args.report && !args.quiet && !args.json) {
    process.stdout.write(`报告已写入 ${displayPath(path.resolve(args.report))}\n`);
  }
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  const known = error instanceof UsageError || error instanceof ConformInputError;
  process.stderr.write((known ? "" : "内部错误：") + error.message + "\n");
  if (error instanceof UsageError) process.stderr.write(USAGE + "\n");
  process.exitCode = 2;
});
