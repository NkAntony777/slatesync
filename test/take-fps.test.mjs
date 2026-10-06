// per-take 帧率覆盖（src/take-fps.js）以及它对 src/fps-metadata.js 的影响。
//
// 三件事必须同时成立：
// 1. 覆盖优先于全局界面设置；
// 2. 清除覆盖后精确回落到全局设置；
// 3. 没有任何覆盖时，recordFpsValue / recordFps / recordFpsSource /
//    recordFpsDisplay / detectedMetadataFps / differsFromUi 与改动前逐字符一致
//    —— 最后一条用一份"改动前的原实现"做对照矩阵来钉死。

import test from "node:test";
import assert from "node:assert/strict";

import {
  GLOBAL_FPS_SOURCE_LABEL,
  TAKE_FPS_SOURCE_LABEL,
  createTakeFpsStore,
  isValidFpsValue,
  recordFileMetadataFpsValue,
} from "../src/take-fps.js";
import { createFpsMetadataController } from "../src/fps-metadata.js";
import { createFileImportController } from "../src/file-import.js";
import { createLtcController } from "../src/ltc-controller.js";
import { detectTakeGroupKeys } from "../src/grouping.js";
import {
  bextAspeedToFpsValue,
  fpsLabel,
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
} from "../src/timecode.js";

const FPS_OPTIONS = [
  { value: "23.976", textContent: "23.976" },
  { value: "24", textContent: "24" },
  { value: "25", textContent: "25" },
  { value: "29.97", textContent: "29.97" },
  { value: "29.97df", textContent: "29.97 DF" },
  { value: "30", textContent: "30" },
  { value: "50", textContent: "50" },
];

/** 最小 fpsInput 替身：只需要 options / value / dispatchEvent。 */
function fakeFpsInput(value = "25") {
  const el = new EventTarget();
  el.value = value;
  el.options = FPS_OPTIONS;
  return el;
}

function wavRecord(name, parentPath = "FOLDER01", extra = {}) {
  return {
    name,
    relativePath: `${parentPath}/${name}`,
    parentPath,
    channels: 1,
    sampleRate: 48000,
    ...extra,
  };
}

// 三个 take：ZOOM0001 声明 23.976，ZOOM0002 声明 25，ZOOM0003 完全没有元数据。
const RECORDS = [
  wavRecord("ZOOM0001_Tr1.WAV", "FOLDER01", { ixmlInfo: { timecodeRate: { value: "24000/1001" }, timecodeFlag: { value: "NDF" } } }),
  wavRecord("ZOOM0001_Tr2.WAV", "FOLDER01", { ixmlInfo: { timecodeRate: { value: "24000/1001" }, timecodeFlag: { value: "NDF" } } }),
  wavRecord("ZOOM0002_Tr1.WAV", "FOLDER01", { bextInfo: { description: "aSPEED=25" } }),
  wavRecord("ZOOM0002_Tr2.WAV", "FOLDER01", { bextInfo: { description: "aSPEED=25" } }),
  wavRecord("ZOOM0003_Tr1.WAV", "FOLDER01"),
  wavRecord("ZOOM0003_Tr2.WAV", "FOLDER01"),
];

function setup({ globalFps = "25", withStore = true } = {}) {
  const fpsInput = fakeFpsInput(globalFps);
  const takeGroupKeys = detectTakeGroupKeys(RECORDS);
  const takeFps = withStore
    ? createTakeFpsStore({ getTakeGroupKeys: () => takeGroupKeys, getDefaultFpsValue: () => fpsInput.value })
    : null;
  const fps = createFpsMetadataController(withStore ? { fpsInput, takeFps } : { fpsInput });
  return { fpsInput, takeGroupKeys, takeFps, fps };
}

const TAKE_A = "FOLDER01/ZOOM0001";
const TAKE_B = "FOLDER01/ZOOM0002";
const TAKE_C = "FOLDER01/ZOOM0003";
const recA1 = RECORDS[0];
const recA2 = RECORDS[1];
const recB1 = RECORDS[2];
const recC1 = RECORDS[4];

// ---------- 覆盖优先于全局 ----------

test("覆盖优先于全局设置", () => {
  const { takeFps } = setup({ globalFps: "25" });

  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "25", "没有覆盖时回落全局默认");
  assert.equal(takeFps.setOverride(TAKE_A, "23.976"), "23.976");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "23.976", "覆盖压过全局默认");
  assert.equal(takeFps.hasOverride(TAKE_A), true);
  assert.equal(takeFps.getOverride(TAKE_A), "23.976");
  assert.deepEqual(takeFps.resolveFpsForTake(TAKE_A), parseFps("23.976"));
});

test("覆盖也压过调用方传入的回落值", () => {
  const { takeFps } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "29.97df");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A, "50"), "29.97df");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_B, "50"), "50", "未覆盖的 take 仍用回落值");
});

test("按 record 解析帧率：同一 take 的所有分轨共享覆盖", () => {
  const { takeFps } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "23.976");

  assert.equal(takeFps.takeKeyForRecord(recA1), TAKE_A);
  assert.equal(takeFps.takeKeyForRecord(recA2), TAKE_A);
  assert.equal(takeFps.overrideValueForRecord(recA1), "23.976");
  assert.equal(takeFps.overrideValueForRecord(recA2), "23.976", "同 take 的另一条分轨也命中");
  assert.equal(takeFps.resolveFpsValueForRecord(recA1), "23.976");
  assert.equal(takeFps.resolveFpsValueForRecord(recA2, "50"), "23.976");
  assert.equal(takeFps.resolveFpsValueForRecord(recB1, "50"), "50", "别的 take 不受影响");
  assert.deepEqual(takeFps.resolveFpsForRecord(recC1), parseFps("25"));
});

test("非法帧率值被拒绝且不污染覆盖表", () => {
  const { takeFps } = setup();
  for (const bad of ["", "   ", "abc", "12/0", null, undefined, 25, "0"]) {
    assert.equal(takeFps.setOverride(TAKE_A, bad), "", `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(takeFps.setOverride("", "25"), "", "空 takeKey 不接受写入");
  assert.equal(takeFps.overrideCount(), 0);
  assert.equal(takeFps.hasAnyOverride(), false);
  assert.equal(isValidFpsValue("24000/1001"), true);
  assert.equal(isValidFpsValue(" 25 "), true, "带空白仍可解析，写入时被 trim");
  assert.equal(takeFps.setOverride(TAKE_A, " 24 "), "24", "写入时 trim");
});

// ---------- 清除覆盖后回落 ----------

test("清除覆盖后回落到全局设置", () => {
  const { takeFps } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "23.976");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "23.976");

  assert.equal(takeFps.clearOverride(TAKE_A), true, "清除已有覆盖返回 true");
  assert.equal(takeFps.clearOverride(TAKE_A), false, "重复清除返回 false");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "25", "回到全局默认");
  assert.equal(takeFps.hasOverride(TAKE_A), false);
  assert.deepEqual(takeFps.listOverrides(), []);
});

test("按 take 批量清除只影响该 take", () => {
  const { takeFps } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "23.976");
  takeFps.setOverride(TAKE_B, "30");

  assert.equal(takeFps.clearOverridesForRecords([recA1, recA2]), 1, "一次清除整个 take");
  assert.equal(takeFps.resolveFpsValueForRecord(recA1), "25");
  assert.equal(takeFps.resolveFpsValueForRecord(recB1), "30", "另一个 take 保留覆盖");
  assert.equal(takeFps.clearAll(), 1);
  assert.equal(takeFps.overrideCount(), 0);
});

// ---------- 多个 take 互不干扰 ----------

test("多个 take 各自独立", () => {
  const { takeFps, fpsInput } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "23.976");
  takeFps.setOverride(TAKE_B, "29.97df");
  // TAKE_C 故意不覆盖

  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "23.976");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_B), "29.97df");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_C), "25");
  assert.equal(fpsInput.value, "25", "覆盖不会回写全局控件");
  assert.equal(takeFps.overrideCount(), 2);
  assert.deepEqual(takeFps.listOverrides(), [
    { takeKey: TAKE_A, value: "23.976" },
    { takeKey: TAKE_B, value: "29.97df" },
  ], "listOverrides 按 takeKey 排序");
});

test("改全局设置后，未覆盖的 take 跟着变、已覆盖的 take 不动", () => {
  const { takeFps, fpsInput } = setup({ globalFps: "25" });
  takeFps.setOverride(TAKE_A, "23.976");

  fpsInput.value = "50";
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_C), "50", "未覆盖的 take 跟随全局");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "23.976", "已覆盖的 take 不受全局影响");
});

// ---------- 导入冲突：只覆盖元数据命中的 take ----------

test("adoptMetadataFps 只覆盖元数据命中的 take，同目录的 25p 素材不受影响", () => {
  const { takeFps, fpsInput } = setup({ globalFps: "25" });

  const applied = takeFps.adoptMetadataFps(RECORDS, "23.976");
  assert.deepEqual(applied, [{ takeKey: TAKE_A, value: "23.976" }], "只命中 ZOOM0001");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_A), "23.976");
  assert.equal(takeFps.resolveFpsValueForTake(TAKE_B), "25", "25p 的 ZOOM0002 保持全局值");
  assert.equal(fpsInput.value, "25", "全局控件没有被改动");
});

test("adoptMetadataFps 用等价帧率匹配（29.97 与 30000/1001 视为同一个）", () => {
  const { takeFps } = setup({ globalFps: "25" });
  const applied = takeFps.adoptMetadataFps(RECORDS, "23.98");
  assert.deepEqual(applied, [{ takeKey: TAKE_A, value: "23.98" }], "23.98 是合法输入，原样存储");
  assert.equal(fpsValueEquivalent(takeFps.resolveFpsValueForTake(TAKE_A), "23.976"), true);
});

test("adoptMetadataFps 没有命中或值非法时返回空，交回调用方走全局回退", () => {
  const { takeFps } = setup({ globalFps: "25" });
  assert.deepEqual(takeFps.adoptMetadataFps(RECORDS, "120"), [], "没有文件声明 120");
  assert.deepEqual(takeFps.adoptMetadataFps(RECORDS, ""), [], "空值不采纳");
  assert.deepEqual(takeFps.adoptMetadataFps(RECORDS, "bogus"), [], "非法值不采纳");
  assert.deepEqual(takeFps.adoptMetadataFps([], "25"), []);
  assert.equal(takeFps.overrideCount(), 0);
});

test("recordsMatchingFpsValue 忽略没有帧率元数据的文件", () => {
  const { takeFps } = setup();
  assert.deepEqual(takeFps.recordsMatchingFpsValue(RECORDS, "25").map(r => r.name), [
    "ZOOM0002_Tr1.WAV",
    "ZOOM0002_Tr2.WAV",
  ]);
  assert.equal(recordFileMetadataFpsValue(RECORDS[4]), "");
  assert.equal(recordFileMetadataFpsValue(null), "");
});

test("setOverrideForRecords 一个 take 只写一条，跨 take 各写一条", () => {
  const { takeFps } = setup({ globalFps: "25" });
  const applied = takeFps.setOverrideForRecords([recA1, recA2, recB1, recC1], "24");
  assert.deepEqual(applied, [
    { takeKey: TAKE_A, value: "24" },
    { takeKey: TAKE_B, value: "24" },
    { takeKey: TAKE_C, value: "24" },
  ]);
  assert.equal(takeFps.overrideCount(), 3);
});

// ---------- 来源标记 ----------

test("来源标记区分 per-take 覆盖 / 文件元数据 / 全局选择", () => {
  const { fps, takeFps } = setup({ globalFps: "25" });

  assert.equal(fps.recordFpsSource(recA1), "iXML");
  assert.equal(fps.recordFpsSourceKind(recA1), "metadata");
  assert.equal(fps.recordFpsSource(recB1), "bext aSPEED");
  assert.equal(fps.recordFpsSourceKind(recB1), "metadata");
  assert.equal(fps.recordFpsSource(recC1), GLOBAL_FPS_SOURCE_LABEL);
  assert.equal(fps.recordFpsSourceKind(recC1), "ui");

  takeFps.setOverride(TAKE_A, "29.97df");
  assert.equal(fps.recordFpsSource(recA1), TAKE_FPS_SOURCE_LABEL);
  assert.equal(fps.recordFpsSourceKind(recA1), "override");
  assert.equal(fps.recordFpsSource(recA2), TAKE_FPS_SOURCE_LABEL, "同 take 的所有分轨都标成覆盖");
  assert.equal(fps.recordFpsSource(recB1), "bext aSPEED", "别的 take 的来源标记不受影响");
});

test("覆盖值优先于文件元数据参与预览计算", () => {
  const { fps, takeFps } = setup({ globalFps: "25" });
  assert.equal(fps.recordFpsValue(recA1), "23.976", "元数据优先（改动前的既有行为）");

  takeFps.setOverride(TAKE_A, "30");
  assert.equal(fps.recordFpsValue(recA1), "30", "per-take 覆盖优先于元数据");
  assert.equal(fps.recordFpsValue(recA2), "30");
  assert.deepEqual(fps.recordFps(recA1), parseFps("30"));
  assert.equal(fps.recordFpsDisplay(recA1), "30 FPS · per-take 覆盖");
  assert.equal(fps.takeFpsOverrideValue(recA1), "30");
  assert.equal(fps.takeFpsOverrideValue(recB1), "", "未覆盖的 take 返回空串");

  takeFps.clearOverride(TAKE_A);
  assert.equal(fps.recordFpsValue(recA1), "23.976", "清除覆盖后回到元数据");
  assert.equal(fps.recordFpsSource(recA1), "iXML");
});

test("覆盖 ALE/CSV 与视频元数据记录", () => {
  const fpsInput = fakeFpsInput("25");
  const metaRecord = { name: "A001_C001.mov", relativePath: "FOLDER01/A001_C001.mov", _meta: { fpsValue: "29.97" } };
  const videoRecord = { name: "A002_C002.wav", relativePath: "FOLDER01/A002_C002.wav", _video: { fpsValue: "50" } };
  const takeGroupKeys = detectTakeGroupKeys([metaRecord, videoRecord]);
  const takeFps = createTakeFpsStore({ getTakeGroupKeys: () => takeGroupKeys, getDefaultFpsValue: () => fpsInput.value });
  const fps = createFpsMetadataController({ fpsInput, takeFps });

  assert.equal(fps.recordFpsSource(metaRecord), "ALE/CSV");
  assert.equal(fps.recordFpsSource(videoRecord), "视频元数据");

  takeFps.setOverride(takeFps.takeKeyForRecord(metaRecord), "24");
  takeFps.setOverride(takeFps.takeKeyForRecord(videoRecord), "30");
  assert.equal(fps.recordFpsSource(metaRecord), TAKE_FPS_SOURCE_LABEL);
  assert.equal(fps.recordFpsSource(videoRecord), TAKE_FPS_SOURCE_LABEL);
  assert.equal(fps.recordFpsValue(metaRecord), "24", "覆盖压过 ALE/CSV 的 29.97");
  assert.equal(fps.recordFpsValue(videoRecord), "30", "覆盖压过视频元数据的 50");
  assert.equal(isOverride(fps, metaRecord), true);
  assert.equal(isOverride(fps, videoRecord), true);
});

function isOverride(fps, record) {
  return fps.recordFpsSourceKind(record) === "override";
}

test("recordFpsSourceKind 对没有元数据的记录回落到 ui", () => {
  const { fps, takeFps } = setup({ globalFps: "25" });
  assert.equal(fps.recordFpsSourceKind(recC1), "ui");
  takeFps.setOverride(TAKE_C, "60");
  assert.equal(fps.recordFpsSourceKind(recC1), "override");
  assert.equal(fps.recordFpsValue(recC1), "60");
});

function recordFpsValueKindIsOverride(fps, record) {
  return fps.recordFpsSourceKind(record) === "override";
}

// ---------- LTC 检测按 take 解析帧率 ----------

// createLtcController 在构造期读 window.Worker（没有 Worker 就走主线程解码路径），
// 解析 per-take 帧率的两个导出是纯函数，所以这里可以脱离浏览器直接测。
function ltcControllerFor({ globalFps = "25", takeFps = null } = {}) {
  const previousWindow = globalThis.window;
  globalThis.window = { Worker: null };
  try {
    return createLtcController({
      els: { fpsInput: fakeFpsInput(globalFps) },
      takeFps,
      fpsSelectLabel: value => value,
      recordsByGroup: () => new Map(),
      groupLabel: record => record?.name || "",
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("LTC 控制器：没有 takeFps 时每个 take 都用全局帧率", () => {
  const ltc = ltcControllerFor({ globalFps: "25" });
  assert.equal(ltc.resolveTakeFpsValue(TAKE_A), "25");
  assert.equal(ltc.resolveTakeFpsValue(TAKE_B), "25");
  assert.deepEqual(ltc.takeCandidateFpsValues(TAKE_A), FPS_OPTIONS.map(o => o.value),
    "候选帧率就是下拉框的全部选项，与改动前一致");
});

test("LTC 控制器：覆盖的 take 用自己的帧率，其它 take 不受影响", () => {
  const { takeFps } = setup({ globalFps: "25" });
  const ltc = ltcControllerFor({ globalFps: "25", takeFps });
  takeFps.setOverride(TAKE_A, "23.976");

  assert.equal(ltc.resolveTakeFpsValue(TAKE_A), "23.976");
  assert.equal(ltc.resolveTakeFpsValue(TAKE_B), "25");
  assert.equal(ltc.resolveTakeFpsValue(TAKE_A, "50"), "23.976", "显式提示值优先");
  assert.equal(ltc.takeCandidateFpsValues(TAKE_A)[0], "23.976", "覆盖值排在候选首位");
  assert.equal(ltc.takeCandidateFpsValues(TAKE_B)[0], "23.976", "候选本身仍是下拉框全部选项");

  takeFps.setOverride(TAKE_B, "24000/1001");
  assert.equal(ltc.resolveTakeFpsValue(TAKE_B), "24000/1001");
  assert.deepEqual(ltc.takeCandidateFpsValues(TAKE_B), ["24000/1001", ...FPS_OPTIONS.map(o => o.value)],
    "下拉框里没有的帧率值会被补进候选并排最前");

  takeFps.clearOverride(TAKE_A);
  assert.equal(ltc.resolveTakeFpsValue(TAKE_A), "25", "清除覆盖后解码回到全局帧率");
});

// ---------- 导入冲突：per-take 覆盖取代全局污染 ----------

// 一个文件夹里同时有 23.976 的 take 和 25p 的素材，正是现场要处理的混合情况。
const MIXED_IMPORT = [
  { name: "ZOOM0001_Tr1.WAV", ixml: "24000/1001" },
  { name: "ZOOM0001_Tr2.WAV", ixml: "24000/1001" },
  { name: "ZOOM0001_Tr3.WAV", ixml: "24000/1001" },
  { name: "ZOOM0004_Tr1.WAV", ixml: "25" },
];

function fakeImportSetup({ globalFps = "25", withStore = true, adopt = true, items = MIXED_IMPORT } = {}) {
  const fpsInput = fakeFpsInput(globalFps);
  const fps = createFpsMetadataController({ fpsInput });
  const records = [];
  let takeGroupKeys = new Map();
  const takeFps = withStore
    ? createTakeFpsStore({ getTakeGroupKeys: () => takeGroupKeys, getDefaultFpsValue: () => fpsInput.value })
    : null;
  const logs = [];
  const setFpsValueCalls = [];
  const prompts = [];
  const rendered = [];
  const disabled = () => ({ disabled: false });
  const els = {
    undoBtn: disabled(), previewBtn: disabled(), extractLtcBtn: disabled(),
    extractLtcFallbackBtn: disabled(), exportMetadataBtn: disabled(),
    combinePolyBtn: disabled(), writeLtcBtn: disabled(),
    statusLine: { textContent: "" },
  };
  const fileImport = createFileImportController({
    els,
    scanWave: (entry, { relativePath, parentPath }) => {
      const spec = items.find(item => item.name === entry.name);
      const record = {
        name: entry.name, relativePath, parentPath,
        channels: 1, sampleRate: 48000, durationSamples: 48000n,
      };
      if (spec.ixml) record.ixmlInfo = { timecodeRate: { value: spec.ixml }, timecodeFlag: { value: "NDF" } };
      if (spec.meta) record._meta = { fpsValue: spec.meta };
      return record;
    },
    scanVideo: async () => { throw new Error("测试里不导入视频"); },
    wavSuffix: /\.(wav|wave)$/i,
    videoSuffix: /\.(mov|mp4|mxf)$/i,
    metadataSuffix: /\.(csv|ale)$/i,
    parseMetadataImport: () => [],
    setDirectoryHandle: () => {},
    getRecords: () => records,
    pushRecord: record => records.push(record),
    clearAfterImportState: () => {},
    refreshTakeGroups: () => { takeGroupKeys = detectTakeGroupKeys(records); },
    takeGroupCount: () => new Set(takeGroupKeys.values()).size,
    combineEligibleGroups: () => [],
    detectedMetadataFps: fps.detectedMetadataFps,
    fpsDiffersFromUi: fps.differsFromUi,
    fpsInput,
    setFpsValue: value => { setFpsValueCalls.push(value); fps.setFpsValue(value); },
    fpsSelectLabel: fps.fpsSelectLabel,
    confirmMetadataFpsMismatch: async payload => { prompts.push(payload); return adopt; },
    takeFps,
    renderRows: () => rendered.push(records.length),
    setState: () => {},
    log: message => logs.push(message),
    guarded: fn => fn,
  });
  return { fileImport, records, takeFps, fpsInput, fps, logs, setFpsValueCalls, prompts, rendered };
}

function dropImportItems(items = MIXED_IMPORT) {
  return items.map(spec => ({
    webkitGetAsEntry: () => ({
      isFile: true,
      name: spec.name,
      file: resolve => resolve(new File([new Uint8Array(64)], spec.name)),
    }),
  }));
}

test("导入冲突选择“采用元数据”：只给受影响的 take 建覆盖，不动全局设置", async () => {
  const { fileImport, takeFps, fpsInput, logs, setFpsValueCalls, prompts } = fakeImportSetup({ adopt: true });

  await fileImport.handleDropItems(dropImportItems());

  assert.equal(prompts.length, 1, "仍然通过 confirmMetadataFpsMismatch 询问");
  assert.equal(prompts[0].currentValue, "25");
  assert.equal(prompts[0].metadata.value, "23.976");
  assert.deepEqual(setFpsValueCalls, [], "关键：不再调用全局 setFpsValue");
  assert.equal(fpsInput.value, "25", "全局帧率选择保持不变");

  assert.deepEqual(takeFps.listOverrides(), [{ takeKey: "/ZOOM0001", value: "23.976" }],
    "只有元数据为 23.976 的 take 拿到覆盖");
  assert.equal(takeFps.resolveFpsValueForTake("/ZOOM0004_Tr1.WAV"), "25",
    "同目录的 25p 素材回落全局 25");
  assert.ok(logs.some(line => line.includes("applied to 1 take(s) from file metadata")),
    `日志应说明按 take 应用：${JSON.stringify(logs)}`);
});

test("导入冲突选择“保持当前”：既不建覆盖也不动全局", async () => {
  const { fileImport, takeFps, fpsInput, setFpsValueCalls, logs } = fakeImportSetup({ adopt: false });

  await fileImport.handleDropItems(dropImportItems());

  assert.deepEqual(setFpsValueCalls, []);
  assert.equal(fpsInput.value, "25");
  assert.deepEqual(takeFps.listOverrides(), []);
  assert.ok(logs.some(line => line.includes("kept 25 FPS despite file metadata 23.976 FPS")), JSON.stringify(logs));
});

test("导入冲突：没有注入 takeFps 时退回旧的全局 setFpsValue 行为", async () => {
  const { fileImport, fpsInput, setFpsValueCalls, logs } = fakeImportSetup({ withStore: false, adopt: true });

  await fileImport.handleDropItems(dropImportItems());

  assert.deepEqual(setFpsValueCalls, ["23.976"], "旧接线继续走全局切换");
  assert.equal(fpsInput.value, "23.976");
  assert.ok(logs.some(line => line.includes("switched to 23.976 FPS from file metadata")), JSON.stringify(logs));
});

test("导入冲突：元数据没命中任何 take 时同样退回全局切换", async () => {
  // 只有 ALE/CSV 的元数据帧率（_meta）时，detectedMetadataFps 会统计到它，
  // 但 adoptMetadataFps 只认文件自带的 iXML/aSPEED，所以退回旧的全局切换。
  const items = [
    { name: "ZOOM0009_Tr1.WAV", meta: "23.976" },
    { name: "ZOOM0009_Tr2.WAV", meta: "23.976" },
  ];
  const { fileImport, fpsInput, setFpsValueCalls, prompts, takeFps, logs } = fakeImportSetup({ adopt: true, items });

  await fileImport.handleDropItems(dropImportItems(items));

  assert.equal(prompts[0].metadata.value, "23.976", "冲突被检测到");
  assert.deepEqual(setFpsValueCalls, ["23.976"], "没有可覆盖的 take，退回全局切换");
  assert.equal(fpsInput.value, "23.976");
  assert.deepEqual(takeFps.listOverrides(), []);
  assert.ok(logs.some(line => line.includes("switched to 23.976 FPS from file metadata")), JSON.stringify(logs));
});

test("导入没有帧率元数据时完全不打扰用户", async () => {
  const items = [{ name: "ZOOM0010_Tr1.WAV" }, { name: "ZOOM0010_Tr2.WAV" }];
  const { fileImport, prompts, setFpsValueCalls, takeFps, logs } = fakeImportSetup({ adopt: true, items });

  await fileImport.handleDropItems(dropImportItems(items));

  assert.equal(prompts.length, 0, "没有元数据帧率就不弹窗");
  assert.deepEqual(setFpsValueCalls, []);
  assert.deepEqual(takeFps.listOverrides(), []);
  assert.equal(logs.some(line => line.includes("FPS:")), false, "不产生 FPS 日志");
});

// ---------- 回归：没有任何覆盖时，行为与改动前完全一致 ----------

// 改动前 fps-metadata.js 的原始实现，逐行照抄，用来当对照。
function legacyFileMetadataFpsValue(record) {
  return ixmlRateToFpsValue(record.ixmlInfo) || bextAspeedToFpsValue(record.bextInfo) || "";
}
function legacyMetaFpsValue(record) {
  return record._meta?.fpsValue || record._video?.fpsValue || "";
}
function legacyRecordFpsValue(record, globalValue) {
  return legacyFileMetadataFpsValue(record) || legacyMetaFpsValue(record) || globalValue;
}
function legacyRecordFpsSource(record) {
  if (ixmlRateToFpsValue(record.ixmlInfo)) return "iXML";
  if (bextAspeedToFpsValue(record.bextInfo)) return "bext aSPEED";
  if (record._meta?.fpsValue) return "ALE/CSV";
  if (record._video?.fpsValue) return "视频元数据";
  return "界面设置";
}
function legacyFpsSelectLabel(value, options) {
  const option = Array.from(options).find(item => item.value === value);
  return option ? `${option.textContent} FPS` : fpsLabel(parseFps(value));
}
function legacyDetectedMetadataFps(recordsToCheck) {
  const counts = new Map();
  for (const record of recordsToCheck) {
    const value = legacyFileMetadataFpsValue(record) || legacyMetaFpsValue(record);
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

const REGRESSION_RECORDS = [
  wavRecord("plain_Tr1.WAV", "FOLDER01"),
  wavRecord("ixml_Tr1.WAV", "FOLDER01", { ixmlInfo: { timecodeRate: { value: "23.976" }, timecodeFlag: { value: "NDF" } } }),
  wavRecord("ixml_df_Tr1.WAV", "FOLDER01", { ixmlInfo: { timecodeRate: { value: "29.97" }, timecodeFlag: { value: "DF" } } }),
  wavRecord("bext_Tr1.WAV", "FOLDER01", { bextInfo: { description: "aSPEED=25" } }),
  wavRecord("both_Tr1.WAV", "FOLDER01", {
    ixmlInfo: { timecodeRate: { value: "30" }, timecodeFlag: { value: "NDF" } },
    bextInfo: { description: "aSPEED=25" },
  }),
  wavRecord("empty_ixml_Tr1.WAV", "FOLDER01", { ixmlInfo: { timecodeRate: { value: "" } } }),
  { name: "A001_C001.mov", relativePath: "FOLDER01/A001_C001.mov", _meta: { fpsValue: "29.97" } },
  { name: "A002_C002.wav", relativePath: "FOLDER01/A002_C002.wav", _video: { fpsValue: "50" } },
  { name: "A003_C003.wav", relativePath: "FOLDER01/A003_C003.wav" },
  wavRecord("weird_Tr1.WAV", "FOLDER01", { bextInfo: { description: "not a bext line" } }),
];

for (const withStore of [false, true]) {
  const label = withStore ? "注入了空的 takeFps store" : "完全没有注入 takeFps";

  test(`回归：无覆盖时 ${label} 的 recordFps* 与改动前逐项一致`, () => {
    for (const globalFps of ["25", "24", "29.97df", "30", "50"]) {
      const { fps, fpsInput } = setup({ globalFps, withStore });
      for (const record of REGRESSION_RECORDS) {
        const expectedValue = legacyRecordFpsValue(record, globalFps);
        assert.equal(fps.recordFpsValue(record), expectedValue,
          `recordFpsValue ${record.name} @${globalFps}`);
        assert.equal(fps.recordFpsSource(record), legacyRecordFpsSource(record),
          `recordFpsSource ${record.name} @${globalFps}`);
        assert.equal(fps.recordFpsDisplay(record),
          `${legacyFpsSelectLabel(expectedValue, fpsInput.options)} · ${legacyRecordFpsSource(record)}`,
          `recordFpsDisplay ${record.name} @${globalFps}`);
        assert.deepEqual(fps.recordFps(record), parseFps(expectedValue), `recordFps ${record.name} @${globalFps}`);
        assert.equal(fps.recordFpsSourceKind(record),
          legacyRecordFpsSource(record) === "界面设置" ? "ui" : "metadata",
          `recordFpsSourceKind ${record.name} @${globalFps}`);
        assert.equal(fps.takeFpsOverrideValue(record), "", `无覆盖时 takeFpsOverrideValue ${record.name}`);
      }
    }
  });

  test(`回归：无覆盖时 ${label} 的 detectedMetadataFps / differsFromUi 与改动前一致`, () => {
    for (const globalFps of ["25", "24", "29.97df"]) {
      const { fps, fpsInput } = setup({ globalFps, withStore });
      assert.deepEqual(fps.detectedMetadataFps(REGRESSION_RECORDS), legacyDetectedMetadataFps(REGRESSION_RECORDS),
        `detectedMetadataFps @${globalFps}`);
      assert.equal(fps.detectedMetadataFps([]), null);
      for (const record of REGRESSION_RECORDS) {
        for (const candidate of ["25", "24", "23.976", "29.97df", "120"]) {
          assert.equal(fps.differsFromUi(candidate), !fpsValueEquivalent(candidate, fpsInput.value),
            `differsFromUi ${candidate} @${globalFps}`);
        }
      }
    }
  });

  test(`回归：${label} 时 fileMetadataFpsValue 与原实现一致`, () => {
    const { fps } = setup({ withStore });
    for (const record of REGRESSION_RECORDS) {
      assert.equal(fps.fileMetadataFpsValue(record), legacyFileMetadataFpsValue(record), record.name);
    }
  });
}

test("回归：setFpsValue 仍然写回控件并派发 change 事件", () => {
  const { fps, fpsInput } = setup({ globalFps: "25" });
  let changes = 0;
  fpsInput.addEventListener("change", () => { changes += 1; });
  fps.setFpsValue("29.97df");
  assert.equal(fpsInput.value, "29.97df");
  assert.equal(changes, 1);
});

test("回归：导出的函数名集合保持向后兼容", () => {
  const { fps } = setup({ withStore: false });
  for (const name of [
    "detectedMetadataFps",
    "differsFromUi",
    "fpsSelectLabel",
    "recordFps",
    "recordFpsDisplay",
    "recordFpsSource",
    "recordFpsValue",
    "setFpsValue",
  ]) {
    assert.equal(typeof fps[name], "function", `index.html 依赖的 ${name} 必须仍是函数`);
  }
});
