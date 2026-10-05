import { buildAllDiagnostics, channelVerdict, dbfs } from "./ltc-diagnostics.js";

const STATUS_META = {
  ok: { icon: "✓", text: "正常" },
  warn: { icon: "!", text: "需复核" },
  fail: { icon: "✗", text: "失败" },
  pending: { icon: "…", text: "未检测" },
};

const SEVERITY_ICON = { error: "✗", warn: "⚠", info: "ℹ" };

const CHIP_CLASS = {
  "ltc": "ok",
  "scanned-fail": "warn",
  "few-ltc-edges": "warn",
  "aperiodic": "audio",
  "level": "quiet",
  "window-level": "quiet",
  "short": "quiet",
  "skipped": "quiet",
  "unscanned": "quiet",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function channelChip(info) {
  const verdict = channelVerdict(info);
  const chip = el("span", `diag-chip ${CHIP_CLASS[verdict.code] || "quiet"}`);
  const peakText = info.peak !== undefined ? ` ${dbfs(info.peak)}dB` : "";
  chip.textContent = `${info.recordName}·ch${info.channelLabel} ${verdict.label}${verdict.code === "ltc" ? "" : peakText}`;
  chip.title = verdict.detail || verdict.label;
  return chip;
}

function issueNode(issue) {
  const node = el("div", `diag-issue ${issue.severity}`);
  node.appendChild(el("div", "diag-issue-title", `${SEVERITY_ICON[issue.severity] || "ℹ"} ${issue.title}`));
  if (issue.detail) node.appendChild(el("div", "diag-issue-detail", issue.detail));
  if (issue.suggestions?.length) {
    const list = el("ul", "diag-sugg");
    for (const suggestion of issue.suggestions) list.appendChild(el("li", "", suggestion));
    node.appendChild(list);
  }
  return node;
}

export function createDiagnosticsPanel({ els, groupLabelFor, fpsSelectLabel, samplesToTimecode }) {
  function render(reportsMap, { fpsValue } = {}) {
    const section = els.diagSection;
    const body = els.diagBody;
    if (!section || !body) return;
    if (!reportsMap || reportsMap.size === 0) {
      section.hidden = true;
      body.textContent = "";
      if (els.diagSummary) els.diagSummary.textContent = "";
      return;
    }

    const fpsLabel = fpsValue ? fpsSelectLabel?.(fpsValue) || fpsValue : "";
    const takes = buildAllDiagnostics({
      reportsMap,
      fpsValue,
      fpsLabel,
      groupLabelFor,
      samplesToTimecode,
    });

    const counts = { ok: 0, warn: 0, fail: 0, pending: 0 };
    for (const take of takes) counts[take.status] = (counts[take.status] || 0) + 1;
    if (els.diagSummary) {
      els.diagSummary.textContent = "";
      els.diagSummary.appendChild(el("span", "diag-count", `共 ${takes.length} 组`));
      for (const [key, text] of [["ok", "正常"], ["warn", "需复核"], ["fail", "失败"]]) {
        if (!counts[key]) continue;
        const chip = el("span", `diag-count ${key}`, `${{ ok: "✓", warn: "⚠", fail: "✗" }[key]} ${counts[key]} ${text}`);
        els.diagSummary.appendChild(chip);
      }
    }

    body.textContent = "";
    for (const take of takes) {
      const meta = STATUS_META[take.status] || STATUS_META.pending;
      const details = el("details", `diag-take ${take.status}`);
      details.open = take.status === "fail" || take.status === "warn";

      const summary = el("summary", "diag-take-head");
      summary.appendChild(el("span", `diag-status ${take.status}`, meta.icon));
      summary.appendChild(el("span", "diag-take-name", take.label));
      summary.appendChild(el("span", "diag-headline", take.headline));
      const issueCount = take.issues.filter(issue => issue.severity !== "info").length;
      if (issueCount) summary.appendChild(el("span", "diag-issue-count", `${issueCount} 项`));
      details.appendChild(summary);

      if (take.issues.length) {
        const issuesBox = el("div", "diag-issues");
        for (const issue of take.issues) issuesBox.appendChild(issueNode(issue));
        details.appendChild(issuesBox);
      }

      if (take.channels?.length) {
        const channelsBox = el("div", "diag-channels");
        for (const info of take.channels) channelsBox.appendChild(channelChip(info));
        details.appendChild(channelsBox);
      }

      body.appendChild(details);
    }
    const wasHidden = section.hidden;
    section.hidden = false;
    if (wasHidden) section.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  return { render };
}
