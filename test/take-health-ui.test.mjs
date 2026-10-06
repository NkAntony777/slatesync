// take 体检面板 / 导出演收面板 / per-take 帧率编辑器的视图模型
//
// 这一层测试只碰从 DOM 渲染里剥出来的纯函数（confirm-flows.js 的 view model、
// sync-workflow.js 的 sidecar 拼接、preview-table.js 的 fps 徽章 class），
// 不依赖浏览器。index.html 里那层 innerHTML 渲染因此可以随便改而不会悄悄
// 弄丢语义——这里钉住的是语义。
//
// 三条被 brief 点名、也最容易在重构中丢掉的不变量，单独有测试：
// - error 醒目、且不被"只显示 error"之外的逻辑藏起来；
// - guide 字段必须露出来（pass 也一样），否则验收模块退化成废话；
// - 帧率候选与 #fpsInput 完全一致，23.976 ≠ 24、29.97 ≠ 30、DF ≠ NDF。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_STATE_META,
  buildAcceptanceViewModel,
  buildFpsOverrideViewModel,
  buildTakeHealthViewModel,
  commonVideoFpsValue,
  fpsCandidateOptions,
  fpsRowOptions,
  healthExcludedChannelKeys,
  takeHealthConfirmLines,
  takeHealthFindingsForChecklist,
  takeHealthScopeForCombine,
} from "../src/confirm-flows.js";
import { buildAcceptanceChecklist, renderAcceptanceChecklistText } from "../src/acceptance-checklist.js";
import { syncGuideText, syncWorkflowText } from "../src/sync-workflow.js";
import { fpsBadgeClass } from "../src/preview-table.js";
import { GLOBAL_FPS_SOURCE_LABEL, TAKE_FPS_SOURCE_LABEL } from "../src/take-fps.js";
import { effectiveKeptKeys, resolveCheckedKeys } from "../src/confirm-flows.js";

const INDEX_HTML = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/** index.html 里 #fpsInput 的真实选项——per-take 候选表的唯一事实来源。 */
function indexFpsOptions() {
  const block = INDEX_HTML.match(/<select id="fpsInput"[\s\S]*?<\/select>/);
  assert.ok(block, "index.html must contain #fpsInput");
  return Array.from(block[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g))
    .map(match => ({ value: match[1], label: match[2].trim() }));
}

/** 把 index.html 的 <option> 变成 fpsCandidateOptions 认识的 select-like 对象。 */
function selectLikeFrom(options) {
  return { options: options.map(option => ({ value: option.value, textContent: option.label })) };
}

function finding(overrides = {}) {
  return {
    takeKey: "FOLDER01/ZOOM0001",
    takeLabel: "ZOOM0001",
    severity: "warn",
    code: "ltc-trust-soft-sync",
    title: "兜底模式识别的时码",
    detail: "LTC 波形有噪声，靠长段拟合才锁定起始时码。",
    suggestion: "在 Resolve 里核对同步后再交付。",
    records: [],
    channels: [],
    ...overrides,
  };
}

function take(overrides = {}) {
  const takeKey = overrides.takeKey ?? "FOLDER01/ZOOM0001";
  const takeLabel = overrides.takeLabel ?? "ZOOM0001";
  // inspectTakes 产出的每条 finding 都带着所属 take 的 key/label；这里照抄这个约定。
  const findings = (overrides.findings || []).map(item => ({ ...finding(), ...item, takeKey, takeLabel }));
  return {
    takeKey,
    takeLabel,
    ...overrides,
    findings,
    counts: {
      error: findings.filter(item => item.severity === "error").length,
      warn: findings.filter(item => item.severity === "warn").length,
      info: findings.filter(item => item.severity === "info").length,
      findingCount: findings.length,
    },
  };
}

function health(takes) {
  // summary 的键名照抄 inspectTakes：{ takeCount, findingCount, affectedTakes, error, warn, info }。
  const findings = takes.flatMap(item => item.findings);
  return {
    takes,
    summary: {
      takeCount: takes.length,
      findingCount: findings.length,
      affectedTakes: takes.filter(item => item.findings.length > 0).length,
      error: findings.filter(item => item.severity === "error").length,
      warn: findings.filter(item => item.severity === "warn").length,
      info: findings.filter(item => item.severity === "info").length,
    },
  };
}

function combineResult(overrides = {}) {
  return {
    name: "Poly_TAKE01_001.wav",
    channels: 2,
    sampleRate: 48000,
    bitsPerSample: 24,
    durationSamples: 48000n * 60n,
    timecode: "01:00:00:00",
    referenceName: "Poly_TAKE01_001_sync.wav",
    tracks: [
      { outputChannel: 1, name: "Tr1", source: "ZOOM0001_Tr1.WAV", sourceChannel: 0 },
      { outputChannel: 2, name: "Tr2", source: "ZOOM0001_Tr2.WAV", sourceChannel: 0 },
    ],
    excludedTracks: [
      { source: "ZOOM0001_Tr3.WAV", sourceChannel: 0, reason: "LTC" },
    ],
    ...overrides,
  };
}

/** buildExportChoices 的输出形状：{ takes: [{ channels: [{ key, confirmedLtc }] }], allKeys } */
function exportChoices(channelKeys, ltcKeys = []) {
  const confirmed = new Set(ltcKeys);
  return {
    takes: [{
      takeKey: "FOLDER01/ZOOM0001",
      takeLabel: "ZOOM0001",
      channels: channelKeys.map(key => ({ key, takeKey: "FOLDER01/ZOOM0001", confirmedLtc: confirmed.has(key) })),
    }],
    allKeys: channelKeys,
    confirmedLtcKeys: confirmed,
  };
}

// ================================================================ 体检面板

test("体检结果按 take 分组，并带上 severity 元信息", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeKey: "FOLDER01/A", takeLabel: "A", findings: [finding({ takeKey: "FOLDER01/A", takeLabel: "A" })] }),
    take({ takeKey: "FOLDER01/B", takeLabel: "B", findings: [] }),
  ]));
  assert.equal(model.takeCount, 2);
  assert.equal(model.takes.length, 2);
  assert.equal(model.takes[0].takeLabel, "A");
  assert.equal(model.takes[0].findings[0].meta.label, "warn");
  assert.equal(model.takes[0].findings[0].meta.icon, "⚠");
  assert.equal(model.warnCount, 1);
  assert.equal(model.hasErrors, false);
});

test("error 排在每个 take 的最前面：error 意味着这个 take 合并会出错", () => {
  const model = buildTakeHealthViewModel(health([
    take({
      takeLabel: "A",
      findings: [
        finding({ severity: "info", code: "take-ok" }),
        finding({ severity: "warn", code: "w" }),
        finding({ severity: "error", code: "duration-mismatch" }),
      ],
    }),
  ]));
  assert.deepEqual(model.takes[0].findings.map(item => item.code), ["duration-mismatch", "w", "take-ok"]);
  assert.equal(model.takes[0].severity, "error");
  assert.equal(model.hasErrors, true);
  assert.deepEqual(model.errorTakeLabels, ["A"]);
});

test("error 的 take 排在前面，info 的 take 排在后面", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeLabel: "ZZZ-clean", findings: [finding({ severity: "info" })] }),
    take({ takeLabel: "AAA-broken", findings: [finding({ severity: "error" })] }),
  ]));
  assert.deepEqual(model.takes.map(item => item.takeLabel), ["AAA-broken", "ZZZ-clean"]);
});

test("只显示 error 会隐藏 warn/info，并把藏起来的 take 数量交代清楚", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeLabel: "broken", findings: [finding({ severity: "error" })] }),
    take({ takeLabel: "only-warn", findings: [finding({ severity: "warn" })] }),
  ]), { errorsOnly: true });
  assert.equal(model.errorsOnly, true);
  assert.deepEqual(model.takes.map(item => item.takeLabel), ["broken"]);
  assert.equal(model.hiddenTakeCount, 1);
  // 计数不变：筛选是视图行为，不该把统计数字也筛掉。
  assert.equal(model.warnCount, 1);
  assert.equal(model.takeCount, 2);
});

test("单 take 超过 limit 的 finding 折叠，但留下折叠计数", () => {
  const many = Array.from({ length: 5 }, (_, index) => finding({ severity: "error", code: `e${index}` }));
  const model = buildTakeHealthViewModel(health([take({ findings: many })]), { limit: 2 });
  assert.equal(model.takes[0].findings.length, 2);
  assert.equal(model.takes[0].hiddenCount, 3);
  assert.equal(model.errorCount, 5);
});

test("合并按钮旁的计数在有 error 时点名叫声，并说明后果", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeLabel: "TAKE01", findings: [finding({ severity: "error", code: "no-ltc-or-preview" })] }),
  ]));
  assert.match(model.combineNoticeText, /1 个 take 有 error/);
  assert.match(model.combineNoticeText, /TAKE01/);
  // 后果要写出来，且不能变成一句"已阻断"。
  assert.match(model.combineNoticeText, /直接报错|错位/);
  assert.equal(model.errorTakeCount, 1);
});

test("没有 error 时计数是中性文案，不制造警报", () => {
  const model = buildTakeHealthViewModel(health([take({ findings: [finding({ severity: "warn" })] })]));
  assert.equal(model.hasErrors, false);
  assert.match(model.combineNoticeText, /无 error/);
  assert.doesNotMatch(model.combineNoticeText, /有 error/);
});

test("空数据降级：没有体检结果时面板是空态而不是崩", () => {
  for (const input of [null, undefined, {}, { takes: null }]) {
    const model = buildTakeHealthViewModel(input);
    assert.equal(model.available, false);
    assert.equal(model.empty, true);
    assert.equal(model.hasErrors, false);
    assert.equal(model.combineNoticeText, "");
    assert.deepEqual(model.takes, []);
  }
});

test("时长不一致的 take 不会被静默丢掉：inspectTakes 保留了它，面板也看得见", () => {
  const model = buildTakeHealthViewModel(health([
    take({
      takeLabel: "TRUNCATED",
      findings: [finding({ severity: "error", code: "duration-mismatch", title: "分轨时长不一致" })],
    }),
  ]));
  assert.equal(model.hasErrors, true);
  assert.equal(model.takes[0].findings[0].code, "duration-mismatch");
  assert.match(model.takes[0].findings[0].suggestion, /./);
});

test("checklist 用到的 finding 形状从视图模型里还原得出来", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeKey: "FOLDER01/A", takeLabel: "A", findings: [finding({ takeKey: "FOLDER01/A", takeLabel: "A" })] }),
    take({ takeKey: "FOLDER01/B", takeLabel: "B", findings: [finding({ takeKey: "FOLDER01/B", takeLabel: "B", severity: "error" })] }),
  ]));
  const all = takeHealthFindingsForChecklist(model);
  assert.equal(all.length, 2);
  assert.deepEqual(Object.keys(all[0]).sort(), ["code", "detail", "severity", "suggestion", "takeKey", "takeLabel", "title"]);
  const onlyB = takeHealthFindingsForChecklist(model, "FOLDER01/B");
  assert.equal(onlyB.length, 1);
  assert.equal(onlyB[0].severity, "error");
});

test("scope 到本次合并的 take：没被合并的 take 的 error 不算在这次账上", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeKey: "FOLDER01/IN", takeLabel: "IN", findings: [finding({ severity: "error", takeKey: "FOLDER01/IN", takeLabel: "IN" })] }),
    take({ takeKey: "FOLDER01/OUT", takeLabel: "OUT", findings: [finding({ severity: "error", takeKey: "FOLDER01/OUT", takeLabel: "OUT" })] }),
  ]));
  const scope = takeHealthScopeForCombine(model, [["FOLDER01/IN", []]]);
  assert.equal(scope.hasErrors, true);
  assert.equal(scope.errorTakeCount, 1);
  assert.deepEqual(scope.errorTakeLabels, ["IN"]);
  // 被滤掉的那个 take 的 error 仍然留在原模型里——面板上照样看得见。
  assert.equal(model.errorTakeCount, 2);
});

test("本次合并的 take 都没 error 时，scope 不制造告警", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeKey: "FOLDER01/A", takeLabel: "A", findings: [finding({ severity: "warn" })] }),
    take({ takeKey: "FOLDER01/B", takeLabel: "B", findings: [finding({ severity: "error" })] }),
  ]));
  const scope = takeHealthScopeForCombine(model, [["FOLDER01/A", []]]);
  assert.equal(scope.hasErrors, false);
  assert.deepEqual(scope.errorTakeLabels, []);
});

test("确认框文案点名 take、原因与建议，并且明确不替用户阻断", () => {
  const model = buildTakeHealthViewModel(health([
    take({ takeLabel: "TAKE01", findings: [finding({ severity: "error", code: "duration-mismatch", title: "分轨时长不一致" })] }),
  ]));
  const lines = takeHealthConfirmLines(takeHealthScopeForCombine(model, [["FOLDER01/ZOOM0001", []]]));
  const text = lines.join("\n");
  assert.match(text, /1 条 error/);
  assert.match(text, /TAKE01/);
  assert.match(text, /分轨时长不一致/);
  assert.match(text, /不判断哪一项可以忽略/);
});

test("确认框文案超过 limit 时说明还有几条", () => {
  const findings = Array.from({ length: 4 }, (_, i) => finding({ severity: "error", code: `e${i}`, title: `问题 ${i}` }));
  const model = buildTakeHealthViewModel(health([take({ takeLabel: "TAKE01", findings })]));
  const text = takeHealthConfirmLines(takeHealthScopeForCombine(model, [["FOLDER01/ZOOM0001", []]]), { limit: 2 }).join("\n");
  assert.match(text, /还有 2 条/);
});

test("没有 error 时确认框不出现体检段落", () => {
  const model = buildTakeHealthViewModel(health([take({ findings: [] })]));
  assert.deepEqual(takeHealthConfirmLines(takeHealthScopeForCombine(model, [["FOLDER01/ZOOM0001", []]])), []);
  assert.deepEqual(takeHealthConfirmLines(null), []);
});

// ================================================================ 验收面板

test("checklist 分成 fail / manual / pass / na 四组，顺序是先处理的", () => {
  const checklist = {
    outputName: "Poly_TAKE01.wav",
    profileLabel: "Resolve",
    channels: 4,
    summary: { total: 4, pass: 1, fail: 1, manual: 1, na: 1, needsHuman: 1 },
    items: [
      { id: "p", state: "pass", label: "源文件未被改动", detail: "d", guide: "g" },
      { id: "f", state: "fail", label: "体检有 error", detail: "d", guide: "g" },
      { id: "m", state: "manual", label: "同步试听", detail: "d", guide: "g" },
      { id: "n", state: "na", label: "编码", detail: "d", guide: "" },
    ],
  };
  const model = buildAcceptanceViewModel(checklist);
  assert.deepEqual(model.groups.map(group => group.state), ["fail", "manual", "pass", "na"]);
  assert.deepEqual(model.groups.map(group => group.count), [1, 1, 1, 1]);
  assert.equal(model.hasProblems, true);
  assert.equal(model.needsHuman, 1);
});

test("guide 字段被保留且计入统计——这是整个模块存在的理由", () => {
  const checklist = buildAcceptanceChecklist(combineResult(), {
    profile: "resolve",
    referenceName: "Poly_TAKE01_001_sync.wav",
    referenceChannel: "FOLDER01/ZOOM0001_Tr1.WAV:0",
    takeKey: "FOLDER01/ZOOM0001",
    healthFindings: [],
  });
  const model = buildAcceptanceViewModel(checklist);
  const withGuide = model.items.filter(item => item.hasGuide);
  assert.ok(withGuide.length > 0, "real checklist must carry guides");
  // pass 也带 guide：自动确认过 ≠ 不用在目标软件里动手。
  const passWithGuide = withGuide.filter(item => item.state === "pass");
  assert.ok(passWithGuide.length > 0, "a passing item still needs a manual action in Resolve");
  assert.equal(model.guideCount, withGuide.length);
});

test("每一项都带得出 state 的图标与配色类", () => {
  const model = buildAcceptanceViewModel({
    summary: { total: 4, pass: 1, fail: 1, manual: 1, na: 1, needsHuman: 1 },
    items: [
      { id: "a", state: "pass", label: "l", detail: "d", guide: "" },
      { id: "b", state: "fail", label: "l", detail: "d", guide: "" },
      { id: "c", state: "manual", label: "l", detail: "d", guide: "" },
      { id: "d", state: "na", label: "l", detail: "d", guide: "" },
    ],
  });
  assert.deepEqual(model.items.map(item => item.meta.className), [
    "accept-item pass", "accept-item fail", "accept-item manual", "accept-item na",
  ]);
  assert.deepEqual(model.items.map(item => item.meta.icon), ["✓", "✗", "!", "–"]);
  assert.deepEqual(Object.keys(ACCEPTANCE_STATE_META), ["pass", "fail", "manual", "na"]);
});

test("needsHuman 会翻译成「还有 N 项需要你人工确认」", () => {
  const model = buildAcceptanceViewModel({
    summary: { total: 2, pass: 1, fail: 0, manual: 1, na: 0, needsHuman: 1 },
    items: [
      { id: "a", state: "pass", label: "l", detail: "d", guide: "g" },
      { id: "b", state: "manual", label: "l", detail: "d", guide: "g" },
    ],
  });
  assert.match(model.needsHumanText, /还有 1 项需要你人工确认/);
  assert.match(model.summaryText, /需人工确认 1/);
});

test("有 fail 但没有 manual 时，提示语换成「先处理」", () => {
  const model = buildAcceptanceViewModel({
    summary: { total: 1, pass: 0, fail: 1, manual: 0, na: 0, needsHuman: 0 },
    items: [{ id: "a", state: "fail", label: "l", detail: "d", guide: "g" }],
  });
  assert.equal(model.needsHuman, 0);
  assert.match(model.needsHumanText, /1 项发现了问题/);
});

test("勾选状态按 item id 保留", () => {
  const items = [
    { id: "a", state: "pass", label: "l", detail: "d", guide: "" },
    { id: "b", state: "manual", label: "l", detail: "d", guide: "" },
  ];
  const model = buildAcceptanceViewModel({ summary: { total: 2, pass: 1, fail: 0, manual: 1, na: 0, needsHuman: 1 }, items }, { checked: new Set(["b"]) });
  assert.equal(model.checkedCount, 1);
  assert.deepEqual(model.items.map(item => item.checked), [false, true]);
});

test("清单缺失时降级为不可用，而不是抛错", () => {
  for (const input of [null, undefined, {}, { items: null }]) {
    const model = buildAcceptanceViewModel(input);
    assert.equal(model.available, false);
    assert.equal(model.empty, true);
    assert.equal(model.needsHuman, 0);
    assert.deepEqual(model.groups, []);
    assert.match(model.needsHumanText, /导入与试听仍需你确认/);
  }
});

test("未知的 state 不会让面板崩，退到 manual 的样式", () => {
  const model = buildAcceptanceViewModel({
    summary: { total: 1, pass: 0, fail: 0, manual: 0, na: 0, needsHuman: 0 },
    items: [{ id: "x", state: "weird", label: "l", detail: "d", guide: "" }],
  });
  assert.equal(model.items[0].meta, ACCEPTANCE_STATE_META.manual);
});

// ================================================================ sidecar 拼接

test("验收清单文本用 \\r\\n 接在合板说明之后", () => {
  const result = combineResult();
  const checklist = buildAcceptanceChecklist(result, { profile: "resolve", referenceName: result.referenceName, referenceChannel: "FOLDER01/ZOOM0001_Tr1.WAV:0" });
  const base = syncWorkflowText(result, { referenceName: result.referenceName });
  const text = syncGuideText(result, { referenceName: result.referenceName, checklist });
  assert.ok(text.startsWith(base), "既有合板说明正文必须原样保留在最前");
  assert.equal(text.slice(base.length), `\r\n${renderAcceptanceChecklistText(checklist)}`);
  assert.match(text, /【交付验收清单】/);
});

test("sidecar 只有一个 BOM，清单段落不会再插一个", () => {
  const result = combineResult();
  const checklist = buildAcceptanceChecklist(result, { profile: "resolve", referenceName: result.referenceName, referenceChannel: "FOLDER01/ZOOM0001_Tr1.WAV:0" });
  // poly-combine-controller.js 给整篇加一次 BOM；syncGuideText 不许自己再加。
  const text = `\uFEFF${syncGuideText(result, { referenceName: result.referenceName, checklist })}`;
  assert.equal(text.split("\uFEFF").length - 1, 1);
  assert.ok(text.startsWith("\uFEFF"));
});

test("没有清单时 sidecar 与以前完全一致", () => {
  const result = combineResult();
  assert.equal(
    syncGuideText(result, { referenceName: result.referenceName }),
    syncWorkflowText(result, { referenceName: result.referenceName }),
  );
});

// ================================================================ index.html 静态接线

/**
 * 没有 jsdom（运行时零依赖，package.json 归别人管），所以用静态检查代替真跑浏览器。
 * 它抓的正是本轮真踩到过的那几类错：id 拼错、CSS 类不存在、import 路径写错。
 */
test("index.html 里 getElementById 的每个 id 都真实存在（含本轮新增的）", () => {
  const ids = new Set(Array.from(INDEX_HTML.matchAll(/\sid="([^"]+)"/g)).map(match => match[1]));
  const referenced = Array.from(INDEX_HTML.matchAll(/getElementById\("([^"]+)"\)/g)).map(match => match[1]);
  const missing = [...new Set(referenced)].filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `getElementById 指向不存在的 id: ${missing.join(", ")}`);
});

test("本轮新增的 DOM id 都在 index.html 里，且各自只出现一次", () => {
  const newIds = [
    "takeHealthSection", "takeHealthSummary", "takeHealthErrorsOnlyInput", "takeHealthBody",
    "acceptanceSection", "acceptanceSummary", "acceptanceNeedsHuman", "acceptanceBody", "acceptanceCloseBtn",
    "combineHealthNotice",
    "fpsOverrideAddInput", "fpsOverrideAddBtn", "fpsOverrideClearAllBtn", "fpsOverrideHint", "fpsOverrideList",
  ];
  for (const id of newIds) {
    const count = (INDEX_HTML.match(new RegExp(`\\sid="${id}"`, "g")) || []).length;
    assert.equal(count, 1, `#${id} 应该在 HTML 里恰好出现一次，实际 ${count}`);
  }
});

test("新面板用到的 CSS 类在 style.css 里都有定义", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
  // 从本轮新增的三段渲染代码里抠 class="..." 的字面量。
  const classes = new Set();
  for (const match of INDEX_HTML.matchAll(/class="([^"{}]+)"/g)) {
    // 只查带本轮前缀的类，避免把整个既有样式表都拖进来断言。
    for (const name of match[1].split(/\s+/)) {
      if (/^(take-health|accept|acceptance|fps-override|combine-health|diag-issue|diag-take|diag-status|diag-headline|diag-issue-count|rail-notice-title)/.test(name)) classes.add(name);
    }
  }
  // 动态拼出来的（模板串里带 ${} 的）不参与——它们的真实名字由 view model 决定，
  // 已由 buildTakeHealthViewModel / ACCEPTANCE_STATE_META / BUILD fps options 的测试覆盖。
  const missing = [...classes].filter(name => !new RegExp(`\\.${name.replace(/[-]/g, "\\-")}[\\s.,{:]`).test(css));
  assert.deepEqual(missing, [], `style.css 缺少这些类: ${missing.join(", ")}`);
});

test("W5a 的 post-render 绕过代码已经清掉", () => {
  assert.doesNotMatch(INDEX_HTML, /markTakeFpsBadges/, "绕过用的 markTakeFpsBadges 应当已删除");
  // 由 preview-table.js 直接给 class，不再按徽章文案反推。
  assert.doesNotMatch(INDEX_HTML, /classList\.add\("take-override"\)/);
});

test("fps-badge.take-override 与 fps-badge.ui 都在 style.css 里", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
  assert.match(css, /\.fps-badge\.take-override\s*\{/);
  assert.match(css, /\.fps-badge\.ui\s*\{/);
});

test("prefers-reduced-motion 与窄屏降级都写进了 style.css", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
});

test("index.html 里的每个相对 import 都能解析到真实文件", async () => {
  const paths = [...new Set(Array.from(INDEX_HTML.matchAll(/from "\.\/([^"]+)"/g)).map(match => match[1]))];
  assert.ok(paths.length > 0);
  const missing = [];
  for (const path of paths) {
    try { await import(new URL(`../${path}`, import.meta.url)); }
    catch (error) { missing.push(`${path}: ${error.message}`); }
  }
  assert.deepEqual(missing, [], `import 失败: ${missing.join(" | ")}`);
});


test("fps 徽章区分 per-take 覆盖 / 文件元数据 / 界面设置三种来源", () => {
  assert.equal(fpsBadgeClass(TAKE_FPS_SOURCE_LABEL), "fps-badge take-override");
  assert.equal(fpsBadgeClass("iXML"), "fps-badge ixml");
  assert.equal(fpsBadgeClass("bext aSPEED"), "fps-badge ixml");
  assert.equal(fpsBadgeClass("ALE/CSV"), "fps-badge ixml");
  assert.equal(fpsBadgeClass("视频元数据"), "fps-badge video");
  assert.equal(fpsBadgeClass(GLOBAL_FPS_SOURCE_LABEL), "fps-badge ui");
});

test("fps 徽章保留 LTC / 预览两条既有来源，且未知来源退回基色", () => {
  assert.equal(fpsBadgeClass("LTC检测"), "fps-badge ltc");
  assert.equal(fpsBadgeClass("FPS预览"), "fps-badge preview");
  assert.equal(fpsBadgeClass("将来新增的来源"), "fps-badge");
  assert.equal(fpsBadgeClass(undefined), "fps-badge");
});

test("per-take 覆盖的红、界面设置的灰、文件元数据的绿 三者不撞色", () => {
  const classes = new Set([fpsBadgeClass(TAKE_FPS_SOURCE_LABEL), fpsBadgeClass("iXML"), fpsBadgeClass(GLOBAL_FPS_SOURCE_LABEL)]);
  assert.equal(classes.size, 3);
});

// ================================================================ 帧率候选

test("per-take 候选帧率与 #fpsInput 的选项逐项一致", () => {
  const expected = indexFpsOptions();
  assert.ok(expected.length > 0);
  assert.deepEqual(fpsCandidateOptions(selectLikeFrom(expected)), expected);
});

test("23.976 ≠ 24、29.97 ≠ 30、DF ≠ NDF 在候选表里都成立", () => {
  const values = fpsCandidateOptions(selectLikeFrom(indexFpsOptions())).map(option => option.value);
  for (const value of ["23.976", "24", "29.97", "29.97df", "30", "59.94", "59.94df", "60", "119.88", "119.88df"]) {
    assert.ok(values.includes(value), `missing ${value}`);
  }
  // 同一时间的两种帧率必须能被区分开，否则 per-take 覆盖就是装饰。
  assert.notEqual(new Set(["23.976", "24"]).size, 1);
  assert.notEqual(new Set(["29.97", "30"]).size, 1);
  assert.notEqual(new Set(["29.97df", "30"]).size, 1);
  assert.notEqual(new Set(["29.97", "29.97df"]).size, 1);
  assert.equal(new Set(values).size, values.length, "候选值不能重复");
});

test("空 select 降级成空候选，不抛错", () => {
  for (const input of [null, undefined, {}, { options: [] }]) {
    assert.deepEqual(fpsCandidateOptions(input), []);
  }
});

test("候选表里没有的当前值会被补出来，而不是显示成空白", () => {
  const candidates = indexFpsOptions();
  const options = fpsRowOptions({ candidates, value: "23.98" });
  assert.equal(options[0].value, "23.98");
  assert.equal(options[0].extra, true);
  assert.equal(options.length, candidates.length + 1);
  // 已经在表里的值不重复补。
  assert.equal(fpsRowOptions({ candidates, value: "25" }).length, candidates.length);
});

test("编辑器按 take 列出当前帧率与来源，未覆盖的 take 是可添加候选", () => {
  const model = buildFpsOverrideViewModel({
    candidates: indexFpsOptions(),
    takeKeys: ["FOLDER01/ZOOM0002", "FOLDER01/ZOOM0001"],
    overrides: [{ takeKey: "FOLDER01/ZOOM0002", value: "29.97df" }],
    defaultValue: "24",
    takeLabelFor: key => key.split("/").pop(),
    sourceKindForTake: key => (key.endsWith("ZOOM0002") ? "override" : "metadata"),
    resolvedValueForTake: (key, fallback) => (key.endsWith("ZOOM0002") ? "29.97df" : "25"),
  });
  assert.equal(model.takeCount, 2);
  assert.equal(model.overrideCount, 1);
  // 行按 take 标签排序，不依赖插入顺序。
  assert.deepEqual(model.rows.map(row => row.takeLabel), ["ZOOM0001", "ZOOM0002"]);
  assert.equal(model.rows[0].kind, "metadata");
  assert.equal(model.rows[0].sourceText, "文件元数据");
  assert.equal(model.rows[0].value, "25");
  assert.equal(model.rows[1].kind, "override");
  assert.equal(model.rows[1].sourceText, "per-take 覆盖");
  assert.equal(model.rows[1].value, "29.97df");
  assert.equal(model.rows[1].hasOverride, true);
  assert.deepEqual(model.addableTakes.map(item => item.takeLabel), ["ZOOM0001"]);
});

test("每一行的下拉都带着完整候选表（与工程帧率一致）", () => {
  const candidates = indexFpsOptions();
  const model = buildFpsOverrideViewModel({
    candidates,
    takeKeys: ["FOLDER01/A"],
    overrides: [],
    defaultValue: "24",
    sourceKindForTake: () => "ui",
  });
  assert.deepEqual(model.rows[0].options.map(option => option.value), candidates.map(option => option.value));
  assert.equal(model.rows[0].value, "24");
  assert.equal(model.rows[0].sourceText, "界面全局设置");
});

test("界面全局设置改变后，未覆盖的 take 跟着变", () => {
  const build = defaultValue => buildFpsOverrideViewModel({
    candidates: indexFpsOptions(),
    takeKeys: ["FOLDER01/A"],
    overrides: [],
    defaultValue,
    sourceKindForTake: () => "ui",
  }).rows[0].value;
  assert.equal(build("24"), "24");
  assert.equal(build("25"), "25");
});

test("没有素材时编辑器降级为空态", () => {
  const model = buildFpsOverrideViewModel({ candidates: indexFpsOptions(), takeKeys: [], overrides: [], defaultValue: "24" });
  assert.equal(model.empty, true);
  assert.equal(model.takeCount, 0);
  assert.equal(model.overrideCount, 0);
  assert.deepEqual(model.addableTakes, []);
  assert.match(model.summaryText, /导入素材后/);
});

test("summary 说清覆盖了几个 take", () => {
  const model = buildFpsOverrideViewModel({
    candidates: indexFpsOptions(),
    takeKeys: ["A", "B", "C"],
    overrides: [{ takeKey: "A", value: "25" }],
    defaultValue: "24",
  });
  assert.match(model.summaryText, /1\/3 个 take/);
});

// ================================================================ 体检输入辅助

test("视频帧率只在所有视频/ALE 一致时才作为基准", () => {
  assert.equal(commonVideoFpsValue([{ _video: { fpsValue: "25" } }, { _video: { fpsValue: "25" } }]), "25");
  assert.equal(commonVideoFpsValue([{ _meta: { fpsValue: "30" } }]), "30");
  // 两个视频写不同帧率时，"与摄影机帧率冲突" 只会是噪声。
  assert.equal(commonVideoFpsValue([{ _video: { fpsValue: "25" } }, { _video: { fpsValue: "30" } }]), "");
  assert.equal(commonVideoFpsValue([{ name: "no-fps.wav" }]), "");
  assert.equal(commonVideoFpsValue([]), "");
  assert.equal(commonVideoFpsValue(null), "");
});

test("体检看到的剔除集合是全部通道减去最终保留的那些（含方案自动排除的 LTC）", () => {
  const choices = exportChoices(["k1", "k2", "k3", "ltc"], ["ltc"]);
  const excluded = healthExcludedChannelKeys(choices, "resolve", new Set(["k1", "k2", "k3"]));
  assert.ok(excluded.has("ltc"), "resolve 方案自动排除的 LTC 也算被剔除");
  assert.ok(!excluded.has("k1"));
  assert.deepEqual([...excluded], ["ltc"]);

  // archive 方案不排 LTC，勾上了就保留；勾掉的仍然算剔除。
  const archive = healthExcludedChannelKeys(choices, "archive", new Set(["k1", "ltc"]));
  assert.deepEqual([...archive].sort(), ["k2", "k3"]);
});

test("手动取消勾选的通道同样计入剔除集合", () => {
  const choices = exportChoices(["k1", "k2"]);
  const excluded = healthExcludedChannelKeys(choices, "resolve", new Set(["k1"]));
  assert.deepEqual([...excluded], ["k2"]);
});

test("剔除集合与实际保留集合互为补集", () => {
  const choices = exportChoices(["k1", "k2", "k3", "ltc"], ["ltc"]);
  const explicit = new Map([["k2", false]]);
  const checked = resolveCheckedKeys(choices, "resolve", explicit);
  const kept = effectiveKeptKeys(choices, "resolve", checked);
  const excluded = healthExcludedChannelKeys(choices, "resolve", resolveCheckedKeys(choices, "resolve", explicit));
  for (const key of choices.allKeys) {
    assert.notEqual(kept.has(key), excluded.has(key), `${key} must be in exactly one side`);
  }
  assert.equal(kept.size + excluded.size, choices.allKeys.length);
});
