// 单文件自包含的 HTML 校验报告渲染器（conform_check.v1 的第二种输出形态）。
//
// 为什么要有它：JSON 与终端摘要都是给机器/命令行看的。审片、制片、制片管理
// 的人不读 JSON——他们要的是「哪几条我判不了、哪几条连错了、拿什么替代」，
// 而这些必须在报告里一眼看见，不能靠人自己去翻 JSON。
//
// 硬约束（改动前先读这四条）：
//   1. 纯函数：renderConformHtml(report) -> string。不读盘、不碰 DOM、不 import node:*。
//      同一份 report 对象永远渲染出同一份 HTML；JSON 与 HTML 出自同一份对象。
//   2. 自包含：样式全部内联在 <style> 里；不引 CDN、不引外部字体/图片；
//      渲染结果里不得出现 http:// 或 https:// 任何子串。
//      —— 报告会被当邮件附件发出去，收件人的机器上多一个外链就意味着它会偷偷联网。
//   3. 不写 <script>：这是给别人看的静态件，脚本只会凭空多出一个 XSS 面。
//   4. 不引入任何新判定：只呈现 report 对象里已有的内容。分组、配色、排版都是呈现，
//      但绝不新增一条「这条 clip 到底算不算通过」的结论。三态与退出码语义一字不改。
//
// 自包含不是「写的时候小心一点」就行的承诺，是被 assertSelfContainedHtml 实测的硬约束：
// CLI 写文件前会真的查一遍，查不过就不写。

import { CONFORM_EXIT_MEANINGS, CONFORM_VERDICTS, describeFailOn } from "./conform-check.js";

/** HTML 报告的渲染契约标识。跟 JSON 报告同源，但各自标明自己是什么形态。 */
export const CONFORM_HTML_RENDERER = "conform-report-html.v1";

// ---------------------------------------------------------------------------
// 呈现元数据（只有配色/文案，没有判定）
// ---------------------------------------------------------------------------

const VERDICT_META = Object.freeze({
  [CONFORM_VERDICTS.SUPPORTED]: {
    tone: "ok",
    cn: "有独立证据支撑",
    note: "文件自带的独立见证（内嵌时码 / LTC）与清单声称相容，且没有任何一条证据反对。",
  },
  [CONFORM_VERDICTS.UNVERIFIED]: {
    tone: "warn",
    cn: "判不了 — 这是「我不知道」",
    note: "unverified ≠ 错。它不是通过，也不是失败：只是没找到能独立支撑这条连线的证据。",
  },
  [CONFORM_VERDICTS.CONFLICT]: {
    tone: "bad",
    cn: "证据互相矛盾",
    note: "至少有一条证据反对这条连线；文件内部两条见证打架时，谁也不能单独当见证。",
  },
});

const FAIL_ON_LEVEL_LABEL = Object.freeze({
  none: "none — 本次没有门禁被触发，全部放行",
  conflict: "conflict — 有证据矛盾即失败",
  "unverified-ratio": "unverified-ratio — 不可判定比例超过阈值即失败",
  "conflict+unverified-ratio": "conflict+unverified-ratio — 两条门禁都响了",
});

const FAIL_ON_GATE_LABEL = Object.freeze({
  conflict: "存在任意一条 conflict 即失败（不可关闭）",
  "unverified-ratio": "unverified 比例超过阈值即失败（阈值来自 --max-unverified-ratio）",
});

const EVIDENCE_STATUS_TONE = Object.freeze({
  pass: "ok",
  fail: "bad",
  missing: "miss",
  na: "na",
});

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** 所有进入 HTML 的动态文本都必须过这里。 */
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function renderScalar(value) {
  if (value === null || value === undefined) return '<span class="nil">—</span>';
  if (typeof value === "boolean") return '<span class="bool">' + (value ? "true" : "false") + "</span>";
  return esc(String(value));
}

/** 把 report 里任意形状的值（标量 / 数组 / 对象）渲染成可读的小块。 */
function renderValue(value) {
  if (value === null || value === undefined) return '<span class="nil">—</span>';
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="nil">（空）</span>';
    return '<ul class="vlist">' + value.map((item) => "<li>" + renderValue(item) + "</li>").join("") + "</ul>";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return '<span class="nil">（空）</span>';
    return '<dl class="kv">' + entries
      .map(([key, item]) => "<dt>" + esc(key) + "</dt><dd>" + renderValue(item) + "</dd>")
      .join("") + "</dl>";
  }
  return renderScalar(value);
}

// ---------------------------------------------------------------------------
// 样式（全部内联；不引 CDN、不引外部字体/图片、不出现 url(...)）
// ---------------------------------------------------------------------------

const STYLE = [
  ":root{",
  "--ink:#15181d;--ink-2:#333a45;--muted:#5d6472;--line:#dde1e8;--line-2:#eef0f4;",
  "--bg:#f5f6f8;--panel:#fff;",
  "--ok:#14663a;--ok-bg:#e8f6ed;--ok-line:#8fd0aa;",
  "--warn:#7d5100;--warn-bg:#fff4d4;--warn-line:#e3ab12;",
  "--bad:#9d1a1a;--bad-bg:#fdeaea;--bad-line:#e59a9a;",
  "--miss:#4a5568;--miss-bg:#eef1f5;",
  "--mono:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;",
  "--sans:system-ui,-apple-system,'Segoe UI','Noto Sans CJK SC','Microsoft YaHei',sans-serif;",
  "}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.62}",
  ".wrap{max-width:1200px;margin:0 auto;padding:26px 20px 72px}",
  "h1{font-size:25px;margin:0 0 4px;letter-spacing:.2px}",
  "h2{font-size:19px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}",
  "h3{font-size:15px;margin:22px 0 8px;color:var(--ink-2);letter-spacing:.3px}",
  "h3 .k{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--muted);margin-left:6px}",
  "h4{font-size:13px;margin:14px 0 6px;color:var(--muted);text-transform:none}",
  "code{font-family:var(--mono);font-size:.9em;background:var(--line-2);padding:1px 5px;border-radius:3px;word-break:break-all}",
  "p{margin:0 0 10px}",
  "ul{margin:6px 0;padding-left:22px}",
  "li{margin:3px 0}",
  "section{margin:18px 0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 22px}",
  ".subtitle{color:var(--muted);margin:0 0 2px;font-size:13.5px}",
  ".note{color:var(--muted);font-size:13.5px;background:var(--line-2);border-left:3px solid var(--line);padding:9px 12px;border-radius:0 5px 5px 0;margin:10px 0}",
  ".nil{color:#9aa1ad;font-style:italic}",
  ".bool{color:var(--muted)}",
  ".muted{color:var(--muted)}",
  ".vlist{margin:2px 0;padding-left:16px;font-family:var(--mono);font-size:12.5px}",
  /* 三态配色：supported 绿 / unverified 黄（醒目，且与绿色明显不同） / conflict 红 */
  ".cards{display:flex;flex-wrap:wrap;gap:12px;margin:4px 0 18px}",
  ".card{flex:1 1 190px;border:1px solid var(--line);border-radius:9px;padding:13px 15px;background:var(--panel)}",
  ".card .num{font-size:34px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}",
  ".card .lbl{font-family:var(--mono);font-size:13px;margin-top:2px;font-weight:600}",
  ".card .sub{font-size:12.5px;color:var(--muted);margin-top:3px}",
  ".card.t-ok{border:1px solid var(--ok-line);background:var(--ok-bg)}",
  ".card.t-ok .num,.card.t-ok .lbl{color:var(--ok)}",
  ".card.t-warn{border:2px solid var(--warn-line);background:var(--warn-bg);box-shadow:0 0 0 3px rgba(227,171,18,.14)}",
  ".card.t-warn .num,.card.t-warn .lbl{color:var(--warn)}",
  ".card.t-bad{border:1px solid var(--bad-line);background:var(--bad-bg)}",
  ".card.t-bad .num,.card.t-bad .lbl{color:var(--bad)}",
  ".badge{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:600;padding:1px 8px;border-radius:11px;border:1px solid transparent;white-space:nowrap}",
  ".badge.v-ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}",
  ".badge.v-warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}",
  ".badge.v-bad{color:var(--bad);background:var(--bad-bg);border-color:var(--bad-line)}",
  ".badge.v-miss{color:var(--miss);background:var(--miss-bg);border-color:var(--line)}",
  ".badge.v-na{color:var(--muted);background:var(--miss-bg);border-color:var(--line)}",
  ".badge.v-hit{color:#fff;background:var(--ink);border-color:var(--ink)}",
  ".focus{display:flex;gap:18px;align-items:flex-start;border-radius:10px;padding:18px 20px;margin:16px 0;border:1px solid var(--line)}",
  ".focus .focus-num{font-size:40px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}",
  ".focus .focus-body{flex:1}",
  ".focus h2{border:0;margin:0 0 6px;padding:0;font-size:17px}",
  ".focus.t-warn{background:var(--warn-bg);border:2px solid var(--warn-line)}",
  ".focus.t-warn .focus-num,.focus.t-warn h2{color:var(--warn)}",
  ".focus.t-ok{background:var(--ok-bg);border-color:var(--ok-line)}",
  ".focus.t-ok .focus-num,.focus.t-ok h2{color:var(--ok)}",
  ".focus.t-bad{background:var(--bad-bg);border-color:var(--bad-line)}",
  ".focus.t-bad .focus-num,.focus.t-bad h2{color:var(--bad)}",
  "table{width:100%;border-collapse:collapse;margin:6px 0 4px;font-size:13.5px}",
  "th,td{text-align:left;vertical-align:top;padding:7px 9px;border-bottom:1px solid var(--line-2)}",
  "th{background:var(--line-2);font-size:12.5px;color:var(--ink-2);font-weight:600;white-space:nowrap}",
  "tbody tr:hover{background:#fafbfc}",
  "table.kv-table td:first-child{white-space:nowrap;color:var(--muted);width:190px}",
  "dl.kv{margin:0;display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:12.5px;font-family:var(--mono)}",
  "dl.kv dt{color:var(--muted);white-space:nowrap}",
  "dl.kv dd{margin:0;word-break:break-word}",
  ".clip{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0;background:var(--panel)}",
  ".clip.v-ok{border-left:6px solid var(--ok)}",
  ".clip.v-warn{border-left:6px solid var(--warn);background:#fffdf6}",
  ".clip.v-bad{border-left:6px solid var(--bad)}",
  ".clip-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:4px}",
  ".clip-head h2{border:0;margin:0;padding:0;font-size:17px}",
  ".clip-verdict-cn{font-size:13px;color:var(--muted)}",
  ".clip-note{margin:4px 0 10px;font-size:13px;color:var(--ink-2);background:var(--line-2);padding:7px 10px;border-radius:5px}",
  "table.evidence{font-size:12.5px}",
  "table.evidence th{white-space:nowrap}",
  "table.evidence td.ev-kind{width:230px}",
  "table.evidence td.ev-status{width:78px}",
  "table.evidence td.ev-delta{width:132px;font-family:var(--mono);font-size:12px}",
  "table.evidence td.ev-cov{width:96px}",
  "tr.ev-detail td{background:#fbfcfd;border-bottom:2px solid var(--line);font-size:12.5px}",
  ".ev-detail-text{font-weight:600}",
  ".ev-delta .k,.ev-detail-text .k{color:var(--muted);font-family:var(--mono);font-size:11.5px;font-weight:600}",
  ".ev-readby{color:var(--muted);margin-top:3px;font-family:var(--mono);font-size:12px;word-break:break-word}",
  ".ev-readby .k{color:var(--ink-2);font-weight:600}",
  ".tag{display:inline-block;font-family:var(--mono);font-size:11px;padding:0 6px;border-radius:9px;margin-left:6px;border:1px solid var(--line);color:var(--muted);background:var(--line-2)}",
  ".tag-strong{color:#2b3a67;border-color:#b9c4de;background:#eef2fa}",
  ".tag-weak{color:var(--muted)}",
  ".tag-identifier{color:#5a4a20;border-color:#d9c99a;background:#f7f1e2}",
  ".reason-codes{display:flex;flex-wrap:wrap;gap:6px}",
  ".reason-code{font-family:var(--mono);font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid var(--line);background:var(--miss-bg);color:var(--ink-2)}",
  ".foot{color:var(--muted);font-size:12.5px;margin-top:20px;border-top:1px solid var(--line);padding-top:12px}",
  "@media print{body{background:#fff}.wrap{max-width:none;padding:0}section,.clip{break-inside:avoid;box-shadow:none}}",
].join("");

// ---------------------------------------------------------------------------
// 片段渲染
// ---------------------------------------------------------------------------

function verdictMeta(verdict) {
  return VERDICT_META[verdict] || { tone: "warn", cn: String(verdict), note: "" };
}

function renderHeader(report) {
  const run = report.run || {};
  const bits = [
    "契约 " + esc(report.contract),
    "清单 schema " + esc(report.clipListSchema),
    "媒体目录 " + esc(report.mediaRoot || "."),
  ];
  if (run.generatedAt) bits.push("生成于 " + esc(run.generatedAt));
  if (run.nodeVersion) bits.push("Node " + esc(run.nodeVersion));
  return (
    "<header>" +
    "<h1>合板校验报告（conform_check.v1）</h1>" +
    '<p class="subtitle">' + bits.join(" · ") + "</p>" +
    (report.syntheticStubMedia
      ? '<p class="note"><strong>合成素材提示：</strong>媒体文件名含 <code>_stub</code>，属合成素材，' +
        "本次结果<strong>未在真实拍摄素材上验证</strong>（report.syntheticStubMedia = true）。</p>"
      : "") +
    "</header>"
  );
}

/** 总览：三态计数 + unverifiedRatio（单列）+ failOn 档位 + 退出码语义 + 媒体扫描情况。 */
function renderOverview(report) {
  const summary = report.summary || {};
  const options = report.options || {};
  const failOn = describeFailOn(summary, options.maxUnverifiedRatio);
  const media = report.media || {};
  const run = report.run || {};

  const cards = [
    { tone: "ok", num: summary.supported ?? 0, lbl: "supported", sub: VERDICT_META.supported.cn },
    { tone: "warn", num: summary.unverified ?? 0, lbl: "unverified", sub: VERDICT_META.unverified.cn },
    { tone: "bad", num: summary.conflict ?? 0, lbl: "conflict", sub: VERDICT_META.conflict.cn },
  ].map((card) =>
    '<div class="card t-' + card.tone + '">' +
    '<div class="num">' + esc(card.num) + "</div>" +
    '<div class="lbl">' + esc(card.lbl) + "</div>" +
    '<div class="sub">' + esc(card.sub) + "</div>" +
    "</div>",
  ).join("");

  const ratioText = ((summary.unverifiedRatio ?? 0) * 100).toFixed(2) + "%";

  const kvRows = [
    ["clip 总数", esc(summary.clips ?? 0)],
    [
      "不可判定比例 unverifiedRatio",
      '<span class="badge v-warn">' + esc(ratioText) + "</span> " +
        '<span class="muted">（' + esc(summary.unverified ?? 0) + " / " + esc(summary.clips ?? 0) +
        " 条判不了；这是「我不知道」的条数，不算通过）</span>",
    ],
    [
      "failOn 档位",
      '<strong>' + esc(FAIL_ON_LEVEL_LABEL[failOn.level] || failOn.level) + "</strong>" +
        '<div class="muted">生效门禁：' +
        failOn.gates.map((gate) => esc(FAIL_ON_GATE_LABEL[gate] || gate)).join("；") +
        "</div>" +
        '<div class="muted">本次触发：' +
        (failOn.fired.length
          ? failOn.fired.map((gate) => esc(gate)).join(" + ")
          : "（无）") +
        "</div>",
    ],
    [
      "退出码",
      '<strong>' + esc(report.exitCode) + "</strong> — " + esc(report.exitMeaning || ""),
    ],
  ].map((row) => "<tr><td>" + row[0] + "</td><td>" + row[1] + "</td></tr>").join("");

  const exitRows = Object.entries(CONFORM_EXIT_MEANINGS).map(([code, meaning]) => {
    const hit = Number(code) === Number(report.exitCode);
    return (
      "<tr" + (hit ? ' class="hit"' : "") + ">" +
      "<td><strong>" + esc(code) + "</strong></td>" +
      "<td>" + esc(meaning) + "</td>" +
      "<td>" + (hit ? '<span class="badge v-hit">本次</span>' : '<span class="muted">—</span>') + "</td>" +
      "</tr>"
    );
  }).join("");

  const mediaRows = [
    ["媒体目录", esc(report.mediaRoot || ".")],
    ["扫描到的文件", esc(media.filesSeen ?? 0)],
    ["可读的 WAV", esc(media.waveFilesReadable ?? 0)],
    ["读不动的 WAV", esc(media.waveFilesUnreadable ?? 0)],
    ["带内嵌起始时码的文件", esc(media.withEmbeddedStart ?? 0)],
    ["LTC 扫描过的文件", esc(media.ltcScanned ?? 0)],
    ["LTC 解出时码的文件", esc(media.ltcDecoded ?? 0)],
    ["非 WAV 文件（忽略）", run.ignoredNonWaveFiles === undefined ? "—" : esc(run.ignoredNonWaveFiles)],
    ["识别到的 take 分组", run.takesDetected === undefined ? "—" : esc(run.takesDetected)],
    ["扫描耗时", run.durationMs === undefined ? "—" : esc(run.durationMs) + " ms"],
  ].map((row) => "<tr><td>" + row[0] + "</td><td>" + row[1] + "</td></tr>").join("");

  return (
    '<section id="overview">' +
    "<h2>总览</h2>" +
    '<div class="cards">' + cards + "</div>" +
    '<table class="kv-table"><tbody>' + kvRows + "</tbody></table>" +
    "<h3>退出码语义</h3>" +
    '<table><thead><tr><th>码</th><th>代表什么</th><th>本次</th></tr></thead><tbody>' +
    exitRows +
    "</tbody></table>" +
    '<p class="note">退出码 <strong>2</strong> 是输入问题（清单读不到、JSON 非法、schema 不符、用法错），' +
    "不是判定结果；报告能生成本身就说明输入这一关已经过了，所以正常情况下不会命中它。</p>" +
    "<h3>媒体目录扫描情况</h3>" +
    '<table class="kv-table"><tbody>' + mediaRows + "</tbody></table>" +
    "</section>"
  );
}

/** 不可判定专区：把 unverified 单独拎出来，占比单列，避免被 supported 的绿色盖住。 */
function renderUnverifiedFocus(report) {
  const summary = report.summary || {};
  const count = summary.unverified ?? 0;
  const total = summary.clips ?? 0;
  const ratio = (summary.unverifiedRatio ?? 0) * 100;
  const clips = (report.clips || []).filter((clip) => clip.verdict === CONFORM_VERDICTS.UNVERIFIED);

  if (!count) {
    return (
      '<section class="focus t-ok" id="unverified-focus">' +
      '<div class="focus-num">0</div>' +
      '<div class="focus-body"><h2>判不了的条目：0 / ' + esc(total) + "（0.00%）</h2>" +
      "<p>本次没有 unverified 条目。也就是说每一条 clip 要么有独立证据支撑，要么证据直接反对——没有夹在中间的。</p>" +
      "</div></section>"
    );
  }

  const list = clips.map((clip) => {
    const reasons = (clip.reasons || []).map((code) =>
      '<span class="reason-code">' + esc(code) + "</span>",
    ).join(" ");
    return (
      "<li><code>" + esc(clip.id) + "</code> — " + esc(clip.claim?.name || "（清单未给文件名）") +
      '<div class="muted">原因：' + (reasons || "—") + "</div></li>"
    );
  }).join("");

  return (
    '<section class="focus t-warn" id="unverified-focus">' +
    '<div class="focus-num">' + esc(count) + "</div>" +
    '<div class="focus-body">' +
    "<h2>判不了的条目：" + esc(count) + " / " + esc(total) + "（" + ratio.toFixed(2) + "%）</h2>" +
    "<p>这 <strong>" + esc(count) + "</strong> 条 clip 的结论是 <code>unverified</code>。" +
    "<strong>unverified ≠ 错</strong>：它既不是通过也不是失败，它就是「我不知道」——" +
    "没找到能独立支撑这条连线的证据。把它们当成通过，正是这一层要防的事。</p>" +
    '<ul class="focus-list">' + list + "</ul>" +
    "</div></section>"
  );
}

/**
 * 跳过核对 / 媒体缺席的条目。
 *
 * 口径只有一条，且只用报告里已有的字段：identifier.filename 这条证据没有 pass，
 * 也就是「没有锁定到一个具体媒体文件」——文件不在目录里、清单没给文件名，
 * 或者同名多份、工具不替人挑。这不是新判定：evaluateClip 已经把它们各自
 * 判成 unverified 或 conflict，这里只是把它们单独拎出来给人看。
 */
export function collectSkippedClips(report) {
  const clips = report?.clips || [];
  return clips
    .filter((clip) => {
      const row = (clip.evidence || []).find((item) => item.kind === "identifier.filename");
      return !row || row.status !== "pass";
    })
    .map((clip) => {
      const row = (clip.evidence || []).find((item) => item.kind === "identifier.filename");
      return {
        id: clip.id,
        name: clip.claim?.name || "",
        reel: clip.claim?.reel || null,
        verdict: clip.verdict,
        reasonCodes: [...(clip.reasons || [])],
        detail: row?.detail || "",
      };
    });
}

function renderSkippedSection(report) {
  const skipped = collectSkippedClips(report);
  const body = skipped.length
    ? '<table><thead><tr><th>clip</th><th>文件名</th><th>结论</th><th>原因码</th><th>说明</th></tr></thead><tbody>' +
      skipped.map((item) => {
        const meta = verdictMeta(item.verdict);
        const reasons = item.reasonCodes.map((code) =>
          '<span class="reason-code">' + esc(code) + "</span>",
        ).join(" ");
        return (
          "<tr>" +
          "<td><code>" + esc(item.id) + "</code></td>" +
          "<td>" + esc(item.name || "（清单未给文件名）") + "</td>" +
          '<td><span class="badge v-' + meta.tone + '">' + esc(item.verdict) + "</span></td>" +
          "<td>" + (reasons || "—") + "</td>" +
          "<td>" + esc(item.detail) + "</td>" +
          "</tr>"
        );
      }).join("") +
      "</tbody></table>"
    : '<p class="note">本次没有条目落在这一栏：每条 clip 都锁定到了一个具体的媒体文件。</p>';

  return (
    '<section id="skipped">' +
    "<h2>跳过核对 / 媒体缺席</h2>" +
    '<p class="note">下面这些条目<strong>没有核对到任何具体的媒体文件</strong>：' +
    "文件不在媒体目录里（<code>media-not-found</code>）、来源格式没给文件名（<code>no-filename-in-edl</code>）、" +
    "或者同名多份工具不替人挑（<code>ambiguous-filename</code>）。" +
    "工具没有替人猜，也没有把它们当成通过——每一行仍然带着它自己的结论。</p>" +
    body +
    "</section>"
  );
}

/** 证据链逐行展开。 */
function renderEvidenceRows(clip) {
  const rows = clip.evidence || [];
  return rows.map((row) => {
    const tone = EVIDENCE_STATUS_TONE[row.status] || "na";
    const deltas = [];
    if (row.deltaSeconds !== null && row.deltaSeconds !== undefined) {
      deltas.push('<span class="k">deltaSeconds</span> ' + esc(row.deltaSeconds));
    }
    if (row.deltaFrames !== null && row.deltaFrames !== undefined) {
      deltas.push('<span class="k">deltaFrames</span> ' + esc(row.deltaFrames));
    }
    if (row.toleranceFrames !== null && row.toleranceFrames !== undefined) {
      deltas.push('<span class="k">toleranceFrames</span> ' + esc(row.toleranceFrames));
    }
    return (
      '<tr class="ev ev-' + tone + '" data-evidence-kind="' + esc(row.kind) + '"' +
      ' data-evidence-strength="' + esc(row.strength) + '"' +
      ' data-evidence-status="' + esc(row.status) + '">' +
      '<td class="ev-kind"><code>' + esc(row.kind) + "</code>" +
      '<span class="tag tag-' + esc(row.strength) + '">' + esc(row.strength) + "</span></td>" +
      '<td class="ev-status"><span class="badge v-' + tone + '">' + esc(row.status) + "</span></td>" +
      '<td class="ev-exp">' + renderValue(row.expected) + "</td>" +
      '<td class="ev-meas">' + renderValue(row.measured) + "</td>" +
      '<td class="ev-delta">' +
      (deltas.length ? deltas.map((line) => "<div>" + line + "</div>").join("") : '<span class="nil">—</span>') +
      "</td>" +
      '<td class="ev-cov">' +
      (row.coverage
        ? '<span class="badge v-' + (row.coverage === "exact" || row.coverage === "inside" ? "ok" : "miss") + '">' +
          esc(row.coverage) + "</span>"
        : '<span class="nil">—</span>') +
      "</td>" +
      "</tr>" +
      '<tr class="ev-detail"><td colspan="6">' +
      '<div class="ev-detail-text"><span class="k">detail</span> ' + esc(row.detail || "") + "</div>" +
      (row.readBy
        ? '<div class="ev-readby"><span class="k">readBy</span> ' + esc(row.readBy) + "</div>"
        : "") +
      "</td></tr>"
    );
  }).join("");
}

function renderCandidates(clip) {
  const candidates = clip.candidates || [];
  if (!candidates.length) {
    return '<p class="note">没有命中任何候选文件（名字没在媒体目录里查到，或来源格式没给文件名）。</p>';
  }
  return (
    '<table><thead><tr><th>候选文件</th><th>采样率</th><th>声道</th><th>位深</th><th>采样数</th>' +
    "<th>bext</th><th>iXML</th><th>LTC</th></tr></thead><tbody>" +
    candidates.map((item) => {
      const ltc = item.ltc
        ? '<span class="badge v-' + (item.ltc.status === "locked" ? "ok" : "miss") + '">' +
          esc(item.ltc.status) + (item.ltc.timecode ? " " + esc(item.ltc.timecode) : "") + "</span>"
        : '<span class="nil">—</span>';
      return (
        "<tr>" +
        "<td><code>" + esc(item.path) + "</code></td>" +
        "<td>" + esc(item.sampleRate ?? "—") + "</td>" +
        "<td>" + esc(item.channels ?? "—") + "</td>" +
        "<td>" + esc(item.bitsPerSample ?? "—") + "</td>" +
        "<td>" + esc(item.durationSamples || "—") + "</td>" +
        "<td>" + (item.hasBext ? "有" : "无") + "</td>" +
        "<td>" + (item.hasIxml ? "有" : "无") + "</td>" +
        "<td>" + ltc + "</td>" +
        "</tr>"
      );
    }).join("") +
    "</tbody></table>"
  );
}

function renderAlternates(clip) {
  const alternates = clip.alternates || [];
  if (!alternates.length) {
    return '<p class="note">没有找到其它覆盖该源区间的候选文件。</p>';
  }
  return (
    '<table><thead><tr><th>替代文件</th><th>文件起点</th><th>文件终点</th><th>距声称入点</th></tr></thead><tbody>' +
    alternates.map((item) =>
      "<tr>" +
      "<td><code>" + esc(item.path) + "</code></td>" +
      "<td>" + esc(item.startTimecode ?? "—") + "</td>" +
      "<td>" + esc(item.endTimecode ?? "—") + "</td>" +
      "<td>" + esc(item.startDeltaFrames ?? "—") + " 帧</td>" +
      "</tr>",
    ).join("") +
    "</tbody></table>"
  );
}

function renderClip(clip) {
  const meta = verdictMeta(clip.verdict);
  const claim = clip.claim || {};

  const claimRows = [
    ["源文件名", claim.name ? "<code>" + esc(claim.name) + "</code>" : '<span class="nil">（清单未给文件名）</span>'],
    ["卷号 reel", claim.reel ? "<code>" + esc(claim.reel) + "</code>" : '<span class="nil">—</span>'],
    [
      "帧率",
      "<code>" + esc(claim.fps ?? "—") + "</code> · drop-frame：<strong>" +
        (claim.dropFrame ? "是（丢帧）" : "否（非丢帧）") + "</strong>",
    ],
    ["sourceIn（规范化时码）", "<code>" + esc(claim.sourceIn ?? "—") + "</code>"],
    ["sourceIn（原始标签）", "<code>" + esc(claim.sourceInRaw ?? claim.sourceIn ?? "—") + "</code>"],
    ["sourceIn（帧号）", "<code>" + esc(claim.sourceInFrames ?? "—") + "</code>"],
    ["sourceOut（规范化时码）", "<code>" + esc(claim.sourceOut ?? "—") + "</code>"],
    ["sourceOut（原始标签）", "<code>" + esc(claim.sourceOutRaw ?? claim.sourceOut ?? "—") + "</code>"],
    ["sourceOut（帧号）", "<code>" + esc(claim.sourceOutFrames ?? "—") + "</code>"],
    [
      "时间线入出",
      claim.timelineIn
        ? "<code>" + esc(claim.timelineIn) + "</code> → <code>" + esc(claim.timelineOut ?? "—") + "</code>"
        : '<span class="nil">—</span>',
    ],
    ["源跨度（帧）", "<code>" + esc(claim.spanFrames ?? "—") + "</code>"],
    ["备注", claim.note ? esc(claim.note) : '<span class="nil">—</span>'],
  ].map((row) => "<tr><td>" + row[0] + "</td><td>" + row[1] + "</td></tr>").join("");

  const reasons = (clip.reasons || []).map((code) =>
    '<span class="reason-code">' + esc(code) + "</span>",
  ).join(" ");
  const suggestions = (clip.suggestions || []).map((text) => "<li>" + esc(text) + "</li>").join("");
  const ltcRequest = clip.ltcRequest
    ? '<p class="note">待办（<span class="k">ltcRequest</span>）：需要对 <code>' + esc(clip.ltcRequest.probePath) +
      "</code> 补扫一轮 LTC（原因 <code>" + esc(clip.ltcRequest.reason) + "</code>）。</p>"
    : "";

  /* EVIDENCE-BLOCK-START */
  const evidenceHtml = renderEvidenceRows(clip);
  /* EVIDENCE-BLOCK-END */

  return (
    '<article class="clip v-' + meta.tone + '" id="clip-' + esc(clip.id) + '">' +
    '<div class="clip-head">' +
    '<span class="badge v-' + meta.tone + '">' + esc(clip.verdict) + "</span>" +
    "<h2>" + esc(clip.id) + "</h2>" +
    '<span class="clip-verdict-cn">' + esc(meta.cn) + "</span>" +
    "</div>" +
    '<p class="clip-note">' + esc(meta.note) + "</p>" +
    "<h3>清单声称</h3>" +
    '<table class="kv-table"><tbody>' + claimRows + "</tbody></table>" +
    "<h3>证据链（逐行）</h3>" +
    '<table class="evidence"><thead><tr><th>kind / strength</th><th>status</th>' +
    "<th>expected（清单声称）</th>" +
    "<th>measured（实测）</th>" +
    "<th>deltaSeconds / deltaFrames / toleranceFrames</th>" +
    "<th>coverage（覆盖方式）</th></tr></thead><tbody>" +
    evidenceHtml +
    "</tbody></table>" +
    "<h3>原因</h3>" +
    (reasons ? '<div class="reason-codes">' + reasons + "</div>" : '<p class="muted">—</p>') +
    "<h3>命中的候选文件 <span class=\"k\">candidates</span></h3>" +
    renderCandidates(clip) +
    "<h3>未选中的替代项（时码相近 / 覆盖该源区间） <span class=\"k\">alternates</span></h3>" +
    renderAlternates(clip) +
    "<h3>建议 <span class=\"k\">suggestions</span></h3>" +
    (suggestions ? "<ul>" + suggestions + "</ul>" : '<p class="muted">—</p>') +
    ltcRequest +
    "</article>"
  );
}

function renderClips(report) {
  const clips = report.clips || [];
  return (
    '<section id="clips">' +
    "<h2>逐条 clip（" + esc(clips.length) + " 条）</h2>" +
    '<p class="note">每条 clip 一条证据链：每一行是一次独立比较——读哪个字节、走哪个模块、和什么比、差多少、容差多少。' +
    "这一层只认证据，不连片段、不修时码。</p>" +
    clips.map((clip) => renderClip(clip)).join("") +
    "</section>"
  );
}

function renderFooter(report) {
  const run = report.run || {};
  const bits = [];
  bits.push("契约 " + esc(report.contract));
  bits.push("渲染器 " + esc(CONFORM_HTML_RENDERER));
  if (run.generatedAt) bits.push("生成于 " + esc(run.generatedAt));
  if (report.syntheticStubMedia) bits.push("合成素材（_stub），未在真实拍摄素材上验证");
  return (
    '<p class="foot">本报告与 JSON 报告出自同一份 report 对象，渲染是纯函数。' +
    "报告只呈现已有的判定，不引入任何新结论；supported / unverified / conflict 三态与退出码语义与 JSON 完全一致。" +
    "单文件自包含：无外部字体、无外部图片、无脚本。" +
    " · " + bits.join(" · ") +
    "</p>"
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 把一份 conform 报告渲染成单文件自包含的 HTML。
 *
 * @param {object} report  buildConformReport 产出的报告对象（CLI 与 JSON 用的是同一份）
 * @returns {string} 完整 HTML 文档
 */
export function renderConformHtml(report) {
  if (!report || typeof report !== "object") {
    throw new TypeError("renderConformHtml 需要一份 report 对象");
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>合板校验报告 · " + esc(report.contract || "conform_check.v1") + "</title>",
    "<style>" + STYLE + "</style>",
    "</head>",
    "<body>",
    '<main class="wrap">',
    renderHeader(report),
    renderOverview(report),
    renderUnverifiedFocus(report),
    renderSkippedSection(report),
    renderClips(report),
    renderFooter(report),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 自包含检查：真的扫一遍渲染结果，而不是「写的时候小心一点」。
 *
 * CLI 写文件前会调用它；查不过就不写文件——宁可没有报告，也不要一份会偷偷联网的报告。
 *
 * @param {string} html
 * @returns {true}
 * @throws {Error} 列出全部违规项
 */
export function assertSelfContainedHtml(html) {
  const text = String(html || "");
  const problems = [];
  const external = text.match(/https?:\/\//gi);
  if (external) problems.push("出现 " + external.length + " 处 http(s):// 外部链接");
  if (/<script/i.test(text)) problems.push("出现 <script>");
  if (/<link\b/i.test(text)) problems.push("出现 <link>");
  if (/<img\b/i.test(text)) problems.push("出现 <img>");
  if (/<iframe\b|<object\b|<embed\b/i.test(text)) problems.push("出现 iframe/object/embed");
  if (/\bsrc\s*=/i.test(text)) problems.push("出现 src= 属性");
  if (/url\(/i.test(text)) problems.push("CSS 里出现 url()");
  if (/@import/i.test(text)) problems.push("出现 @import");
  if (problems.length) {
    throw new Error("HTML 报告不是自包含的：" + problems.join("；"));
  }
  return true;
}
