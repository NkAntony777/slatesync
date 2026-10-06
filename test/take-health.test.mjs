// take 级体检（src/take-health.js）
//
// 覆盖 brief 里点名的 7 类检查，每类至少一个正例，并钉死 code / severity / 中文文案要素。
// 另外钉死两条工程约束：
// - 绝不抛错：畸形输入（null 字段、BigInt/String 混用、空 take、非 Map 的结果）只产出 finding；
// - 绝不产生误报：一个完全正常的 take 应该是零 error、零 warn。

import test from "node:test";
import assert from "node:assert/strict";

import {
  LTC_TRUST,
  TAKE_HEALTH_CODES,
  effectiveTimecodeFor,
  inspectTakeHealth,
  inspectTakes,
  ltcTrustFor,
  sortFindings,
  sourceChannelKey,
} from "../src/take-health.js";
import { detectTakeGroupKeys, recordKey } from "../src/grouping.js";
import { parseFps } from "../src/timecode.js";

const FPS = { parseFps };

function rec(name, extra = {}) {
  return {
    name,
    relativePath: `FOLDER01/${name}`,
    parentPath: "FOLDER01",
    channels: 1,
    sampleRate: 48000,
    bitsPerSample: 24,
    audioFormat: 1,
    blockAlign: 3,
    durationSamples: 48000n * 60n,
    oldTimeReference: 0n,
    fileHandle: {},
    ...extra,
  };
}

function ltcOk(extra = {}) {
  return {
    ok: true,
    newTimeReference: 48000n,
    fpsValue: "25",
    timecode: "01:00:00:00",
    sourceTimecode: "01:00:00:00",
    sourceRecord: null,
    channelIndex: 0,
    channelLabel: "1",
    confidence: 0.95,
    qualityRank: 3,
    lockedFrames: 40,
    softSync: false,
    requiresConfirmation: false,
    ...extra,
  };
}

function codes(findings) {
  return findings.map(item => item.code);
}

function find(findings, code) {
  return findings.find(item => item.code === code);
}

function assertSeverity(findings, code, severity) {
  const item = find(findings, code);
  assert.ok(item, `expected finding ${code}, got ${codes(findings).join(",") || "(none)"}`);
  assert.equal(item.severity, severity, `${code} severity`);
  return item;
}

/** 4 轨 48k/24bit/60s、一致 LTC 成功、无帧率元数据的 take 视为"完全正常"。 */
function healthyRecords() {
  return [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV"), rec("ZOOM0001_Tr3.WAV"), rec("ZOOM0001_Tr4.WAV")];
}

function healthyLtc(records) {
  const map = new Map();
  const source = { ...records[0], sourceRecord: records[0], channelIndex: 0 };
  for (const record of records) map.set(recordKey(record), ltcOk({ sourceRecord: records[0], channelIndex: 0 }));
  return map;
}

// ---------------------------------------------------------------- 工具函数

test("channel key 复用 sourceTrackKey 的 `${recordKey}:${channel}` 约定", () => {
  const record = rec("ZOOM0001_Tr6.WAV");
  assert.equal(sourceChannelKey(record, 2), "FOLDER01/ZOOM0001_Tr6.WAV:2");
});

test("ltcTrustFor 区分标准 / 兜底 / 失败 / 未检测四态", () => {
  assert.equal(ltcTrustFor(ltcOk()), LTC_TRUST.STANDARD);
  assert.equal(ltcTrustFor(ltcOk({ softSync: true, requiresConfirmation: true })), LTC_TRUST.SOFT_SYNC);
  assert.equal(ltcTrustFor(ltcOk({ requiresConfirmation: true })), LTC_TRUST.SOFT_SYNC);
  assert.equal(ltcTrustFor({ ok: false, statusText: "没锁定" }), LTC_TRUST.FAILED);
  assert.equal(ltcTrustFor(ltcOk({ newTimeReference: null })), LTC_TRUST.FAILED);
  assert.equal(ltcTrustFor(undefined), LTC_TRUST.MISSING);
  assert.equal(ltcTrustFor(null), LTC_TRUST.MISSING);
});

test("effectiveTimecodeFor 优先用预览，其次 LTC，最后文件自带", () => {
  const record = rec("ZOOM0001_Tr1.WAV", { oldTimeReference: 100n });
  const ltcMap = new Map([[recordKey(record), ltcOk({ newTimeReference: 200n })]]);
  const previewMap = new Map([[recordKey(record), { newTimeReference: 300n, fpsValue: "24" }]]);

  assert.deepEqual(effectiveTimecodeFor(record, { ltcMap, previewMap: new Map() }), {
    samples: 200n, source: "ltc", fpsValue: "25", ltc: ltcMap.get(recordKey(record)), preview: null,
  });
  const withPreview = effectiveTimecodeFor(record, { ltcMap, previewMap });
  assert.equal(withPreview.source, "preview");
  assert.equal(withPreview.samples, 300n);
  assert.equal(withPreview.fpsValue, "24");
  assert.equal(effectiveTimecodeFor(record, { ltcMap: new Map() }).source, "record");
  assert.equal(effectiveTimecodeFor(rec("x.wav", { oldTimeReference: undefined }), {}).samples, null);
});

// ---------------------------------------------------------------- 1. 音频参数

test("1a 采样率不一致 -> error sample-rate-mismatch，并点名文件", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { sampleRate: 44100 })];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "sample-rate-mismatch", "error");
  assert.match(item.detail, /44100 Hz/);
  assert.match(item.detail, /ZOOM0001_Tr1\.WAV/);
  assert.match(item.detail, /ZOOM0001_Tr2\.WAV/);
  assert.ok(item.records.includes("FOLDER01/ZOOM0001_Tr1.WAV"));
});

test("1b 位深不一致 -> error bit-depth-mismatch", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { bitsPerSample: 16 })];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "bit-depth-mismatch", "error");
  assert.match(item.detail, /16 bit/);
});

test("1c 音频格式不一致 -> error audio-format-mismatch（PCM vs Float）", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { audioFormat: 3, isFloat: true })];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "audio-format-mismatch", "error");
  assert.match(item.detail, /PCM/);
  assert.match(item.detail, /Float/);
});

test("1d 时长不一致 -> error duration-mismatch，且换算成秒", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { durationSamples: 48000n * 58n })];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "duration-mismatch", "error");
  assert.match(item.detail, /60\.000s/);
  assert.match(item.detail, /58\.000s/);
  assert.match(item.detail, /2\.000s/);
});

// ---------------------------------------------------------------- 2. 起始时码

test("2a 同一 take 起始 TimeReference 不一致 -> error start-timeref-mismatch（预览路径）", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const previews = new Map([
    [recordKey(records[0]), { newTimeReference: 48000n, fpsValue: "25" }],
    [recordKey(records[1]), { newTimeReference: 480000n, fpsValue: "25" }],
  ]);
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, previews, parseFps: FPS.parseFps }),
    "start-timeref-mismatch", "error");
  // 48000 samples @48kHz/25fps = 00:00:01:00；480000 samples = 00:00:10:00
  assert.match(item.detail, /00:00:01:00/);
  assert.match(item.detail, /00:00:10:00/);
  assert.match(item.detail, /ZOOM0001_Tr2\.WAV/);
});

test("2b 同一 take 起始 TimeReference 不一致 -> error start-timeref-mismatch（LTC 路径）", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const ltc = new Map([
    [recordKey(records[0]), ltcOk({ newTimeReference: 48000n })],
    [recordKey(records[1]), ltcOk({ newTimeReference: 96000n })],
  ]);
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "start-timeref-mismatch", "error");
  // 48000 samples = 00:00:01:00；96000 samples = 00:00:02:00
  assert.match(item.detail, /00:00:01:00/);
  assert.match(item.detail, /00:00:02:00/);
});

test("2c 部分分轨没有时码 -> error timecode-source-incomplete，点名缺哪几条", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { oldTimeReference: undefined })];
  const ltc = new Map([[recordKey(records[0]), ltcOk()]]);
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "timecode-source-incomplete", "error");
  assert.match(item.detail, /ZOOM0001_Tr2\.WAV/);
  assert.deepEqual(item.records, ["FOLDER01/ZOOM0001_Tr2.WAV"]);
});

test("2d 同一 take 混用预览与 LTC 时码 -> error timecode-source-mixed", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const ltc = new Map([[recordKey(records[0]), ltcOk({ newTimeReference: 48000n })]]);
  const previews = new Map([[recordKey(records[1]), { newTimeReference: 48000n, fpsValue: "25" }]]);
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, previews, parseFps: FPS.parseFps }),
    "timecode-source-mixed", "error");
  assert.match(item.detail, /预览时码/);
  assert.match(item.detail, /LTC 时码/);
});

// ---------------------------------------------------------------- 3. LTC 可信度

test("3a 完全没有 LTC 也没有预览 -> error timecode-source-missing", () => {
  const records = healthyRecords().map(record => ({ ...record, oldTimeReference: undefined }));
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "timecode-source-missing", "error");
  assert.match(item.detail, /4 个分轨/);
  assert.ok(item.suggestion.length > 0);
});

test("3b 兜底 / 软同步结果 -> warn ltc-soft-sync-unverified，并写明 66% 错读率", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  for (const record of records) {
    ltc.set(recordKey(record), ltcOk({
      sourceRecord: records[0], channelIndex: 0, softSync: true, requiresConfirmation: true, lockedFrames: 5, confidence: 0.5,
    }));
  }
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-soft-sync-unverified", "warn");
  assert.match(item.detail, /兜底算法/);
  assert.match(item.detail, /66%/);
  assert.match(item.suggestion, /逐条核对/);
});

test("3c LTC 检测失败 -> warn ltc-detect-failed，带回 failureCode 与建议", () => {
  const records = healthyRecords();
  const ltc = new Map(records.map(record => [recordKey(record), {
    ok: false, status: "warn", statusText: "未锁定 LTC：已扫描音轨接近静音", failureCode: "silent",
    suggestion: "确认 LTC 接入并录到了正确的声道",
  }]));
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-detect-failed", "warn");
  assert.match(item.detail, /silent/);
  assert.match(item.detail, /全部/);
  assert.equal(item.suggestion, "确认 LTC 接入并录到了正确的声道");
});

test("3d 识别质量低 -> warn ltc-low-quality", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  ltc.set(recordKey(records[0]), ltcOk({ sourceRecord: records[0], channelIndex: 0, qualityRank: 1, confidence: 0.42, lockedFrames: 3 }));
  assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-low-quality", "warn");
});

test("3e 低电平靠增益恢复 -> warn ltc-low-level-recovered", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  ltc.set(recordKey(records[0]), ltcOk({ sourceRecord: records[0], channelIndex: 0, analysisGain: 3.2 }));
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-low-level-recovered", "warn");
  assert.match(item.detail, /\+10\.1 dB/);
});

test("3f DF 标记与帧率不符 -> warn ltc-dropframe-mismatch", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  ltc.set(recordKey(records[0]), ltcOk({ sourceRecord: records[0], channelIndex: 0, dropMismatch: true }));
  assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-dropframe-mismatch", "warn");
});

test("3g 从没跑过检测 -> info ltc-not-detected（不是错误，只是没检查）", () => {
  const records = healthyRecords();
  assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "ltc-not-detected", "info");
});

// ---------------------------------------------------------------- 4. 帧率冲突

test("4a 同一 take 各文件声明的帧率不一致 -> error fps-conflict-in-take", () => {
  const records = [
    rec("ZOOM0001_Tr1.WAV", { ixmlInfo: { timecodeRate: { value: "25" }, timecodeFlag: { value: "NDF" } } }),
    rec("ZOOM0001_Tr2.WAV", { ixmlInfo: { timecodeRate: { value: "30000/1001" }, timecodeFlag: { value: "NDF" } } }),
  ];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps }),
    "fps-conflict-in-take", "error");
  assert.match(item.detail, /25/);
  assert.match(item.detail, /29\.97/);
});

test("4b 与视频元数据帧率不一致 -> error fps-conflict-with-video", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  const item = assertSeverity(inspectTakeHealth({
    takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, videoFpsValue: "24", parseFps: FPS.parseFps,
  }), "fps-conflict-with-video", "error");
  assert.match(item.detail, /24/);
  assert.match(item.detail, /25/);
});

test("4c 23.976 与 23.98 视为同一帧率，29.97 与 29.97df 视为不同", () => {
  const equivalent = [
    rec("ZOOM0001_Tr1.WAV", { ixmlInfo: { timecodeRate: { value: "24000/1001" }, timecodeFlag: { value: "NDF" } } }),
    rec("ZOOM0001_Tr2.WAV", { ixmlInfo: { timecodeRate: { value: "23.98" }, timecodeFlag: { value: "NDF" } } }),
  ];
  assert.equal(find(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: equivalent, parseFps: FPS.parseFps }),
    "fps-conflict-in-take"), undefined);

  const dropMismatch = [
    rec("ZOOM0001_Tr1.WAV", { ixmlInfo: { timecodeRate: { value: "30000/1001" }, timecodeFlag: { value: "NDF" } } }),
    rec("ZOOM0001_Tr2.WAV", { ixmlInfo: { timecodeRate: { value: "30000/1001" }, timecodeFlag: { value: "DF" } } }),
  ];
  assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: dropMismatch, parseFps: FPS.parseFps }),
    "fps-conflict-in-take", "error");
});

test("4d 完全没有帧率来源 -> info fps-source-fallback", () => {
  assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: healthyRecords(), parseFps: FPS.parseFps }),
    "fps-source-fallback", "info");
});

// ---------------------------------------------------------------- 5. LTC 声道来源

test("5a 时码解出但没有来源通道 -> warn ltc-source-unconfirmed（不能靠 Tr6 顶替）", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  ltc.set(recordKey(records[0]), ltcOk({ sourceRecord: null, channelIndex: null }));
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-source-unconfirmed", "warn");
  assert.match(item.detail, /Tr6/);
  assert.match(item.suggestion, /不要用文件名/);
});

test("5b 排除列表里的通道没有检测背书 -> warn ltc-channel-unconfirmed", () => {
  const records = healthyRecords();
  const ltc = healthyLtc(records);
  const item = assertSeverity(inspectTakeHealth({
    takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc,
    ltcSourceChannels: new Set([sourceChannelKey(records[3], 0)]), parseFps: FPS.parseFps,
  }), "ltc-channel-unconfirmed", "warn");
  assert.match(item.detail, /FOLDER01\/ZOOM0001_Tr4\.WAV:0/);
});

test("5c 文件名像技术轨但从未确认 -> info ltc-named-tech-track（只提示，不判 LTC）", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_TC-IN.WAV")];
  const ltc = new Map([
    [recordKey(records[0]), ltcOk({ sourceRecord: records[0], channelIndex: 0 })],
    [recordKey(records[1]), ltcOk({ sourceRecord: records[0], channelIndex: 0 })],
  ]);
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: ltc, parseFps: FPS.parseFps }),
    "ltc-named-tech-track", "info");
  assert.deepEqual(item.channels, ["FOLDER01/ZOOM0001_TC-IN.WAV:0"]);
});

test("5d ZOOM 的 Tr6 命名本身不算技术轨，不应触发 ltc-named-tech-track", () => {
  const records = healthyRecords();
  assert.equal(find(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: healthyLtc(records), parseFps: FPS.parseFps }),
    "ltc-named-tech-track"), undefined);
});

// ---------------------------------------------------------------- 6. Poly 通道布局

test("6a 2 通道 -> info poly-stereo-pair，说明 Resolve 当 Stereo", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: healthyLtc(records), parseFps: FPS.parseFps }),
    "poly-stereo-pair", "info");
  assert.match(item.detail, /Stereo/);
  assert.match(item.suggestion, /Clip Attributes/);
  assert.deepEqual(item.channels, ["FOLDER01/ZOOM0001_Tr1.WAV:0", "FOLDER01/ZOOM0001_Tr2.WAV:0"]);
});

test("6b 4/5 通道 -> info poly-adaptive-layout，不会自动拆成独立 Mono 轨", () => {
  const four = [1, 2, 3, 4].map(n => rec(`ZOOM0001_Tr${n}.WAV`));
  const item = assertSeverity(inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: four, ltcResults: healthyLtc(four), parseFps: FPS.parseFps }),
    "poly-adaptive-layout", "info");
  assert.match(item.title, /4 通道/);
  assert.match(item.detail, /Adaptive/);
  assert.equal(item.channels.length, 4);
});

test("6c 排除 LTC 后按剩余通道数判断布局（4 轨排除 1 路 -> 3 通道 Adaptive）", () => {
  const four = [1, 2, 3, 4].map(n => rec(`ZOOM0001_Tr${n}.WAV`));
  const findings = inspectTakeHealth({
    takeKey: "FOLDER01/ZOOM0001", groupRecords: four, ltcResults: healthyLtc(four),
    ltcSourceChannels: new Set([sourceChannelKey(four[0], 0)]),
    excludedChannelKeys: new Set([sourceChannelKey(four[0], 0)]), parseFps: FPS.parseFps,
  });
  const adaptive = assertSeverity(findings, "poly-adaptive-layout", "info");
  assert.equal(adaptive.channels.length, 3, "布局判断要用排除后的实际通道数");
  assert.equal(find(findings, "poly-stereo-pair"), undefined);
});

test("6c2 3 轨排除 1 路 LTC -> 剩 2 通道，按 Stereo 提示", () => {
  const three = [1, 2, 3].map(n => rec(`ZOOM0001_Tr${n}.WAV`));
  const findings = inspectTakeHealth({
    takeKey: "FOLDER01/ZOOM0001", groupRecords: three, ltcResults: healthyLtc(three),
    ltcSourceChannels: new Set([sourceChannelKey(three[0], 0)]),
    excludedChannelKeys: new Set([sourceChannelKey(three[0], 0)]), parseFps: FPS.parseFps,
  });
  const stereo = assertSeverity(findings, "poly-stereo-pair", "info");
  assert.equal(stereo.channels.length, 2);
  assert.equal(find(findings, "poly-adaptive-layout"), undefined);
});

test("6d 全部通道被排除 -> error all-channels-excluded", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const excluded = new Set(records.map(record => sourceChannelKey(record, 0)));
  const item = assertSeverity(inspectTakeHealth({
    takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: healthyLtc(records), excludedChannelKeys: excluded, parseFps: FPS.parseFps,
  }), "all-channels-excluded", "error");
  assert.match(item.detail, /2 路/);
  assert.match(item.suggestion, /对白通道/);
});

// ---------------------------------------------------------------- 7. 汇总与不抛错

test("7a 正常 take 零 error 零 warn（防止误报刷屏）", () => {
  const records = healthyRecords();
  const findings = inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, ltcResults: healthyLtc(records), parseFps: FPS.parseFps });
  assert.equal(findings.filter(item => item.severity === "error").length, 0, codes(findings).join(","));
  assert.equal(findings.filter(item => item.severity === "warn").length, 0, codes(findings).join(","));
  assert.ok(find(findings, "ltc-not-detected") === undefined);
});

test("7b 每条 finding 的字段形状完整，code 全部登记在 TAKE_HEALTH_CODES", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { sampleRate: 44100 })];
  const findings = inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps });
  assert.ok(findings.length > 0);
  for (const item of findings) {
    assert.equal(item.takeKey, "FOLDER01/ZOOM0001");
    assert.equal(item.takeLabel, "ZOOM0001");
    assert.ok(["error", "warn", "info"].includes(item.severity));
    assert.match(item.code, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `code 必须是 kebab-case：${item.code}`);
    assert.ok(TAKE_HEALTH_CODES[item.code], `code 未登记：${item.code}`);
    assert.equal(TAKE_HEALTH_CODES[item.code], item.severity, `${item.code} 的 severity 必须与契约一致`);
    assert.ok(item.title.length > 0);
    assert.ok(item.detail.length > 20, `${item.code} 的 detail 要写具体数值，不能是废话`);
    if (item.records) assert.ok(item.records.every(key => typeof key === "string"));
    if (item.channels) assert.ok(item.channels.every(key => /:\d+$/.test(key)));
  }
});

test("7c inspectTakes 按 take 聚合并给出各 severity 计数", () => {
  const good = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV")];
  const bad = [rec("ZOOM0002_Tr1.WAV", { sampleRate: 44100 }), rec("ZOOM0002_Tr2.WAV")];
  const records = [...good, ...bad];
  const takeGroupKeys = detectTakeGroupKeys(records);
  const ltc = new Map([...good, ...bad].map(record => [recordKey(record), ltcOk({ sourceRecord: record, channelIndex: 0 })]));
  const { takes, summary } = inspectTakes({ records, takeGroupKeys, ltcResults: ltc, parseFps: FPS.parseFps });

  assert.equal(takes.length, 2);
  assert.deepEqual(takes.map(take => take.takeLabel), ["ZOOM0001", "ZOOM0002"]);
  assert.ok(summary.error >= 1, "ZOOM0002 的采样率不一致应计为 error");
  assert.equal(summary.findingCount, takes.reduce((sum, take) => sum + take.findings.length, 0));
  assert.equal(summary.error, takes.reduce((sum, take) => sum + take.counts.error, 0));
  assert.equal(summary.takeCount, 2);
  assert.ok(summary.affectedTakes >= 1);
  assert.equal(takes.find(take => take.takeLabel === "ZOOM0001").counts.error, 0);
});

test("7d 不同目录的同名 take -> error duplicate-poly-name", () => {
  const a = [rec("ZOOM0001_Tr1.WAV", { parentPath: "A" }), rec("ZOOM0001_Tr2.WAV", { parentPath: "A" })];
  const b = [rec("ZOOM0001_Tr1.WAV", { parentPath: "B" }), rec("ZOOM0001_Tr2.WAV", { parentPath: "B" })];
  for (const record of [...a, ...b]) record.relativePath = `${record.parentPath}/${record.name}`;
  const records = [...a, ...b];
  const { takes, summary } = inspectTakes({ records, takeGroupKeys: detectTakeGroupKeys(records), ltcResults: healthyLtc(records), parseFps: FPS.parseFps });
  assert.equal(takes.length, 2);
  for (const take of takes) assertSeverity(take.findings, "duplicate-poly-name", "error");
  assert.equal(summary.error, 2);
});

test("7e sortFindings 让 error 排在最前", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV", { sampleRate: 44100 })];
  const findings = inspectTakeHealth({ takeKey: "FOLDER01/ZOOM0001", groupRecords: records, parseFps: FPS.parseFps });
  const severities = findings.map(item => item.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a] - { error: 0, warn: 1, info: 2 }[b])));
  assert.deepEqual(sortFindings(findings), findings);
});

test("7f 畸形输入不抛错", () => {
  const cases = [
    () => inspectTakeHealth(),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [] }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [null, undefined] }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [rec("A_Tr1.WAV", { durationSamples: "not-a-number" })] }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [rec("A_Tr1.WAV")], ltcResults: "garbage" }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [rec("A_Tr1.WAV")], previews: 42 }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [rec("A_Tr1.WAV")], parseFps: () => { throw new Error("bad fps"); } }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [rec("A_Tr1.WAV", { channels: "x" })] }),
    () => inspectTakeHealth({ takeKey: "T", groupRecords: [{ name: "x.wav" }] }),
    () => inspectTakes(),
    () => inspectTakes({ records: "nope" }),
    () => inspectTakes({ records: [rec("A_Tr1.WAV"), rec("A_Tr2.WAV")], takeGroupKeys: null }),
    () => ltcTrustFor({ ok: true, newTimeReference: 1n, softSync: "yes" }),
    () => effectiveTimecodeFor(null, {}),
    () => sourceChannelKey(null, 0),
  ];
  for (const run of cases) assert.doesNotThrow(run);
});

test("7g take 列表默认只看真正的分轨 take，单文件不会进来", () => {
  const records = [rec("ZOOM0001_Tr1.WAV"), rec("ZOOM0001_Tr2.WAV"), rec("NOTATRACK.WAV")];
  assert.equal(inspectTakes({ records, takeGroupKeys: detectTakeGroupKeys(records), ltcResults: healthyLtc(records), parseFps: FPS.parseFps }).takes.length, 1);
  assert.equal(inspectTakes({ records, takeGroupKeys: detectTakeGroupKeys(records), includeUngrouped: true, ltcResults: healthyLtc(records), parseFps: FPS.parseFps }).takes.length, 2);
});
