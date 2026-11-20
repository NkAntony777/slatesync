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
 *   2  输入不可读 / 用法错 / schema 不符 / EDL 解析失败（不认识的记录、字段数不对、
 *      时码非法、只有视频轨没有音频轨……任何一种都不静默跳过）
 *
 * 输入可以是两种：本项目自定义的剪辑清单（clip_list.v1 JSON），或剪辑室直接给的
 * CMX3600 EDL。EDL 会在内存里投影成 clip_list.v1 再走同一套判定，判定层不知道
 * 输入来自哪种格式——这样格式层出错不会污染「三态」的语义。
 *
 * 用法：
 *   node scripts/conform-check.mjs clips.json --media ./media
 *   node scripts/conform-check.mjs turnover.edl --media ./media        （按扩展名识别）
 *   node scripts/conform-check.mjs --edl turnover.edl --media ./media  （显式指定）
 *     [--edl-fps 25]                 EDL 帧率（FCM 只声明丢帧/非丢帧，不声明速率）
 *     [--emit-clip-list out.json]    把 EDL 派生的 clip_list.v1 另存，便于人工补文件名
 *     [--json]                       把机器可读报告打到 stdout
 *     [--report out.json]            另存机器可读报告
 *     [--html out.html]              另存单文件自包含 HTML 报告（给人看的那份）
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
  normalizeClipList,
  parseClipList,
} from "../src/conform-check.js";
import {
  EdlParseError,
  edlToClipList,
  parseCmx3600Edl,
} from "../src/edl-cmx3600.js";
import { assertSelfContainedHtml, renderConformHtml } from "../src/conform-report-html.js";

const USAGE = `用法: node scripts/conform-check.mjs <clip-list.json|turnover.edl> --media <dir> [--json] [--report <out.json>] [--html <out.html>]
  [--edl <file.edl>] [--edl-fps 25] [--emit-clip-list <out.json>]
  [--frame-tolerance N] [--duration-tolerance N] [--max-unverified-ratio R]
  [--ltc auto|off|on] [--ltc-scan-seconds N] [--quiet]

退出码: 0 全部有独立证据 / 1 存在 conflict 或不可判定比例超阈值 / 2 输入不可读、用法错或 EDL 解析失败`;

// 与 scripts/export-sync-package.mjs 同一套自动 LTC 候选帧率，避免两处口径漂移。
const LTC_FPS_CANDIDATES = ["23.976", "24", "25", "29.97", "29.97df", "30", "48", "50", "59.94", "59.94df", "60"];
const WAVE_FILE_PATTERN = /\.(wav|wave|bwf)$/i;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = new Set(["json", "quiet"]);
  const values = new Set([
    "media", "report", "html", "frame-tolerance", "duration-tolerance",
    "max-unverified-ratio", "ltc", "ltc-scan-seconds",
    "edl", "edl-fps", "emit-clip-list",
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

const FPS_SOURCE_LABEL = Object.freeze({
  cli: "--edl-fps 指定",
  "default-dropframe": "时码用分号，按 29.97df 推定",
  default: "未声明，默认 25",
});

/** EDL 溯源摘要。人看的，机器看 report.run.source。 */
function formatEdlSource(source) {
  const lines = [];
  lines.push(
    `EDL 源：${source.file || "(未命名)"}（${source.parser}）`
    + (source.title ? ` TITLE ${source.title}` : "")
    + (source.fcm ? ` / FCM ${source.fcm}` : " / 无 FCM 行"),
  );
  lines.push(
    `帧率 ${source.fps}（${FPS_SOURCE_LABEL[source.fpsSource] || source.fpsSource}）`
    + ` / 事件 ${source.events} 条：音频 ${source.audioEvents}`
    + `、仅视频已排除 ${source.videoOnlyEventsExcluded}`
    + `、dissolve ${source.dissolves}、注释 ${source.comments} 条`,
  );
  lines.push(
    `文件名：从注释解析 ${source.namesResolved} 条 / 未解析 ${source.namesUnresolved} 条`
    + (source.namesUnresolved ? "（未解析的判 unverified，不猜文件名）" : ""),
  );
  if (source.videoOnlyEventsExcluded) {
    lines.push(`已排除的仅视频事件：${source.videoOnlyEventIds.join(", ")}（不参与判定，仅计数）`);
  }
  return lines.join("\n");
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length > 1) throw new UsageError(`多余的参数：${args.positional.slice(1).join(" ")}`);
  let listPath = args.positional[0] || null;
  // EDL 入口：--edl 显式给，或位置参数本身是 .edl（按扩展名识别，方便直接拖文件）。
  let edlPath = args.edl === undefined ? null : String(args.edl);
  if (edlPath && listPath) {
    throw new UsageError(
      `--edl 与位置参数不能同时给：${listPath}。EDL 会派生清单，两份输入互相覆盖`,
    );
  }
  if (!edlPath && listPath && /\.edl$/i.test(listPath)) {
    edlPath = listPath;
    listPath = null;
  }
  if (!edlPath && !listPath) throw new UsageError("缺少输入：剪辑清单路径，或 --edl <file.edl>");
  if (!args.media) throw new UsageError("缺少 --media <媒体目录>");
  if (!edlPath && args["edl-fps"] !== undefined) throw new UsageError("--edl-fps 只在 EDL 输入下有意义");
  if (!edlPath && args["emit-clip-list"] !== undefined) throw new UsageError("--emit-clip-list 只在 EDL 输入下有意义");
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
  // 输入 → clip_list.v1。两条路径在这里汇合，判定层与报告层完全不知道差别。
  let clipList;
  let edlSource = null;
  if (edlPath) {
    let edlText;
    try {
      edlText = fs.readFileSync(path.resolve(edlPath), "utf8");
    } catch (error) {
      throw new ConformInputError(`读不到 EDL：${edlPath}（${error.message}）`);
    }
    const parsed = parseCmx3600Edl(edlText, { fps: args["edl-fps"], fileName: path.basename(edlPath) });
    const draft = edlToClipList(parsed);
    if (args["emit-clip-list"]) {
      const outPath = path.resolve(String(args["emit-clip-list"]));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
      process.stderr.write(`已写出 EDL 派生的剪辑清单：${displayPath(outPath)}（name 为空的条目需要人工补文件名）\n`);
    }
    // allowUnresolvedName：EDL 里没有文件名的条目留空。
    // 只对 EDL 派生路径放宽；直接读 clip_list 文件仍按原 schema 拒绝空 name（退出码 2）。
    clipList = normalizeClipList(draft, { allowUnresolvedName: true });
    edlSource = {
      kind: "edl-cmx3600",
      parser: parsed.parser,
      file: parsed.fileName,
      title: parsed.title,
      fcm: parsed.fcm,
      fps: parsed.fpsValue,
      fpsSource: parsed.fpsSource,
      events: parsed.counts.events,
      audioEvents: parsed.counts.audioEvents,
      videoOnlyEventsExcluded: parsed.counts.videoOnlyEventsExcluded,
      videoOnlyEventIds: parsed.counts.videoOnlyEventIds,
      dissolves: parsed.counts.dissolves,
      dissolveEvents: parsed.dissolves,
      comments: parsed.counts.comments,
      namesResolved: parsed.counts.namesResolved,
      namesUnresolved: parsed.counts.namesUnresolved,
      duplicateEventNumbers: parsed.counts.duplicateEventNumbers,
      eventLines: parsed.events.map((event) => ({
        id: event.id,
        line: event.line,
        track: event.track,
        transition: event.transition,
        dissolveFrames: event.dissolveFrames,
        reel: event.reel,
        name: event.name || null,
        nameSource: event.nameSource,
      })),
    };
  } else {
    let listText;
    try {
      listText = fs.readFileSync(path.resolve(listPath), "utf8");
    } catch (error) {
      throw new ConformInputError(`读不到剪辑清单：${listPath}（${error.message}）`);
    }
    clipList = parseClipList(listText);
  }

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
  // run 是 CLI 的溯源块（不属于三态判定契约）：只在 EDL 输入时多一个 source 字段，
  // clip_list 输入的输出与改动前逐字节一致。
  if (edlSource) report.run.source = edlSource;

  if (args.report) {
    const outPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  // HTML 报告与 JSON 报告出自**同一份内存里的 report 对象**，不是两套逻辑：
  // 渲染是纯函数（report -> HTML 字符串），JSON.stringify 与 renderConformHtml
  // 只是同一份判定的两种形态。
  if (args.html) {
    const outPath = path.resolve(String(args.html));
    const html = renderConformHtml(report);
    // 自包含是硬约束：真的扫一遍渲染结果，查不过就不写文件。
    // 宁可没有报告，也不要一份会偷偷联网、或者带脚本的报告。
    try {
      assertSelfContainedHtml(html);
    } catch (error) {
      throw new ConformInputError(error.message);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, "utf8");
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  if (!args.quiet && !args.json) {
    if (edlSource) process.stdout.write(formatEdlSource(edlSource) + "\n\n");
    process.stdout.write(formatHumanReport(report) + "\n");
    process.stdout.write(`耗时 ${report.run.durationMs} ms（媒体 ${report.media.filesSeen} 个文件 / LTC 扫描 ${report.media.ltcScanned} 个）\n`);
  }
  if (!args.quiet && !args.json) {
    if (args.report) {
      process.stdout.write(`报告已写入 ${displayPath(path.resolve(String(args.report)))}\n`);
    }
    if (args.html) {
      process.stdout.write(
        `HTML 报告已写入 ${displayPath(path.resolve(String(args.html)))}（单文件自包含：无外链、无脚本）\n`,
      );
    }
  }
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  // EDL 解析失败是「输入问题」，退出码 2，并且必须逐条给行号与原因：
  // 只说「解析失败」会让人对着几百行 EDL 猜哪里错了。
  if (error instanceof EdlParseError) {
    process.stderr.write(error.message + "（退出码 2）\n");
    for (const issue of error.issues) {
      process.stderr.write("  " + (issue.line > 0 ? "行 " + issue.line : "文件") + "：" + issue.message + "\n");
      if (issue.text) process.stderr.write("        原文：" + issue.text + "\n");
    }
    process.exitCode = 2;
    return;
  }
  const known = error instanceof UsageError || error instanceof ConformInputError;
  process.stderr.write((known ? "" : "内部错误：") + error.message + "\n");
  if (error instanceof UsageError) process.stderr.write(USAGE + "\n");
  process.exitCode = 2;
});
