// 合板率总览（纯数据层）：把"这批素材到底能合出几个 Poly"一次算清楚。
//
// 为什么需要它：导入完成后状态栏只说一句"已载入 42 个 WAV，识别到 18 个分轨 take"，
// 但 18 个里现在就能合的有几个，从来没人算过。不可合的 take 静默沉在体检面板里，
// 合板率因此是个黑箱——用户只能靠反复点"合板"和看报错去猜。这里给出这个数字，
// 并说明被卡住的原因分布。
//
// 设计约束（与 src/take-health.js 一致）：
// - 纯函数：不碰 DOM / 浏览器 API / 文件系统，可被 node --test 直接调用；
// - 绝不抛错：null 字段、BigInt 与 String 混用、非 Map 的分组结果都只产出空统计；
// - 不另立判定：结构门槛（分组 + 严格等长）完全由 grouping.js 的 combineEligibleGroupsFor 说了算
//   （它要求分轨严格等长，这是既有设计，本模块不改它的语义），
//   归因完全复用 take-health.js 的 inspectTakeHealth。本模块只做"归类 + 计数"。
//
// 与体检面板的分工：这里只给**聚合计数**；具体是哪几个 take、卡在哪一条分轨、
// 该怎么处理，一律由体检面板逐条展示，状态栏不复制第二份诊断数据。
//
// 一处有意的严格化：被卡 = "结构门槛没过" **或** "体检给出 error 级归因"。
// combineEligibleGroupsFor 只管分组与严格等长，采样率/位深/格式/时码的校验都在
// wave-combine.js 的 validateCombineGroup 里、点"合板"那一刻才 throw。
// 如果这里照抄它的结果，采样率打架的 take 会被报成"可合"，合板率就成了新的黑箱——
// 那正是这个功能要消灭的东西。所以结构门槛用既有判定（不改它的语义），
// error 归因用体检判定，两者都过了才算"现在就能合"。
// 代价：状态栏的"可合 N 个"会比合板按钮的可用分组更严格，这是故意的差异。

import {
  combineEligibleGroupsFor,
  detectTakeGroupKeys,
  groupLabelFor,
  isTakeTrackFor,
  recordsByGroupFor,
  shortGroupLabel,
} from "./grouping.js";
import { inspectTakeHealth } from "./take-health.js";

/**
 * 归因码 -> 状态栏要说的中文原因。
 * 独立成一个稳定枚举而不是直接用中文文案，是为了让测试和后续 UI 都能按码断言。
 */
export const MERGE_REASONS = Object.freeze({
  SAMPLE_RATE: "sample-rate",
  BIT_DEPTH: "bit-depth",
  AUDIO_FORMAT: "audio-format",
  DURATION: "duration",
  TIMECODE_MISMATCH: "timecode-mismatch",
  TIMECODE_MISSING: "timecode-missing",
  TIMECODE_MIXED: "timecode-mixed",
  FPS_CONFLICT: "fps-conflict",
  OTHER: "other",
});

export const MERGE_REASON_LABELS = Object.freeze({
  [MERGE_REASONS.SAMPLE_RATE]: "采样率不一致",
  [MERGE_REASONS.BIT_DEPTH]: "位深不一致",
  [MERGE_REASONS.AUDIO_FORMAT]: "音频格式不一致",
  [MERGE_REASONS.DURATION]: "时长不一致",
  [MERGE_REASONS.TIMECODE_MISMATCH]: "起始时码不一致",
  [MERGE_REASONS.TIMECODE_MISSING]: "起始时码缺失",
  [MERGE_REASONS.TIMECODE_MIXED]: "时码来源混用",
  [MERGE_REASONS.FPS_CONFLICT]: "帧率声明冲突",
  [MERGE_REASONS.OTHER]: "其他问题",
});

/**
 * take-health 的 code -> 归因码，以及"同一个 take 踩多个坑时先报哪个"。
 *
 * 为什么要有优先级：一个 take 可能同时踩好几个坑（采样率不同 + 时长也不同）。
 * 状态栏按原因计数，必须加起来正好等于被卡总数，否则用户会把"3 个时长 + 2 个时码"
 * 读成 5 个 take。所以每个被卡的 take 只归到**一个**主因，按下面的固定顺序取。
 * 没有被选中的那些原因并不会消失——体检面板仍会逐条列出。
 *
 * 顺序即修素材的先后：格式层面的冲突（采样率/位深/编码）不解决就写不出合法 WAV，
 * 排在最前；其次是时长；时码问题最后，因为前两类不修好时码怎么对都没意义。
 * 登记的 code 全是 error 级（见 TAKE_HEALTH_CODES），warn/info（如"还没跑 LTC 检测"）
 * 不会抢走主因，否则状态栏会为无关提示去报一个 take"被卡住"。
 */
const REASON_BY_CODE = Object.freeze([
  ["sample-rate-mismatch", MERGE_REASONS.SAMPLE_RATE],
  ["bit-depth-mismatch", MERGE_REASONS.BIT_DEPTH],
  ["audio-format-mismatch", MERGE_REASONS.AUDIO_FORMAT],
  ["duration-mismatch", MERGE_REASONS.DURATION],
  ["start-timeref-mismatch", MERGE_REASONS.TIMECODE_MISMATCH],
  ["timecode-source-missing", MERGE_REASONS.TIMECODE_MISSING],
  ["timecode-source-incomplete", MERGE_REASONS.TIMECODE_MISSING],
  ["timecode-source-mixed", MERGE_REASONS.TIMECODE_MIXED],
  ["fps-conflict-in-take", MERGE_REASONS.FPS_CONFLICT],
]);

// 排序用的名次：同一个归因码可能登记了多个 code（如"起始时码缺失"对应 missing/incomplete），
// 名次取**第一次**出现的位置，那才是它在优先级里的真实位置。
const REASON_RANK = Object.freeze(REASON_BY_CODE.reduce((rank, [, reason], index) => {
  if (!(reason in rank)) rank[reason] = index;
  return rank;
}, {}));

const OTHER_REASON_RANK = REASON_BY_CODE.length;

// 状态栏最多列几类原因，再多就折叠成"等 N 类问题"——一屏状态行放不下十种原因。
const MAX_REASON_ITEMS = 3;

// ---------------------------------------------------------------- 基础工具

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 与 file-import.js 的 wavRecords 同口径：视频音轨和 ALE/CSV 元数据不参与分轨 take 判断。 */
function isWaveRecord(record) {
  return Boolean(record) && typeof record === "object" && !record._meta && !record._video;
}

function waveRecordsOf(recordList) {
  if (!Array.isArray(recordList)) return [];
  return recordList.filter(isWaveRecord);
}

/**
 * 时长取值 -> 可比较的字符串键。BigInt / number / 纯数字字符串等价，
 * 取不到合法值就返回 ""（表示"读不出来"），绝不抛错。
 * grouping.js 的 hasExactSameDuration 是直接 BigInt() 的，畸形数据会在那里炸；
 * 本地判定需要自己先过滤一遍。
 */
function durationKey(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? safe(() => BigInt(value).toString(), "") : "";
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return safe(() => BigInt(value.trim()).toString(), "");
  return "";
}

/** 严格等长（与 combineEligibleGroupsFor 的 hasExactSameDuration 同一把尺子）。 */
function hasStrictlySameDuration(groupRecords) {
  const keys = groupRecords.map(record => durationKey(record?.durationSamples));
  // 只要有一条读不出时长就不能判"能合"：宁可算作被卡，也不要给用户一个合不出来的数字。
  if (keys.some(key => !key)) return false;
  return keys.every(key => key === keys[0]);
}

// ---------------------------------------------------------------- 分组

function normalizeGroupKeys(records, takeGroupKeys) {
  // 调用方给了分组结果就用它的（用户可能手工改过分组）；
  // 没给就按 grouping.js 的规则自己算一遍——和 UI 的 refreshTakeGroups 用的是同一个函数，
  // 这样状态栏不需要为了一句统计额外接线。
  if (takeGroupKeys instanceof Map) return takeGroupKeys;
  return safe(() => detectTakeGroupKeys(records), new Map());
}

/** 归组范围与 take-health.js 的 inspectTakes 一致：只认"至少两条分轨、且都被判定为分轨"的组。 */
function takeGroupsOf(records, takeGroupKeys) {
  const groups = safe(() => recordsByGroupFor(records, takeGroupKeys), new Map());
  const takes = new Map();
  for (const [key, groupRecords] of groups) {
    if (!Array.isArray(groupRecords) || groupRecords.length < 2) continue;
    if (!groupRecords.every(record => isTakeTrackFor(record, takeGroupKeys))) continue;
    takes.set(key, groupRecords);
  }
  return takes;
}

/** 结构上就能合的 take（分组 + 严格等长）。复用既有判定，畸形数据导致它抛错时退回等价的本地判定。 */
function structurallyEligibleKeysOf(records, takeGroupKeys) {
  const usable = safe(() => combineEligibleGroupsFor(records, takeGroupKeys), null);
  if (Array.isArray(usable)) {
    return new Set(usable.map(entry => entry?.[0]).filter(Boolean));
  }
  const fallback = new Set();
  for (const [key, groupRecords] of takeGroupsOf(records, takeGroupKeys)) {
    if (hasStrictlySameDuration(groupRecords)) fallback.add(key);
  }
  return fallback;
}

// ---------------------------------------------------------------- 归因

function reasonLabelFor(reason) {
  return MERGE_REASON_LABELS[reason] || MERGE_REASON_LABELS[MERGE_REASONS.OTHER];
}

/**
 * 在体检 findings 里挑一个主因：先按登记顺序匹配已知 code；
 * 都匹配不上时，若时长确实不等就归到时长（combineEligibleGroupsFor 的唯一剩余门槛就是它）。
 * 返回 null 表示"没找到任何会挡住合板的问题"。
 */
function primaryReasonOf(findings, groupRecords) {
  for (const [code, reason] of REASON_BY_CODE) {
    const hit = (findings || []).find(item => item?.code === code);
    if (hit) return { code, reason, finding: hit };
  }
  if (!hasStrictlySameDuration(groupRecords)) {
    return { code: "duration-mismatch", reason: MERGE_REASONS.DURATION, finding: null };
  }
  return null;
}

function takeLabelFor(key, groupRecords, takeGroupKeys) {
  return safe(() => groupLabelFor(groupRecords[0], takeGroupKeys), "")
    || safe(() => shortGroupLabel(key), "")
    || String(key);
}

function describeBlockedTake(key, label, primary) {
  const finding = primary?.finding || null;
  return {
    key,
    label,
    // 主因找不到（极少见：结构门槛没过但体检也没给出可登记的原因）时说"其他问题"，
    // 宁可笼统也不要谎报一个原因。
    reason: reasonLabelFor(primary?.reason || MERGE_REASONS.OTHER),
    code: primary?.code || "",
    detail: finding?.detail || finding?.title || "",
  };
}

// blocked 里对外存的是中文原因，排序需要一个稳定的码 -> 用这张反查表，别在比较器里现算字符串。
const CODE_BY_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(MERGE_REASON_LABELS).map(([reason, label]) => [label, reason])),
);

function reasonCodeFor(item) {
  return CODE_BY_LABEL[item?.reason] || MERGE_REASONS.OTHER;
}

function compareBlocked(a, b) {
  const byReason = (REASON_RANK[reasonCodeFor(a)] ?? OTHER_REASON_RANK) - (REASON_RANK[reasonCodeFor(b)] ?? OTHER_REASON_RANK);
  if (byReason) return byReason;
  return String(a.label).localeCompare(String(b.label), "zh-Hans-CN");
}

// ---------------------------------------------------------------- 主入口

/**
 * 合板率总览。纯函数，畸形输入只产出空统计，绝不抛错。
 *
 * @param {object[]} recordList 参与判断的记录（内部会滤掉 _meta / _video）
 * @param {Map} [takeGroupKeys]   grouping.js 的 take 分组结果；不给就自己算一遍
 * @param {object} [options]      透传给 take-health.js 的选项（ltcResults / previews 等）
 * @returns {{wavCount:number, takeCount:number, eligibleCount:number,
 *            blocked:Array<{key:string,label:string,reason:string,code:string,detail:string}>,
 *            rate:number|null}}
 *          rate = eligibleCount / takeCount；takeCount 为 0 时给 null 而不是 NaN。
 */
export function summarizeMergeRate(recordList, takeGroupKeys, options = {}) {
  const records = waveRecordsOf(recordList);
  const groupKeys = normalizeGroupKeys(records, takeGroupKeys);
  const takes = takeGroupsOf(records, groupKeys);
  const structurallyEligible = structurallyEligibleKeysOf(records, groupKeys);

  const blocked = [];
  let eligibleCount = 0;
  for (const [key, groupRecords] of takes) {
    const label = takeLabelFor(key, groupRecords, groupKeys);
    const findings = safe(() => inspectTakeHealth({
      takeKey: key,
      takeLabel: label,
      groupRecords,
      ...(options || {}),
    }), []);
    const primary = primaryReasonOf(Array.isArray(findings) ? findings : [], groupRecords);
    if (structurallyEligible.has(key) && !primary) {
      eligibleCount += 1;
      continue;
    }
    blocked.push(describeBlockedTake(key, label, primary));
  }
  blocked.sort(compareBlocked);

  const takeCount = takes.size;
  return {
    wavCount: records.length,
    takeCount,
    eligibleCount,
    blocked,
    // 没有 take 时 rate 是 null：0/0 会变成 NaN，而 NaN 在文案里会显示成 "NaN%"。
    rate: takeCount ? eligibleCount / takeCount : null,
  };
}

// ---------------------------------------------------------------- 状态栏文案

function normalizeSummary(summary) {
  const source = summary && typeof summary === "object" ? summary : {};
  const takeCount = Math.max(0, Number(source.takeCount) || 0);
  return {
    takeCount,
    // 夹一下：文案层宁可保守也不该打印出"可合 5 个（共 3 个 take）"这种自相矛盾的话。
    eligibleCount: Math.min(Math.max(0, Number(source.eligibleCount) || 0), takeCount),
    blocked: Array.isArray(source.blocked) ? source.blocked.filter(Boolean) : [],
  };
}

function reasonCountText(blocked) {
  const counts = new Map();
  for (const item of blocked) {
    const reason = String(item.reason || "").trim() || MERGE_REASON_LABELS[MERGE_REASONS.OTHER];
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  // 数量多的排前面；同数保持 blocked 里已有的原因优先级（Array#sort 稳定），
  // 保证同一批素材每次导入出来的文案完全一致。
  const ordered = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ordered.length) return "";
  const shown = ordered.slice(0, MAX_REASON_ITEMS).map(([reason, count]) => `${reason} ${count} 个`).join("，");
  return ordered.length > MAX_REASON_ITEMS ? `${shown}，共 ${ordered.length} 类问题` : shown;
}

/**
 * 状态栏那段 take 文案。返回带前导逗号的片段，识别不到 take 时返回空串
 * （保持改动前"只有 WAV 数量"的样子）。
 *
 * 只放聚合计数：可合几个 + 被卡的原因分布。具体卡在哪个 take、哪条分轨，
 * 体检面板已经在逐条列了，这里不重复。
 */
export function formatMergeRateSummary(summary) {
  const { takeCount, eligibleCount, blocked } = normalizeSummary(summary);
  if (!takeCount) return "";
  const head = `，识别到 ${takeCount} 个分轨 take`;
  if (eligibleCount === takeCount) return `${head}（全部可合）`;
  const reasons = reasonCountText(blocked);
  // 一个都合不了时把原因摆到最前面，别只丢一个 0 让人猜。
  if (!eligibleCount) return reasons ? `${head}（暂时一个都合不了：${reasons}）` : `${head}（暂时一个都合不了）`;
  if (!reasons) return `${head}（可合 ${eligibleCount} 个，其余 ${takeCount - eligibleCount} 个待体检确认）`;
  return `${head}（可合 ${eligibleCount} 个，${reasons}）`;
}