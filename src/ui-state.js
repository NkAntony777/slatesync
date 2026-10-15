export function createUiStateController({ els }) {
  // 运行日志：定长环形缓冲（新→旧）。满了就丢最旧的——长时间批量操作也不会
  // 让 DOM 无限增长；用户可复制全文去上报问题。
  const LOG_MAX_LINES = 400;
  const logLines = [];

  function setState(text, kind = "ok") {
    els.stateText.textContent = text;
    els.stateText.style.color = kind === "err" ? "var(--danger)" : kind === "warn" ? "var(--warn)" : "var(--ink)";
  }

  function log(line) {
    logLines.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (logLines.length > LOG_MAX_LINES) logLines.length = LOG_MAX_LINES;
    els.log.textContent = logLines.join("\n");
  }

  /** 全文导出（新→旧，与界面显示一致），供"复制日志"按钮组装上报内容。 */
  function logText() {
    return logLines.join("\n");
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
      log(`ERROR: ${error.message}`);
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
