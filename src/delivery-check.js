// 交付自检（纯逻辑层）：把已经写出去的 Poly WAV 读回来，按交付规范逐条核验。
//
// 为什么要有这个模块：
// src/acceptance-checklist.js 核的是"计划与内存里的统计"——result.clippedSamples、
// 分轨参数是否一致、输出方案选了什么。那些数描述的是"我们打算写什么"，
// 不是"文件里真的有什么"。写出这一环完全可能出岔子：bext 的响度字段没回填成功、
// axml 忘了写、chna 少了一条、位深和计划对不上——这些只有把字节读回来才知道。
// 本模块补的就是这一环：输入写出去的字节，输出一份可判定的检查清单。
//
// 边界：
// - 纯函数。输入就是字节，不碰 DOM、不碰浏览器 API、不读盘。
// - 畸形输入（截断的文件、缺 chunk、字段乱填）一律收敛成 fail / manual，绝不抛错。
//   交付自检是要给人看的报告，不能因为一个坏文件把整个导出流程炸掉。
// - expected 里没给的字段，相关项判 manual（有明确依据的判 na），不猜。
//   工具给不出结论时说"给不出结论"，比给一个看着像结论的数诚实。
//
// 判定依据的出处：
// - EBU Tech 3285：bext chunk 的布局。version 2 在 412–421 字节增加了五个响度字段，
//   单位都是 ×100 的整数（LUFS×100 / LU×100 / dBTP×100），0x8000 表示"未测量"。
// - EBU Tech 3306：axml chunk 里的 ebu_loudness_information，老工具读这个。
// - chna（EBU Tech 3285 补充件 / BW64 的通道分配）：uint16 通道数，然后每条 80 字节
//   （uint16 轨道号、uint16 扬声器标签、12 字节 ASCII 扬声器名、64 字节 ASCII 轨道名）。
// - 抖动：位深下降（32 bit 浮点 / 32 bit 整数 → 24 bit）必须抖，否则安静段落有量化台阶；
//   升位或同位深不抖。依据见 docs/声音合板指南.md「抖动：位深下降时必须有」。

import { parseWaveFmt } from "./wave.js";
import { BEXT_LOUDNESS_ABSENT, BEXT_LOUDNESS_OFFSETS } from "./loudness.js";

export const DELIVERY_CHECK_STATES = Object.freeze({ PASS: "pass", FAIL: "fail", MANUAL: "manual", NA: "na" });

/** 检查项的固定顺序。UI 展示顺序与这个数组一致。 */
export const DELIVERY_CHECK_IDS = Object.freeze([
  "bwf-structure",
  "loudness-matches",
  "true-peak-ceiling",
  "axml-present",
  "chna-matches",
  "channel-count",
  "sample-rate-bit-depth",
  "duration",
  "dither-policy",
]);

// 比对容差：响度 0.1 LU、真峰值 0.1 dB。
// bext 里存的是 ×100 的整数，量化步长 0.01，比容差小一个数量级——
// 所以容差留的余量是给"测量实现之间的差异"用的，不是给量化误差用的。
// 这里比的是同一个测量写进文件前后的值（不是两套实现互比），
// 所以比 EBU Tech 3341 给真峰值定的 +0.2/−0.4 dB 更紧是合理的。
const LOUDNESS_TOLERANCE = 0.1;
const TRUE_PEAK_TOLERANCE = 0.1;

// 真峰值上限的比较余量：文件里存的是 ×100 的整数，除出来的值可能比上限低 0.005。
// 用半个量化步长当余量，避免把"正好压在上限上"判成超标。
const CEILING_EPSILON = 0.005;

const WAVE_CONTAINERS = new Set(["RIFF", "RF64", "BW64"]);
const MAX_RIFF32 = 0xffffffff;

// bext 里 version 字段的偏移（EBU Tech 3285：TimeReference 占 338–345，version 占 346–347）。
const BEXT_VERSION_OFFSET = 346;

// chna 每条通道记录的字节数：轨道号 2 + 扬声器标签 2 + 扬声器名 12 + 轨道名 64。
const CHNA_ENTRY_SIZE = 80;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

function viewOf(bytes) {
  try {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}

function asciiAt(bytes, offset, length) {
  let out = "";
  for (let index = 0; index < length; index++) {
    const code = bytes[offset + index];
    if (code === undefined) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * 读一个 ASCII 定长字段：遇到 NUL 就停。
 * 写入端（wave-time-reference.js 的 writeAsciiFixed）用 0 补齐，不是空格，
 * 所以按 NUL 截断才是对的；末尾的空格是名字本身的一部分，trim 掉。
 */
function asciiField(bytes, offset, length) {
  let out = "";
  for (let index = 0; index < length; index++) {
    const code = bytes[offset + index];
    if (code === undefined || code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/** ds64（RF64 / BW64 的真实长度表）。 */
function parseDs64(view, bytes, start) {
  if (start + 28 > bytes.length) return null;
  const table = new Map();
  const tableLength = view.getUint32(start + 24, true);
  let offset = start + 28;
  for (let index = 0; index < tableLength && offset + 12 <= bytes.length; index++) {
    table.set(asciiAt(bytes, offset, 4), view.getBigUint64(offset + 4, true));
    offset += 12;
  }
  return {
    riffSize: view.getBigUint64(start, true),
    dataSize: view.getBigUint64(start + 8, true),
    sampleCount: view.getBigUint64(start + 16, true),
    table,
  };
}

function resolveDs64Size(id, ds64, fallback) {
  if (!ds64) return fallback;
  const raw = id === "data" ? ds64.dataSize : ds64.table.get(id);
  if (raw === undefined) return fallback;
  return raw > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(raw);
}

/**
 * 把整个文件解析成 chunk 表。
 *
 * 为什么要自己写而不用 src/wave.js 的 listWaveChunks：
 * 那个函数吃的是 File（异步切片），而交付自检拿到的是已经在内存里的字节，
 * 要能同步地、零拷贝地读回；解析规则（RIFF 限长、ds64、奇数长度补齐）保持一致。
 */
function inspectWave(input) {
  const bytes = asBytes(input);
  const wave = { bytes, container: null, form: null, chunks: new Map(), sizes: new Map(), truncated: false };
  if (!bytes || bytes.length < 12) return wave;
  const view = viewOf(bytes);
  if (!view) return wave;

  wave.container = asciiAt(bytes, 0, 4);
  wave.form = asciiAt(bytes, 8, 4);
  if (!WAVE_CONTAINERS.has(wave.container) || wave.form !== "WAVE") return wave;

  const riffSize32 = view.getUint32(4, true);
  // RIFF 头里的长度是权威的：文件尾部的垃圾数据不算 chunk。
  // RF64 / BW64 的长度是 0xFFFFFFFF 标记，真实长度在 ds64 里。
  let limit = bytes.length;
  if (wave.container === "RIFF" && riffSize32 !== MAX_RIFF32) limit = Math.min(limit, riffSize32 + 8);

  let ds64 = null;
  let position = 12;
  while (position + 8 <= limit) {
    const id = asciiAt(bytes, position, 4);
    const rawSize = view.getUint32(position + 4, true);
    const start = position + 8;
    if (id === "ds64") {
      ds64 = parseDs64(view, bytes, start);
      position = start + rawSize + (rawSize & 1);
      continue;
    }
    let size = rawSize;
    if (rawSize === MAX_RIFF32) size = resolveDs64Size(id, ds64, Math.max(0, limit - start));
    const available = Math.max(0, Math.min(size, limit - start));
    if (!wave.chunks.has(id)) {
      // subarray 是视图不是拷贝：data 段动辄几百 MB，拷一份纯属浪费。
      wave.chunks.set(id, bytes.subarray(start, start + available));
      wave.sizes.set(id, size);
    }
    position = start + size + (size & 1);
    // 声明的长度超过文件实际长度：文件被截断了，后面的 chunk 不再可信。
    if (available < size) { wave.truncated = true; break; }
  }
  return wave;
}

/**
 * 从一个 WAV 文件的字节里找出所有 chunk（RIFF chunk 列表），返回 Map<四字符 id, 数据字节>。
 *
 * 约定：
 * - 重复的 id 取第一次出现的那个（WAV 规范不禁止重复，但 Poly 的写入端不会产生重复）。
 * - 数据是**视图**（subarray），不复制；调用方不要写它。
 * - 畸形输入（不是 RIFF/WAVE、被截断）不抛错：能读多少读多少，读不到就返回空表。
 *
 * @param {Uint8Array} bytes 文件的完整字节
 * @returns {Map<string, Uint8Array>}
 */
export function readWaveChunks(bytes) {
  return inspectWave(bytes).chunks;
}

/** bext 的一个响度字段。value 已经还原成实际单位（LUFS / LU / dBTP）。 */
function bextField(raw, signed) {
  if (raw === null) return { raw: null, absent: true, value: null };
  const absent = raw === BEXT_LOUDNESS_ABSENT;
  const scaled = signed && raw > 0x7fff ? raw - 0x10000 : raw;
  return { raw, absent, value: scaled / 100 };
}

/**
 * 读 bext chunk。
 *
 * 五个响度字段（EBU Tech 3285，version 2）：
 *   412 积分响度（LUFS×100，int16）
 *   414 响度范围（LU×100，uint16；写端会把负值夹到 0）
 *   416 真峰值（dBTP×100，int16）
 *   418 最大瞬时响度（LUFS×100，int16）
 *   420 最大短时响度（LUFS×100，int16）
 * 0x8000 是"没测"的约定值。响度范围是非负量，所以按 uint16 读，
 * 它的 0x8000 同样是"没测"的标记。
 */
function parseBextChunk(bytes) {
  if (!bytes || bytes.length < 348) return null;
  const view = viewOf(bytes);
  if (!view) return null;
  const read = (offset, length) => (bytes.length >= length ? view.getUint16(offset, true) : null);
  return {
    version: view.getUint16(BEXT_VERSION_OFFSET, true),
    fields: {
      loudnessValue: bextField(read(BEXT_LOUDNESS_OFFSETS.loudnessValue, 414), true),
      loudnessRange: bextField(read(BEXT_LOUDNESS_OFFSETS.loudnessRange, 416), false),
      maxTruePeakLevel: bextField(read(BEXT_LOUDNESS_OFFSETS.maxTruePeakLevel, 418), true),
      maxMomentaryLoudness: bextField(read(BEXT_LOUDNESS_OFFSETS.maxMomentaryLoudness, 420), true),
      maxShortTermLoudness: bextField(read(BEXT_LOUDNESS_OFFSETS.maxShortTermLoudness, 422), true),
    },
  };
}

/** 读 fmt chunk。fmt 太短或结构不对时返回 null（不抛错）。 */
function parseFmtChunk(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const view = viewOf(bytes);
  if (!view) return null;
  try {
    return parseWaveFmt(view, bytes.length, "fmt ");
  } catch {
    return null;
  }
}

/** 读 chna chunk：通道数 + 每条 80 字节的分配记录。 */
function parseChnaChunk(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const view = viewOf(bytes);
  if (!view) return null;
  const count = view.getUint16(0, true);
  const entries = [];
  for (let index = 0; index < count; index++) {
    const base = 2 + index * CHNA_ENTRY_SIZE;
    if (base + CHNA_ENTRY_SIZE > bytes.length) break;
    entries.push({
      trackIndex: view.getUint16(base, true),
      speakerLabel: view.getUint16(base + 2, true),
      speakerName: asciiField(bytes, base + 4, 12),
      trackName: asciiField(bytes, base + 16, 64),
    });
  }
  return { count, entries, malformed: bytes.length !== 2 + count * CHNA_ENTRY_SIZE };
}

/** 读 axml chunk（EBU Tech 3306）。 */
function parseAxmlChunk(bytes) {
  if (!bytes) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const value = tag => {
    const matched = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
    if (!matched) return null;
    const parsed = Number.parseFloat(matched[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    text,
    hasLoudnessInformation: text.includes("<ebu_loudness_information>"),
    integrated: value("integrated_loudness"),
    truePeak: value("max_truepeak_level"),
    maxMomentary: value("max_momentary_loudness"),
    maxShortTerm: value("max_shortterm_loudness"),
    range: value("loudness_range"),
  };
}

function entry(id, label, state, detail, extra = {}) {
  const item = { id, label, state, detail };
  if (extra.expected !== undefined) item.expected = extra.expected;
  if (extra.actual !== undefined) item.actual = extra.actual;
  return item;
}

/**
 * expected.loudness 里给了哪些可核的测量值。
 * 空的 loudness 对象当作"没给"——调用方可能是先建了个空壳再填。
 */
function loudnessExpectation(want) {
  const loudness = want.loudness && typeof want.loudness === "object" ? want.loudness : null;
  if (!loudness) return null;
  const values = {
    integrated: finiteNumber(loudness.integrated),
    range: finiteNumber(loudness.range),
    truePeak: finiteNumber(loudness.truePeak),
    maxMomentary: finiteNumber(loudness.maxMomentary),
    maxShortTerm: finiteNumber(loudness.maxShortTerm),
  };
  return Object.values(values).some(value => value !== null) ? values : null;
}

/** 期望帧数。接受 BigInt（合并结果里的 durationSamples 就是 BigInt）与安全整数。 */
function expectedFrames(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/** 真峰值读数：bext 优先（它是文件头的权威位置），axml 作为第二来源。 */
function truePeakReading(bext, axml) {
  if (bext && !bext.fields.maxTruePeakLevel.absent) {
    return { value: bext.fields.maxTruePeakLevel.value, source: "bext" };
  }
  if (axml && axml.truePeak !== null) return { value: axml.truePeak, source: "axml" };
  return null;
}

function bwfStructure(bext, want) {
  const id = "bwf-structure";
  const label = "BWF 结构：bext 存在、版本、响度字段";
  if (!bext) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 bext chunk：这不是 BWF，也不符合本工具的写出约定（bext 总是第一个 chunk）。",
      { expected: "bext chunk 存在", actual: "缺失" });
  }
  const problems = [];
  const unverified = [];

  const wantVersion = finiteNumber(want.bextVersion);
  if (wantVersion === null) {
    unverified.push("bext 版本（expected.bextVersion 没给）");
  } else if (bext.version !== wantVersion) {
    problems.push(`bext 是 version ${bext.version}，期望 version ${wantVersion}`);
  }

  const loudness = loudnessExpectation(want);
  if (!loudness) {
    unverified.push("五个响度字段（expected.loudness 没给，不知道这份 Poly 是否应当带响度读数）");
  } else {
    // 只对 expected 里给了值的那几项要求"不能是没测"：
    // 响度范围与瞬时/短时值在极短素材上本来就量不出来（写端写 0x8000 是对的），
    // 拿它们当硬性要求会把合法文件判成 fail。
    const wanted = [
      ["loudnessValue", "积分响度", loudness.integrated],
      ["loudnessRange", "响度范围", loudness.range],
      ["maxTruePeakLevel", "真峰值", loudness.truePeak],
      ["maxMomentaryLoudness", "最大瞬时响度", loudness.maxMomentary],
      ["maxShortTermLoudness", "最大短时响度", loudness.maxShortTerm],
    ];
    for (const [field, name, value] of wanted) {
      if (value === null) continue;
      if (bext.fields[field].absent) problems.push(`${name}字段是「没测」（0x8000），期望 ${value}`);
    }
  }

  if (problems.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL, `${problems.join("；")}。`,
      { expected: `bext version ${wantVersion ?? "（未指定）"}`, actual: `bext version ${bext.version}` });
  }
  if (unverified.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      `bext 存在（version ${bext.version}），但${unverified.join("、")}核不了，工具不猜。`,
      { actual: `bext version ${bext.version}` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `bext 存在，version ${bext.version}；该有值的响度字段都有实测值（EBU Tech 3285：412/414/416/418/420，单位 ×100，0x8000 表示未测量）。`,
    { expected: `bext version ${wantVersion}`, actual: `bext version ${bext.version}` });
}

function loudnessMatches(bext, axml, want) {
  const id = "loudness-matches";
  const label = "响度读数与测量值一致";
  const loudness = loudnessExpectation(want);
  const wanted = [];
  if (loudness) {
    const push = (field, name, unit, value, tolerance) => {
      if (value !== null) wanted.push({ field, name, unit, value, tolerance });
    };
    push("loudnessValue", "积分响度", "LUFS", loudness.integrated, LOUDNESS_TOLERANCE);
    push("maxTruePeakLevel", "真峰值", "dBTP", loudness.truePeak, TRUE_PEAK_TOLERANCE);
    push("loudnessRange", "响度范围", "LU", loudness.range, LOUDNESS_TOLERANCE);
    push("maxMomentaryLoudness", "最大瞬时响度", "LUFS", loudness.maxMomentary, LOUDNESS_TOLERANCE);
    push("maxShortTermLoudness", "最大短时响度", "LUFS", loudness.maxShortTerm, LOUDNESS_TOLERANCE);
  }
  if (!wanted.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      "expected.loudness 里没有可核的测量值（积分响度 / 真峰值都没给），核不了写出去的读数对不对。");
  }
  if (!bext) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 bext chunk，读不到响度字段，没法核对写出去的读数。",
      { expected: wanted.map(item => `${item.name} ${item.value} ${item.unit}`).join(" / "), actual: "bext 缺失" });
  }

  const problems = [];
  const measured = [];
  for (const spec of wanted) {
    const actual = bext.fields[spec.field];
    if (actual.absent) {
      problems.push(`${spec.name}字段是「没测」（0x8000），期望 ${spec.value} ${spec.unit}`);
      continue;
    }
    measured.push(`${spec.name} ${actual.value.toFixed(2)} ${spec.unit}`);
    const delta = actual.value - spec.value;
    if (Math.abs(delta) > spec.tolerance + 1e-9) {
      problems.push(`${spec.name}文件里是 ${actual.value.toFixed(2)} ${spec.unit}，期望 ${spec.value} ${spec.unit}（差 ${delta.toFixed(2)}）`);
    }
  }

  // axml 里是同一组数（EBU Tech 3306）。它也是"写出去的读数"，
  // 两个地方写的不一致本身就是缺陷，所以一起核。
  const axmlProblems = [];
  if (axml && axml.hasLoudnessInformation) {
    const pairs = [
      ["integrated", "积分响度", "LUFS", wanted.find(item => item.field === "loudnessValue")],
      ["truePeak", "真峰值", "dBTP", wanted.find(item => item.field === "maxTruePeakLevel")],
    ];
    for (const [key, name, unit, spec] of pairs) {
      if (!spec || axml[key] === null) continue;
      const delta = axml[key] - spec.value;
      if (Math.abs(delta) > spec.tolerance + 1e-9) {
        axmlProblems.push(`axml 里${name}是 ${axml[key].toFixed(2)} ${unit}，期望 ${spec.value} ${unit}（差 ${delta.toFixed(2)}）`);
      }
    }
  }
  problems.push(...axmlProblems);

  if (problems.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL, `${problems.join("；")}。`,
      { expected: wanted.map(item => `${item.name} ${item.value} ${item.unit}`).join(" / "), actual: measured.join(" / ") || "（读不到）" });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `文件里的读数与测量值一致：${measured.join(" / ")}（容差 ${LOUDNESS_TOLERANCE} LU / ${TRUE_PEAK_TOLERANCE} dB）。`,
    { expected: wanted.map(item => `${item.name} ${item.value} ${item.unit}`).join(" / "), actual: measured.join(" / ") });
}

function truePeakCeiling(bext, axml, want) {
  const id = "true-peak-ceiling";
  const label = "真峰值不超出交付上限";
  const target = want.loudnessTarget && typeof want.loudnessTarget === "object"
    ? finiteNumber(want.loudnessTarget.truePeak)
    : null;
  if (target === null) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      "expected.loudnessTarget.truePeak 没给，工具不猜交付上限（R128 是 −1 dBTP、A/85 是 −2 dBTP，但用途不同，不能替人选）。");
  }
  const reading = truePeakReading(bext, axml);
  if (!reading) {
    const loudness = loudnessExpectation(want);
    if (loudness && loudness.truePeak !== null) {
      return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
        "期望有真峰值读数，文件里却是「没测」（bext 的 416 字节是 0x8000），上限核不了。",
        { expected: `≤ ${target} dBTP`, actual: "读不到真峰值" });
    }
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      "文件里读不到真峰值（bext 的 416 字节是「没测」，或没有 bext），核不了上限。",
      { expected: `≤ ${target} dBTP`, actual: "读不到真峰值" });
  }
  if (reading.value > target + CEILING_EPSILON) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `真峰值 ${reading.value.toFixed(2)} dBTP 超出交付上限 ${target} dBTP（超 ${(reading.value - target).toFixed(2)} dB，读自 ${reading.source}）。`,
      { expected: `≤ ${target} dBTP`, actual: `${reading.value.toFixed(2)} dBTP` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `真峰值 ${reading.value.toFixed(2)} dBTP，不超过交付上限 ${target} dBTP（读自 ${reading.source}）。`,
    { expected: `≤ ${target} dBTP`, actual: `${reading.value.toFixed(2)} dBTP` });
}

function axmlPresent(axml, want) {
  const id = "axml-present";
  const label = "axml 里有 ebu_loudness_information";
  const loudness = loudnessExpectation(want);
  if (!axml) {
    if (loudness) {
      return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
        "文件里没有 axml chunk（EBU Tech 3306 的 ebu_loudness_information 缺失），但 expected.loudness 说明这次应当带响度读数。",
        { expected: "axml chunk 存在", actual: "缺失" });
    }
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      "文件里没有 axml chunk。expected.loudness 没给，不知道这份 Poly 是否应当带响度元数据（关掉响度测量时就不写 axml）。",
      { expected: "axml chunk 存在", actual: "缺失" });
  }
  if (!axml.hasLoudnessInformation) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "axml chunk 存在，但里面没有 <ebu_loudness_information>：按 EBU Tech 3306 读响度的老工具读不到这份元数据。",
      { expected: "含 <ebu_loudness_information>", actual: "没有该元素" });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    "axml chunk 存在，且含 <ebu_loudness_information>（EBU Tech 3306 的响度元数据）。",
    { expected: "含 <ebu_loudness_information>", actual: "含" });
}

function chnaMatches(chna, want) {
  const id = "chna-matches";
  const label = "chna 通道分配与轨道名一致";
  if (!chna) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有 chna chunk：Poly 的「第 N 通道就是第 N 支麦克风」这条语义只能靠 chna 传递（EBU Tech 3285 补充件 / BW64）。",
      { expected: "chna chunk 存在", actual: "缺失" });
  }
  if (chna.malformed) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `chna chunk 结构不合法：声明 ${chna.count} 条通道，实际只读出 ${chna.entries.length} 条（每条 80 字节：轨道号 2 + 扬声器标签 2 + 扬声器名 12 + 轨道名 64）。`,
      { expected: `${chna.count} 条完整记录`, actual: `${chna.entries.length} 条` });
  }
  const names = Array.isArray(want.trackNames) ? want.trackNames.map(name => String(name ?? "").trim()) : null;
  if (!names || !names.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      `expected.trackNames 没给，核不了逐条轨道名（只能确认文件里有 ${chna.count} 条通道记录）。`,
      { actual: `${chna.count} 条通道记录` });
  }
  if (chna.count !== names.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `chna 声明 ${chna.count} 条通道，expected.trackNames 有 ${names.length} 条。`,
      { expected: `${names.length} 条`, actual: `${chna.count} 条` });
  }
  const problems = [];
  names.forEach((name, index) => {
    const record = chna.entries[index];
    if (!record) { problems.push(`第 ${index + 1} 条记录缺失`); return; }
    if (record.trackName !== name) problems.push(`第 ${index + 1} 条轨道名是「${record.trackName}」，期望「${name}」`);
    if (record.trackIndex !== index + 1) problems.push(`第 ${index + 1} 条的轨道号是 ${record.trackIndex}，期望 ${index + 1}`);
  });
  if (problems.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL, `${problems.join("；")}。`,
      { expected: names.join(" / "), actual: chna.entries.map(record => record.trackName).join(" / ") });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `${chna.count} 条通道，轨道号 1…${chna.count}，轨道名逐条对得上：${names.join(" / ")}。`,
    { expected: names.join(" / "), actual: names.join(" / ") });
}

function channelCount(fmt, want) {
  const id = "channel-count";
  const label = "fmt 里的通道数";
  if (!fmt) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 fmt chunk，读不到通道数。",
      { actual: "fmt 缺失或过短" });
  }
  const expected = finiteNumber(want.channels);
  if (expected === null) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      `expected.channels 没给，核不了通道数（文件里是 ${fmt.channels} 通道）。`,
      { actual: `${fmt.channels} 通道` });
  }
  if (fmt.channels !== expected) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `fmt 里是 ${fmt.channels} 通道，期望 ${expected} 通道。`,
      { expected: `${expected} 通道`, actual: `${fmt.channels} 通道` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `fmt 里是 ${fmt.channels} 通道，与期望一致。`,
    { expected: `${expected} 通道`, actual: `${fmt.channels} 通道` });
}

function sampleRateBitDepth(fmt, want) {
  const id = "sample-rate-bit-depth";
  const label = "fmt 里的采样率与位深";
  if (!fmt) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 fmt chunk，读不到采样率与位深。",
      { actual: "fmt 缺失或过短" });
  }
  const rate = finiteNumber(want.sampleRate);
  const bits = finiteNumber(want.bitsPerSample);
  if (rate === null && bits === null) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      `expected.sampleRate / expected.bitsPerSample 没给，核不了（文件里是 ${fmt.sampleRate} Hz / ${fmt.bitsPerSample} bit）。`,
      { actual: `${fmt.sampleRate} Hz / ${fmt.bitsPerSample} bit` });
  }
  const problems = [];
  if (rate !== null && fmt.sampleRate !== rate) problems.push(`采样率是 ${fmt.sampleRate} Hz，期望 ${rate} Hz`);
  if (bits !== null && fmt.bitsPerSample !== bits) problems.push(`位深是 ${fmt.bitsPerSample} bit，期望 ${bits} bit`);
  if (problems.length) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL, `${problems.join("；")}。`,
      { expected: `${rate ?? "—"} Hz / ${bits ?? "—"} bit`, actual: `${fmt.sampleRate} Hz / ${fmt.bitsPerSample} bit` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `fmt 里是 ${fmt.sampleRate} Hz / ${fmt.bitsPerSample} bit，与期望一致。`,
    { expected: `${rate ?? "—"} Hz / ${bits ?? "—"} bit`, actual: `${fmt.sampleRate} Hz / ${fmt.bitsPerSample} bit` });
}

function durationCheck(fmt, data, want, declaredSize = null, headerOnly = false) {
  const id = "duration";
  const label = "data 段的帧数";
  if (!data) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有 data chunk，读不到时长。",
      { actual: "data 缺失" });
  }
  if (!fmt || !fmt.blockAlign) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 fmt chunk（或 block align 是 0），算不出帧数。",
      { actual: "fmt 缺失或 block align 为 0" });
  }
  // 用 chunk **声明**的长度算帧数：只读文件头时 data 段是截断的，
  // 但头里写的长度是准的——那正是这个文件声称自己有多长。
  const bytes = declaredSize ?? data.length;
  if (bytes % fmt.blockAlign !== 0) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `data 段 ${bytes} 字节不是 block align ${fmt.blockAlign} 的整数倍：文件要么被截断，要么 block align 写错了。`,
      { actual: `${bytes} 字节` });
  }
  const frames = BigInt(bytes / fmt.blockAlign);
  const expected = expectedFrames(want.durationSamples);
  if (expected === null) {
    return entry(id, label, DELIVERY_CHECK_STATES.MANUAL,
      `expected.durationSamples 没给，核不了；文件里是 ${frames} 帧（${bytes} 字节 ÷ block align ${fmt.blockAlign}）。`,
      { actual: `${frames} 帧` });
  }
  if (frames !== expected) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `data 段是 ${frames} 帧，期望 ${expected} 帧。`,
      { expected: `${expected} 帧`, actual: `${frames} 帧` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    `data 段是 ${frames} 帧，与期望一致（${bytes} 字节 ÷ block align ${fmt.blockAlign}）。`,
    { expected: `${expected} 帧`, actual: `${frames} 帧` });
}

function ditherPolicy(fmt, want) {
  const id = "dither-policy";
  const label = "降位深时的抖动策略";
  if (want.ditherExpected !== true) {
    return entry(id, label, DELIVERY_CHECK_STATES.NA,
      want.ditherExpected === false
        ? "expected.ditherExpected 为 false：位深没有下降，不需要抖动，本项不适用。"
        : "expected.ditherExpected 没给：工具不知道这次有没有位深下降（升位与同位深都不需要抖动），本项不适用。");
  }
  if (!fmt) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      "文件里没有可读的 fmt chunk，读不到输出位深。",
      { expected: "24 bit", actual: "fmt 缺失或过短" });
  }
  if (fmt.bitsPerSample !== 24) {
    return entry(id, label, DELIVERY_CHECK_STATES.FAIL,
      `位深下降了却输出成 ${fmt.bitsPerSample} bit：降位深（32 bit 浮点 / 32 bit 整数 → 24 bit）必须抖，否则安静段落有量化台阶，输出应当是 24 bit。`,
      { expected: "24 bit", actual: `${fmt.bitsPerSample} bit` });
  }
  return entry(id, label, DELIVERY_CHECK_STATES.PASS,
    "输出是 24 bit，走的是降位深那条路（抖动由写入端处理）。本项只能核到位深——抖动量本身要逐样本才验得了，本模块不读音频数据。",
    { expected: "24 bit", actual: `${fmt.bitsPerSample} bit` });
}

/**
 * 核验写出去的 Poly。
 *
 * @param {Uint8Array} bytes 写出的 Poly WAV 的完整字节
 * @param {object} expected 期望值，字段都可选（缺了就判 manual 或 na）
 *   channels, sampleRate, bitsPerSample, durationSamples,
 *   trackNames: string[],                 每个输出通道的名字（与 _channels.json 同序）
 *   loudness: { integrated, truePeak, range, maxMomentary, maxShortTerm },  已知的测量值
 *   loudnessTarget: { integrated, truePeak },   交付目标（真峰值上限）
 *   ditherExpected: boolean,               位深下降时是否应当有抖动
 *   bextVersion: number                    期望的 bext 版本
 * @returns {{ ok: boolean, checks: Array<object>, summary: object }}
 *
 * ok 只看 fail：manual 是"工具给不出结论"，既不算通过也不算失败。
 * 想看全貌请读 checks 里的每一项。
 */
export function checkWrittenPoly(bytes, expected = {}) {
  const want = expected && typeof expected === "object" ? expected : {};
  const wave = inspectWave(bytes);
  const bext = parseBextChunk(wave.chunks.get("bext"));
  const axml = parseAxmlChunk(wave.chunks.get("axml"));
  const chna = parseChnaChunk(wave.chunks.get("chna"));
  const fmt = parseFmtChunk(wave.chunks.get("fmt "));
  const data = wave.chunks.get("data") ?? null;

  const checks = [
    bwfStructure(bext, want),
    loudnessMatches(bext, axml, want),
    truePeakCeiling(bext, axml, want),
    axmlPresent(axml, want),
    chnaMatches(chna, want),
    channelCount(fmt, want),
    sampleRateBitDepth(fmt, want),
    durationCheck(fmt, data, want, wave.sizes.get("data") ?? null, Boolean(want.headerOnly)),
    ditherPolicy(fmt, want),
  ];

  const summary = { pass: 0, fail: 0, manual: 0, na: 0, total: checks.length };
  for (const item of checks) summary[item.state] = (summary[item.state] ?? 0) + 1;
  return { ok: summary.fail === 0, checks, summary };
}
