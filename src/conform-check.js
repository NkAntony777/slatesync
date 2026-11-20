// 合板校验层（conform_check.v1）：用「独立见证」判断剪辑清单里的每条 clip
// 是否真的连到了它声称的那条 take，而不是相信 NLE，也不是相信操作者。
//
// 为什么要有这个模块（一句话）：时间线「连得顺」是最危险的信号——调研里
// Resolve 在真实 turnover 上 878/882 个片段都能连上，其中 734 个（84%）连错，
// 而且 no error / no warning。所以需要一个只认证据、宁可不给结论的独立见证层。
//
// 本模块的职责边界（与 src/delivery-check.js 对齐，同样是纯逻辑层）：
//   - 纯函数：不碰 DOM、不读盘、不 import node:fs。媒体事实由调用方以
//     「probe」对象的形式喂进来（scripts/conform-check.mjs 负责扫描媒体目录）。
//     这样同一份判定既能跑在 Node CLI / CI，也能跑在浏览器里选好的目录上。
//   - 输入畸形一律收敛成错误列表/不可判定态，绝不抛到调用方脸上。
//   - 工具给不出结论时说「给不出结论」（unverified），比给一个看着像结论的
//     布尔诚实。unverified !== 错，conflict === 证据互相矛盾。
//
// 证据源全部复用已有模块，不另造：
//   - 时码数学与帧率/drop-frame 归一：src/timecode.js（parseFps /
//     timecodeToFrames / fpsRate / frac 代数）。本模块不做任何裸帧率换算，
//     所有比较都先化成「一天里的精确有理秒数」再比，因此 25 / 29.97DF /
//     23.976 混用时不会出现把 DF 帧数当 NDF 帧数算的错。
//   - 文件内嵌时码（BWF bext.TimeReference / iXML TIMESTAMP_SAMPLES_SINCE_MIDNIGHT）
//     的读取端是 src/wave.js 的 scanWave；写入端是 src/wave-time-reference.js
//     （合板流程用它把 LTC 解出的起始时码写回文件，所以「写入方」与
//     「校验方」互为对照，不是两套各自实现的时间码）。
//   - LTC：src/ltc-decoder.js 的 detectAuto（含鲁棒 PLL、软同步纠错）。
//   - 时长/采样率：src/wave.js 的 scanWave。
//   - take 归属：src/grouping.js 的 detectTakeGroupKeys。
//
// 本模块不做：EDL / ALE / OTIO / FCPXML 解析。那是后续「格式层」的事，
// v1 只定义并消费本项目自定义的最小剪辑清单（clip_list.v1）。

import {
  addFrac,
  divFrac,
  frac,
  fpsRate,
  framesToTimecode,
  mulFrac,
  normalizeTimeReference,
  parseFps,
  timecodeToFrames,
  timecodeSeparator,
} from "./timecode.js";

/** 校验契约版本。输出 JSON 的 contract 字段固定写这个值。 */
export const CONFORM_CHECK_CONTRACT = "conform_check.v1";

/** 输入剪辑清单的 schema 名。 */
export const CLIP_LIST_SCHEMA = "clip_list.v1";

/** 三态判定。没有第四种「错但没证据」的状态——拿不出证据就是 unverified。 */
export const CONFORM_VERDICTS = Object.freeze({
  SUPPORTED: "supported",
  UNVERIFIED: "unverified",
  CONFLICT: "conflict",
});

/**
 * 证据强度。
 * - identifier：操作者自己声明的东西（文件名、卷号、时间线入出）。它不是独立见证，
 *   命中只说明「清单和文件名对上了」，不能证明文件里装的就是那条 take。
 * - strong：写进文件内容的第三方/机器证据（BWF bext 起始时码、iXML 时间戳、LTC）。
 * - weak：内容派生但可巧合的度量（时长、采样率、take 分组归属）。
 *
 * supported 的判定门槛：至少一条 strong 证据通过、且没有任何一条证据 fail。
 * 只有 identifier + weak 全通过时给 unverified，并写明「无独立见证」。
 */
export const EVIDENCE_STRENGTH = Object.freeze({
  IDENTIFIER: "identifier",
  WEAK: "weak",
  STRONG: "strong",
});

/** 单项证据的状态。missing 不是 fail：找不到证据不等于证据反对。 */
export const EVIDENCE_STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  MISSING: "missing",
  NA: "na",
});

/**
 * 容差与门槛的默认值。全部是具名常量，改这里就能改变判定，CLI 可逐项覆盖。
 *
 * FRAME_TOLERANCE_FRAMES = 1（帧级容差）
 *   bext.TimeReference 是「自午夜起的采样数」，是采样级精确的；剪辑清单里的
 *   源入/出是帧量化的。23.976 / 29.97 / 59.94 这类非整数帧率下，一帧不是整数个
 *   采样（48000 Hz / 29.97 = 1601.6 采样每帧），所以「采样边界换算成帧」本身
 *   就可能偏出半帧；再加现场录音常在 take 头部留不足一帧的 pre-roll，
 *   1 帧容差把这些无害的取整吸收掉。反过来，连错 take 的偏差量级是秒级，
 *   1 帧完全不够掩盖它——这就是这个容差能成立的依据。
 * DURATION_TOLERANCE_FRAMES = 1（时长容差）
 *   WAV 头里的 data chunk 是采样级精确的，但清单里的 sourceOut 到底是
 *   「最后一帧」还是「最后一帧之后」没有统一约定，两种写法差 1 帧；同时
 *   非整数帧率下 durationSamples 换算成帧也可能取整差 1。所以给 1 帧。
 * MAX_UNVERIFIED_RATIO = 0（不可判定比例门槛）
 *   作为 CI 门禁，默认「只要有一条 clip 给不出独立见证就不放过」：宁可靠人放行，
 *   也不让「我不知道」悄悄变成绿灯。确实有拿不到内嵌时码也不接 LTC 的素材时，
 *   用 --max-unverified-ratio 显式声明一个可接受比例，把责任写回给人。
 * LTC_MIN_CONFIDENCE = 0.6
 *   低于这个置信度的 LTC 锁不当证据用（宁可 missing 也不拿错锁当见证）。
 *   与 scripts/export-sync-package.mjs 里自动 LTC 的 confidence>=0.6 门槛一致。
 */
export const DEFAULT_FRAME_TOLERANCE_FRAMES = 1;
export const DEFAULT_DURATION_TOLERANCE_FRAMES = 1;
export const DEFAULT_MAX_UNVERIFIED_RATIO = 0;
export const LTC_MIN_CONFIDENCE = 0.6;
export const DEFAULT_LTC_SCAN_SECONDS = 60;
export const DEFAULT_LTC_POLICY = "auto";

/** 剪辑清单允许的顶层字段。多一个字段就是 schema 不符（退出码 2）。 */
export const CLIP_LIST_TOP_FIELDS = new Set(["schema", "fps", "clips", "note"]);
/** 单条 clip 允许的字段。 */
export const CLIP_FIELDS = new Set([
  "id", "name", "reel", "sourceIn", "sourceOut", "timelineIn", "timelineOut", "fps", "note",
]);

export class ConformInputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ConformInputError";
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 有理数小工具：只做 frac 代数（加减/比较/取绝对值），不做任何时码换算。
// 时码 <-> 帧 <-> 秒的全部换算都走 src/timecode.js。
// ---------------------------------------------------------------------------

const negate = (a) => frac(-a.n, a.d);
const subtract = (a, b) => addFrac(a, negate(b));
const absolute = (a) => (a.n < 0n ? negate(a) : a);
const compareFrac = (a, b) => {
  const d = subtract(a, b);
  return d.n === 0n ? 0 : d.n < 0n ? -1 : 1;
};
/** 采样数 -> 秒（精确有理数）。 */
const secondsFromSamples = (samples, sampleRate) => frac(samples, BigInt(sampleRate));
/** 一天里的秒（frac）-> 指定帧率下的帧数（frac，非整数帧是常态）。 */
const framesAt = (seconds, fps) => mulFrac(seconds, fpsRate(fps));
/** 帧数 -> 秒（精确有理数，DF 已由 timecodeToFrames 处理）。 */
const secondsFromFrames = (frames, fps) => divFrac(frac(frames), fpsRate(fps));
const floorFrames = (seconds, fps) => {
  const frames = framesAt(seconds, fps);
  return frames.n >= 0n ? frames.n / frames.d : -((-frames.n + frames.d - 1n) / frames.d);
};
/** 秒的展示：定宽「整数部分 + 9 位小数」（够看清亚帧级偏差，且机器比对时形态稳定）。 */
function fmtSeconds(a) {
  const negative = a.n < 0n;
  const numerator = negative ? -a.n : a.n;
  const whole = numerator / a.d;
  const rest = numerator - whole * a.d;
  const digits = String((rest * 1000000000n) / a.d).padStart(9, "0");
  return (negative ? "-" : "") + `${whole}.${digits}`;
}
function compareBig(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** 帧容差换算成秒：容差写在「帧」里，比的时候统一换成秒，所以跨帧率可比。 */
function toleranceSeconds(frames, fps) {
  return divFrac(frac(BigInt(frames)), fpsRate(fps));
}

const floorDiv = (seconds, fps) => floorFrames(seconds, fps);

function secondsFromTimecodeAt(timecode, fps) {
  return secondsFromFrames(timecodeToFrames(timecode, fps), fps);
}

// ---------------------------------------------------------------------------
// 输入：剪辑清单（clip_list.v1）
// ---------------------------------------------------------------------------

/**
 * 解析并校验剪辑清单。
 *
 * 最小 schema（v1，JSON only；CSV 留给后续格式层）：
 * {
 *   "schema": "clip_list.v1",
 *   "fps": "25",                        // 顶层默认帧率，clip 可覆盖
 *   "clips": [
 *     {
 *       "id": "clip-001",               // 必填，清单内唯一
 *       "name": "A001_T001.WAV",        // 必填，媒体目录里的文件名
 *       "reel": "A001",                 // 可选，卷号
 *       "sourceIn": "10:00:00:00",      // 必填，源入（该 clip 声称的 take 起点）
 *       "sourceOut": "10:00:06:00",     // 必填，源出
 *       "timelineIn": "01:00:00:00",    // 可选，时间线入（须与 timelineOut 成对）
 *       "timelineOut": "01:00:06:00",   // 可选，时间线出
 *       "fps": "29.97df",               // 可选，覆盖顶层帧率
 *       "note": "..."
 *     }
 *   ]
 * }
 *
 * 严格拒绝未知字段：清单里多写一个字段（拼错 tolerance / sourceTC 之类）会让
 * 校验静默漏掉一项，所以 v1 直接判 schema 不符（退出码 2）。
 */
export function parseClipList(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConformInputError(`剪辑清单不是合法 JSON：${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConformInputError("剪辑清单必须是一个 JSON 对象");
  }
  if (raw.schema !== CLIP_LIST_SCHEMA) {
    throw new ConformInputError(
      `剪辑清单 schema 应为 "${CLIP_LIST_SCHEMA}"，实际为 ${JSON.stringify(raw.schema ?? null)}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!CLIP_LIST_TOP_FIELDS.has(key)) {
      throw new ConformInputError(`剪辑清单含未定义顶层字段：${key}`);
    }
  }
  if (!Array.isArray(raw.clips) || raw.clips.length === 0) {
    throw new ConformInputError("clips 必须是非空数组");
  }
  const defaultFpsValue = raw.fps === undefined ? "25" : String(raw.fps);
  let defaultFps;
  try {
    defaultFps = parseFps(defaultFpsValue);
  } catch (error) {
    throw new ConformInputError(`顶层 fps 无法解析：${error.message}`);
  }
  if (defaultFps.drop === undefined) defaultFps = { ...defaultFps, drop: false };

  const seenIds = new Set();
  const clips = [];
  for (const [index, entry] of raw.clips.entries()) {
    const label = `clips[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConformInputError(`${label} 必须是对象`);
    }
    for (const key of Object.keys(entry)) {
      if (!CLIP_FIELDS.has(key)) throw new ConformInputError(`${label} 含未定义字段：${key}`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new ConformInputError(`${label}.id 必填且为非空字符串`);
    if (seenIds.has(id)) throw new ConformInputError(`${label}.id 重复：${id}`);
    seenIds.add(id);
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new ConformInputError(`${label}.name 必填且为非空字符串（媒体目录里的文件名）`);
    }
    const fpsValue = entry.fps === undefined ? defaultFpsValue : String(entry.fps);
    let fps;
    try {
      fps = parseFps(fpsValue);
    } catch (error) {
      throw new ConformInputError(`${label}.fps 无法解析：${error.message}`);
    }
    if (fps.drop === undefined) fps = { ...fps, drop: false };
    const sourceIn = parseClaimTimecode(entry.sourceIn, fps, `${label}.sourceIn`);
    const sourceOut = parseClaimTimecode(entry.sourceOut, fps, `${label}.sourceOut`);
    if (compareBig(sourceOut.frames, sourceIn.frames) <= 0) {
      throw new ConformInputError(`${label}.sourceOut 必须晚于 sourceIn`);
    }
    const hasTimelineIn = entry.timelineIn !== undefined && entry.timelineIn !== null;
    const hasTimelineOut = entry.timelineOut !== undefined && entry.timelineOut !== null;
    if (hasTimelineIn !== hasTimelineOut) {
      throw new ConformInputError(`${label}.timelineIn / timelineOut 必须成对出现`);
    }
    const timelineIn = hasTimelineIn ? parseClaimTimecode(entry.timelineIn, fps, `${label}.timelineIn`) : null;
    const timelineOut = hasTimelineOut ? parseClaimTimecode(entry.timelineOut, fps, `${label}.timelineOut`) : null;
    if (timelineIn && timelineOut && compareBig(timelineOut.frames, timelineIn.frames) <= 0) {
      throw new ConformInputError(`${label}.timelineOut 必须晚于 timelineIn`);
    }
    clips.push({
      id,
      name: entry.name.trim(),
      reel: typeof entry.reel === "string" && entry.reel.trim() ? entry.reel.trim() : null,
      note: typeof entry.note === "string" ? entry.note : null,
      fps,
      fpsValue,
      sourceIn,
      sourceOut,
      timelineIn,
      timelineOut,
    });
  }
  return { schema: CLIP_LIST_SCHEMA, fpsValue: defaultFpsValue, fps: defaultFps, clips };
}

function parseClaimTimecode(value, fps, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConformInputError(`${label} 必填且为 "HH:MM:SS:FF" 形式的字符串`);
  }
  const raw = value.trim();
  let frames;
  try {
    frames = timecodeToFrames(raw, fps);
  } catch (error) {
    throw new ConformInputError(`${label} 无法解析（帧率 ${fps.value || "?"}）：${error.message}`);
  }
  return {
    raw,
    frames,
    // 用 framesToTimecode 回显一遍，调用方拿到的期望值是「按该帧率归一后的」形态：
    // DF 与 NDF 的同一个帧号会显示成不同字符串，报告里就不会混淆。
    normalized: framesToTimecode(frames, fps),
    separator: timecodeSeparator(fps),
  };
}

// ---------------------------------------------------------------------------
// 媒体索引（调用方提供）
// ---------------------------------------------------------------------------

/**
 * 建一个按小写文件名索引的媒体索引。重复文件名视为「无法判定该验哪一个」。
 */
export function indexProbes(probes) {
  const byName = new Map();
  for (const probe of probes || []) {
    const key = String(probe.name || "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(probe);
  }
  return {
    probes: probes || [],
    byName,
    lookup(name) {
      const list = byName.get(String(name || "").toLowerCase()) || [];
      if (list.length > 1) return { status: "ambiguous", list };
      return list.length ? { status: "ok", list } : { status: "none", list };
    },
  };
}

// ---------------------------------------------------------------------------
// 单条 clip 的证据链
// ---------------------------------------------------------------------------

function evidenceRow(kind, strength, status, expected, measured, extra = {}) {
  return { kind, strength, status, expected: expected ?? null, measured: measured ?? null, ...extra };
}

function startStampOf(probe) {
  const stamps = [];
  if (probe?.bext?.present && probe.bext.timeReference !== null && probe.bext.timeReference !== undefined) {
    stamps.push({
      kind: "content.bext-time-reference",
      samples: BigInt(probe.bext.timeReference),
      seconds: secondsFromSamples(
        normalizeTimeReference(BigInt(probe.bext.timeReference), probe.sampleRate),
        probe.sampleRate,
      ),
    });
  }
  if (probe?.ixml?.present && probe.ixml.timeReference !== null && probe.ixml.timeReference !== undefined) {
    stamps.push({
      kind: "content.ixml-time-reference",
      samples: BigInt(probe.ixml.timeReference),
      seconds: secondsFromSamples(
        normalizeTimeReference(BigInt(probe.ixml.timeReference), probe.sampleRate),
        probe.sampleRate,
      ),
    });
  }
  return stamps;
}

function durationSecondsOf(probe) {
  if (probe?.durationSamples === null || probe?.durationSamples === undefined) return null;
  return secondsFromSamples(BigInt(probe.durationSamples), probe.sampleRate);
}

function fpsFromLtc(probe) {
  const ltc = probe?.ltc;
  if (!ltc || ltc.status !== "locked" || !ltc.fpsValue) return null;
  try {
    const fps = parseFps(String(ltc.fpsValue));
    return fps.drop === undefined ? { ...fps, drop: false } : fps;
  } catch {
    return null;
  }
}

/**
 * 评一条 clip。
 *
 * @param {object} claim      parseClipList 产出的单条 clip
 * @param {object} index      indexProbes 产出的媒体索引
 * @param {object} options    容差与策略
 * @returns {object} 该 clip 的判定（含 evidence 数组、reasons、alternates、ltcRequest）
 */
export function evaluateClip(claim, index, options = {}) {
  const frameTolerance = Number.isInteger(options.frameTolerance) ? options.frameTolerance : DEFAULT_FRAME_TOLERANCE_FRAMES;
  const durationTolerance = Number.isInteger(options.durationTolerance)
    ? options.durationTolerance
    : DEFAULT_DURATION_TOLERANCE_FRAMES;
  const ltcPolicy = options.ltcPolicy || DEFAULT_LTC_POLICY;
  const fps = claim.fps;
  const frameTolSeconds = toleranceSeconds(frameTolerance, fps);
  const durationTolSeconds = toleranceSeconds(durationTolerance, fps);

  const sourceInSeconds = secondsFromFrames(claim.sourceIn.frames, fps);
  const sourceOutSeconds = secondsFromFrames(claim.sourceOut.frames, fps);
  const spanSeconds = subtract(sourceOutSeconds, sourceInSeconds);

  const lookup = index.lookup(claim.name);
  const candidates = lookup.status === "ok" ? lookup.list : [];
  const reasons = [];
  const suggestions = [];
  const evidence = [];

  // ---- 1. 标识类证据（自我声明，不是独立见证） --------------------------
  if (lookup.status === "none") {
    evidence.push(evidenceRow(
      "identifier.filename",
      EVIDENCE_STRENGTH.IDENTIFIER,
      EVIDENCE_STATUS.MISSING,
      { name: claim.name },
      { matchedFiles: [] },
      {
        detail: "媒体目录里没有这个名字的文件",
        readBy: "调用方扫描媒体目录后按小写文件名精确匹配",
      },
    ));
    reasons.push("media-not-found");
  } else if (lookup.status === "ambiguous") {
    evidence.push(evidenceRow(
      "identifier.filename",
      EVIDENCE_STRENGTH.IDENTIFIER,
      EVIDENCE_STATUS.FAIL,
      { name: claim.name },
      { matchedFiles: lookup.list.map((probe) => probe.path) },
      {
        detail: "媒体目录里有多个同名文件，无法判定该验哪一个",
        readBy: "调用方扫描媒体目录后按小写文件名精确匹配",
      },
    ));
    reasons.push("ambiguous-filename");
  } else {
    const probe = candidates[0];
    evidence.push(evidenceRow(
      "identifier.filename",
      EVIDENCE_STRENGTH.IDENTIFIER,
      EVIDENCE_STATUS.PASS,
      { name: claim.name },
      { matchedFile: probe.path, bytes: probe.bytes ?? null },
      {
        detail: `命中 ${probe.path}`,
        readBy: "调用方扫描媒体目录后按小写文件名精确匹配",
      },
    ));
  }

  if (claim.reel) {
    const reelText = claim.reel.toLowerCase();
    const foundIn = candidates
      .map((probe) => String(probe.path || probe.name || "").toLowerCase())
      .filter((text) => text.includes(reelText));
    evidence.push(evidenceRow(
      "identifier.reel",
      EVIDENCE_STRENGTH.IDENTIFIER,
      foundIn.length ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.MISSING,
      { reel: claim.reel },
      { foundIn: foundIn.length ? foundIn : [] },
      {
        // 卷号在文件名/路径里的写法没有标准，所以「没找到」只记 missing，
        // 绝不因为它把整条 clip 判成 conflict：这是刻意的保守设计。
        detail: foundIn.length
          ? `在 ${foundIn.join(", ")} 里找到卷号`
          : "命中文件里没有出现这个卷号（命名不保证含卷号，故不判失败）",
        readBy: "候选文件路径的大小写不敏感子串匹配",
      },
    ));
  }

  if (claim.timelineIn && claim.timelineOut) {
    const timelineSpan = secondsFromFrames(claim.timelineOut.frames - claim.timelineIn.frames, fps);
    const diff = subtract(spanSeconds, timelineSpan);
    const within = compareFrac(absolute(diff), durationTolSeconds) <= 0;
    evidence.push(evidenceRow(
      "identifier.timeline-span",
      EVIDENCE_STRENGTH.IDENTIFIER,
      within ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
      { sourceSpanFrames: (claim.sourceOut.frames - claim.sourceIn.frames).toString() },
      { timelineSpanFrames: (claim.timelineOut.frames - claim.timelineIn.frames).toString() },
      {
        expectedTimecode: { sourceIn: claim.sourceIn.normalized, sourceOut: claim.sourceOut.normalized },
        measuredTimecode: { timelineIn: claim.timelineIn.normalized, timelineOut: claim.timelineOut.normalized },
        deltaSeconds: fmtSeconds(diff),
        deltaFrames: fmtSeconds(framesAt(absolute(diff), fps)),
        toleranceFrames: durationTolerance,
        detail: within
          ? "时间线入出差与源入出差一致"
          : "时间线入出差与源入出差不一致：剪辑清单自身自相矛盾",
        readBy: "claim.sourceOut - claim.sourceIn 与 claim.timelineOut - claim.timelineIn 逐帧相减",
      },
    ));
    if (!within) reasons.push("timeline-span-mismatch");
  }

  // ---- 2. 内容证据（文件自己携带的第三方/机器见证） --------------------
  const probe = candidates[0] || null;
  const stamps = probe ? startStampOf(probe) : [];
  const mediaSeconds = probe ? durationSecondsOf(probe) : null;
  let noEmbeddedStamp = false;

  if (probe && stamps.length === 0) {
    const why = probe.readable === false ? "文件无法解析" : "文件既没有 BWF bext 也没有 iXML 时间戳";
    evidence.push(evidenceRow(
      "content.embedded-range",
      EVIDENCE_STRENGTH.STRONG,
      EVIDENCE_STATUS.MISSING,
      { timecode: claim.sourceIn.normalized, frames: claim.sourceIn.frames.toString() },
      null,
      { detail: why, readBy: "src/wave.js scanWave 读 bext.TimeReference / iXML TIMESTAMP_SAMPLES_SINCE_MIDNIGHT" },
    ));
    evidence.push(evidenceRow(
      "content.embedded-span",
      EVIDENCE_STRENGTH.STRONG,
      EVIDENCE_STATUS.MISSING,
      { timecode: claim.sourceOut.normalized, frames: claim.sourceOut.frames.toString() },
      null,
      { detail: why, readBy: "src/wave.js scanWave 读 bext.TimeReference / iXML TIMESTAMP_SAMPLES_SINCE_MIDNIGHT" },
    ));
    noEmbeddedStamp = true;
  } else if (probe && stamps.length) {
    // 内嵌时码给出的是「这个文件自己记录的区间」：起点 = bext.TimeReference（或 iXML
    // 时间戳）归一到当天秒数，终点 = 起点 + data chunk 时长。这里判的不是「相等」，
    // 而是「相容」：剪辑清单的 sourceIn 通常不是 take 的第一帧（现场留 pre-roll、
    // 成片只取 take 中一段都是常态），所以正确的问题是
    //   清单声称的入点 / 出点是否落在文件自己记录的区间内（各留帧容差）。
    // 一旦声称区间跑到文件区间之外，这个文件就装不下这条 clip——连错 take 时这是
    // 最直接的信号，偏差量级是秒，而容差只有 1 帧。
    const start = stamps[0].seconds;
    const end = mediaSeconds ? addFrac(start, mediaSeconds) : null;
    const inDelta = subtract(sourceInSeconds, start);
    const inInside = end
      ? compareFrac(inDelta, negate(frameTolSeconds)) >= 0 &&
        compareFrac(subtract(sourceInSeconds, end), frameTolSeconds) <= 0
      : null;
    const inExact = end ? compareFrac(absolute(inDelta), frameTolSeconds) <= 0 : null;
    const beforeFile = end ? compareFrac(inDelta, negate(frameTolSeconds)) < 0 : null;
    evidence.push(evidenceRow(
      "content.embedded-range",
      EVIDENCE_STRENGTH.STRONG,
      probe.readable === false || !end
        ? EVIDENCE_STATUS.MISSING
        : inInside ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
      { timecode: claim.sourceIn.normalized, frames: claim.sourceIn.frames.toString(), seconds: fmtSeconds(sourceInSeconds) },
      {
        claimTimecode: claim.sourceIn.normalized,
        fileStart: framesToTimecode(floorDiv(start, fps), fps),
        fileEnd: end ? framesToTimecode(floorDiv(end, fps), fps) : null,
        fileStartSamples: stamps[0].samples.toString(),
        fileStartSeconds: fmtSeconds(start),
        fileEndSeconds: end ? fmtSeconds(end) : null,
        source: stamps[0].kind,
        sampleRate: probe.sampleRate,
      },
      {
        deltaSeconds: fmtSeconds(inDelta),
        deltaFrames: fmtSeconds(framesAt(inDelta, fps)),
        toleranceFrames: frameTolerance,
        coverage: probe.readable === false || !end
          ? "unknown"
          : inInside ? (inExact ? "exact" : "inside") : beforeFile ? "before-file" : "after-file",
        detail: probe.readable === false
          ? "文件无法解析，内嵌时码不可用"
          : !end
            ? "拿不到文件时长，无法判断声称区间是否落在文件内"
            : inInside
              ? (inExact
                ? "清单声称的源入就是文件自身记录的起点"
                : "清单声称的源入落在文件自身记录的区间内")
              : beforeFile
                ? "文件自身记录的起点晚于清单声称的源入：这个文件里没有这段素材"
                : "清单声称的源入晚于文件自身记录的终点：这个文件里没有这段素材",
        readBy: "src/wave.js scanWave 读 bext.TimeReference / iXML TIMESTAMP_SAMPLES_SINCE_MIDNIGHT -> normalizeTimeReference 归一到当天秒数，加上 data chunk 时长得到文件区间；与 timecodeToFrames(sourceIn, fps)/fpsRate 比",
      },
    ));
    if (!inInside) reasons.push("embedded-range-mismatch");

    const outDelta = end ? subtract(end, sourceOutSeconds) : null;
    const outInside = end
      ? compareFrac(outDelta, negate(durationTolSeconds)) >= 0 &&
        compareFrac(subtract(sourceOutSeconds, start), negate(frameTolSeconds)) >= 0
      : null;
    evidence.push(evidenceRow(
      "content.embedded-span",
      EVIDENCE_STRENGTH.STRONG,
      probe.readable === false || !end
        ? EVIDENCE_STATUS.MISSING
        : outInside ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
      { timecode: claim.sourceOut.normalized, frames: claim.sourceOut.frames.toString(), seconds: fmtSeconds(sourceOutSeconds) },
      {
        claimTimecode: claim.sourceOut.normalized,
        fileEnd: end ? framesToTimecode(floorDiv(end, fps), fps) : null,
        fileEndSeconds: end ? fmtSeconds(end) : null,
        durationSamples: String(probe.durationSamples ?? ""),
        sampleRate: probe.sampleRate,
      },
      {
        deltaSeconds: outDelta ? fmtSeconds(outDelta) : null,
        deltaFrames: outDelta ? fmtSeconds(framesAt(outDelta, fps)) : null,
        toleranceFrames: durationTolerance,
        detail: probe.readable === false
          ? "文件无法解析，内嵌时码不可用"
          : !end
            ? "拿不到文件时长"
            : outInside
              ? "文件自身记录的终点覆盖到清单声称的源出（容差内）"
              : "文件自身记录的终点早于清单声称的源出：文件里没有这么长",
        readBy: "文件区间终点秒数与 sourceOut 秒数相减（>= -容差 为通过）",
      },
    ));
    if (!outInside) reasons.push("embedded-span-mismatch");
  }

  // ---- 2b. 时长（弱证据：可巧合，不足以单独支撑 supported） -------------
  if (probe && mediaSeconds) {
    // 单向判定：文件必须装得下清单声称的这段素材。文件比这段长是常态
    // （整条 take 只用了其中一段），所以「长」不是问题，「不够长」才是。
    const diff = subtract(mediaSeconds, spanSeconds);
    const within = compareFrac(diff, negate(durationTolSeconds)) >= 0;
    evidence.push(evidenceRow(
      "content.duration",
      EVIDENCE_STRENGTH.WEAK,
      probe.readable === false ? EVIDENCE_STATUS.MISSING : within ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
      {
        spanTimecode: `${claim.sourceIn.normalized} -> ${claim.sourceOut.normalized}`,
        spanFrames: (claim.sourceOut.frames - claim.sourceIn.frames).toString(),
        spanSeconds: fmtSeconds(spanSeconds),
      },
      {
        durationSamples: String(probe.durationSamples ?? ""),
        sampleRate: probe.sampleRate,
        seconds: fmtSeconds(mediaSeconds),
      },
      {
        deltaSeconds: fmtSeconds(diff),
        deltaFrames: fmtSeconds(framesAt(absolute(diff), fps)),
        toleranceFrames: durationTolerance,
        detail: within
          ? "媒体时长足以装下清单声称的这段素材（时长够不等于身份对，仅作弱证据）"
          : "媒体时长短于清单声称的这段素材",
        readBy: "src/wave.js scanWave 的 data chunk 尺寸 -> 采样数 -> 秒数，与 (sourceOut - sourceIn) 秒数比",
      },
    ));
    if (!within) reasons.push("duration-too-short");
  } else if (probe) {
    evidence.push(evidenceRow(
      "content.duration",
      EVIDENCE_STRENGTH.WEAK,
      EVIDENCE_STATUS.MISSING,
      { spanFrames: (claim.sourceOut.frames - claim.sourceIn.frames).toString() },
      null,
      { detail: probe.readable === false ? "文件无法解析" : "拿不到文件时长", readBy: "src/wave.js scanWave 的 data chunk" },
    ));
  }

  // ---- 2c. LTC（最强的独立见证：声音本身携带的时码） -------------------
  const ltc = probe?.ltc;
  const ltcFps = fpsFromLtc(probe);
  if (probe && ltc && ltc.status === "locked" && ltc.confidence >= LTC_MIN_CONFIDENCE && ltcFps) {
    // 与内嵌时码同一个语义：LTC 给出的是「这段音频自己从哪一刻开始跑」，
    // 加上文件时长就是它的区间；判的是清单声称的区间是否落在里面。
    const ltcSeconds = secondsFromTimecodeAt(ltc.timecode, ltcFps);
    const ltcEnd = mediaSeconds ? addFrac(ltcSeconds, mediaSeconds) : null;
    const inInside = ltcEnd
      ? compareFrac(subtract(sourceInSeconds, ltcSeconds), negate(frameTolSeconds)) >= 0 &&
        compareFrac(subtract(sourceInSeconds, ltcEnd), frameTolSeconds) <= 0
      : null;
    const delta = subtract(ltcSeconds, sourceInSeconds);
    const within = inInside;
    evidence.push(evidenceRow(
      "content.ltc-range",
      EVIDENCE_STRENGTH.STRONG,
      within === null ? EVIDENCE_STATUS.MISSING : within ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
      { timecode: claim.sourceIn.normalized, frames: claim.sourceIn.frames.toString(), seconds: fmtSeconds(sourceInSeconds) },
      {
        claimTimecode: claim.sourceIn.normalized,
        ltcStart: ltc.timecode,
        ltcEnd: ltcEnd ? framesToTimecode(floorDiv(ltcEnd, fps), fps) : null,
        fpsValue: String(ltc.fpsValue),
        confidence: ltc.confidence,
        lockedFrames: ltc.lockedFrames ?? null,
        channelIndex: ltc.channelIndex ?? null,
        samples: ltc.samples ?? null,
      },
      {
        deltaSeconds: fmtSeconds(delta),
        deltaFrames: fmtSeconds(framesAt(delta, fps)),
        toleranceFrames: frameTolerance,
        detail: within === null
          ? "拿不到文件时长，无法判断 LTC 区间是否覆盖声称区间"
          : within
            ? "解码出的 LTC 区间覆盖清单声称的源入（音频自己携带的时码）"
            : "解码出的 LTC 区间覆盖不了清单声称的源入",
        readBy: "src/ltc-decoder.js detectAuto 解出首帧时码 -> timecodeToFrames / fpsRate 归一秒数，加上文件时长得到区间；与 sourceIn 比",
      },
    ));
    if (!within) reasons.push("ltc-range-mismatch");

    // 内嵌时码与 LTC 是两条互相独立的见证，直接对撞。
    for (const stamp of stamps) {
      const stampDelta = subtract(ltcSeconds, stamp.seconds);
      const agree = compareFrac(absolute(stampDelta), frameTolSeconds) <= 0;
      evidence.push(evidenceRow(
        "content.cross-evidence-agreement",
        EVIDENCE_STRENGTH.STRONG,
        agree ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAIL,
        { stampKind: stamp.kind, timecode: framesToTimecode(floorDiv(stamp.seconds, fps), fps), samples: stamp.samples.toString() },
        { timecode: ltc.timecode, fpsValue: String(ltc.fpsValue), confidence: ltc.confidence },
        {
          deltaSeconds: fmtSeconds(stampDelta),
          deltaFrames: fmtSeconds(framesAt(stampDelta, fps)),
          toleranceFrames: frameTolerance,
          detail: agree
            ? `${stamp.kind} 与 LTC 一致`
            : `${stamp.kind} 与 LTC 互相矛盾：文件内部的见证就不一致，谁也不能单独当证据`,
          readBy: "同一文件里 bext/iXML 起始秒数与 LTC 首帧秒数相减",
        },
      ));
      if (!agree) reasons.push("internal-evidence-disagreement");
    }
  } else if (probe && ltc && ltc.status === "error") {
    evidence.push(evidenceRow(
      "content.ltc-range",
      EVIDENCE_STRENGTH.STRONG,
      EVIDENCE_STATUS.MISSING,
      { timecode: claim.sourceIn.normalized },
      null,
      { detail: `LTC 解码失败：${ltc.error}`, readBy: "src/ltc-decoder.js detectAuto" },
    ));
  } else if (probe && ltc && ltc.status === "none") {
    evidence.push(evidenceRow(
      "content.ltc-range",
      EVIDENCE_STRENGTH.STRONG,
      EVIDENCE_STATUS.MISSING,
      { timecode: claim.sourceIn.normalized },
      null,
      {
        // 「扫过但锁不上」必须和「没扫」分开说，否则报告会骗人。
        detail: `已扫描 LTC 但没有锁定：${ltc.failure?.message || "未找到可用的时码帧"}`,
        readBy: "src/ltc-decoder.js detectAuto + src/ltc-signal.js ltcFailureSummary",
      },
    ));
  } else if (probe) {
    evidence.push(evidenceRow(
      "content.ltc-range",
      EVIDENCE_STRENGTH.STRONG,
      EVIDENCE_STATUS.MISSING,
      { timecode: claim.sourceIn.normalized },
      null,
      {
        detail: probe.readable === false
          ? "文件无法解析"
          : "未扫描 LTC（该条尚未触发 LTC 扫描策略，或扫描后没有拿到足够置信的锁）",
        readBy: "src/ltc-decoder.js detectAuto",
      },
    ));
  }

  // ---- 3. 三态判定 -----------------------------------------------------
  const failing = evidence.filter((row) => row.status === EVIDENCE_STATUS.FAIL);
  const strongPasses = evidence.filter(
    (row) => row.strength === EVIDENCE_STRENGTH.STRONG && row.status === EVIDENCE_STATUS.PASS,
  );
  let verdict;
  if (failing.length) verdict = CONFORM_VERDICTS.CONFLICT;
  else if (strongPasses.length) verdict = CONFORM_VERDICTS.SUPPORTED;
  else {
    verdict = CONFORM_VERDICTS.UNVERIFIED;
    if (!reasons.length) reasons.push("no-independent-witness");
  }
  // 证据链里如实记下「没有内嵌时码」，但只有当结论不是 supported 时才把它列为原因：
  // 靠 LTC 支撑起来的 clip 不该被这一条误解成「缺证据」。
  if (noEmbeddedStamp && verdict !== CONFORM_VERDICTS.SUPPORTED) reasons.unshift("no-embedded-timecode");
  if (verdict === CONFORM_VERDICTS.SUPPORTED && !reasons.length) reasons.push("independent-witness");

  // ---- 4. 是否需要补一轮 LTC（交给调用方执行，再回来重评） --------------
  let ltcRequest = null;
  if (probe && probe.readable !== false && ltcPolicy !== "off" && ltcPolicy !== "none") {
    const noStamp = stamps.length === 0;
    const disagreeing = verdict === CONFORM_VERDICTS.CONFLICT;
    if (ltcPolicy === "on" || noStamp || disagreeing) {
      ltcRequest = {
        probePath: probe.path,
        reason: ltcPolicy === "on" ? "ltc-policy-on" : noStamp ? "no-embedded-stamp" : "verdict-conflict",
      };
    }
  }

  // ---- 5. 候选替代：媒体目录里还有谁覆盖清单声称的这段 ------------------
  const alternates = [];
  if (verdict !== CONFORM_VERDICTS.SUPPORTED && probe) {
    for (const other of index.probes) {
      if (!other || other === probe || other.readable === false) continue;
      const otherStamps = startStampOf(other);
      if (!otherStamps.length) continue;
      const otherStart = otherStamps[0].seconds;
      const otherDuration = durationSecondsOf(other);
      if (!otherDuration) continue;
      const otherEnd = addFrac(otherStart, otherDuration);
      const coversStart = compareFrac(otherStart, addFrac(sourceInSeconds, frameTolSeconds)) <= 0;
      const coversEnd = compareFrac(otherEnd, subtract(sourceOutSeconds, durationTolSeconds)) >= 0;
      if (!coversStart || !coversEnd) continue;
      const distance = absolute(subtract(otherStart, sourceInSeconds));
      alternates.push({
        path: other.path,
        startTimecode: framesToTimecode(floorDiv(otherStart, fps), fps),
        endTimecode: framesToTimecode(floorDiv(otherEnd, fps), fps),
        startDeltaFrames: fmtSeconds(framesAt(distance, fps)),
      });
    }
    alternates.sort((a, b) => Number(a.startDeltaFrames) - Number(b.startDeltaFrames));
    if (alternates.length) {
      suggestions.push(
        `媒体目录里 ${alternates.slice(0, 3).map((alt) => alt.path).join(", ")} 覆盖清单声称的源区间（距声称入点 ${alternates[0].startDeltaFrames} 帧）`,
      );
    }
  }

  return {
    id: claim.id,
    claim: {
      name: claim.name,
      reel: claim.reel,
      fps: claim.fpsValue,
      dropFrame: Boolean(fps.drop),
      sourceIn: claim.sourceIn.normalized,
      sourceInFrames: claim.sourceIn.frames.toString(),
      sourceOut: claim.sourceOut.normalized,
      sourceOutFrames: claim.sourceOut.frames.toString(),
      spanFrames: (claim.sourceOut.frames - claim.sourceIn.frames).toString(),
      timelineIn: claim.timelineIn ? claim.timelineIn.normalized : null,
      timelineOut: claim.timelineOut ? claim.timelineOut.normalized : null,
      note: claim.note,
    },
    verdict,
    reasons,
    evidence,
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      sampleRate: candidate.sampleRate ?? null,
      channels: candidate.channels ?? null,
      bitsPerSample: candidate.bitsPerSample ?? null,
      durationSamples: String(candidate.durationSamples ?? ""),
      hasBext: Boolean(candidate.bext?.present),
      hasIxml: Boolean(candidate.ixml?.present),
      ltc: candidate.ltc ? { status: candidate.ltc.status, timecode: candidate.ltc.timecode ?? null } : null,
    })),
    ltcRequest,
    alternates,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export function summarize(results) {
  const counts = {
    [CONFORM_VERDICTS.SUPPORTED]: 0,
    [CONFORM_VERDICTS.UNVERIFIED]: 0,
    [CONFORM_VERDICTS.CONFLICT]: 0,
  };
  for (const result of results) counts[result.verdict] += 1;
  return {
    clips: results.length,
    supported: counts[CONFORM_VERDICTS.SUPPORTED],
    unverified: counts[CONFORM_VERDICTS.UNVERIFIED],
    conflict: counts[CONFORM_VERDICTS.CONFLICT],
    unverifiedRatio: results.length ? counts[CONFORM_VERDICTS.UNVERIFIED] / results.length : 0,
  };
}

const EXIT_MEANINGS = Object.freeze({
  0: "全部 clip 都有独立证据支撑",
  1: "存在证据矛盾（conflict），或不可判定比例超过阈值",
  2: "输入不可读 / 用法错 / schema 不符",
});

function summarizeLtcUse(results) {
  let scanned = 0;
  let decoded = 0;
  const seen = new Set();
  for (const result of results) {
    if (!result.ltcRequest) continue;
    if (seen.has(result.ltcRequest.probePath)) continue;
    seen.add(result.ltcRequest.probePath);
    scanned += 1;
    const candidate = result.candidates[0];
    if (candidate?.ltc?.status === "locked") decoded += 1;
  }
  return { scanned, decoded };
}

/**
 * 组装机器可读报告。
 *
 * @param {object} input { clipList, probes, options, mediaRoot }
 */
export function buildConformReport(input) {
  const { clipList, probes = [], options = {}, mediaRoot = "" } = input;
  const index = indexProbes(probes);
  const results = clipList.clips.map((claim) => evaluateClip(claim, index, options));
  const summary = summarize(results);
  const maxUnverifiedRatio = Number.isFinite(options.maxUnverifiedRatio)
    ? options.maxUnverifiedRatio
    : DEFAULT_MAX_UNVERIFIED_RATIO;
  const exitCode = resolveExitCode(summary, maxUnverifiedRatio);
  const ltcRequests = results
    .filter((result) => result.ltcRequest)
    .map((result) => ({ clipId: result.id, ...result.ltcRequest }));
  const used = summarizeLtcUse(results);
  const synthetic = probes.some((probe) => /_stub/i.test(probe.name || probe.path || ""));

  return {
    contract: CONFORM_CHECK_CONTRACT,
    clipListSchema: CLIP_LIST_SCHEMA,
    mediaRoot,
    options: {
      frameToleranceFrames: options.frameTolerance ?? DEFAULT_FRAME_TOLERANCE_FRAMES,
      durationToleranceFrames: options.durationTolerance ?? DEFAULT_DURATION_TOLERANCE_FRAMES,
      maxUnverifiedRatio,
      ltcPolicy: options.ltcPolicy || DEFAULT_LTC_POLICY,
      ltcScanSeconds: options.ltcScanSeconds ?? DEFAULT_LTC_SCAN_SECONDS,
    },
    syntheticStubMedia: synthetic,
    media: {
      filesSeen: probes.length,
      waveFilesReadable: probes.filter((probe) => probe.readable !== false).length,
      waveFilesUnreadable: probes.filter((probe) => probe.readable === false).length,
      withEmbeddedStart: probes.filter((probe) => startStampOf(probe).length > 0).length,
      ltcDecoded: used.decoded,
      ltcScanned: used.scanned,
    },
    summary,
    exitCode,
    exitMeaning: EXIT_MEANINGS[String(exitCode)] || "",
    ltcRequests,
    clips: results,
  };
}

/** 退出码。1 只在「证据说不了」或「阈值被人显式放宽」之外收紧，不放大。 */
export function resolveExitCode(summary, maxUnverifiedRatio = DEFAULT_MAX_UNVERIFIED_RATIO) {
  if (summary.conflict > 0) return 1;
  if (summary.unverifiedRatio > maxUnverifiedRatio) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 人类可读摘要
// ---------------------------------------------------------------------------

export function formatHumanReport(report) {
  const lines = [];
  lines.push(`conform ${report.contract} | 媒体目录 ${report.mediaRoot || "."} | ${report.media.filesSeen} 个文件`);
  lines.push(
    `容差：帧 ${report.options.frameToleranceFrames} 帧 / 时长 ${report.options.durationToleranceFrames} 帧 / 不可判定比例上限 ${report.options.maxUnverifiedRatio} / LTC ${report.options.ltcPolicy}`,
  );
  if (report.syntheticStubMedia) {
    lines.push("注意：媒体文件名含 _stub，属合成素材，未在真实拍摄素材上验证。");
  }
  lines.push("");
  for (const clip of report.clips) {
    const verdict = clip.verdict;
    const tag = verdict === "supported" ? "OK  " : verdict === "conflict" ? "FAIL" : "??? ";
    lines.push(
      `[${tag}] ${clip.id}  ${clip.claim.name}  ${clip.claim.sourceIn}->${clip.claim.sourceOut} @ ${clip.claim.fps}`,
    );
    for (const row of clip.evidence) {
      const mark = row.status === "pass" ? "pass" : row.status === "fail" ? "FAIL" : row.status === "missing" ? "----" : "  na";
      lines.push(`        ${mark}  ${row.kind} (${row.strength}) ${row.detail || ""}`);
    }
    if (clip.reasons.length) lines.push(`        原因：${clip.reasons.join(", ")}`);
    for (const suggestion of clip.suggestions) lines.push(`        提示：${suggestion}`);
    if (verdict === "unverified") {
      lines.push("        说明：unverified !== 错。只是没有找到能独立支撑这条连线的证据。");
    }
  }
  lines.push("");
  lines.push(
    `合计：${report.summary.clips} 条 -> supported ${report.summary.supported} / unverified ${report.summary.unverified} / conflict ${report.summary.conflict}（不可判定比例 ${report.summary.unverifiedRatio.toFixed(2)}）`,
  );
  lines.push(`退出码 ${report.exitCode}：${report.exitMeaning}`);
  return lines.join("\n");
}
