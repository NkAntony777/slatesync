export function createDialogController(els) {
  function resetAltButton() {
    els.confirmAltBtn.hidden = true;
    els.confirmAltBtn.textContent = "";
    els.confirmAltBtn.onclick = null;
  }

  function showConfirmDialog({
    title,
    copy,
    cancelText = "取消",
    confirmText = "确认",
    altText = "",
    cancelResult = false,
    confirmResult = true,
    altResult = "alt",
    danger = false,
    // 可选：强制确认勾选框的文案。提供后，确认按钮在勾选之前保持禁用——
    // 用于"必须已自行备份"这类不可跳过的提醒。
    requireAck = "",
  }) {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      let settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        els.confirmOverlay.classList.remove("show");
        els.confirmOverlay.setAttribute("aria-hidden", "true");
        els.confirmCancelBtn.removeEventListener("click", onCancel);
        els.confirmAltBtn.removeEventListener("click", onAlt);
        els.confirmWriteBtn.removeEventListener("click", onConfirm);
        els.confirmAckInput?.removeEventListener("change", onAckChange);
        if (els.confirmAckRow) els.confirmAckRow.hidden = true;
        if (els.confirmWriteBtn) els.confirmWriteBtn.disabled = false;
        document.removeEventListener("keydown", onKeydown);
        previousFocus?.focus?.();
        resolve(result);
      }

      function onCancel() {
        close(cancelResult);
      }

      function onAlt() {
        close(altResult);
      }

      function onConfirm() {
        if (els.confirmWriteBtn.disabled) return;
        close(confirmResult);
      }

      function onAckChange() {
        els.confirmWriteBtn.disabled = !els.confirmAckInput.checked;
      }

      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(cancelResult);
        }
      }

      els.confirmTitle.textContent = title;
      els.confirmCopy.innerHTML = copy;
      els.confirmCancelBtn.textContent = cancelText;
      resetAltButton();
      if (altText) {
        els.confirmAltBtn.textContent = altText;
        els.confirmAltBtn.hidden = false;
      }
      els.confirmWriteBtn.textContent = confirmText;
      els.confirmWriteBtn.classList.toggle("danger", danger);
      // 强制勾选：不勾就不给点"确认写入"。另存/取消不受影响。
      if (requireAck && els.confirmAckRow && els.confirmAckInput) {
        els.confirmAckLabel.textContent = requireAck;
        els.confirmAckInput.checked = false;
        els.confirmAckRow.hidden = false;
        els.confirmWriteBtn.disabled = true;
        els.confirmAckInput.addEventListener("change", onAckChange);
      }
      els.confirmOverlay.classList.add("show");
      els.confirmOverlay.setAttribute("aria-hidden", "false");
      els.confirmCancelBtn.addEventListener("click", onCancel);
      els.confirmAltBtn.addEventListener("click", onAlt);
      els.confirmWriteBtn.addEventListener("click", onConfirm);
      document.addEventListener("keydown", onKeydown);
      requestAnimationFrame(() => els.confirmCancelBtn.focus());
    });
  }

  function chooseMetadataFormat() {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      let settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        els.confirmOverlay.classList.remove("show");
        els.confirmOverlay.setAttribute("aria-hidden", "true");
        els.confirmCancelBtn.removeEventListener("click", onCancel);
        els.confirmAltBtn.removeEventListener("click", onAle);
        els.confirmWriteBtn.removeEventListener("click", onResolve);
        document.removeEventListener("keydown", onKeydown);
        previousFocus?.focus?.();
        resolve(result);
      }

      function onCancel() { close(null); }
      function onAle() { close("ale"); }
      function onResolve() { close("resolve"); }
      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(null);
        }
      }

      els.confirmTitle.textContent = "导出为元数据";
      els.confirmCopy.innerHTML = [
        "请选择要导出的元数据格式。",
        "<strong>Resolve CSV</strong> 适合 DaVinci Resolve 导入；<strong>ALE</strong> 适合 Avid/场记/日样交换流程。"
      ].join("<br>");
      els.confirmCancelBtn.textContent = "取消";
      els.confirmAltBtn.textContent = "ALE";
      els.confirmWriteBtn.textContent = "Resolve CSV";
      els.confirmWriteBtn.classList.remove("danger");
      els.confirmAltBtn.hidden = false;
      els.confirmOverlay.classList.add("show");
      els.confirmOverlay.setAttribute("aria-hidden", "false");
      els.confirmCancelBtn.addEventListener("click", onCancel);
      els.confirmAltBtn.addEventListener("click", onAle);
      els.confirmWriteBtn.addEventListener("click", onResolve);
      document.addEventListener("keydown", onKeydown);
      requestAnimationFrame(() => els.confirmWriteBtn.focus());
    });
  }

  return { chooseMetadataFormat, showConfirmDialog };
}
