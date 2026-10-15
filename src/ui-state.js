export function createUiStateController({ els }) {
  // 运行日志：定长环形缓冲（新→旧），分级着色（info/warn/error）。
  // 满了就丢最旧的——长时间批量操作也不会让 DOM 无限增长；用户可复制全文去上报问题。
  const LOG_MAX_LINES = 400;
  const logLines = []; // { time, kind, text }，新→旧

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderLog() {
    els.log.innerHTML = logLines
      .map(entry => {
        const cls = entry.kind === "error" ? "log-error" : entry.kind === "warn" ? "log-warn" : "";
        const mark = entry.kind === "error" ? " [ERROR]" : entry.kind === "warn" ? " [WARN]" : "";
        return `<span class="log-line${cls ? " " + cls : ""}">[${entry.time}]${mark} ${escapeHtml(entry.text)}</span>`;
      })
      .join("");
  }

  function setState(text, kind = "ok") {
    els.stateText.textContent = text;
    els.stateText.style.color = kind === "err" ? "var(--danger)" : kind === "warn" ? "var(--warn)" : "var(--ink)";
  }

  /**
   * 记一行日志。kind: "info" | "warn" | "error"。
   * error 级会额外弹 toast 引导用户复制日志反馈——bug 上报的最佳时机就是
   * 错误刚发生的这一刻。
   */
  function log(line, kind = "info") {
    logLines.unshift({ time: new Date().toLocaleTimeString(), kind, text: String(line) });
    if (logLines.length > LOG_MAX_LINES) logLines.length = LOG_MAX_LINES;
    renderLog();
    if (kind === "error") {
      showToast("❌ 出错了 — 点日志面板右上角「复制日志」把信息发给开发者", 6000);
    }
  }

  /** 全文导出（新→旧，与界面显示一致），供"复制日志"按钮组装上报内容。 */
  function logText() {
    return logLines
      .map(entry => {
        const mark = entry.kind === "error" ? " [ERROR]" : entry.kind === "warn" ? " [WARN]" : "";
        return `[${entry.time}]${mark} ${entry.text}`;
      })
      .join("\n");
  }

  function showToast(message, duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), duration);
  }

  function updateWriteProgress(label, fileText, done, total) {
    const ratio = total ? done / total : 0;
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    els.progressLabel.textContent = label;
    els.progressFile.textContent = fileText;
    els.progressFill.style.width = `${percent}%`;
    els.progressPct.textContent = `${percent}%`;
  }

  async function guarded(fn) {
    try {
      await fn();
    } catch (error) {
      setState("错误", "err");
      els.statusLine.textContent = error.message;
      log(error.message, "error");
    }
  }

  return {
    guarded,
    log,
    logText,
    setState,
    showToast,
    updateWriteProgress,
  };
}
