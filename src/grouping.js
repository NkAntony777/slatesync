export function recordKey(record) {
  return record.relativePath || record.name;
}

export function recordLabel(record) {
  return record.relativePath || record.name;
}

export function groupKeyFor(record, takeGroupKeys) {
  return takeGroupKeys.get(recordKey(record)) || recordKey(record);
}

export function groupLabelFor(record, takeGroupKeys) {
  const key = takeGroupKeys.get(recordKey(record));
  return key ? shortGroupLabel(key) : recordLabel(record);
}

export function takeGroupCount(takeGroupKeys) {
  return new Set(takeGroupKeys.values()).size;
}

export function shortGroupLabel(key) {
  const parts = key.split("/").filter(Boolean);
  return parts[parts.length - 1] || key || "根目录";
}

export function hasSplitTrackNamePattern(record) {
  return Boolean(splitTrackStem(record));
}

export function hasZoomHNamePattern(record) {
  return hasSplitTrackNamePattern(record);
}

function hasExactSameDuration(group) {
  if (!group.length) return false;
  const durations = group.map(record => BigInt(record.durationSamples));
  const min = durations.reduce((a, b) => a < b ? a : b, durations[0]);
  const max = durations.reduce((a, b) => a > b ? a : b, durations[0]);
  return max === min;
}

// 显式轨道标记：ZOOM0001_Tr1 / 0001_CH2 / Foo_track3 / Bar_ch 4。唯一不需要元数据佐证就能成组的规则。
const EXPLICIT_TRACK_PATTERN = /^(.*?)(?:[_\-\s])(?:tr|trk|track|tk|ch|chan|channel)\s*(?:\d+(?:\s*[-_]\s*\d+)?|[lr](?:\s*[-_]\s*[lr])?)$/i;
// 成对 LR：Take_LR。
const PAIRED_LR_PATTERN = /^(.*?)(?:[_\-\s])l\s*[-_ ]?\s*r$/i;
// 单侧 L/R：Mix_L + Mix_R、Cam_A_L + Cam_A_R。旧规则只认成对写法，单侧的 LR 对一律成不了组。
const SINGLE_LR_PATTERN = /^(.*?)(?:[_\-\s])([lr])$/i;
// 通用数字后缀：S01T01_1 / Boom_1 / XLR1 / TAKE01_A001。
// (?<![0-9]) 保证序号是完整的数字段：MIC_20260106 这类日期尾巴（8 位连续数字）
// 若允许前缀切在数字中间，就会被拆成 MIC_202601+06 和 MIC_202601+07 而误合并。
const NUMBER_SUFFIX_PATTERN = /^(.*?)(?:[_\-\s])?(?<![0-9])(\d{1,4})$/;

// 纯占位主干：这些词本身就是"第几个 take"的计数器，不是麦克风名。
// TAKE01 + TAKE02 会被解析成同一主干，若放行就会把两个 take 合成一个 Poly。
// 但 T01_1/2/3 的主干是 T01，不是 T —— 分轨索引在尾部，形态完全不同，不受影响。
const PLACEHOLDER_STEMS = new Set([
  "t", "take", "tk", "clip", "rec", "recording", "iso", "track", "file", "audio",
  "new", "untitled", "sound", "input", "out", "output", "recorder",
]);

function splitTrackStemDetail(record) {
  const stem = (record.name || "").replace(/\.[^.]+$/, "");
  const explicit = stem.match(EXPLICIT_TRACK_PATTERN);
  if (explicit?.[1]) return { stem: explicit[1].trim(), rule: "explicit", index: null };
  const paired = stem.match(PAIRED_LR_PATTERN);
  if (paired?.[1]) return { stem: paired[1].trim(), rule: "explicit", index: null };
  const single = stem.match(SINGLE_LR_PATTERN);
  // 注意捕获组编号：(.*?) 是第 1 组（主干），([lr]) 是第 2 组（L/R 字母）。
  if (single?.[1]) return { stem: single[1].trim(), rule: "generic", index: single[2].toLowerCase() === "l" ? 1 : 2 };
  const numbered = stem.match(NUMBER_SUFFIX_PATTERN);
  // 前缀为空 = 没有稳定主干（001.WAV 这种就是 take 本身），宁可不成组。
  if (numbered?.[1]?.trim() && !isPlaceholderStem(numbered[1])) {
    return { stem: numbered[1].trim(), rule: "generic", index: Number(numbered[2]) };
  }
  return null;
}

function isPlaceholderStem(stem) {
  return PLACEHOLDER_STEMS.has(stem.trim().toLowerCase());
}

function splitTrackStem(record) {
  return splitTrackStemDetail(record)?.stem || "";
}

// 通用规则的序号（用于排序和写 iXML 通道号）。显式规则返回 null，交给既有的 zoom 路径。
export function genericTrackNumber(record) {
  const detail = splitTrackStemDetail(record);
  return detail?.rule === "generic" ? detail.index : null;
}

// 同一次录音的各条分轨应当共享起始时码；没有时码时退而求其次看时长是否几乎一致。
// 两条 take（如 TAKE01 / TAKE02）时长相同且都缺 TimeReference 时仍可能通过，这是命名规则的固有歧义；
// 用元数据佐证把风险压到可接受，是这里能做的全部——所以守卫失败时宁可不成组。
function sharesTakeIdentity(group) {
  const refs = group.map(record => record.oldTimeReference);
  const allHaveRef = refs.every(ref => typeof ref === "bigint" || typeof ref === "number");
  // 时码都在且互不相同 = 两次不同录音的直接证据，直接否掉。
  if (allHaveRef && !refs.every(ref => ref === refs[0])) return false;
  // 时长是独立的第二道判据，必须同时成立。时码相同但时长差一倍（60s vs 120s）
  // 同样不是同一个 take 的分轨，不能因为时码对上了就放行。
  const durations = group.map(record => Number(record.durationSamples));
  if (!durations.every(Number.isFinite)) return allHaveRef;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  // 1% 容差：合板阶段的时长强校验仍在 hasExactSameDuration，这里只需要证明"像同一次录音"。
  return min > 0 && (max - min) <= max * 0.01;
}

// 只有走通用规则（名字猜出来的）成组时才算。显式轨道标记是录音机自己写的，可信度足够。
function isPlausibleSplitCluster(group) {
  // 通用规则只服务单声道分轨。多声道文件的名字里带数字，更可能是 take 本身或混音成品，
  // 误合并的代价（两个 take 被合进一个 Poly）远大于漏合并的代价。
  if (!group.every(record => record.channels === 1)) return false;
  const first = group[0];
  if (!group.every(record => record.sampleRate === first.sampleRate && record.bitsPerSample === first.bitsPerSample)) return false;
  const indexes = group.map(record => genericTrackNumber(record));
  // 同一个序号出现两次，说明它们不是同一个 take 的并列分轨。
  if (new Set(indexes).size !== indexes.length) return false;
  return sharesTakeIdentity(group);
}

export function ltcScanPriority(record) {
  const name = record.name || "";
  if (record.channels === 1 && hasSplitTrackNamePattern(record)) return 0;
  if (record.channels === 1) return 1;
  if (/_LR\.wav$/i.test(name)) return 3;
  return 2;
}

export function ltcScanRecords(groupRecords) {
  return [...groupRecords].sort((a, b) => {
    const priority = ltcScanPriority(a) - ltcScanPriority(b);
    if (priority) return priority;
    return (a.name || "").localeCompare(b.name || "");
  });
}

export function detectTakeGroupKeys(recordList) {
  const clusters = new Map();
  for (const record of recordList) {
    const detail = splitTrackStemDetail(record);
    if (!detail) continue;
    const key = `${record.parentPath}/${detail.stem.toLowerCase()}`;
    if (!clusters.has(key)) clusters.set(key, { stem: detail.stem, records: [], generic: false });
    const cluster = clusters.get(key);
    cluster.records.push(record);
    if (detail.rule === "generic") cluster.generic = true;
  }

  const keys = new Map();
  for (const [, cluster] of clusters) {
    const { records, generic, stem } = cluster;
    if (records.length < 2) continue;
    if (generic && !isPlausibleSplitCluster(records)) continue;
    const groupKey = `${records[0].parentPath}/${stem}`;
    for (const record of records) keys.set(recordKey(record), groupKey);
  }
  return keys;
}

export function isTakeTrackFor(record, takeGroupKeys) {
  return takeGroupKeys.has(recordKey(record));
}

export function isZoomLrFile(record) {
  return /_LR\.wav$/i.test(record.name);
}

export function zoomTrackNumber(record) {
  const match = record.name.match(/(?:^|[_-])Tr(\d+)\.wav$/i);
  return match ? Number(match[1]) : null;
}

export function zoomTrackNumbers(record) {
  const match = record.name.match(/(?:^|[_-])Tr(\d+)\.wav$/i);
  if (!match) return [];
  const digits = match[1];
  if (record.channels > 1 && digits.length === record.channels) {
    return Array.from(digits, digit => Number(digit));
  }
  return [Number(digits)];
}

export function combineSortValue(record) {
  if (isZoomLrFile(record)) return 0;
  const tracks = zoomTrackNumbers(record);
  if (tracks.length) return 10 + tracks[0];
  // 通用序号单独占一段（20+），避免和 Zoom 的 Tr 序号撞在同一个排序区间里。
  const generic = genericTrackNumber(record);
  if (generic !== null) return 20 + generic;
  return 1000;
}

export function recordsByGroupFor(recordList, takeGroupKeys) {
  const groups = new Map();
  for (const record of recordList) {
    const key = groupKeyFor(record, takeGroupKeys);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

export function combineEligibleGroupsFor(recordList, takeGroupKeys) {
  return Array.from(recordsByGroupFor(recordList, takeGroupKeys).entries())
    .filter(([, groupRecords]) => groupRecords.length > 1 && groupRecords.every(record => isTakeTrackFor(record, takeGroupKeys)))
    .filter(([, groupRecords]) => hasExactSameDuration(groupRecords))
    // 这一行恒真：channels > 1 || channels === 1 等价于「存在通道数 >= 1 的分轨」，
    // 对任何非空分组都成立，因此它不做任何过滤。保留是为不改动既有分组语义，
    // 但**不要**把它当成通道数校验——合板前的真实一致性检查见 src/take-health.js。
    .filter(([, groupRecords]) => groupRecords.some(record => record.channels > 1) || groupRecords.some(record => record.channels === 1));
}
