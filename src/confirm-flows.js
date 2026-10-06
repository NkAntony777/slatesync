import { combineTrackPlan } from "./wave-combine.js";
import { recordKey, shortGroupLabel } from "./grouping.js";
import { polyExportProfile, polyProfileOptions, sourceTrackKey } from "./poly-export-profiles.js";

// ---------------------------------------------------------------------------
// 输出配置（方案 / 通道 / SyncRef）
//
// 界面上以前根本没有让用户选通道的地方，但 confirmCombinePoly 又在告诉用户
// "L/R 混音与 ISO 是否同时输出需显式选择"——那句话无处可去。这一节把选择
// 过程收敛成纯函数：UI 只负责画 checkbox 和回传勾上的 key，所有判断在这里做完。
//
// 返回对象的字段名必须和 src/poly-combine-controller.js、
// src/poly-export-profiles.js 现在读的完全一致（profile / selectedSourceChannels
// / excludedSourceChannels / referenceSourceChannel），不要另发明字段。
// ---------------------------------------------------------------------------

/** 没有被 combineEligibleGroups() 收编的分组，原因代码 → 中文说明。 */
export const TAKE_EXCLUSION_REASONS = Object.freeze({
  "not-a-take": "只有一个文件，没识别成分轨 take",
  "mixed-take": "同组里混入了未识别为分轨的文件",
  "duration-mismatch": "分轨时长不一致，无法逐样本对齐",
  "unknown": "不满足合并条件",
});

// grouping.js 的 hasExactSameDuration 是私有的；这里按同样判据（BigInt 精确比较）
// 复刻一份，只用来给被丢弃的分组挑一个能说清楚的理由，不参与放行判断。
function hasSameDuration(groupRecords) {
  if (!groupRecords.length) return false;
  const durations = groupRecords.map(record => BigInt(record.durationSamples));
  const min = durations.reduce((a, b) => (a < b ? a : b), durations[0]);
  const max = durations.reduce((a, b) => (a > b ? a : b), durations[0]);
  return min === max;
}

function entriesOf(source) {
  if (!source) return [];
  if (source instanceof Map) return Array.from(source.entries());
  if (Array.isArray(source)) return source;
  return Array.from(source);
}

/**
 * 把一批可合并的 take 摊平成"通道清单"。
 *
 * confirmedLtc 只认 ltcResults 里的检测结论（ok + sourceRecord + channelIndex），
 * 文件名里的 Tr6 / "LTC" 之类只是命名线索，不作为 LTC 依据——这条区分是项目里
 * 反复强调过的，界面上必须能让用户看见"哪几个通道真的被检测为 LTC"。
 */
export function buildExportChoices(groups, { ltcResults } = {}) {
  const results = new Map(entriesOf(ltcResults));
  const confirmedLtcKeys = new Set();
  const evidence = new Map();
  for (const [, groupRecords] of groups || []) {
    for (const record of groupRecords) {
      const ltc = results.get(recordKey(record));
      if (!ltc?.ok || !ltc.sourceRecord) continue;
      if (ltc.channelIndex === undefined || ltc.channelIndex === null) continue;
      const key = `${recordKey(ltc.sourceRecord)}:${ltc.channelIndex}`;
      confirmedLtcKeys.add(key);
      evidence.set(key, ltc.startTimecode || ltc.timecode || "");
    }
  }

  const takes = (groups || []).map(([takeKey, groupRecords]) => ({
    takeKey,
    takeLabel: shortGroupLabel(takeKey),
    channels: combineTrackPlan(groupRecords).map(track => {
      const key = sourceTrackKey(track);
      return {
        key,
        takeKey,
        takeLabel: shortGroupLabel(takeKey),
        recordKey: recordKey(track.record),
        recordName: track.record.name || track.record.relativePath || "",
        channelIndex: track.channelIndex,
        channelName: track.channelName,
        sourceChannelIndex: track.channelIndexValue,
        confirmedLtc: confirmedLtcKeys.has(key),
        ltcTimecode: evidence.get(key) || "",
      };
    }),
  }));

  return {
    takes,
    allKeys: takes.flatMap(take => take.channels.map(channel => channel.key)),
    confirmedLtcKeys,
  };
}

/** 某个通道在某方案下的默认勾选：排除 LTC 的方案默认不勾 LTC，其余默认全勾。 */
export function defaultCheckedForChannel(channel, profileId = "resolve") {
  const profile = polyExportProfile(profileId);
  if (profile.ltcPolicy === "exclude" && channel.confirmedLtc) return false;
  return true;
}

/**
 * 合并"方案默认"和"用户显式勾选"，得到最终勾选集合。
 * explicit 里只放用户亲手点过的 key；没点过的跟随方案默认，
 * 这样切换方案时 LTC 通道的默认勾选会自动跟着变，而不是把用户的选择冻住。
 */
export function resolveCheckedKeys(choices, profileId = "resolve", explicit = new Map()) {
  const checked = new Set();
  for (const take of choices.takes) {
    for (const channel of take.channels) {
      const value = explicit.has(channel.key)
        ? Boolean(explicit.get(channel.key))
        : defaultCheckedForChannel(channel, profileId);
      if (value) checked.add(channel.key);
    }
  }
  return checked;
}

/** 主 Poly 里真正会保留的通道：先看勾选，再按方案的 LTC 策略扣掉被排除的 LTC。 */
export function effectiveKeptKeys(choices, profileId = "resolve", checkedKeys = new Set()) {
  const profile = polyExportProfile(profileId);
  const kept = new Set();
  for (const take of choices.takes) {
    for (const channel of take.channels) {
      if (!checkedKeys.has(channel.key)) continue;
      if (profile.ltcPolicy === "exclude" && channel.confirmedLtc) continue;
      kept.add(channel.key);
    }
  }
  return kept;
}

/** 可以作为 SyncRef 的候选：主 Poly 里保留的节目通道（被 LTC 排除的不算）。 */
export function referenceChannelCandidates(choices, profileId = "resolve", checkedKeys = new Set()) {
  const kept = effectiveKeptKeys(choices, profileId, checkedKeys);
  return choices.takes.flatMap(take => take.channels.filter(channel => kept.has(channel.key)));
}

/**
 * 组装交给 poly-combine-controller 的选项。字段名与上游一致。
 * 非法组合一律抛中文错误：调用方是 guarded()，会原样弹给用户。
 */
export function buildExportOptions({
  profileId = "resolve",
  choices,
  checkedKeys = new Set(),
  referenceSourceChannel = "",
  groupCount = 1,
} = {}) {
  const profile = polyExportProfile(profileId);
  if (!choices) throw new Error("输出通道清单还没准备好，请重新点击「合并 Poly WAV」");
  const known = new Set(choices.allKeys);
  const selectedSourceChannels = new Set();
  for (const key of checkedKeys) {
    if (!known.has(key)) throw new Error(`输出通道不存在：${key}`);
    selectedSourceChannels.add(key);
  }
  if (!selectedSourceChannels.size) throw new Error("至少要保留一个输出通道：所有通道都被取消勾选了");

  const kept = effectiveKeptKeys(choices, profile.id, selectedSourceChannels);
  if (!kept.size) {
    throw new Error(`${profile.label} 会排除已确认的 LTC 通道；取消勾选后没有可用的节目音频。请勾选对白/枪声等节目通道，或改选保留 LTC 的方案`);
  }

  const options = { profile: profile.id, selectedSourceChannels };
  const reference = typeof referenceSourceChannel === "string" ? referenceSourceChannel.trim() : "";
  if (reference) {
    if (!profile.reference) throw new Error(`${profile.label} 不需要 SyncRef 参考声道；需要参考声道请改选 PluralEyes 或 Syncaila`);
    if (groupCount > 1) throw new Error(`SyncRef 需要逐 take 指定：当前有 ${groupCount} 个 take，请一次导出一个，或先清空参考声道`);
    if (!kept.has(reference)) throw new Error("SyncRef 必须从主 Poly 保留的通道里选；被方案排除的 LTC 通道和未勾选的通道都不能当参考声");
    options.referenceSourceChannel = reference;
  }
  return options;
}

/** 给"输出配置"面板的一行摘要：保留几轨、移除了几条、移的原因分别是什么。 */
export function summarizeExportSelection(choices, profileId, checkedKeys) {
  const profile = polyExportProfile(profileId);
  const kept = effectiveKeptKeys(choices, profileId, checkedKeys);
  const droppedLtc = [];
  const droppedUnselected = [];
  for (const take of choices.takes) {
    for (const channel of take.channels) {
      if (kept.has(channel.key)) continue;
      if (channel.confirmedLtc && profile.ltcPolicy === "exclude") droppedLtc.push(channel.key);
      else if (!checkedKeys.has(channel.key)) droppedUnselected.push(channel.key);
    }
  }
  const parts = [`主 Poly 保留 ${kept.size} 轨`];
  if (droppedUnselected.length) parts.push(`未勾选 ${droppedUnselected.length} 条`);
  if (droppedLtc.length) parts.push(`${profile.label} 移除 ${droppedLtc.length} 条已确认 LTC`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 被静默丢弃的 take
//
// combineEligibleGroupsFor()（src/grouping.js）会把时长不一致的 take 整个过滤掉，
// 界面以前一声不吭。用户导入 10 个 take、体检发现只有 8 个可合，另外 2 个去哪了
// 没人告诉他。这里把差额和原因算出来。
// ---------------------------------------------------------------------------

/**
 * 对比 recordsByGroup() 与 combineEligibleGroups()，给出没被合并的分组和原因。
 * 纯元数据/视频文件（ALE / CSV / MOV）单独成组，本来就不参与合并，不算"丢掉的 take"。
 */
export function describeDroppedTakes({ recordsByGroup, takeGroupKeys = new Map(), eligibleGroups = [] } = {}) {
  const eligible = new Set(eligibleGroups.map(([key]) => key));
  const items = [];
  for (const [groupKey, groupRecords] of entriesOf(recordsByGroup)) {
    if (eligible.has(groupKey)) continue;
    if (!groupRecords.some(record => !record._meta && !record._video)) continue;
    let reason = "unknown";
    if (groupRecords.length <= 1) reason = "not-a-take";
    else if (!groupRecords.every(record => takeGroupKeys.has(recordKey(record)))) reason = "mixed-take";
    else if (!hasSameDuration(groupRecords)) reason = "duration-mismatch";
    items.push({
      groupKey,
      takeLabel: shortGroupLabel(groupKey),
      recordCount: groupRecords.length,
      reason,
      reasonText: TAKE_EXCLUSION_REASONS[reason] || TAKE_EXCLUSION_REASONS.unknown,
    });
  }
  items.sort((a, b) => a.takeLabel.localeCompare(b.takeLabel));
  const byReason = {};
  for (const item of items) byReason[item.reason] = (byReason[item.reason] || 0) + 1;
  return { count: items.length, items, byReason };
}

/** 丢弃清单的面板/弹窗文案（HTML）。没有丢弃项时返回空串。 */
export function droppedTakesNoticeText(dropped, { limit = 6 } = {}) {
  if (!dropped?.count) return "";
  const rows = dropped.items.slice(0, limit)
    .map(item => `${item.takeLabel}（${item.recordCount} 个文件）：${item.reasonText}`);
  return [
    `<strong>有 ${dropped.count} 个分组未纳入合并</strong>：`,
    ...rows,
    dropped.items.length > limit ? `还有 ${dropped.items.length - limit} 组…` : "",
  ].filter(Boolean).join("<br>");
}

/** 丢弃项按原因聚合，一行说清"为什么少了这些"。 */
export function droppedTakesSummaryText(dropped) {
  if (!dropped?.count) return "";
  return Object.entries(dropped.byReason)
    .map(([reason, count]) => `${TAKE_EXCLUSION_REASONS[reason] || reason} ${count} 组`)
    .join("；");
}

// ---------------------------------------------------------------------------
// take 体检 → 面板视图模型
//
// src/take-health.js 只回答"有哪些问题"，这里回答"面板上摆什么"。
// 两者分开的原因：渲染一旦和判断写在一起，就没法在 node --test 里断言。
//
// 两条 UI 语义不能丢：
// - error 意味着"这个 take 合并会出错"，所以它必须显眼，并且不被"只显示 error"
//   之类的筛选藏起来（筛选是用户主动收窄视野，不是默认行为）。
// - 不能静默阻断。用户点合并时看到的是"哪些 take 有问题 + 后果是什么 + 建议"，
//   走不走由他决定。
// ---------------------------------------------------------------------------

/** severity → 徽章文案 / 图标 / CSS 类。CSS 类名与 style.css 里的 .diag-issue.<sev> 对齐。 */
export const TAKE_HEALTH_SEVERITY_META = Object.freeze({
  error: { label: "error", text: "合并会出错", icon: "✗" },
  warn: { label: "warn", text: "能合但要复核", icon: "⚠" },
  info: { label: "info", text: "提示", icon: "ℹ" },
});

function severityOrder(severity) {
  return severity === "error" ? 0 : severity === "warn" ? 1 : severity === "info" ? 2 : 3;
}

/**
 * 体检结果 → 面板视图模型。
 *
 * @param {object|null} health            inspectTakes() 的返回值
 * @param {object}  [options]
 * @param {boolean} [options.errorsOnly]  只显示 error（用户主动收窄视野）
 * @param {number}  [options.limit]       单个 take 最多展开多少条 finding，超出折叠计数
 */
export function buildTakeHealthViewModel(health, { errorsOnly = false, limit = 12 } = {}) {
  const takes = Array.isArray(health?.takes) ? health.takes : [];
  const summary = health?.summary && typeof health.summary === "object" ? health.summary : {};
  const count = key => (Number.isFinite(Number(summary[key])) ? Number(summary[key]) : 0);

  const errorTakeLabels = takes
    .filter(take => Number(take?.counts?.error) > 0)
    .map(take => take.takeLabel || take.takeKey || "");

  const groups = takes.map(take => {
    const findings = Array.isArray(take?.findings) ? take.findings : [];
    const shown = errorsOnly ? findings.filter(item => item?.severity === "error") : findings;
    const ordered = [...shown].sort((a, b) => severityOrder(a?.severity) - severityOrder(b?.severity));
    const limited = ordered.slice(0, Math.max(0, limit));
    return {
      takeKey: take?.takeKey || "",
      takeLabel: take?.takeLabel || take?.takeKey || "",
      counts: { ...(take?.counts || {}) },
      errorCount: Number(take?.counts?.error) || 0,
      warnCount: Number(take?.counts?.warn) || 0,
      infoCount: Number(take?.counts?.info) || 0,
      // 严重程度由最靠前的一条 finding 决定；空 take 归 info（不是 error）。
      severity: ordered[0]?.severity === "error" || ordered[0]?.severity === "warn" ? ordered[0].severity : "info",
      statusText: ordered.length ? `${ordered.length} 条待处理` : errorsOnly ? "无 error" : "无问题",
      hiddenByFilter: errorsOnly && shown.length === 0 && findings.length > 0,
      hiddenCount: ordered.length - limited.length,
      findings: limited.map(item => ({
        takeKey: item?.takeKey || "",
        takeLabel: item?.takeLabel || "",
        code: item?.code || "",
        severity: item?.severity || "info",
        title: item?.title || "",
        detail: item?.detail || "",
        suggestion: item?.suggestion || "",
        records: Array.isArray(item?.records) ? item.records : [],
        channels: Array.isArray(item?.channels) ? item.channels : [],
        meta: TAKE_HEALTH_SEVERITY_META[item?.severity] || TAKE_HEALTH_SEVERITY_META.info,
      })),
    };
  });

  // 折叠掉的 take 仍留在模型里（hiddenByFilter），渲染层据此显示"N 个 take 已被筛掉"，
  // 避免用户以为那些 take 没问题。
  // error 的 take 排前面：error 意味着"这个 take 合并会出错"，它不该被压在列表下面，
  // 更不该出现在需要滚动才能看到的地方。
  const bySeverity = (a, b) => severityOrder(a.severity) - severityOrder(b.severity)
    || String(a.takeLabel).localeCompare(String(b.takeLabel));
  const ordered = [...groups].sort(bySeverity);
  const visible = ordered.filter(group => !group.hiddenByFilter);
  const errorCount = count("error");
  const warnCount = count("warn");
  const infoCount = count("info");

  return {
    available: takes.length > 0,
    empty: takes.length === 0,
    takeCount: takes.length,
    visibleTakeCount: visible.length,
    hiddenTakeCount: ordered.length - visible.length,
    findingCount: count("findingCount"),
    errorCount,
    warnCount,
    infoCount,
    hasErrors: errorCount > 0,
    errorTakeCount: errorTakeLabels.length,
    errorTakeLabels,
    errorsOnly: Boolean(errorsOnly),
    takes: visible,
    allTakes: ordered,
    summaryText: takes.length
      ? `共 ${takes.length} 个 take · error ${errorCount} 条 · warn ${warnCount} 条 · info ${infoCount} 条`
      : "还没有可体检的分轨 take",
    // 「合并 Poly WAV」按钮旁的计数。error 时明确说后果，不静默阻断。
    combineNoticeText: errorCount
      ? `合并前体检：${errorTakeLabels.length} 个 take 有 error（共 ${errorCount} 条）——${errorTakeLabels.slice(0, 3).join("、")}${errorTakeLabels.length > 3 ? " 等" : ""}。这些 take 合并会直接报错，或合出时码错位的 Poly；工具不替你判断哪一项可以忽略。`
      : takes.length
        ? `合并前体检：${takes.length} 个 take 无 error（warn ${warnCount} 条）。`
        : "",
  };
}

/** 体检结论并进验收清单用：把模型里的 finding 还原成 acceptance-checklist 认识的形状。 */
export function takeHealthFindingsForChecklist(viewModel, takeKey = "") {
  const source = Array.isArray(viewModel?.allTakes) ? viewModel.allTakes : [];
  return source
    .filter(take => !takeKey || take.takeKey === takeKey)
    .flatMap(take => take.findings.map(finding => ({
      takeKey: finding.takeKey || take.takeKey,
      takeLabel: finding.takeLabel || take.takeLabel,
      severity: finding.severity,
      code: finding.code,
      title: finding.title,
      detail: finding.detail,
      suggestion: finding.suggestion,
    })));
}

/**
 * 只保留"这次真的要合并"的 take 上的 error。
 *
 * 批量导出时 el 10 个 take 只挑 3 个合并，把另外 7 个的 error 也报成"你这次会出错"
 * 就是在制造噪声、训练用户忽略告警。反过来，被筛掉的 take 的 error 仍然留在
 * 体检面板里（那里本来就该看见它们）。
 */
export function takeHealthScopeForCombine(viewModel, groups) {
  if (!viewModel?.available) return { ...(viewModel || {}), hasErrors: false, errorTakeCount: 0, errorTakeLabels: [], errorFindings: [] };
  const keys = new Set((groups || []).map(([key]) => key));
  const errorFindings = viewModel.takes
    .filter(take => keys.has(take.takeKey))
    .flatMap(take => take.findings.filter(finding => finding.severity === "error"));
  const errorTakeLabels = viewModel.takes
    .filter(take => keys.has(take.takeKey) && take.errorCount > 0)
    .map(take => take.takeLabel);
  return {
    ...viewModel,
    errorFindings,
    errorTakeLabels,
    errorTakeCount: errorTakeLabels.length,
    errorCount: errorFindings.length,
    hasErrors: errorFindings.length > 0,
  };
}

/** 确认框里"这次合并会怎样"的一段中文。error 存在时列出 take 与首条原因。 */
export function takeHealthConfirmLines(scope, { limit = 5 } = {}) {
  if (!scope?.hasErrors) return [];
  const rows = scope.errorFindings.slice(0, limit).map(finding =>
    `<strong>${finding.takeLabel || finding.takeKey || "本 take"}</strong>：${finding.title}${finding.suggestion ? ` — ${finding.suggestion}` : ""}`);
  return [
    `<strong>合并前体检发现 ${scope.errorCount} 条 error，涉及 ${scope.errorTakeCount} 个 take：</strong>`,
    ...rows,
    scope.errorFindings.length > limit ? `还有 ${scope.errorFindings.length - limit} 条，见「合并前体检」面板…` : "",
    "这些不是提醒：合并会直接报错，或合出时码错位、无法在 Resolve 里同步的 Poly。",
    "<strong>工具不判断哪一项可以忽略</strong>，也不替你阻断；请确认后再决定是否继续。",
  ].filter(Boolean);
}

/**
 * 视频 / ALE 元数据里记录的帧率。只有全部一致才算数：
 * 两个视频写着不同帧率时，"与摄影机帧率冲突" 这条 finding 只会制造噪声。
 */
export function commonVideoFpsValue(records) {
  const values = new Set();
  for (const record of records || []) {
    const value = record?._video?.fpsValue || record?._meta?.fpsValue;
    if (value) values.add(String(value));
  }
  return values.size === 1 ? Array.from(values)[0] : "";
}

/** 本次导出真正会被剔除的源通道：全部通道减去最终保留的那些（含方案自动排除的 LTC）。 */
export function healthExcludedChannelKeys(choices, profileId, checkedKeys) {
  const kept = effectiveKeptKeys(choices, profileId, checkedKeys);
  return new Set((choices?.allKeys || []).filter(key => !kept.has(key)));
}

// ---------------------------------------------------------------------------
// 导出演收清单 → 面板视图模型
//
// 设计语义（src/acceptance-checklist.js 的契约，UI 必须尊重）：
// state 是工具给出的"自动结论"，pass 不等于不需要人工操作；
// guide 是该项在目标软件里仍要执行的动作，对任意 state 都可能存在。
// 所以 guide 一定要显示出来——藏掉它，这个模块就退化成一句废话。
// ---------------------------------------------------------------------------

/** state → 徽章文案 / 图标。className 与 style.css 里的 .accept-item.<state> 对齐。 */
export const ACCEPTANCE_STATE_META = Object.freeze({
  pass: { label: "自动确认通过", icon: "✓", className: "accept-item pass" },
  fail: { label: "发现问题", icon: "✗", className: "accept-item fail" },
  manual: { label: "需人工确认", icon: "!", className: "accept-item manual" },
  na: { label: "本方案不适用", icon: "–", className: "accept-item na" },
});

/** 展示分组顺序：先要处理的，再要人做的，最后才是通过的和不适用的。 */
const ACCEPTANCE_GROUP_ORDER = Object.freeze(["fail", "manual", "pass", "na"]);

/**
 * 验收清单 → 可勾选面板的视图模型。
 *
 * @param {object|null} checklist       buildAcceptanceChecklist() 的返回值
 * @param {object}  [options]
 * @param {Set<string>} [options.checked] 用户已勾选的 item id
 */
export function buildAcceptanceViewModel(checklist, { checked = new Set() } = {}) {
  const items = Array.isArray(checklist?.items) ? checklist.items : [];
  const summary = checklist?.summary && typeof checklist.summary === "object" ? checklist.summary : {};
  const count = key => (Number.isFinite(Number(summary[key])) ? Number(summary[key]) : 0);
  const done = new Set(checked || []);

  const modelItems = items.map(item => {
    const state = item?.state || "manual";
    return {
      id: item?.id || "",
      state,
      label: item?.label || "",
      detail: item?.detail || "",
      // guide 对 pass 同样存在：自动确认过 ≠ 不用在目标软件里动手。
      guide: item?.guide || "",
      hasGuide: Boolean(item?.guide),
      evidence: item?.evidence ?? null,
      checked: done.has(item?.id),
      meta: ACCEPTANCE_STATE_META[state] || ACCEPTANCE_STATE_META.manual,
    };
  });

  const groups = ACCEPTANCE_GROUP_ORDER
    .map(state => ({
      state,
      ...(ACCEPTANCE_STATE_META[state] || ACCEPTANCE_STATE_META.manual),
      count: modelItems.filter(item => item.state === state).length,
      items: modelItems.filter(item => item.state === state),
    }))
    .filter(group => group.count > 0);

  const needsHuman = count("manual");
  const failCount = count("fail");

  return {
    available: items.length > 0,
    empty: items.length === 0,
    outputName: checklist?.outputName ?? null,
    profileLabel: checklist?.profileLabel || "",
    channels: checklist?.channels ?? null,
    schema: checklist?.schema || "",
    summary: {
      total: modelItems.length,
      pass: count("pass"),
      fail: failCount,
      manual: needsHuman,
      na: count("na"),
      needsHuman,
    },
    needsHuman,
    hasProblems: failCount > 0,
    checkedCount: modelItems.filter(item => item.checked).length,
    // guide 必须露出：这是整个模块存在的理由。
    guideCount: modelItems.filter(item => item.hasGuide).length,
    groups,
    items: modelItems,
    summaryText: `共 ${modelItems.length} 项 · 通过 ${count("pass")} · 问题 ${failCount} · 需人工确认 ${needsHuman} · 不适用 ${count("na")}`,
    needsHumanText: needsHuman
      ? `还有 ${needsHuman} 项需要你人工确认：勾选只代表你已在目标软件里完成这一项，不代表工具验证过它。`
      : failCount
        ? `没有需要人工确认的项，但有 ${failCount} 项发现了问题：先处理再交付。`
        : "工具能自动判定的项都通过了；目标软件里的导入与试听仍需你确认。",
  };
}

// ---------------------------------------------------------------------------
// per-take 帧率覆盖 → 编辑器视图模型
//
// 候选帧率必须与 els.fpsInput 的选项完全一致：23.976 ≠ 24、29.97 ≠ 30、
// DF 与 NDF 必须分开（项目里反复强调过的坑）。这里从 select 元素直接读，
// 不另写一份列表——两份列表早晚会漂移。
// ---------------------------------------------------------------------------

/** select-like（`<select>` 或 { options }）→ 帧率候选。保持原顺序与原 value。 */
export function fpsCandidateOptions(selectLike) {
  return Array.from(selectLike?.options || [])
    .map(option => ({ value: String(option?.value ?? ""), label: String(option?.textContent ?? "").trim() }))
    .filter(option => option.value);
}

/** 行内下拉的选项：候选表 + 行的当前值（当前值不在候选表里时补一条，避免显示成空白）。 */
export function fpsRowOptions({ candidates = [], value = "" } = {}) {
  if (!value || candidates.some(candidate => candidate.value === value)) return candidates;
  return [{ value, label: `${value}（不在帧率列表中）`, extra: true }, ...candidates];
}

/** recordFpsSourceKind 的三个取值 → 面板文案。 */
export const FPS_SOURCE_KIND_TEXT = Object.freeze({
  override: "per-take 覆盖",
  metadata: "文件元数据",
  ui: "界面全局设置",
});

/**
 * 帧率来源面板 + per-take 覆盖编辑器的视图模型。
 *
 * rows 覆盖"所有实际存在的 take"（而不只是有覆盖的那些），因为面板同时要回答
 * "这个 take 的帧率现在来自哪里"；hasOverride 区分有没有被覆盖。
 */
export function buildFpsOverrideViewModel({
  candidates = [],
  takeKeys = [],
  overrides = [],
  defaultValue = "",
  takeLabelFor = key => String(key || ""),
  sourceKindForTake = () => "ui",
  resolvedValueForTake = () => "",
} = {}) {
  const options = fpsCandidateOptions({ options: candidates });
  const overrideByTake = new Map((overrides || []).map(entry => [entry?.takeKey, entry?.value || ""]));
  const keys = Array.from(new Set([...(takeKeys || []), ...overrideByTake.keys()]))
    .filter(Boolean)
    .sort((a, b) => takeLabelFor(a).localeCompare(takeLabelFor(b)) || String(a).localeCompare(String(b)));

  const rows = keys.map(takeKey => {
    const overrideValue = overrideByTake.get(takeKey) || "";
    const kind = sourceKindForTake(takeKey) || "ui";
    const value = overrideValue || resolvedValueForTake(takeKey, defaultValue) || defaultValue;
    return {
      takeKey,
      takeLabel: takeLabelFor(takeKey),
      hasOverride: Boolean(overrideValue),
      overrideValue,
      value,
      label: options.find(option => option.value === value)?.label || value,
      kind,
      sourceText: FPS_SOURCE_KIND_TEXT[kind] || FPS_SOURCE_KIND_TEXT.ui,
      options: fpsRowOptions({ candidates: options, value }),
    };
  });

  return {
    options,
    rows,
    overrideCount: rows.filter(row => row.hasOverride).length,
    takeCount: rows.length,
    empty: rows.length === 0,
    defaultValue,
    defaultLabel: options.find(option => option.value === defaultValue)?.label || defaultValue,
    addableTakes: rows.filter(row => !row.hasOverride).map(row => ({ takeKey: row.takeKey, takeLabel: row.takeLabel })),
    summaryText: rows.length
      ? `界面全局设置 ${defaultValue}；已给 ${rows.filter(row => row.hasOverride).length}/${rows.length} 个 take 设了 per-take 覆盖`
      : "导入素材后可以逐个 take 指定帧率。",
  };
}

// ---------------------------------------------------------------------------
// 输出目录记忆
//
// Chrome 不允许网页直接写"下载/文稿/桌面"，所以批量导出必须让用户点一次文件夹。
// showDirectoryPicker 返回的 handle 可以存进 IndexedDB，下次用 queryPermission /
// requestPermission 复用，省掉每次批量导出都重新选目录的摩擦。
//
// 任何一步失败（file:// 下 IndexedDB 被禁、Firefox/Safari 没有该 API、用户拒绝授权、
// 用户主动取消选择）都只降级，绝不抛错挡住导出：降级后回到"逐次选择 + 提示"的老路径。
// ---------------------------------------------------------------------------

export const OUTPUT_DIRECTORY_DB_NAME = "slatesync-output";
export const OUTPUT_DIRECTORY_STORE_NAME = "handles";
export const OUTPUT_DIRECTORY_KEY = "output-directory";

function openDirectoryDb(dbName) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no-indexeddb"));
      return;
    }
    let request;
    try {
      request = indexedDB.open(dbName, 1);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTPUT_DIRECTORY_STORE_NAME)) {
        db.createObjectStore(OUTPUT_DIRECTORY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb-open-failed"));
    request.onblocked = () => reject(new Error("indexeddb-blocked"));
  });
}

async function withDirectoryStore(dbName, mode, run) {
  const db = await openDirectoryDb(dbName);
  try {
    return await new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const tx = db.transaction(OUTPUT_DIRECTORY_STORE_NAME, mode);
      tx.oncomplete = () => finish(null, request?.result);
      tx.onabort = () => finish(tx.error || new Error("indexeddb-aborted"));
      tx.onerror = () => finish(tx.error || new Error("indexeddb-failed"));
      try {
        request = run(tx.objectStore(OUTPUT_DIRECTORY_STORE_NAME));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    try { db.close(); } catch { /* 关不掉也不影响读到的值 */ }
  }
}

/**
 * 目录句柄的权限状态。queryPermission 无条件可问；requestPermission 必须在用户
 * 手势里调用，所以这里把 prompt 交给调用方决定，默认不主动弹授权框。
 */
export async function directoryPermission(handle, { prompt = false } = {}) {
  if (!handle) return { ok: false, state: "none" };
  if (typeof handle.queryPermission !== "function") return { ok: true, state: "granted" };
  let state;
  try {
    state = await handle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return { ok: false, state: "error", error };
  }
  if (state === "granted" || !prompt || typeof handle.requestPermission !== "function") {
    return { ok: state === "granted", state };
  }
  let requested;
  try {
    requested = await handle.requestPermission({ mode: "readwrite" });
  } catch (error) {
    return { ok: false, state: "error", error };
  }
  return { ok: requested === "granted", state: requested };
}

/**
 * 可记住的输出目录。全部方法都不抛错——IndexedDB 不可用时只是 remember=false，
 * 导出功能本身照常走"每次询问"的路径。
 */
export function createRememberedDirectoryStore({
  dbName = OUTPUT_DIRECTORY_DB_NAME,
  picker = () => window.showDirectoryPicker({ mode: "readwrite" }),
} = {}) {
  let supported = null;
  let handle = null;
  let status = { ok: false, reason: "unknown", name: "" };

  function storageSupported() {
    if (supported === null) supported = typeof indexedDB !== "undefined";
    return supported;
  }

  function canPick() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  }

  async function persist(next) {
    if (!storageSupported()) {
      status = { ok: false, reason: "no-indexeddb", name: "" };
      return false;
    }
    try {
      if (next) await withDirectoryStore(dbName, "readwrite", store => store.put(next, OUTPUT_DIRECTORY_KEY));
      else await withDirectoryStore(dbName, "readwrite", store => store.delete(OUTPUT_DIRECTORY_KEY));
      return true;
    } catch {
      status = { ok: false, reason: "write-failed", name: "" };
      return false;
    }
  }

  /** 载入记住的目录。只在已授权时返回句柄，未授权返回 null 让调用方改走选择器。 */
  async function load() {
    if (!storageSupported()) {
      status = { ok: false, reason: "no-indexeddb", name: "" };
      return null;
    }
    let stored = null;
    try {
      stored = await withDirectoryStore(dbName, "readonly", store => store.get(OUTPUT_DIRECTORY_KEY));
    } catch {
      status = { ok: false, reason: "read-failed", name: "" };
      return null;
    }
    if (!stored) {
      handle = null;
      status = { ok: false, reason: "empty", name: "" };
      return null;
    }
    handle = stored;
    const permission = await directoryPermission(stored);
    status = {
      ok: permission.ok,
      reason: permission.ok ? "granted" : permission.state,
      name: stored.name || "",
    };
    return permission.ok ? stored : null;
  }

  /** 已授权的目录句柄，没有或没授权就返回 null（绝不抛错）。 */
  async function remembered({ prompt = false } = {}) {
    if (!handle) await load();
    if (!handle) return null;
    const permission = await directoryPermission(handle, { prompt });
    status = {
      ok: permission.ok,
      reason: permission.ok ? "granted" : permission.state,
      name: handle.name || "",
    };
    return permission.ok ? handle : null;
  }

  /**
   * 让用户选一个输出目录。选完按 remember 决定是否记住。
   * 用户取消（AbortError）返回 null——调用方要区分"取消"和"失败"。
   */
  async function pick({ remember = true } = {}) {
    if (!canPick()) {
      status = { ok: false, reason: "no-picker", name: "" };
      return { handle: null, cancelled: false, remembered: false };
    }
    let picked;
    try {
      picked = await picker();
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      if (!cancelled) status = { ok: false, reason: "pick-failed", name: "" };
      return { handle: null, cancelled, remembered: false };
    }
    if (!picked) {
      status = { ok: false, reason: "pick-failed", name: "" };
      return { handle: null, cancelled: false, remembered: false };
    }
    handle = picked;
    status = { ok: true, reason: "granted", name: picked.name || "" };
    const stored = remember ? await persist(picked) : await persist(null);
    return { handle: picked, cancelled: false, remembered: stored };
  }

  async function forget() {
    handle = null;
    await persist(null);
    status = { ok: false, reason: "empty", name: "" };
    return true;
  }

  /** 给面板显示的一行状态。文案刻意写明"每次仍会询问"这类降级后果。 */
  function describe() {
    const remembered = Boolean(handle || status.name);
    if (status.reason === "granted") {
      return { remembered: true, usable: true, text: `已记住输出目录：${status.name}（下次直接复用）` };
    }
    if (remembered && (status.reason === "prompt" || status.reason === "denied")) {
      return { remembered: true, usable: false, text: `已记住 ${status.name}，但浏览器尚未授权写入；下次导出会再问你一次` };
    }
    if (status.reason === "no-indexeddb") {
      return { remembered: false, usable: false, text: "此环境无法记住输出目录（IndexedDB 不可用），每次导出会重新询问" };
    }
    if (status.reason === "no-picker") {
      return { remembered: false, usable: false, text: "当前浏览器不支持选择文件夹（需要 Chrome / Edge），将逐个询问保存位置" };
    }
    if (status.reason === "read-failed" || status.reason === "write-failed") {
      return { remembered: false, usable: false, text: "无法读写目录记忆（可能被浏览器隐私设置拦下），每次导出会重新询问" };
    }
    return { remembered: false, usable: false, text: "未设置输出目录 — 每次导出都会询问保存位置" };
  }

  return { describe, forget, load, pick, remembered, storageSupported, canPick };
}

/** 覆盖前询问：目录里已经有同名文件时用，返回 true 表示用户同意覆盖。 */
export function confirmOverwriteOutputs(collisionNames, { showConfirmDialog, profileLabel = "" } = {}) {
  const names = collisionNames || [];
  if (!names.length) return Promise.resolve(true);
  return showConfirmDialog({
    title: "输出目录里已有同名文件",
    danger: true,
    cancelText: "取消导出",
    confirmText: `覆盖 ${names.length} 个文件`,
    copy: [
      `当前输出目录里已经存在下列 <strong>${names.length}</strong> 个同名文件：`,
      names.slice(0, 8).map(name => `<strong>${name}</strong>`).join("<br>"),
      names.length > 8 ? `还有 ${names.length - 8} 个…` : "",
      profileLabel ? `本次输出方案：${profileLabel}。` : "",
      "<strong>覆盖后旧的 Poly 无法通过本工具撤销</strong>（合板输出不在备份范围内）。",
      "取消导出不会改动任何文件；确认覆盖会直接替换同名文件。",
    ].filter(Boolean).join("<br>"),
  });
}

export function createConfirmFlows({ showConfirmDialog, fpsSelectLabel }) {
  function confirmWriteChanges(count, includesLtcMute = false) {
    return showConfirmDialog({
      title: "确认写入文件？",
      danger: true,
      confirmText: "确认写入",
      copy: includesLtcMute
        ? [
          `即将写入 <strong>${count}</strong> 个 WAV 的 BWF TimeReference，并将检测到的 LTC 声道/分轨静音。`,
          "<strong>静音音频轨道或分轨无法用撤销按钮恢复</strong>，请确认已有原始文件备份。"
        ].join("<br>")
        : [
          `即将写入 <strong>${count}</strong> 个 WAV 的 BWF TimeReference。`,
          "<strong>建议在修改前先备份原始文件</strong>，确认备份或可恢复后再继续。"
        ].join("<br>"),
    });
  }

  function confirmCombinePoly(groups, options = {}) {
    const trackCounts = groups.map(([key, groupRecords]) => {
      const tracks = combineTrackPlan(groupRecords);
      return `${shortGroupLabel(key)}：${tracks.length} 轨`;
    });
    const batchMode = groups.length > 1;
    const hasPreviewTimecode = Boolean(options.hasPreviewTimecode);
    const hasLtcTimecode = Boolean(options.hasLtcTimecode);
    const hasAlternateTimecode = hasLtcTimecode || hasPreviewTimecode;
    const muteLtc = Boolean(options.muteLtc);
    const profile = polyExportProfile(options.profile || "resolve");
    const hints = polyProfileOptions().find(entry => entry.id === profile.id) || {};
    const dropped = options.droppedTakes?.count ? options.droppedTakes : null;
    const health = options.takeHealth?.hasErrors ? options.takeHealth : null;
    const destinationLabel = options.outputDestinationLabel || (batchMode ? "选择一个输出文件夹" : "逐个选择保存位置");
    const referenceLine = options.referenceSourceChannel
      ? "会额外导出一个单声道 <strong>SyncRef</strong>，只含你指定的那一个节目通道。"
      : hints.reference
        ? "<strong>该方案通常需要独立参考声道</strong>，但当前没有选；本次只输出主 Poly。"
        : "";
    const chromeFolderWarning = [
      "由于 Chrome 的安全限制，",
      "<strong>请不要直接选择“下载”“文稿”“桌面”等受保护的常用文件夹。</strong>",
      "请先在里面新建一个子文件夹再选择；也可以在「输出配置」里记住这个目录，之后自动复用。"
    ].join("<br>");
    return showConfirmDialog({
      title: "合并为 Poly WAV？",
      altText: hasAlternateTimecode ? "使用原始时码" : "",
      altResult: "original",
      danger: Boolean(health),
      confirmText: health ? "我已了解，仍要合并" : hasLtcTimecode
        ? "使用LTC时码"
        : hasPreviewTimecode
          ? "使用预览时码"
        : batchMode ? "选择输出文件夹" : "选择保存位置",
      confirmResult: hasLtcTimecode ? "ltc" : hasPreviewTimecode ? "preview" : true,
      copy: [
        `将把 <strong>${groups.length}</strong> 个分轨 take 合并为 Poly WAV。`,
        trackCounts.slice(0, 6).join("<br>"),
        groups.length > 6 ? `还有 ${groups.length - 6} 个 take…` : "",
        `输出方案：<strong>${profile.label}</strong> — ${hints.usage || ""}；LTC：${hints.ltcText || profile.ltcPolicy}；编码：${hints.encodingText || profile.encoding}。`,
        options.channelSummary || "",
        referenceLine,
        hasLtcTimecode ? "<strong>检测到当前有可用的 LTC 时码。</strong>你可以只把 LTC 起始时码写进新 Poly，源分轨不会被修改。" : "",
        hasLtcTimecode && muteLtc ? profile.ltcPolicy === "retain"
            ? "<strong>保留 LTC 方案：</strong>新 Poly 保留 LTC 技术通道（archive 会静音），不要把技术通道当作节目声。"
            : "<strong>清洁 Poly：</strong>已确认的 LTC 通道会从新 Poly 物理移除，不留下静音空轨；源分轨不会被修改。" : "",
        hasLtcTimecode && !muteLtc ? "当前未勾选静音 LTC 轨，新 Poly 会保留 LTC 音频。" : "",
        !hasLtcTimecode && hasPreviewTimecode ? "<strong>检测到当前有未写入的时码修改预览。</strong>你可以只把预览后的起始时码写进新 Poly，源分轨不会被修改。" : "",
        dropped ? droppedTakesNoticeText(dropped) : "",
        ...takeHealthConfirmLines(health),
        `输出位置：${destinationLabel}。<strong>已存在同名文件时会先询问</strong>，不会静默覆盖。`,
        options.hasRememberedDirectory ? "" : batchMode ? chromeFolderWarning : "",
        "L/R 混音与各条 ISO 是否同时输出，在左侧「输出配置」里逐通道勾选；这里不再自动删轨。",
        "会生成中文合板说明；Resolve 不需要摄影机原始声时请关闭 Retain embedded audio。",
        "原始文件不会被修改。"
      ].filter(Boolean).join("<br>"),
    });
  }

  function confirmLtcFpsMismatch({ currentValue, detectedValue, detectedTimecode, group }) {
    return showConfirmDialog({
      title: "LTC 帧率可能不匹配",
      cancelText: `按当前 ${fpsSelectLabel(currentValue)}`,
      confirmText: `改用 ${fpsSelectLabel(detectedValue)}`,
      copy: [
        `当前设置是 <strong>${fpsSelectLabel(currentValue)}</strong>，但 LTC 波形更像 <strong>${fpsSelectLabel(detectedValue)}</strong>。`,
        `检测到的时码：<strong>${detectedTimecode}</strong>${group ? `（${group}）` : ""}`,
        "请选择继续按当前设置解析，还是切换到自动识别的帧率重新检测。"
      ].join("<br>"),
    });
  }

  function confirmMetadataFpsMismatch({ currentValue, metadata }) {
    return showConfirmDialog({
      title: "文件记录的帧率不同",
      cancelText: `保持 ${fpsSelectLabel(currentValue)}`,
      confirmText: `改用 ${fpsSelectLabel(metadata.value)}`,
      copy: [
        `当前界面设置是 <strong>${fpsSelectLabel(currentValue)}</strong>。`,
        `导入文件的元数据里有 <strong>${metadata.count}/${metadata.total}</strong> 个文件记录为 <strong>${fpsSelectLabel(metadata.value)}</strong>。`,
        "预览会优先按每个文件的元数据帧率计算；界面设置只用于没有元数据帧率的文件和输入格式。"
      ].join("<br>"),
    });
  }

  function confirmSoftSyncWrite(items) {
    const rows = items.slice(0, 8).map(item => {
      const name = item.record?.name || "（未命名文件）";
      const written = item.ltc?.startTimecode || "—";
      const source = item.ltc?.sourceTimecode || "—";
      const frames = item.ltc?.lockedFrames ?? 0;
      return `${name}：写入 <strong>${written}</strong>（源帧 ${source}，连续 ${frames} 帧）`;
    });
    return showConfirmDialog({
      title: "兜底模式结果需逐条核对",
      danger: true,
      confirmText: "我已核对，仍要写入",
      copy: [
        `以下 <strong>${items.length}</strong> 项来自兜底算法（软同步），无法与标准算法交叉验证。`,
        ...rows,
        items.length > 8 ? `还有 ${items.length - 8} 项…` : "",
        "<strong>兜底算法实测曾出现读出错误时码的情况</strong>（对白干扰下错读率约 66%），因此不与普通结果合并确认。",
        "请逐条核对上面的起始时码是否与素材一致；有任何一条对不上就取消，并先确认 LTC 声道选对了。"
      ].filter(Boolean).join("<br>"),
    });
  }

  return {
    confirmCombinePoly,
    confirmLtcFpsMismatch,
    confirmMetadataFpsMismatch,
    confirmOverwriteOutputs,
    confirmSoftSyncWrite,
    confirmWriteChanges,
  };
}