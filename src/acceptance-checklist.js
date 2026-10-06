// 交付验收清单（纯逻辑层）：把 docs/声音合板指南.md 的「交付检查清单」变成产品数据。
//
// 边界：
// - 纯函数。不碰 DOM、浏览器 API、文件读写；所有输入由调用方注入。
// - 只判定工具真能判定的事。目标软件里的动作（Resolve 导入、同步试听、备份）
//   一律 manual；当前方案下不成立的项为 na。
// - state 是「工具能给出的自动结论」，pass 不等于无需人工操作；guide 是该项在
//   目标软件里仍需执行的动作，对任意 state 都可能存在。
//
// 可选输入 healthFindings（来自 src/take-health.js，本模块不 import 它，以免
// 依赖一个尚未完成或被替换的实现）：
//   { takeKey?, takeLabel?, severity, code, title, detail, suggestion? }[]
//   传数组 = 体检已运行；不传 = 体检结果不可用，本项降级为 manual 而不是崩掉。

import { polyExportProfile } from "./poly-export-profiles.js";

export const ACCEPTANCE_STATES = Object.freeze({ PASS: "pass", FAIL: "fail", MANUAL: "manual", NA: "na" });

// 顺序即 UI 展示顺序；与 buildAcceptanceChecklist 返回的 items 一一对应。
export const ACCEPTANCE_ITEM_IDS = Object.freeze([
  "take-source-consistency",
  "ltc-channel-confirmed",
  "profile-decided",
  "exclusion-decisions",
  "resolve-mono-mapping",
  "sync-start-mid-end",
  "camera-audio-not-poly",
  "pcm24-conversion-clean",
  "sidecars-kept",
  "source-immutable",
  "syncref-usage",
  "ltc-track-muted",
  "archive-encoding-preserved",
  "take-health-clear",
]);

// 记事本读取 UTF-8 中文需要 BOM；与 poly-combine-controller.js 写入 sidecar 的做法一致。
export const ACCEPTANCE_TEXT_BOM = "\uFEFF";

const STATE_MARKS = Object.freeze({ pass: "[x]", fail: "[!]", manual: "[ ]", na: "[ ]" });
const STATE_TAGS = Object.freeze({ pass: "", fail: "（发现问题）", manual: "（需人工确认）", na: "（本方案不适用）" });

// 只有这三个方案会把 Poly 送进 Resolve 导入路径，Resolve 专属检查项对它们成立。
const RESOLVE_FAMILY = new Set(["resolve", "sidus", "archive"]);

// severity 取值由 src/take-health.js 决定，这里只认「阻塞」和「其余都需复核」，
// 未知取值一律降级为 manual，不会因为没见过的枚举值把整次导出判成 fail。
const HEALTH_BLOCKING_SEVERITIES = new Set(["error", "fail", "failed", "critical", "blocker", "fatal"]);
const MAX_HEALTH_DETAIL_ITEMS = 8;

function item(id, state, label, detail, extra = {}) {
  return { id, state, label, detail, guide: extra.guide || "", evidence: extra.evidence || null };
}

function profileFor(result, options) {
  if (!result || typeof result !== "object") throw new Error("验收清单需要一次导出的合并结果");
  return polyExportProfile(result.profile || options.profile || "resolve");
}

function countOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isConfirmedLtcReason(reason) {
  const text = String(reason ?? "");
  return text.includes("LTC") && !text.includes("用户") && !text.includes("未选择");
}

function excludedTracks(result) {
  return Array.isArray(result.excludedTracks) ? result.excludedTracks.filter(Boolean) : [];
}

function describeExclusions(list) {
  return list.map(track => `${track.source ?? "未知来源"} / 源通道 ${track.sourceChannel ?? "?"}（${track.reason ?? "未标注原因"}）`).join("；");
}

function sidecarNames(result) {
  const stem = String(result.name ?? "").replace(/\.wav$/i, "");
  return [`${stem}_合板说明.txt`, `${stem}_channels.json`];
}

// 2026-10-05 DaVinci Resolve 20.3.3.10 本机实测（合成素材，不是厂商认证）。
function resolveMappingFact(channels) {
  if (channels === 1) return "单通道导入为 1 通道（实测映射 [1]），不存在拆 Mono 的问题。";
  if (channels === 2) return "双通道导入为 Stereo（实测映射 [1,2]），不是自动拆成独立 Mono 轨。";
  if (channels === 3) return "三通道不在已实测范围内（只实测过 1/2/4/5 通道），导入后的轨类型需在 Clip Attributes > Audio 实际确认。";
  return `${channels} 通道导入为 Adaptive ${channels}（实测 4/5 通道映射 [1..N]），不是自动拆成独立 Mono 轨。`;
}

function takeSourceConsistency(result) {
  return item("take-source-consistency", ACCEPTANCE_STATES.PASS,
    "take 内分轨一致（采样率 / 位深 / 时长 / TimeReference）",
    `合并前校验已确认 ${result.sampleRate} Hz / ${result.bitsPerSample} bit / ${result.durationSamples} samples 一致，源 TimeReference 相同；任一项不一致会在写出前中止，不会产出半成品 Poly。`,
    { guide: "起始时码的取值来自 LTC 解码；数值本身仍要与拍板或摄影机 TC 交叉核对后才可信。" });
}

function ltcChannelConfirmed(result) {
  const confirmed = excludedTracks(result).filter(track => isConfirmedLtcReason(track.reason));
  if (confirmed.length) return item("ltc-channel-confirmed", ACCEPTANCE_STATES.PASS, "LTC 声道已确认",
    `本次通过 LTC 检测确认并排除了 ${confirmed.length} 个 LTC 通道：${describeExclusions(confirmed)}。`,
    { guide: "确认手段是检测结果，不是文件名猜测；换机器、换录音机后要重新检测。" });
  return item("ltc-channel-confirmed", ACCEPTANCE_STATES.MANUAL, "LTC 声道已确认",
    "本次排除清单里没有检测确认的 LTC 通道；工具没有做 LTC 检测，或该 take 里确实没有 LTC 通道，工具无法区分这两种情况。",
    { guide: "在监听里确认 LTC 声道位置，不要靠文件名里的 LTC 字样判断。清洁方案下漏排除会把时间码噪声带进节目声。" });
}

function profileDecided(profile) {
  const ltc = profile.ltcPolicy === "exclude" ? "排除已确认的 LTC 通道" : "保留 LTC 通道";
  const encoding = profile.encoding === "pcm24" ? "多通道离散 PCM24" : "保留源编码";
  const guide = profile.id === "resolve"
    ? "Resolve 20.3.3.10 的验证只覆盖本工具生成的合成素材，不代表任意真实素材或厂商认证。"
    : "方案只定义文件与工作流策略；Sidus / PluralEyes / Syncaila 尚未在本机实测，不能当作软件兼容认证。";
  return item("profile-decided", ACCEPTANCE_STATES.PASS, "输出方案明确", `${profile.label}（文件策略，不代表厂商认证）；LTC：${ltc}；编码：${encoding}。`, { guide });
}

function exclusionDecisions(result) {
  const list = excludedTracks(result);
  if (list.length) return item("exclusion-decisions", ACCEPTANCE_STATES.PASS, "排除通道决定已记录",
    `本次排除 ${list.length} 个源通道：${describeExclusions(list)}。排除清单会一并写进 _channels.json。`,
    { guide: "工具只按显式选择和检测确认的 LTC 通道排除，不按静音或低电平猜测；L/R 混音、room tone 和独立 ISO 是否保留仍要按剪辑需求确认。" });
  return item("exclusion-decisions", ACCEPTANCE_STATES.MANUAL, "排除通道决定已记录",
    "本次没有排除任何源通道。工具不会自动删除静音、小电平或 L/R 混音轨。",
    { guide: "确认不排除确实符合剪辑意图：L/R 混音、room tone、某些 ISO 可能是有意保留的节目素材。要移除请在导出时显式选择输出通道。" });
}

function resolveMonoMapping(result, profile) {
  if (!RESOLVE_FAMILY.has(profile.id)) return item("resolve-mono-mapping", ACCEPTANCE_STATES.NA, "Resolve 多通道 Mono 离散映射",
    `${profile.label} 不走 Resolve 导入路径，本项在当前方案下不适用。`);
  return item("resolve-mono-mapping", ACCEPTANCE_STATES.MANUAL, "Resolve 多通道 Mono 离散映射",
    `${resolveMappingFact(result.channels)} 2026-10-05 Resolve 20.3.3.10 本机实测：播放器默认轨类型不等于 WAV 缺失声道。`,
    { guide: "导入后在 Media Pool 检查 Clip Attributes > Audio：节目声按 Mono 离散映射，通道 1→1、2→2……；不要把麦克风通道误设为 5.1/7.1。" });
}

function syncStartMidEnd() {
  return item("sync-start-mid-end", ACCEPTANCE_STATES.MANUAL, "起始 / 中段 / 结尾同步",
    "工具只能验证文件层事实（采样率、时码、通道样本），实际同步必须在目标软件里试听确认。",
    { guide: "同步后分别听开头拍板、中段对白、末尾尾音三处。开头对上而结尾漂移属于帧率 / 采样率 / 时钟问题，不是单个 TimeReference 偏移能修复的。" });
}

function cameraAudioNotPoly(profile) {
  if (!RESOLVE_FAMILY.has(profile.id)) return item("camera-audio-not-poly", ACCEPTANCE_STATES.NA, "摄影机声不是 Poly 多轨",
    `${profile.label} 不使用 Resolve 的 Retain embedded audio，本项在当前方案下不适用。`);
  return item("camera-audio-not-poly", ACCEPTANCE_STATES.MANUAL, "摄影机声不是 Poly 多轨",
    "Resolve 的 Auto Sync Audio 打开 Retain embedded audio 后会额外出现摄影机原始声道，这些轨不是本 Poly 的多通道。",
    { guide: "不需要摄影机参考声时关闭该选项；打开后按「1 个摄影机声道 + N 个外部节目声道」理解，不要把摄影机声误认为 Poly 缺轨或多出来的轨。" });
}

function pcm24ConversionClean(result, profile) {
  if (profile.encoding === "source") return item("pcm24-conversion-clean", ACCEPTANCE_STATES.NA, "PCM24 转换无削波 / 非有限值",
    `${profile.label} 保留源编码，没有做 PCM24 转换，因此不存在转定点削波这一步。`,
    { guide: "若另外导出 24-bit 定点副本，需对那份副本单独检查削波与非有限值。" });
  const clipped = countOrNull(result.clippedSamples);
  const invalid = countOrNull(result.invalidSamples);
  if (clipped === null || invalid === null) return item("pcm24-conversion-clean", ACCEPTANCE_STATES.MANUAL, "PCM24 转换无削波 / 非有限值",
    "这份合并结果没有提供削波 / 非有限值统计，工具无法给出结论。",
    { guide: "重新导出一次以拿到统计；若输出确实来自旧版本工具，请人工检查是否有超 0 dBFS 的爆音。" });
  if (clipped || invalid) return item("pcm24-conversion-clean", ACCEPTANCE_STATES.FAIL, "PCM24 转换无削波 / 非有限值",
    `转 PCM24 出现 ${clipped} 个超范围样本、${invalid} 个非有限样本。`,
    { guide: "源文件未被修改；32-bit float 超过 0 dBFS 时转定点会削波。先调低增益后重导，或改用 archive 保留源编码。", evidence: { clippedSamples: clipped, invalidSamples: invalid } });
  return item("pcm24-conversion-clean", ACCEPTANCE_STATES.PASS, "PCM24 转换无削波 / 非有限值",
    `${result.channels} 通道 ${result.bitsPerSample} bit 定点输出：${clipped} 个超范围样本、${invalid} 个非有限样本。`,
    { guide: "统计干净不等于听感干净；爆音仍要试听确认。", evidence: { clippedSamples: clipped, invalidSamples: invalid } });
}

function sidecarsKept(result) {
  const expected = sidecarNames(result);
  return item("sidecars-kept", ACCEPTANCE_STATES.MANUAL, "sidecar 保留在输出目录",
    `预期与 ${result.name ?? "输出文件"} 同目录存在：${expected.join("、")}；本验收清单文本会追加进 ${expected[0]}。`,
    { guide: "在输出目录保存时工具会一起写出两个 sidecar；复制、移动或网盘同步之后需要人工确认文件仍在。", evidence: { expected } });
}

function sourceImmutable(result) {
  return item("source-immutable", ACCEPTANCE_STATES.PASS, "源文件未被覆盖",
    `本工具写出的是新文件 ${result.name ?? "（导出文件名）"}，不写回任何源分轨；批量导出时会检测同名 Poly 并要求分批，避免 take 之间互相覆盖。`,
    { guide: "重要素材的备份由你确认：合板前先把原始分轨复制到备份盘或第二块硬盘。源文件一旦被覆盖或移动，本工具无法恢复。" });
}

function syncrefUsage(result, profile, options) {
  if (!profile.reference) return item("syncref-usage", ACCEPTANCE_STATES.NA, "SyncRef 使用方式",
    `${profile.label} 不需要独立参考声道，本项在当前方案下不适用。`);
  const referenceName = options.referenceName || result.referenceName;
  if (!referenceName) return item("syncref-usage", ACCEPTANCE_STATES.MANUAL, "SyncRef 使用方式",
    "本次导出没有生成独立 mono SyncRef 通道，波形同步缺少参考声道。",
    { guide: "SyncRef 要显式选一个确有现场共同声音的节目通道，不能是 LTC、静音轨或被排除的通道。" });
  return item("syncref-usage", ACCEPTANCE_STATES.PASS, "SyncRef 使用方式",
    `已生成辅助参考 ${referenceName}（比较声道：${options.referenceChannel || "见输出通道映射"}）。SyncRef 是辅助文件，不是新增制作轨。`,
    { guide: "不要把主 Poly、原始分轨和 SyncRef 同时当成同一个 take 的三组独立音频导入。SyncRef 不能替代真实现场声音：只有 LTC、静音或与摄影机完全不同的声音时，波形同步没有可靠依据。",
      evidence: { referenceName, referenceChannel: options.referenceChannel || null } });
}

function ltcTrackMuted(profile) {
  if (profile.ltcPolicy !== "retain") return item("ltc-track-muted", ACCEPTANCE_STATES.NA, "LTC 技术轨在目标软件里静音",
    `${profile.label} 排除已确认的 LTC 通道，本项在当前方案下不适用。`);
  return item("ltc-track-muted", ACCEPTANCE_STATES.MANUAL, "LTC 技术轨在目标软件里静音",
    "本方案保留 LTC 通道用于读取时码，它和技术噪声一起存在于输出文件中。",
    { guide: "在目标软件中明确关闭或静音 LTC 技术轨的监听，否则时间码噪声会进入节目声。若只要干净 Poly，先让时码工具识别 LTC 声道，再改用 resolve 方案重导。" });
}

function archiveEncodingPreserved(profile) {
  if (profile.id !== "archive") return item("archive-encoding-preserved", ACCEPTANCE_STATES.NA, "归档编码保留",
    `当前方案为 ${profile.label}，输出的是多通道离散 PCM24，不适用归档编码保留检查。`);
  return item("archive-encoding-preserved", ACCEPTANCE_STATES.PASS, "归档编码保留",
    "本方案保留源编码与源位深，没有做 PCM24 转换，可作为归档母版。",
    { guide: "确认归档副本仍能被目标软件读取；需要交给后期的 PCM24 副本请另存，不要覆盖这份归档。" });
}

export function acceptanceHealthSeverityState(severity) {
  const value = String(severity ?? "").trim().toLowerCase();
  if (HEALTH_BLOCKING_SEVERITIES.has(value)) return ACCEPTANCE_STATES.FAIL;
  return ACCEPTANCE_STATES.MANUAL;
}

function healthFindingLine(finding) {
  const where = finding.takeLabel || finding.takeKey || "本 take";
  const code = finding.code ? String(finding.code) : "未标注代码";
  const head = `${code}（${where}）${finding.title || "未标注标题"}`;
  const tail = [finding.detail, finding.suggestion ? `建议：${finding.suggestion}` : ""].filter(Boolean).join(" ");
  return tail ? `${head} —— ${tail}` : head;
}

function healthFindingBlock(list) {
  const shown = list.slice(0, MAX_HEALTH_DETAIL_ITEMS).map(healthFindingLine).join("；");
  return list.length > MAX_HEALTH_DETAIL_ITEMS ? `${shown}；另有 ${list.length - MAX_HEALTH_DETAIL_ITEMS} 项见体检面板` : shown;
}

function takeHealthClear(options) {
  const id = "take-health-clear";
  if (!Array.isArray(options.healthFindings)) return item(id, ACCEPTANCE_STATES.MANUAL, "take 体检结论",
    "未接入 take 体检结果（healthFindings 未提供），本项降级为人工确认，不假设体检通过。",
    { guide: "人工确认本 take 的分轨时长、起始时码、LTC 通道和剔除通道是否符合预期。" });
  const takeKey = options.takeKey;
  const scoped = options.healthFindings.filter(finding => finding && typeof finding === "object"
    && (!takeKey || !finding.takeKey || finding.takeKey === takeKey));
  const blocking = scoped.filter(finding => acceptanceHealthSeverityState(finding.severity) === ACCEPTANCE_STATES.FAIL);
  const review = scoped.filter(finding => acceptanceHealthSeverityState(finding.severity) === ACCEPTANCE_STATES.MANUAL);
  if (blocking.length) return item(id, ACCEPTANCE_STATES.FAIL, "take 体检结论",
    `take 体检报告 ${blocking.length} 项问题：${healthFindingBlock(blocking)}。`,
    { guide: "先处理问题再重新导出；工具不判断哪一项可以忽略。", evidence: { blocking, review } });
  if (review.length) return item(id, ACCEPTANCE_STATES.MANUAL, "take 体检结论",
    `take 体检报告 ${review.length} 项需要复核：${healthFindingBlock(review)}。`,
    { guide: "逐条看过体检建议后再决定是否继续导出。", evidence: { blocking, review } });
  return item(id, ACCEPTANCE_STATES.PASS, "take 体检结论", `take 体检未报告任何问题（0 项）。`,
    { guide: "体检只覆盖工具能读到的元数据与样本特征，不替代在目标软件里的试听。" });
}

export function buildAcceptanceChecklist(result, options = {}) {
  const profile = profileFor(result, options);
  const items = [
    takeSourceConsistency(result, profile),
    ltcChannelConfirmed(result),
    profileDecided(profile),
    exclusionDecisions(result),
    resolveMonoMapping(result, profile),
    syncStartMidEnd(),
    cameraAudioNotPoly(profile),
    pcm24ConversionClean(result, profile),
    sidecarsKept(result),
    sourceImmutable(result),
    syncrefUsage(result, profile, options),
    ltcTrackMuted(profile),
    archiveEncodingPreserved(profile),
    takeHealthClear(options),
  ];
  const summary = { total: items.length, pass: 0, fail: 0, manual: 0, na: 0, needsHuman: 0 };
  for (const entry of items) summary[entry.state] = (summary[entry.state] ?? 0) + 1;
  summary.needsHuman = summary[ACCEPTANCE_STATES.MANUAL];
  return {
    schema: "slatesync/acceptance-checklist/v1",
    outputName: result.name ?? null,
    channels: countOrNull(result.channels),
    profile: profile.id,
    profileLabel: profile.label,
    encoding: profile.encoding,
    ltcPolicy: profile.ltcPolicy,
    reference: profile.reference,
    items,
    summary,
  };
}

export function acceptanceChecklistStateOf(checklist, id) {
  const entry = checklist?.items?.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`未知验收项：${id}`);
  return entry.state;
}

// 渲染成可勾选的中文文本块，供追加进 _合板说明.txt。
// 文本自身不带 BOM、不带首尾换行；追加到 syncWorkflowText() 的输出时用 "\r\n" 连接，
// 与 poly-combine-controller.js:34 的现有写法一致。bom:true 时前置 \uFEFF 供独立成文件。
export function renderAcceptanceChecklistText(checklist, options = {}) {
  const { summary } = checklist;
  const lines = [
    "【交付验收清单】",
    "工具只判定文件层事实；标注需人工确认的项必须在目标软件里完成后才算通过。",
    `方案：${checklist.profileLabel}｜文件：${checklist.outputName ?? "未知"}`,
    `共 ${summary.total} 项：自动确认通过 ${summary.pass}｜发现问题 ${summary.fail}｜需人工确认 ${summary.manual}｜本方案不适用 ${summary.na}`,
    "",
  ];
  for (const entry of checklist.items) {
    lines.push(`${STATE_MARKS[entry.state]} ${entry.label}${STATE_TAGS[entry.state]} —— ${entry.detail}`);
    if (entry.guide) lines.push(`    → ${entry.guide}`);
  }
  lines.push("", "本清单与 _channels.json 一起构成机器可读的交付记录；工具不判定目标软件端的导入与同步结果。");
  const text = lines.join("\r\n");
  return options.bom ? `${ACCEPTANCE_TEXT_BOM}${text}` : text;
}

export function acceptanceChecklistText(result, options = {}) {
  return renderAcceptanceChecklistText(buildAcceptanceChecklist(result, options), options);
}