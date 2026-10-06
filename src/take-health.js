// take 级体检（纯数据层）：在合并之前把该发现的问题一次列全，按严重程度分级。
//
// 为什么需要它：现有的校验几乎全是 throw，而且都在"点合并"那一刻才爆发
// （见 poly-combine-controller.js 的 recordsWithPreviewTimecode / recordsWithLtcTimecode
// 与 wave-combine.js 的 validateCombineGroup）。用户合完板进 Resolve 才发现不同步时，
// 已经无法回溯是哪一轨、哪一个数值对不上。
//
// 设计约束：
// - 纯函数、无副作用：不碰 DOM / 浏览器 API / 文件系统。
// - 所有输入由调用方注入（含 parseFps），因此可以被 node --test 直接调用。
// - 绝不抛错：字段缺失、类型不对、BigInt/String 混用都只产出 finding 或被忽略。
//
// 分组与 channel key 约定一律复用既有实现，不另起一套命名规则：
// - take 归组：grouping.js 的 groupKeyFor / shortGroupLabel / isTakeTrackFor
// - channel key：poly-export-profiles.js 的 sourceTrackKey（`${recordKey(record)}:${channelIndex}`）
// - 文件声明帧率：take-fps.js 的 recordFileMetadataFpsValue
// - 输出文件名：wave-combine.js 的 safeWaveBaseName + shortGroupLabel

import {
  groupKeyFor,
  isTakeTrackFor,
  recordKey,
  recordLabel,
  shortGroupLabel,
} from "./grouping.js";
import { safeWaveBaseName, combineTrackPlan } from "./wave-combine.js";
import { recordFileMetadataFpsValue } from "./take-fps.js";
import { parseFps, samplesToTimecode } from "./timecode.js";

/** 严重程度排序权重；数字越小越靠前。 */
export const SEVERITY_ORDER = Object.freeze({ error: 0, warn: 1, info: 2 });

/** LTC 可信度三态 + 未检测。 */
export const LTC_TRUST = Object.freeze({
  STANDARD: "standard",
  SOFT_SYNC: "soft-sync",
  FAILED: "failed",
  MISSING: "missing",
});

/**
 * code -> severity 的固定契约。
 * 每个 code 的严重程度都是确定的（没有条件分支），方便 UI 做徽章映射、测试做断言。
 * 新增检查时必须同时在这里登记，否则 inspectTakeHealth 的产物无法被测试锁住。
 */
export const TAKE_HEALTH_CODES = Object.freeze({
  // error：会导致合并失败，或合出来的 Poly 时码是错的
  "sample-rate-mismatch": "error",
  "bit-depth-mismatch": "error",
  "audio-format-mismatch": "error",
  "duration-mismatch": "error",
  "start-timeref-mismatch": "error",
  "timecode-source-missing": "error",
  "timecode-source-incomplete": "error",
  "timecode-source-mixed": "error",
  "fps-conflict-in-take": "error",
  "fps-conflict-with-video": "error",
  "all-channels-excluded": "error",
  "duplicate-poly-name": "error",
  // warn：能合出文件，但结果必须人工复核
  "ltc-soft-sync-unverified": "warn",
  "ltc-low-quality": "warn",
  "ltc-low-level-recovered": "warn",
  "ltc-dropframe-mismatch": "warn",
  "ltc-detect-failed": "warn",
  "ltc-source-unconfirmed": "warn",
  "ltc-channel-unconfirmed": "warn",
  // info：提示，不影响结果正确性
  "ltc-not-detected": "info",
  "ltc-named-tech-track": "info",
  "poly-stereo-pair": "info",
  "poly-adaptive-layout": "info",
  "fps-source-fallback": "info",
});

// 兜底算法在实测中对白干扰下错读率约 66%（见 confirm-flows.js 的 confirmSoftSyncWrite）。
const SOFT_SYNC_ERROR_RATE = 66;

const SUPPORTED_AUDIO_FORMATS = Object.freeze({ 1: "PCM", 3: "IEEE Float", 65534: "WAVE_FORMAT_EXTENSIBLE" });

/** 文件名里明确的技术轨命名（不含 ZOOM 的 Tr6 —— 那个已被项目指南明确否定）。 */
const NAMED_TECH_TRACK = /(?:^|[_\-\s])(?:ltc|ltco|ltc[_\-]?out|tc|tc[_\-]?in|timecode|t[_\-]?c)(?:[_\-\s]|$)/i;

// ---------------------------------------------------------------- 基础工具

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 把 Map / 数组 / 键值对集合统一成 Map；都不是就返回空 Map。 */
function toMap(value, keyOf) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    const map = new Map();
    for (const item of value) {
      const key = keyOf ? keyOf(item) : recordKey(item);
      if (key) map.set(key, item);
    }
    return map;
  }
  if (value && typeof value[Symbol.iterator] === "function") {
    const map = new Map();
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) map.set(entry[0], entry[1]);
    }
    return map;
  }
  return new Map();
}

/** BigInt / number / 数字字符串 → 可比较的字符串键。混用类型也不会抛错。 */
function numericKey(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  return String(value);
}

/** 分组统计不同取值，保留"值 -> 记录"映射，方便 detail 里点名文件。 */
function groupValues(entries, valueOf) {
  const groups = new Map();
  for (const { record } of entries) {
    const value = valueOf(record);
    if (value === null || value === undefined || value === "") continue;
    const key = numericKey(value);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { value, records: [] });
    groups.get(key).records.push(record);
  }
  return Array.from(groups.values());
}

function describeValues(groups, format = value => String(value)) {
  return groups.map(group => `${format(group.value)}（${group.records.map(record => recordLabel(record)).join("、")}）`).join("；");
}

function formatDuration(samples, sampleRate) {
  const count = safe(() => Number(samples), NaN);
  const rate = Number(sampleRate);
  if (!Number.isFinite(count) || !Number.isFinite(rate) || rate <= 0) return String(samples ?? "未知");
  return `${(count / rate).toFixed(3)}s`;
}

/**
 * 帧率签名。用注入的 parseFps 归一化成 `n/d|drop`，
 * 这样 23.976 与 23.98 判为相同，而 29.97 与 29.97df 判为不同（DF 标记必须区分）。
 */
function fpsSignature(value, parseFpsFn) {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.trim();
  return safe(() => {
    const fps = parseFpsFn(text);
    const rate = fps?.rate || fps;
    if (!rate || rate.n === undefined || rate.d === undefined) return text.toLowerCase();
    return `${rate.n}/${rate.d}|${fps.drop ? "df" : "ndf"}`;
  }, text.toLowerCase());
}

function fpsLabelText(value) {
  if (typeof value !== "string" || !value.trim()) return "未设置";
  return value.trim();
}

/** 把 TimeReference 样本数显示成时码；缺 fps 或类型异常时退回原始样本数。 */
function timecodeText(samples, sampleRate, fpsValue, parseFpsFn) {
  if (samples === null || samples === undefined) return "";
  return safe(() => {
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate <= 0) return String(samples);
    if (!fpsValue) return `${samples} samples`;
    return samplesToTimecode(BigInt(samples), rate, parseFpsFn(fpsValue), { wrapDay: true });
  }, String(samples));
}

function finding({ takeKey, takeLabel, code, title, detail, records, channels, suggestion }) {
  const item = { takeKey, takeLabel, severity: TAKE_HEALTH_CODES[code] || "info", code, title, detail };
  const keys = (records || []).map(record => recordKey(record)).filter(Boolean);
  if (keys.length) item.records = keys;
  if (channels?.length) item.channels = channels;
  if (suggestion) item.suggestion = suggestion;
  return item;
}

/** error 优先、其次 warn / info；同级按 code 字典序，保证渲染稳定。 */
export function sortFindings(findings) {
  return [...(findings || [])].sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (bySeverity) return bySeverity;
    return String(a.code).localeCompare(String(b.code));
  });
}

function countSeverities(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const item of findings || []) {
    if (counts[item.severity] !== undefined) counts[item.severity] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------- 对外工具

/**
 * channel key，与 poly-export-profiles.js 的 sourceTrackKey 完全同一套约定：
 * `${record.relativePath || record.name}:${channelIndex}`。
 */
export function sourceChannelKey(record, channelIndex) {
  if (!record || typeof record !== "object") return "";
  return `${recordKey(record) || recordLabel(record) || ""}:${channelIndex}`;
}

/** LTC 结果的可信度三态。newTimeReference 缺失视为失败（与 poly-combine-controller 的判定一致）。 */
export function ltcTrustFor(ltcResult) {
  if (!ltcResult || typeof ltcResult !== "object") return LTC_TRUST.MISSING;
  if (ltcResult.ok !== true || ltcResult.newTimeReference === null || ltcResult.newTimeReference === undefined) {
    return LTC_TRUST.FAILED;
  }
  if (ltcResult.softSync === true || ltcResult.requiresConfirmation === true) return LTC_TRUST.SOFT_SYNC;
  return LTC_TRUST.STANDARD;
}

/**
 * 单个分轨的"有效起始时码"。优先级与合并流程一致：有预览用预览，没有用 LTC 原始值，
 * 都没有才退回文件自带的 TimeReference（即确认框里的"使用原始时码"）。
 * 返回 { samples, source, fpsValue, ltc, preview }，samples 为 null 表示确实没有时码。
 */
export function effectiveTimecodeFor(record, options = {}) {
  const none = { samples: null, source: "none", fpsValue: "", ltc: null, preview: null };
  if (!record || typeof record !== "object") return none;
  const { ltcMap = new Map(), previewMap = new Map() } = options;
  const key = recordKey(record);
  const preview = previewMap.get(key);
  if (preview && preview.newTimeReference !== null && preview.newTimeReference !== undefined) {
    return {
      samples: preview.newTimeReference,
      source: "preview",
      fpsValue: preview.fpsValue || preview.fps?.value || "",
      ltc: ltcMap.get(key) || null,
      preview,
    };
  }
  const ltc = ltcMap.get(key);
  if (ltc && ltc.ok === true && ltc.newTimeReference !== null && ltc.newTimeReference !== undefined) {
    return {
      samples: ltc.newTimeReference,
      source: "ltc",
      fpsValue: ltc.fpsValue || ltc.fps?.value || "",
      ltc,
      preview: preview || null,
    };
  }
  if (record && record.oldTimeReference !== null && record.oldTimeReference !== undefined) {
    return { samples: record.oldTimeReference, source: "record", fpsValue: "", ltc: ltc || null, preview: preview || null };
  }
  return none;
}

// ---------------------------------------------------------------- 分项检查

function checkAudioParams({ takeKey, takeLabel, entries, findings }) {
  const sampleRates = groupValues(entries, record => record.sampleRate);
  if (sampleRates.length > 1) {
    findings.push(finding({
      takeKey, takeLabel, code: "sample-rate-mismatch", records: entries.map(entry => entry.record),
      title: "同一 take 的分轨采样率不一致",
      detail: `分轨声明了 ${sampleRates.length} 种采样率：${describeValues(sampleRates, value => `${value} Hz`)}。合并要求采样率一致，强行合并会得到变速且时码错位的结果。`,
      suggestion: "确认这些文件是否来自同一台录音机、同一场录制；如果是重新导出的素材，请统一采样率后重新导入。",
    }));
  }

  const bitDepths = groupValues(entries, record => record.bitsPerSample);
  if (bitDepths.length > 1) {
    findings.push(finding({
      takeKey, takeLabel, code: "bit-depth-mismatch", records: entries.map(entry => entry.record),
      title: "同一 take 的分轨位深不一致",
      detail: `分轨声明了 ${bitDepths.length} 种位深：${describeValues(bitDepths, value => `${value} bit`)}。不同位深不能直接拼成同一个 Poly WAV。`,
      suggestion: "统一导出位深（建议 24 bit PCM）后再合板；已经混进来的文件请从该 take 中移出。",
    }));
  }

  const formats = groupValues(entries, record => record.audioFormat);
  if (formats.length > 1) {
    findings.push(finding({
      takeKey, takeLabel, code: "audio-format-mismatch", records: entries.map(entry => entry.record),
      title: "同一 take 的分轨音频格式不一致",
      detail: `分轨混用了 ${describeValues(formats, value => SUPPORTED_AUDIO_FORMATS[value] || `format ${value}`)}。Poly 只支持 PCM / IEEE Float 混排之外的单一格式。`,
      suggestion: "把浮点与 PCM 素材分开成不同 take，或先统一转换成同一种格式。",
    }));
  }

  const durations = groupValues(entries, record => record.durationSamples);
  if (durations.length > 1) {
    const shortest = durations.reduce((a, b) => (Number(a.value) < Number(b.value) ? a : b));
    const longest = durations.reduce((a, b) => (Number(a.value) > Number(b.value) ? a : b));
    const sampleRate = Number(entries[0]?.record?.sampleRate) || 0;
    findings.push(finding({
      takeKey, takeLabel, code: "duration-mismatch", records: entries.map(entry => entry.record),
      title: "同一 take 的分轨时长不一致",
      detail: `共 ${durations.length} 种时长：${describeValues(durations, value => formatDuration(value, sampleRate))}；最长与最短相差 ${formatDuration(Number(longest.value) - Number(shortest.value), sampleRate)}。本工具不会自动裁切或补静音，这类 take 会被排除在可合并列表之外。`,
      suggestion: "确认是否少录了一段或多录了一段；如需保留较长的部分，请手动裁切后再合板。",
    }));
  }
}

function checkTimecode({ takeKey, takeLabel, entries, resolved, parseFpsFn, findings }) {
  const withTimecode = resolved.filter(item => item.samples !== null && item.samples !== undefined);
  const missing = resolved.filter(item => item.samples === null || item.samples === undefined);

  if (!withTimecode.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "timecode-source-missing", records: entries.map(entry => entry.record),
      title: "这个 take 没有任何可用时码",
      detail: `${entries.length} 个分轨既没有 LTC 检测结果，也没有时码修改预览，文件自身也没有 TimeReference。用它合板只会得到一个没有时间码的 Poly，Resolve 里无法按 Timecode 同步。`,
      suggestion: "先跑 LTC 检测；如果摄影机与录音机都录了同一现场声，也可以用波形同步。",
    }));
    return;
  }

  if (missing.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "timecode-source-incomplete", records: missing.map(item => item.record),
      title: "同一 take 里部分分轨没有时码",
      detail: `${withTimecode.length} 个分轨有时码，但 ${missing.map(item => recordLabel(item.record)).join("、")} 没有任何时码来源。合并时无法给同一个 take 内所有分轨写入一致的起始时码。`,
      suggestion: "对这些文件补跑 LTC 检测，或在预览里给整个 take 统一填入起始时码。",
    }));
  }

  const byValue = new Map();
  for (const item of withTimecode) {
    const key = numericKey(item.samples);
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(item);
  }
  if (byValue.size > 1) {
    const groups = Array.from(byValue.values());
    const fpsValue = withTimecode.find(item => item.fpsValue)?.fpsValue || "";
    findings.push(finding({
      takeKey, takeLabel, code: "start-timeref-mismatch", records: withTimecode.map(item => item.record),
      title: "同一 take 的起始时码不一致",
      detail: `分轨的起始 TimeReference 有 ${byValue.size} 种取值：${groups.map(group => `${timecodeText(group[0].samples, group[0].record.sampleRate, fpsValue, parseFpsFn)}（${group.map(item => recordLabel(item.record)).join("、")}）`).join("；")}。这正是合板后在 Resolve 里不同步的直接原因。`,
      suggestion: "确认每条分轨各自的 LTC 检测结果是否指向同一次开机；如果某个分轨识别错了，重新指定 LTC 声道再检测。",
    }));
  }

  const sources = new Set(withTimecode.map(item => item.source));
  if (sources.size > 1) {
    const bySource = new Map();
    for (const item of withTimecode) {
      if (!bySource.has(item.source)) bySource.set(item.source, []);
      bySource.get(item.source).push(item);
    }
    findings.push(finding({
      takeKey, takeLabel, code: "timecode-source-mixed", records: withTimecode.map(item => item.record),
      title: "同一 take 混用了不同的时码来源",
      detail: `${Array.from(bySource.entries()).map(([source, items]) => `${source === "preview" ? "预览时码" : "LTC 时码"}：${items.map(item => recordLabel(item.record)).join("、")}`).join("；")}。这些数值即使偶然相同，也是在不同规则下算出来的，不应视为一致。`,
      suggestion: "统一用一种来源：要么给整个 take 跑 LTC，要么在整个 take 的预览里填同一个起始时码。",
    }));
  }
}

function checkLtcTrust({ takeKey, takeLabel, entries, ltcMap, findings }) {
  const results = entries.map(entry => ({ record: entry.record, ltc: ltcMap.get(entry.recordKey) }));
  const usable = results.filter(item => item.ltc && item.ltc.ok === true
    && item.ltc.newTimeReference !== null && item.ltc.newTimeReference !== undefined);
  const failed = results.filter(item => item.ltc && (item.ltc.ok !== true
    || item.ltc.newTimeReference === null || item.ltc.newTimeReference === undefined));

  if (!results.some(item => item.ltc)) {
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-not-detected", records: entries.map(entry => entry.record),
      title: "这个 take 还没有跑过 LTC 检测",
      detail: `${entries.length} 个分轨都没有检测记录。检测结果会直接决定起始时码的来源可信度。`,
      suggestion: "在合并前先执行一次 LTC 检测；确认时码器输出接到了哪一路。",
    }));
    return;
  }

  if (failed.length) {
    const partial = usable.length > 0;
    const first = failed[0].ltc;
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-detect-failed", records: failed.map(item => item.record),
      title: partial ? "部分分轨没有检测到 LTC" : "没有检测到可用的 LTC",
      detail: `${partial ? `${failed.length}/${results.length} 个分轨` : "全部"}没有锁定 LTC：${first.statusText || "未锁定时码"}${first.failureCode ? `（${first.failureCode}）` : ""}。${partial ? "这些分轨会拿不到 LTC 时码。" : "这个 take 只能靠预览时码或文件自带时码合板。"}`,
      suggestion: first.suggestion || "确认 LTC 接入了哪一路、提高时码器输出电平后重试。",
    }));
  }

  if (!usable.length) return;

  const soft = usable.filter(item => ltcTrustFor(item.ltc) === LTC_TRUST.SOFT_SYNC);
  if (soft.length) {
    const first = soft[0].ltc;
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-soft-sync-unverified", records: soft.map(item => item.record),
      title: "起始时码来自兜底（软同步）算法，必须人工复核",
      detail: `${soft.length} 个分轨的 LTC 由兜底算法解出：源帧 ${first.sourceTimecode || first.timecode || "未知"}，连续锁定 ${first.lockedFrames ?? 0} 帧。该算法无法与标准算法交叉验证，实测在对白干扰下错读率约 ${SOFT_SYNC_ERROR_RATE}%。`,
      suggestion: "逐条核对起始时码是否与拍板一致；有任何一条对不上就取消合并，并先确认 LTC 声道选对了。",
    }));
  }

  const lowQuality = usable.filter(item => item.ltc.softSync !== true
    && ((Number(item.ltc.qualityRank) || 2) <= 1 || Number(item.ltc.confidence) < 0.6));
  if (lowQuality.length) {
    const first = lowQuality[0].ltc;
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-low-quality", records: lowQuality.map(item => item.record),
      title: "LTC 识别质量偏低",
      detail: `${lowQuality.length} 个分轨的 LTC 置信度 ${Math.round(Number(first.confidence || 0) * 100)}%、仅连续锁定 ${first.lockedFrames ?? 0} 帧、quality ${first.qualityLabel || "低"}。时码可能偏 1 帧或多帧。`,
      suggestion: "与摄影机时码交叉核对后再使用；必要时改用波形同步。",
    }));
  }

  const amplified = usable.filter(item => Number(item.ltc.analysisGain) > 1);
  if (amplified.length) {
    const first = amplified[0].ltc;
    const gainDb = safe(() => (20 * Math.log10(Number(first.analysisGain))).toFixed(1), "?");
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-low-level-recovered", records: amplified.map(item => item.record),
      title: "LTC 电平过低，靠分析增益才恢复",
      detail: `解码时对分析副本加了 +${gainDb} dB 增益才锁上时码（原始音频未被放大）。电平低通常意味着时码器输出偏弱或线路衰减。`,
      suggestion: "与拍板交叉复核后再合板；后续录制把 LTC 输出提到 −20 ~ −10 dBFS。",
    }));
  }

  const dropMismatch = usable.filter(item => item.ltc.dropMismatch === true);
  if (dropMismatch.length) {
    const first = dropMismatch[0].ltc;
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-dropframe-mismatch", records: dropMismatch.map(item => item.record),
      title: "LTC 的 DF 标记与所选帧率不符",
      detail: `音轨里的 drop-frame 标志位与当前设置（${first.fpsValue || first.fpsLabel || "未知"}）不一致。非 DF 时码按 DF 解析（或反过来）会每小时累积约 3.6 秒的偏差。`,
      suggestion: "改用与 LTC 标志位一致的帧率（29.97 ↔ 29.97 DF）重新检测后再合并。",
    }));
  }
}

function checkLtcSource({ takeKey, takeLabel, entries, ltcMap, ltcSourceChannels, excludedChannelKeys, findings }) {
  const usable = entries.filter(entry => ltcTrustFor(ltcMap.get(entry.recordKey)) !== LTC_TRUST.FAILED
    && ltcTrustFor(ltcMap.get(entry.recordKey)) !== LTC_TRUST.MISSING);
  const confirmed = new Set(ltcSourceChannels);

  const sourceChannels = usable
    .map(entry => ltcMap.get(entry.recordKey))
    .filter(ltc => ltc.sourceRecord && ltc.channelIndex !== null && ltc.channelIndex !== undefined)
    .map(ltc => ({ ltc, key: sourceChannelKey(ltc.sourceRecord, ltc.channelIndex) }));

  // 逐条查，而不是"整个 take 都没有才算"：某一条缺来源，就无法确定该从 Poly 里排除哪一路。
  const noSource = usable.filter(entry => {
    const ltc = ltcMap.get(entry.recordKey);
    return !(ltc.sourceRecord && ltc.channelIndex !== null && ltc.channelIndex !== undefined);
  });
  if (noSource.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-source-unconfirmed", records: noSource.map(entry => entry.record),
      title: "时码解出来了，但不知道来自哪一路",
      detail: `${noSource.length} 个分轨的 LTC 结果没有记录来源文件与通道号：${noSource.map(entry => recordLabel(entry.record)).join("、")}。导出时无法确定该把哪一路从 Poly 里排除，Resolve 里可能多出一条 LTC 技术轨，或者误删一条对白。文件名里的 Tr6 只是轨道编号，不能用来推断哪一路是 LTC。`,
      suggestion: "重新检测并在结果里确认来源通道；不要用文件名里的 Tr6 顶替检测结论。",
    }));
  }

  const unbacked = Array.from(confirmed).filter(key => !sourceChannels.some(item => item.key === key));
  if (unbacked.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-channel-unconfirmed", records: entries.map(entry => entry.record),
      title: "被当作 LTC 排除的通道没有检测或人工确认背书",
      detail: `以下通道被计入 LTC 排除列表，但没有任何 LTC 检测结果指向它：${unbacked.join("、")}。如果这一路其实录的是对白，合板后会静默丢轨。`,
      suggestion: "确认这些通道确实是 LTC 而不是对白；把对白通道从排除列表里拿回来。",
    }));
  }

  const namedTech = [];
  for (const entry of entries) {
    for (let channel = 0; channel < (Number(entry.record.channels) || 0); channel++) {
      const key = sourceChannelKey(entry.record, channel);
      if (confirmed.has(key) || sourceChannels.some(item => item.key === key)) continue;
      if (NAMED_TECH_TRACK.test(entry.record.name || "")) namedTech.push(key);
    }
  }
  if (namedTech.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "ltc-named-tech-track", channels: namedTech,
      title: "文件名像技术轨但从未被确认",
      detail: `${namedTech.join("、")} 的文件名带 LTC / TC 标记，但既没有检测结果指向它，也没有被列入已确认的 LTC 通道。`,
      suggestion: "确认它录到的是什么；如果确实是 LTC，请用检测或手动指定来确认，不要只凭文件名。",
    }));
  }

  if (excludedChannelKeys.size) {
    const total = entries.reduce((sum, entry) => sum + (Number(entry.record.channels) || 0), 0);
    const inTake = Array.from(excludedChannelKeys).filter(key => entries.some(entry => key.startsWith(`${entry.recordKey}:`)));
    if (total > 0 && inTake.length >= total) {
      findings.push(finding({
        takeKey, takeLabel, code: "all-channels-excluded", records: entries.map(entry => entry.record),
        channels: inTake,
        title: "排除后这个 take 一条节目轨都不剩",
        detail: `${inTake.length}/${total} 路全部被排除（已确认的 LTC 或手动排除），合板会因为没有可输出的节目音频而中断。`,
        suggestion: "放开至少一条对白通道，或改用保留 LTC 的导出方案。",
      }));
    }
  }
}

function checkFps({ takeKey, takeLabel, entries, resolved, videoFpsValue, ltcMap, parseFpsFn, fpsValueForRecord, findings }) {
  const declared = groupValues(entries, record => fpsValueForRecord(record));
  if (declared.length > 1) {
    findings.push(finding({
      takeKey, takeLabel, code: "fps-conflict-in-take", records: entries.map(entry => entry.record),
      title: "同一 take 的分轨声明了不同帧率",
      detail: `文件元数据里有 ${declared.length} 种帧率：${describeValues(declared, fpsLabelText)}。同一 take 用不同帧率解析时码，帧号会算错。`,
      suggestion: "确认这些文件是否真的属于同一次录制；必要时用 per-take 帧率覆盖统一成一个值。",
    }));
  }

  const cameraFps = videoFpsValue || (() => {
    const fromRecords = groupValues(entries, record => record._video?.fpsValue || record._meta?.fpsValue);
    return fromRecords.length === 1 ? fromRecords[0].value : "";
  })();

  const takeFps = resolved.find(item => item.fpsValue)?.fpsValue
    || ltcMap.get(entries[0]?.recordKey)?.fpsValue
    || declared[0]?.value
    || "";

  if (cameraFps && takeFps && fpsSignature(cameraFps, parseFpsFn) !== fpsSignature(takeFps, parseFpsFn)) {
    findings.push(finding({
      takeKey, takeLabel, code: "fps-conflict-with-video", records: entries.map(entry => entry.record),
      title: "录音时码帧率与视频元数据记录的帧率不一致",
      detail: `视频/ALE 元数据记录的是 ${fpsLabelText(cameraFps)}，而这个 take 的时码按 ${fpsLabelText(takeFps)} 解析。两者不一致时，Resolve 里的 Timecode 同步会整体错位。`,
      suggestion: "以摄影机实际帧率为准：切换帧率后重新检测 LTC，或用 per-take 帧率覆盖。",
    }));
  }

  if (!declared.length && !cameraFps && !takeFps) {
    findings.push(finding({
      takeKey, takeLabel, code: "fps-source-fallback", records: entries.map(entry => entry.record),
      title: "这个 take 没有任何帧率来源",
      detail: "文件里没有 iXML / bext aSPEED，也没有视频或 ALE 元数据，时码只能按界面当前设置解析。",
      suggestion: "确认界面帧率与摄影机一致；建议给这个 take 设一个 per-take 帧率覆盖。",
    }));
  }
}

function checkPolyLayout({ takeKey, takeLabel, entries, excludedChannelKeys, findings }) {
  const tracks = safe(() => combineTrackPlan(entries.map(entry => entry.record)), []);
  const excluded = new Set(excludedChannelKeys);
  const kept = tracks.filter(track => !excluded.has(sourceChannelKey(track.record, track.channelIndex)));
  const channels = tracks.map(track => sourceChannelKey(track.record, track.channelIndex));

  if (tracks.length && !kept.length) {
    findings.push(finding({
      takeKey, takeLabel, code: "all-channels-excluded", records: entries.map(entry => entry.record), channels,
      title: "排除后这个 take 一条节目轨都不剩",
      detail: `${tracks.length} 路全部被排除（已确认的 LTC 或手动排除），合板会因为没有可输出的节目音频而中断。`,
      suggestion: "放开至少一条对白通道，或改用保留 LTC 的导出方案。",
    }));
    return;
  }

  if (kept.length === 2) {
    findings.push(finding({
      takeKey, takeLabel, code: "poly-stereo-pair", records: entries.map(entry => entry.record),
      channels: kept.map(track => sourceChannelKey(track.record, track.channelIndex)),
      title: "合并后是 2 通道，Resolve 会按 Stereo 导入",
      detail: `输出通道为 ${channels.slice(0, 2).join(" 与 ")}。本机实测 DaVinci Resolve 默认把双通道导入为 Stereo，而不是两条独立 Mono 轨。`,
      suggestion: "如果需要分别处理两路麦克风，导入后到 Clip Attributes → Audio 改成 Mono 离散映射。",
    }));
    return;
  }

  if (kept.length >= 3) {
    findings.push(finding({
      takeKey, takeLabel, code: "poly-adaptive-layout", records: entries.map(entry => entry.record),
      channels: kept.map(track => sourceChannelKey(track.record, track.channelIndex)),
      title: `合并后是 ${kept.length} 通道，Resolve 不会自动拆成独立 Mono 轨`,
      detail: `输出通道为 ${kept.length} 路。本机实测 Resolve 默认把 4/5 通道导入为 Adaptive，多通道不会自动拆成每路麦克风一条轨。`,
      suggestion: "导入后到 Clip Attributes → Audio 改为 Mono 离散映射，再逐路做处理。",
    }));
  }
}

// ---------------------------------------------------------------- 主入口

/**
 * 单个 take 的体检。纯函数，缺字段只产出 finding 或跳过，绝不抛错。
 *
 * @param {object} options
 * @param {string} options.takeKey                 take 归组键（grouping.js 的 groupKeyFor）
 * @param {string} [options.takeLabel]             展示名，默认 shortGroupLabel(takeKey)
 * @param {object[]} options.groupRecords          该 take 的分轨
 * @param {Map|Array} [options.ltcResults]         recordKey -> LTC 结果
 * @param {Map|Array} [options.previews]           recordKey -> 时码修改预览
 * @param {Set} [options.ltcSourceChannels]        已确认的 LTC channel key
 * @param {Set} [options.excludedChannelKeys]      会被排除的 channel key（LTC + 手动）
 * @param {string} [options.videoFpsValue]         视频 / ALE 元数据记录的帧率
 * @param {Function} [options.parseFps]            注入的帧率解析函数
 * @param {Function} [options.fpsValueForRecord]   注入的单文件帧率取值函数
 * @returns {object[]} findings，按 severity 排序
 */
export function inspectTakeHealth(options = {}) {
  const {
    takeKey = "",
    takeLabel = shortGroupLabel(takeKey),
    groupRecords = [],
    ltcResults,
    previews,
    ltcSourceChannels = new Set(),
    excludedChannelKeys = new Set(),
    videoFpsValue = "",
    parseFps: parseFpsFn = parseFps,
    fpsValueForRecord = recordFileMetadataFpsValue,
  } = options;

  const findings = [];
  const records = Array.isArray(groupRecords) ? groupRecords.filter(Boolean) : [];
  if (!records.length) return findings;

  const ltcMap = toMap(ltcResults, item => recordKey(item?.record || item));
  const previewMap = toMap(previews);
  const entries = records.map(record => ({ record, recordKey: recordKey(record) }));
  const resolved = entries.map(entry => ({ record: entry.record, ...effectiveTimecodeFor(entry.record, { ltcMap, previewMap }) }));

  safe(() => checkAudioParams({ takeKey, takeLabel, entries, findings }), null);
  safe(() => checkTimecode({ takeKey, takeLabel, entries, resolved, parseFpsFn, findings }), null);
  safe(() => checkLtcTrust({ takeKey, takeLabel, entries, ltcMap, findings }), null);
  safe(() => checkLtcSource({ takeKey, takeLabel, entries, ltcMap, ltcSourceChannels, excludedChannelKeys, findings }), null);
  safe(() => checkFps({ takeKey, takeLabel, entries, resolved, videoFpsValue, ltcMap, parseFpsFn, fpsValueForRecord, findings }), null);
  safe(() => checkPolyLayout({ takeKey, takeLabel, entries, excludedChannelKeys, findings }), null);

  return sortFindings(findings);
}

/**
 * 全部 take 的体检 + 全局汇总。
 *
 * 归组范围刻意比 grouping.js 的 combineEligibleGroupsFor 更宽：那里会先把时长不一致的
 * take 整个过滤掉，用户因此永远看不到"为什么这个 take 不能合"。这里保留时长不一致的 take，
 * 交给 duration-mismatch 这条 finding 说明原因。
 *
 * @returns {{ takes: Array, summary: object }}
 */
export function inspectTakes(options = {}) {
  const {
    records = [],
    takeGroupKeys = new Map(),
    includeUngrouped = false,
    ltcResults,
    previews,
    ltcSourceChannels = new Set(),
    excludedChannelKeys = new Set(),
    videoFpsValue = "",
    parseFps: parseFpsFn = parseFps,
    fpsValueForRecord = recordFileMetadataFpsValue,
  } = options;

  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const groups = new Map();
  for (const record of list) {
    const key = safe(() => groupKeyFor(record, takeGroupKeys), "") || recordKey(record) || recordLabel(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const takes = [];
  for (const [key, groupRecords] of groups) {
    if (!includeUngrouped && !isMergeCandidateTake(groupRecords, takeGroupKeys)) continue;
    const findings = safe(() => inspectTakeHealth({
      takeKey: key,
      takeLabel: shortGroupLabel(key),
      groupRecords,
      ltcResults,
      previews,
      ltcSourceChannels,
      excludedChannelKeys,
      videoFpsValue,
      parseFps: parseFpsFn,
      fpsValueForRecord,
    }), []);
    takes.push({ takeKey: key, takeLabel: shortGroupLabel(key), findings, counts: countSeverities(findings) });
  }

  takes.sort((a, b) => String(a.takeLabel).localeCompare(String(b.takeLabel)));

  const collisions = duplicateOutputNames(takes);
  if (collisions.size) {
    for (const take of takes) {
      const names = collisions.get(`${safeWaveBaseName(take.takeLabel)}_Poly.WAV`.toLowerCase());
      if (!names?.includes(take.takeLabel)) continue;
      const peers = names.filter(label => label !== take.takeLabel);
      take.findings = sortFindings([
        ...take.findings,
        finding({
          takeKey: take.takeKey, takeLabel: take.takeLabel, code: "duplicate-poly-name",
          title: "不同目录的 take 会产生同名 Poly 文件",
          detail: `${take.takeLabel} 与 ${peers.join("、")} 都会输出为 "${safeWaveBaseName(take.takeLabel)}_Poly.WAV"。批量导出到同一个文件夹时后者会覆盖前者。`,
          suggestion: "分批导出，或先把这些 take 改到能区分的目录/名称。",
        }),
      ]);
      take.counts = countSeverities(take.findings);
    }
  }

  const summary = { takeCount: takes.length, findingCount: 0, affectedTakes: 0, ...countSeverities([]) };
  for (const take of takes) {
    summary.findingCount += take.findings.length;
    summary.error += take.counts.error;
    summary.warn += take.counts.warn;
    summary.info += take.counts.info;
    if (take.findings.length) summary.affectedTakes += 1;
  }

  return { takes, summary };
}

/** 与 combineEligibleGroupsFor 相比只放宽"时长必须一致"这一条，其余门槛保持一致。 */
function isMergeCandidateTake(groupRecords, takeGroupKeys) {
  if (groupRecords.length < 2) return false;
  return groupRecords.every(record => isTakeTrackFor(record, takeGroupKeys));
}

function duplicateOutputNames(takes) {
  const collisions = new Map();
  for (const take of takes) {
    const name = `${safeWaveBaseName(take.takeLabel)}_Poly.WAV`.toLowerCase();
    if (!collisions.has(name)) collisions.set(name, []);
    collisions.get(name).push(take.takeLabel);
  }
  for (const [name, labels] of Array.from(collisions.entries())) {
    if (labels.length < 2) collisions.delete(name);
  }
  return collisions;
}
