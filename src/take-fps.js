// per-take 帧率覆盖：纯逻辑，不碰 DOM、不碰浏览器 API。
//
// 全局帧率控件（els.fpsInput）保留为唯一的"默认值"来源；这里额外维护一张
// takeKey -> fpsValue 的覆盖表，解析顺序是 覆盖 > 调用方传入的回落值 > 全局默认。
// take 归组直接复用 grouping.js 的 groupKeyFor（上游是 detectTakeGroupKeys），
// 不另起一套命名规则，保证覆盖的粒度和"合板 / LTC 检测"看到的 take 完全一致。
import { groupKeyFor, recordKey } from "./grouping.js";
import {
  bextAspeedToFpsValue,
  fpsRate,
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
} from "./timecode.js";

/** recordFpsSource 里代表"per-take 覆盖"的来源标签。 */
export const TAKE_FPS_SOURCE_LABEL = "per-take 覆盖";
/** recordFpsSource 里代表"界面全局选择"的来源标签（沿用既有文案）。 */
export const GLOBAL_FPS_SOURCE_LABEL = "界面设置";

/**
 * 纯函数：读一个文件自带的帧率元数据（iXML / bext aSPEED），没有则返回 ""。
 * fps-metadata.js 复用它，保证"导入时怎么统计的"和"覆盖时怎么挑 take 的"是同一把尺子。
 */
export function recordFileMetadataFpsValue(record) {
  return ixmlRateToFpsValue(record?.ixmlInfo) || bextAspeedToFpsValue(record?.bextInfo) || "";
}

/** 帧率值是否可用：非空、能被 parseFps 解析、且为正速率。 */
export function isValidFpsValue(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let fps;
  try {
    fps = parseFps(value.trim());
  } catch {
    return false;
  }
  const rate = fpsRate(fps);
  return rate.n > 0n && rate.d > 0n;
}

export function createTakeFpsStore({
  getTakeGroupKeys = () => new Map(),
  getDefaultFpsValue = () => "",
} = {}) {
  const overrides = new Map();

  function takeGroupKeys() {
    return getTakeGroupKeys?.() || new Map();
  }

  function globalDefaultValue() {
    const value = getDefaultFpsValue?.();
    return typeof value === "string" ? value : "";
  }

  function normalizeTakeKey(takeKey) {
    return typeof takeKey === "string" ? takeKey.trim() : "";
  }

  function hasOverride(takeKey) {
    return overrides.has(normalizeTakeKey(takeKey));
  }

  function getOverride(takeKey) {
    return overrides.get(normalizeTakeKey(takeKey)) || "";
  }

  /** 写入覆盖；takeKey 或 value 不合法时返回 "" 且不改动表。 */
  function setOverride(takeKey, value) {
    const key = normalizeTakeKey(takeKey);
    if (!key || !isValidFpsValue(value)) return "";
    const stored = value.trim();
    overrides.set(key, stored);
    return stored;
  }

  /** 清除覆盖，返回是否原本存在。 */
  function clearOverride(takeKey) {
    return overrides.delete(normalizeTakeKey(takeKey));
  }

  function clearAll() {
    const removed = overrides.size;
    overrides.clear();
    return removed;
  }

  /** 全部覆盖，按 takeKey 排序，便于 UI 稳定渲染。 */
  function listOverrides() {
    return Array.from(overrides.entries())
      .map(([takeKey, value]) => ({ takeKey, value }))
      .sort((a, b) => a.takeKey.localeCompare(b.takeKey));
  }

  function overrideCount() {
    return overrides.size;
  }

  function hasAnyOverride() {
    return overrides.size > 0;
  }

  function takeKeyForRecord(record) {
    if (!record || !recordKey(record)) return "";
    return groupKeyFor(record, takeGroupKeys());
  }

  function overrideValueForRecord(record) {
    return getOverride(takeKeyForRecord(record));
  }

  /** 有效帧率值：覆盖优先，其次回落值，最后全局默认。 */
  function resolveFpsValueForTake(takeKey, fallbackValue) {
    const override = getOverride(takeKey);
    if (override) return override;
    if (typeof fallbackValue === "string" && fallbackValue.trim()) return fallbackValue;
    return globalDefaultValue();
  }

  function resolveFpsForTake(takeKey, fallbackValue) {
    return parseFps(resolveFpsValueForTake(takeKey, fallbackValue));
  }

  function resolveFpsValueForRecord(record, fallbackValue) {
    return resolveFpsValueForTake(takeKeyForRecord(record), fallbackValue);
  }

  function resolveFpsForRecord(record, fallbackValue) {
    return parseFps(resolveFpsValueForRecord(record, fallbackValue));
  }

  function distinctTakeKeysFor(records) {
    const keys = [];
    const seen = new Set();
    for (const record of records || []) {
      const key = takeKeyForRecord(record);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }

  /** 给一组记录所在的每个 take 建立覆盖，返回实际生效的 take 列表。 */
  function setOverrideForRecords(records, value) {
    const applied = [];
    for (const takeKey of distinctTakeKeysFor(records)) {
      const stored = setOverride(takeKey, value);
      if (stored) applied.push({ takeKey, value: stored });
    }
    return applied;
  }

  function clearOverridesForRecords(records) {
    let cleared = 0;
    for (const takeKey of distinctTakeKeysFor(records)) {
      if (clearOverride(takeKey)) cleared += 1;
    }
    return cleared;
  }

  /** 挑出"文件元数据帧率 == value"的记录；无元数据或 value 非法时返回空。 */
  function recordsMatchingFpsValue(records, value) {
    if (!isValidFpsValue(value)) return [];
    return (records || []).filter(record => {
      const metadataValue = recordFileMetadataFpsValue(record);
      return Boolean(metadataValue) && fpsValueEquivalent(metadataValue, value);
    });
  }

  /**
   * 导入冲突时用：只给"元数据确实写了 value"的 take 建覆盖，
   * 避免把同一个文件夹里 25p 素材也一起改掉。没有命中返回 []。
   */
  function adoptMetadataFps(records, value) {
    return setOverrideForRecords(recordsMatchingFpsValue(records, value), value);
  }

  return {
    adoptMetadataFps,
    clearAll,
    clearOverride,
    clearOverridesForRecords,
    distinctTakeKeysFor,
    getOverride,
    hasAnyOverride,
    hasOverride,
    listOverrides,
    overrideCount,
    overrideValueForRecord,
    recordsMatchingFpsValue,
    resolveFpsForRecord,
    resolveFpsForTake,
    resolveFpsValueForRecord,
    resolveFpsValueForTake,
    setOverride,
    setOverrideForRecords,
    takeKeyForRecord,
  };
}
