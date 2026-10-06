// 交付验收清单（src/acceptance-checklist.js）。
//
// 这个模块的唯一职责：把 docs/声音合板指南.md 的「交付检查清单」变成结构化数据，
// 并且**不假装工具能判断的事它判断不了**。所以测试重点不是"全绿"，
// 而是钉死三件事：
// 1. 同一份输入永远得到同一份清单（纯函数、不修改入参）；
// 2. 5 个方案下的 state 矩阵逐项固定 —— 方案错了就是 bug；
// 3. 拿不到 take 体检结果时降级为 manual 而不是崩掉（src/take-health.js 尚未接入）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTANCE_ITEM_IDS,
  ACCEPTANCE_STATES,
  ACCEPTANCE_TEXT_BOM,
  acceptanceChecklistStateOf,
  acceptanceChecklistText,
  acceptanceHealthSeverityState,
  buildAcceptanceChecklist,
  renderAcceptanceChecklistText,
} from "../src/acceptance-checklist.js";

const PROFILE_IDS = ["resolve", "sidus", "pluraleyes", "syncaila", "archive"];

/** 合并结果的最小可信形状：字段名取自 wave-combine.js:390-396 与 poly-export-profiles.js。 */
function combineResult(overrides = {}) {
  return {
    name: "FOLDER01_A001_Poly.WAV",
    channels: 4,
    durationSamples: 384000n,
    sampleRate: 48000,
    bitsPerSample: 24,
    profile: "resolve",
    tracks: [
      { outputChannel: 1, name: "Tr1", source: "FOLDER01/B001.wav", sourceChannel: 1 },
      { outputChannel: 2, name: "Tr2", source: "FOLDER01/B001.wav", sourceChannel: 2 },
      { outputChannel: 3, name: "Tr3", source: "FOLDER01/B001.wav", sourceChannel: 3 },
      { outputChannel: 4, name: "Tr4", source: "FOLDER01/B001.wav", sourceChannel: 4 },
    ],
    excludedTracks: [{ source: "FOLDER01/B001.wav", sourceChannel: 9, reason: "已确认的 LTC 通道" }],
    clippedSamples: 0,
    invalidSamples: 0,
    ...overrides,
  };
}

function stateMap(result, options = {}) {
  const checklist = buildAcceptanceChecklist(result, options);
  return Object.fromEntries(checklist.items.map(entry => [entry.id, entry.state]));
}

function detailOf(checklist, id) {
  const entry = checklist.items.find(candidate => candidate.id === id);
  assert.ok(entry, `清单里缺少 ${id}`);
  return `${entry.detail}\n${entry.guide}`;
}

// 规范夹具下的完整 state 矩阵：方案差异必须逐项固定。
function expectedMatrix(profile) {
  const base = {
    "take-source-consistency": "pass",
    "ltc-channel-confirmed": "pass",
    "profile-decided": "pass",
    "exclusion-decisions": "pass",
    "resolve-mono-mapping": "manual",
    "sync-start-mid-end": "manual",
    "camera-audio-not-poly": "manual",
    "pcm24-conversion-clean": "pass",
    "sidecars-kept": "manual",
    "source-immutable": "pass",
    "syncref-usage": "na",
    "ltc-track-muted": "na",
    "archive-encoding-preserved": "na",
    "take-health-clear": "manual",
  };
  if (profile === "sidus") base["ltc-track-muted"] = "manual";
  if (profile === "pluraleyes" || profile === "syncaila") {
    base["resolve-mono-mapping"] = "na";
    base["camera-audio-not-poly"] = "na";
    base["syncref-usage"] = "manual";
  }
  if (profile === "archive") {
    base["pcm24-conversion-clean"] = "na";
    base["ltc-track-muted"] = "manual";
    base["archive-encoding-preserved"] = "pass";
  }
  return base;
}

test("清单项目 id 与顺序固定，且每个 id 只出现一次", () => {
  const checklist = buildAcceptanceChecklist(combineResult());
  assert.deepEqual(checklist.items.map(entry => entry.id), [...ACCEPTANCE_ITEM_IDS]);
  assert.equal(new Set(checklist.items.map(entry => entry.id)).size, ACCEPTANCE_ITEM_IDS.length);
  assert.equal(checklist.schema, "slatesync/acceptance-checklist/v1");
  for (const entry of checklist.items) {
    assert.ok(ACCEPTANCE_STATES[entry.state.toUpperCase()], `未知 state：${entry.state}`);
    assert.ok(entry.label && entry.detail, `${entry.id} 缺少 label/detail`);
    assert.equal(typeof entry.guide, "string");
  }
});

test("纯函数：同一份输入两次调用结果一致，且不改写入参", () => {
  const result = combineResult({ profile: "pluraleyes", referenceName: "FOLDER01_A001_SyncRef.WAV" });
  const before = JSON.stringify(result, (key, value) => (typeof value === "bigint" ? value.toString() : value));
  const first = buildAcceptanceChecklist(result);
  const second = buildAcceptanceChecklist(result);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(result, (key, value) => (typeof value === "bigint" ? value.toString() : value)), before);
});

test("5 个方案下的 state 矩阵逐项固定", () => {
  for (const profile of PROFILE_IDS) {
    const checklist = buildAcceptanceChecklist(combineResult({ profile }));
    assert.deepEqual(stateMap(combineResult({ profile })), expectedMatrix(profile), `方案 ${profile} 的矩阵不符`);
    assert.equal(checklist.profile, profile);
    const counted = { pass: 0, fail: 0, manual: 0, na: 0 };
    for (const entry of checklist.items) counted[entry.state] += 1;
    assert.equal(checklist.summary.total, ACCEPTANCE_ITEM_IDS.length);
    assert.equal(checklist.summary.pass, counted.pass);
    assert.equal(checklist.summary.fail, counted.fail);
    assert.equal(checklist.summary.manual, counted.manual);
    assert.equal(checklist.summary.na, counted.na);
    assert.equal(checklist.summary.needsHuman, counted.manual);
    assert.equal(checklist.summary.pass + checklist.summary.fail + checklist.summary.manual + checklist.summary.na, checklist.summary.total);
  }
});

test("Resolve 会把 2/4/5 通道当 Stereo / Adaptive，不是自动拆 Mono", () => {
  const stereo = buildAcceptanceChecklist(combineResult({ channels: 2 }));
  assert.ok(detailOf(stereo, "resolve-mono-mapping").includes("双通道导入为 Stereo"));
  assert.ok(detailOf(stereo, "resolve-mono-mapping").includes("不是自动拆成独立 Mono 轨"));
  for (const channels of [4, 5]) {
    const text = detailOf(buildAcceptanceChecklist(combineResult({ channels })), "resolve-mono-mapping");
    assert.ok(text.includes(`Adaptive ${channels}`), `${channels} 通道应提示 Adaptive`);
  }
  const mono = detailOf(buildAcceptanceChecklist(combineResult({ channels: 1 })), "resolve-mono-mapping");
  assert.ok(mono.includes("单通道") && mono.includes("[1]"));
  const three = detailOf(buildAcceptanceChecklist(combineResult({ channels: 3 })), "resolve-mono-mapping");
  assert.ok(three.includes("不在已实测范围内"), "3 通道属未实测区间，必须说明而不是假装确定");
  assert.ok(detailOf(buildAcceptanceChecklist(combineResult()), "resolve-mono-mapping").includes("Mono 离散映射"));
});

test("只有需要 SyncRef 的方案才出现 syncref-usage", () => {
  for (const profile of ["resolve", "sidus", "archive"]) {
    const checklist = buildAcceptanceChecklist(combineResult({ profile }), { referenceName: "X_SyncRef.WAV" });
    assert.equal(acceptanceChecklistStateOf(checklist, "syncref-usage"), "na");
    assert.ok(detailOf(checklist, "syncref-usage").includes("不适用"));
  }
  for (const profile of ["pluraleyes", "syncaila"]) {
    const withoutRef = buildAcceptanceChecklist(combineResult({ profile }));
    assert.equal(acceptanceChecklistStateOf(withoutRef, "syncref-usage"), "manual");
    assert.ok(detailOf(withoutRef, "syncref-usage").includes("没有生成独立 mono SyncRef"));

    const withRef = buildAcceptanceChecklist(combineResult({ profile, referenceName: "FOLDER01_A001_SyncRef.WAV" }), { referenceChannel: 1 });
    assert.equal(acceptanceChecklistStateOf(withRef, "syncref-usage"), "pass");
    const text = detailOf(withRef, "syncref-usage");
    assert.ok(text.includes("FOLDER01_A001_SyncRef.WAV"), "SyncRef 文件名要写进清单");
    assert.ok(text.includes("不是新增制作轨"));
    assert.ok(text.includes("不要把主 Poly、原始分轨和 SyncRef 同时当成同一个 take 的三组独立音频导入"));
    assert.ok(text.includes("SyncRef 不能替代真实现场声音"));
    assert.equal(withRef.items.find(entry => entry.id === "syncref-usage").evidence.referenceChannel, 1);
  }
  // options.referenceName 是 poly-combine-controller.js 传入 sidecar 的写法，也要认。
  const fromOptions = buildAcceptanceChecklist(combineResult({ profile: "syncaila" }), { referenceName: "REF.WAV" });
  assert.equal(acceptanceChecklistStateOf(fromOptions, "syncref-usage"), "pass");
});

test("sidus 保留 LTC 时要求在目标软件静音技术轨；clean 方案不适用", () => {
  const sidus = buildAcceptanceChecklist(combineResult({ profile: "sidus" }));
  assert.equal(acceptanceChecklistStateOf(sidus, "ltc-track-muted"), "manual");
  assert.ok(detailOf(sidus, "ltc-track-muted").includes("明确关闭或静音 LTC 技术轨"));

  const archive = buildAcceptanceChecklist(combineResult({ profile: "archive" }));
  assert.equal(acceptanceChecklistStateOf(archive, "ltc-track-muted"), "manual");

  for (const profile of ["resolve", "pluraleyes", "syncaila"]) {
    const clean = buildAcceptanceChecklist(combineResult({ profile }));
    assert.equal(acceptanceChecklistStateOf(clean, "ltc-track-muted"), "na");
  }
});

test("archive 保留编码、不做 PCM24 转换；其余方案该项不适用", () => {
  const archive = buildAcceptanceChecklist(combineResult({ profile: "archive", channels: 2, clippedSamples: 99 }));
  assert.equal(acceptanceChecklistStateOf(archive, "pcm24-conversion-clean"), "na");
  assert.ok(detailOf(archive, "pcm24-conversion-clean").includes("保留源编码"));
  assert.equal(acceptanceChecklistStateOf(archive, "archive-encoding-preserved"), "pass");
  assert.ok(detailOf(archive, "archive-encoding-preserved").includes("没有做 PCM24 转换"));

  for (const profile of ["resolve", "sidus", "pluraleyes", "syncaila"]) {
    const checklist = buildAcceptanceChecklist(combineResult({ profile }));
    assert.equal(acceptanceChecklistStateOf(checklist, "archive-encoding-preserved"), "na");
    assert.equal(acceptanceChecklistStateOf(checklist, "pcm24-conversion-clean"), "pass");
  }
});

test("削波或非有限值大于 0 → fail，并带上具体数字", () => {
  const clipped = buildAcceptanceChecklist(combineResult({ profile: "resolve", clippedSamples: 12, invalidSamples: 0 }));
  assert.equal(acceptanceChecklistStateOf(clipped, "pcm24-conversion-clean"), "fail");
  const entry = clipped.items.find(item => item.id === "pcm24-conversion-clean");
  assert.ok(entry.detail.includes("12 个超范围样本"));
  assert.deepEqual(entry.evidence, { clippedSamples: 12, invalidSamples: 0 });
  assert.ok(entry.guide.includes("超过 0 dBFS"));

  const invalid = buildAcceptanceChecklist(combineResult({ profile: "sidus", clippedSamples: 0, invalidSamples: 3 }));
  assert.equal(acceptanceChecklistStateOf(invalid, "pcm24-conversion-clean"), "fail");

  const clean = buildAcceptanceChecklist(combineResult({ profile: "resolve" }));
  assert.equal(acceptanceChecklistStateOf(clean, "pcm24-conversion-clean"), "pass");
  assert.equal(clean.summary.fail, 0);

  const unknown = buildAcceptanceChecklist({ name: "X_Poly.WAV", profile: "resolve", channels: 2 });
  assert.equal(acceptanceChecklistStateOf(unknown, "pcm24-conversion-clean"), "manual");
});

test("LTC 声道确认只认检测结论，不认用户手选或空清单", () => {
  const confirmed = buildAcceptanceChecklist(combineResult());
  assert.equal(acceptanceChecklistStateOf(confirmed, "ltc-channel-confirmed"), "pass");
  assert.ok(detailOf(confirmed, "ltc-channel-confirmed").includes("不是文件名猜测"));

  const userPicked = buildAcceptanceChecklist(combineResult({ excludedTracks: [{ source: "B.wav", sourceChannel: 9, reason: "用户排除" }] }));
  assert.equal(acceptanceChecklistStateOf(userPicked, "ltc-channel-confirmed"), "manual");

  const none = buildAcceptanceChecklist(combineResult({ excludedTracks: [] }));
  assert.equal(acceptanceChecklistStateOf(none, "ltc-channel-confirmed"), "manual");
  assert.equal(acceptanceChecklistStateOf(none, "exclusion-decisions"), "manual");
});

test("没有 health findings 时不崩，五个方案全部降级为人工确认", () => {
  for (const profile of PROFILE_IDS) {
    for (const options of [{}, { healthFindings: null }, { healthFindings: undefined }, { healthFindings: "not-an-array" }]) {
      const checklist = buildAcceptanceChecklist(combineResult({ profile }), options);
      assert.equal(acceptanceChecklistStateOf(checklist, "take-health-clear"), "manual");
      assert.ok(detailOf(checklist, "take-health-clear").includes("未接入 take 体检结果"));
    }
  }
  const broken = buildAcceptanceChecklist(combineResult(), { healthFindings: [null, "x", 7] });
  assert.equal(acceptanceChecklistStateOf(broken, "take-health-clear"), "pass");
});

test("health findings 按 severity 分流，并按 takeKey 过滤", () => {
  const clean = buildAcceptanceChecklist(combineResult(), { healthFindings: [] });
  assert.equal(acceptanceChecklistStateOf(clean, "take-health-clear"), "pass");

  const warning = buildAcceptanceChecklist(combineResult(), {
    healthFindings: [{ takeKey: "FOLDER01/A001", takeLabel: "A001", severity: "warn", code: "TC_UNCONFIRMED", title: "起始时码未确认", detail: "只有文件名推测", suggestion: "听一次拍板" }],
  });
  assert.equal(acceptanceChecklistStateOf(warning, "take-health-clear"), "manual");
  const warnText = detailOf(warning, "take-health-clear");
  assert.ok(warnText.includes("TC_UNCONFIRMED") && warnText.includes("A001") && warnText.includes("建议：听一次拍板"));

  const error = buildAcceptanceChecklist(combineResult(), {
    healthFindings: [{ takeKey: "FOLDER01/A001", severity: "error", code: "DURATION_MISMATCH", title: "分轨时长不同" }],
  });
  assert.equal(acceptanceChecklistStateOf(error, "take-health-clear"), "fail");
  assert.equal(error.summary.fail, 1);

  const mixed = buildAcceptanceChecklist(combineResult(), { healthFindings: [
    { takeKey: "FOLDER01/A001", severity: "warn", code: "W", title: "提示" },
    { takeKey: "FOLDER01/A002", severity: "error", code: "E", title: "错误" },
  ], takeKey: "FOLDER01/A002" });
  assert.equal(acceptanceChecklistStateOf(mixed, "take-health-clear"), "fail");
  assert.ok(detailOf(mixed, "take-health-clear").includes("E"));
  assert.ok(!detailOf(mixed, "take-health-clear").includes("提示"));
});

test("未知或大小写异常的 severity 一律降级为 manual，不判 fail", () => {
  assert.equal(acceptanceHealthSeverityState("error"), "fail");
  assert.equal(acceptanceHealthSeverityState(" ERROR "), "fail");
  assert.equal(acceptanceHealthSeverityState("critical"), "fail");
  for (const severity of ["warn", "info", "unknown-value", "", null, undefined, 42]) {
    assert.equal(acceptanceHealthSeverityState(severity), "manual", `${severity} 不应判成 fail`);
  }
  const checklist = buildAcceptanceChecklist(combineResult(), { healthFindings: [{ severity: "brand-new-level", code: "X", title: "未知级别" }] });
  assert.equal(acceptanceChecklistStateOf(checklist, "take-health-clear"), "manual");
  assert.equal(checklist.summary.fail, 0);
});

test("health 明细超过上限时截断并说明剩余数量", () => {
  const findings = Array.from({ length: 11 }, (_, index) => ({ severity: "error", code: `E${index}`, title: `问题 ${index}` }));
  const checklist = buildAcceptanceChecklist(combineResult(), { healthFindings: findings });
  const entry = checklist.items.find(item => item.id === "take-health-clear");
  assert.equal(entry.state, "fail");
  assert.ok(entry.detail.includes("另有 3 项见体检面板"));
  assert.ok(entry.detail.includes("E0") && entry.detail.includes("E7"));
  assert.ok(!entry.detail.includes("E8"));
});

test("sidecar 文件名由输出文件名推导，且该项必须人工确认", () => {
  const checklist = buildAcceptanceChecklist(combineResult({ name: "FOLDER01_A001_Poly.WAV" }));
  assert.equal(acceptanceChecklistStateOf(checklist, "sidecars-kept"), "manual");
  const entry = checklist.items.find(item => item.id === "sidecars-kept");
  assert.deepEqual(entry.evidence.expected, ["FOLDER01_A001_Poly_合板说明.txt", "FOLDER01_A001_Poly_channels.json"]);
  assert.ok(entry.detail.includes("_channels.json"));
});

test("文本渲染：BOM 可选、勾选符号正确、全 CRLF", () => {
  const result = combineResult({ profile: "resolve", clippedSamples: 5 });
  const plain = acceptanceChecklistText(result);
  assert.ok(!plain.startsWith("\uFEFF"), "默认不带 BOM：追加到已有 sidecar 文本时不能重复 BOM");
  assert.equal(plain.charCodeAt(0), "【".charCodeAt(0));

  const withBom = acceptanceChecklistText(result, { bom: true });
  assert.ok(withBom.startsWith(ACCEPTANCE_TEXT_BOM));
  assert.equal(withBom.charCodeAt(0), 0xfeff);
  assert.equal(withBom, `${ACCEPTANCE_TEXT_BOM}${plain}`);
  assert.equal(ACCEPTANCE_TEXT_BOM, "\uFEFF");

  assert.ok(plain.includes("[x] "), "pass 项用 [x]");
  assert.ok(plain.includes("[!] "), "fail 项用 [!]");
  assert.ok(plain.includes("[ ] "), "manual/na 项用 [ ]");
  assert.ok(plain.includes("（发现问题）"));
  assert.ok(plain.includes("（需人工确认）"));
  assert.ok(plain.includes("（本方案不适用）"));
  assert.ok(plain.includes("【交付验收清单】"));
  assert.ok(plain.includes("方案：DaVinci Resolve｜文件：FOLDER01_A001_Poly.WAV"));
  assert.ok(!/[^\r]\n/.test(plain), "记事本 sidecar 用 CRLF，不能出现裸 LF");
  assert.ok(plain.includes("\r\n"));
});

test("na 与 manual 在文本里仍然逐条出现，不被悄悄丢掉", () => {
  const text = acceptanceChecklistText(combineResult({ profile: "archive" }));
  for (const id of ACCEPTANCE_ITEM_IDS) {
    const entry = buildAcceptanceChecklist(combineResult({ profile: "archive" })).items.find(item => item.id === id);
    assert.ok(text.includes(entry.label), `文本缺少 ${id} 的标题`);
  }
  assert.ok(text.includes("保留源编码"));
  assert.ok(text.includes("→ "), "manual 指引要单独一行渲染");
  const lineCount = text.split("\r\n").filter(line => /^\[[x! ]\] /.test(line)).length;
  assert.equal(lineCount, ACCEPTANCE_ITEM_IDS.length);
});

test("渲染器也接受已构建的清单对象（UI 侧可复用同一渲染路径）", () => {
  const checklist = buildAcceptanceChecklist(combineResult({ profile: "pluraleyes" }));
  const direct = renderAcceptanceChecklistText(checklist);
  const viaText = acceptanceChecklistText(combineResult({ profile: "pluraleyes" }));
  assert.equal(direct, viaText);
  assert.ok(direct.includes("PluralEyes"));
  assert.ok(direct.includes("共 14 项"));
});

test("非法输入抛出明确错误，不返回半成品清单", () => {
  assert.throws(() => buildAcceptanceChecklist(undefined), /合并结果/);
  assert.throws(() => buildAcceptanceChecklist(null), /合并结果/);
  assert.throws(() => buildAcceptanceChecklist(combineResult({ profile: "premiere" })), /未知 Poly 导出方案/);
  assert.throws(() => acceptanceChecklistStateOf(buildAcceptanceChecklist(combineResult()), "nope"), /未知验收项/);
});

test("moduleFallback：profile 缺省时按 resolve 判定", () => {
  const { profile, ...withoutProfile } = combineResult();
  const checklist = buildAcceptanceChecklist(withoutProfile);
  assert.equal(checklist.profile, "resolve");
  assert.equal(checklist.ltcPolicy, "exclude");
  assert.equal(checklist.encoding, "pcm24");
  assert.equal(checklist.reference, false);
  const viaOptions = buildAcceptanceChecklist(withoutProfile, { profile: "archive" });
  assert.equal(viaOptions.profile, "archive");
  assert.equal(viaOptions.profileLabel, "保留原始编码");
});