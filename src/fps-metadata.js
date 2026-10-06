import {
  bextAspeedToFpsValue,
  fpsLabel,
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
} from "./timecode.js";
import {
  GLOBAL_FPS_SOURCE_LABEL,
  TAKE_FPS_SOURCE_LABEL,
  recordFileMetadataFpsValue,
} from "./take-fps.js";

// takeFps 是可选注入的 per-take 覆盖 store（见 src/take-fps.js）。
// 不注入时下面所有解析逻辑与改动前完全一致：只有"全局界面设置"一个来源。
export function createFpsMetadataController({ fpsInput, takeFps = null }) {
  function fpsSelectLabel(value) {
    const option = Array.from(fpsInput.options).find(item => item.value === value);
    return option ? `${option.textContent} FPS` : fpsLabel(parseFps(value));
  }

  function metaFpsValue(record) {
    return record._meta?.fpsValue || record._video?.fpsValue || "";
  }

  function importedMetadataFpsValue(record) {
    return record._meta?.fpsValue || "";
  }

  function fileMetadataFpsValue(record) {
    return recordFileMetadataFpsValue(record);
  }

  /** 该 record 所属 take 是否有 per-take 覆盖；有则返回覆盖值，否则 ""。 */
  function takeFpsOverrideValue(record) {
    return takeFps?.overrideValueForRecord?.(record) || "";
  }

  function detectedMetadataFps(recordsToCheck) {
    const counts = new Map();
    for (const record of recordsToCheck) {
      const value = fileMetadataFpsValue(record) || metaFpsValue(record);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    return {
      value: sorted[0][0],
      count: sorted[0][1],
      total: Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
      all: sorted,
    };
  }

  function recordFpsValue(record) {
    return takeFpsOverrideValue(record) || fileMetadataFpsValue(record) || metaFpsValue(record) || fpsInput.value;
  }

  function recordFps(record) {
    return parseFps(recordFpsValue(record));
  }

  function recordFpsSource(record) {
    if (takeFpsOverrideValue(record)) return TAKE_FPS_SOURCE_LABEL;
    if (ixmlRateToFpsValue(record.ixmlInfo)) return "iXML";
    if (bextAspeedToFpsValue(record.bextInfo)) return "bext aSPEED";
    if (importedMetadataFpsValue(record)) return "ALE/CSV";
    if (record._video?.fpsValue) return "视频元数据";
    return GLOBAL_FPS_SOURCE_LABEL;
  }

  // 机器可读的来源分类，供 UI 做徽章/样式映射（对应"全局选择 / 文件元数据 / per-take 覆盖"三类）。
  function recordFpsSourceKind(record) {
    if (takeFpsOverrideValue(record)) return "override";
    if (fileMetadataFpsValue(record) || importedMetadataFpsValue(record) || record._video?.fpsValue) return "metadata";
    return "ui";
  }

  function recordFpsDisplay(record) {
    return `${fpsSelectLabel(recordFpsValue(record))} · ${recordFpsSource(record)}`;
  }

  function setFpsValue(value) {
    fpsInput.value = value;
    fpsInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function differsFromUi(value) {
    return !fpsValueEquivalent(value, fpsInput.value);
  }

  return {
    detectedMetadataFps,
    differsFromUi,
    fileMetadataFpsValue,
    fpsSelectLabel,
    recordFps,
    recordFpsDisplay,
    recordFpsSource,
    recordFpsSourceKind,
    recordFpsValue,
    setFpsValue,
    takeFpsOverrideValue,
  };
}
