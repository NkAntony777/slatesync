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

function splitTrackStem(record) {
  const stem = (record.name || "").replace(/\.[^.]+$/, "");
  const trackMatch = stem.match(/^(.*?)(?:[_\-\s])(?:tr|trk|track|tk|ch|chan|channel)\s*(?:\d+(?:\s*[-_]\s*\d+)?|[lr](?:\s*[-_]\s*[lr])?)$/i);
  if (trackMatch?.[1]) return trackMatch[1].trim();
  const lrMatch = stem.match(/^(.*?)(?:[_\-\s])l\s*[-_ ]?\s*r$/i);
  if (lrMatch?.[1]) return lrMatch[1].trim();
  return "";
}

export function ltcScanPriority(record) {
  const name = record.name || "";
  if (record.channels === 1 && hasZoomHNamePattern(record)) return 0;
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
    const stem = splitTrackStem(record);
    if (!stem) continue;
    const key = `${record.parentPath}/${stem.toLowerCase()}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(record);
  }

  const keys = new Map();
  for (const [, group] of clusters) {
    if (group.length < 2) continue;
    const groupKey = `${group[0].parentPath}/${splitTrackStem(group[0])}`;
    for (const record of group) keys.set(recordKey(record), groupKey);
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
    .filter(([, groupRecords]) => groupRecords.some(record => record.channels > 1) || groupRecords.some(record => record.channels === 1));
}
