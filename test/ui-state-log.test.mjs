// 运行日志环形缓冲、分级着色与一键导出内容的回归测试。
import test from "node:test";
import assert from "node:assert/strict";

import { createUiStateController } from "../src/ui-state.js";

function makeUi() {
  const els = {
    stateText: { textContent: "", style: {} },
    statusLine: { textContent: "" },
    toast: { textContent: "", classList: { add() {}, remove() {} } },
  };
  // 模拟真实 DOM：textContent 由子节点（innerHTML）派生。
  const logEl = { innerHTML: "", classList: { add() {}, remove() {} } };
  Object.defineProperty(logEl, "textContent", {
    get() { return this.innerHTML.replace(/<[^>]+>/g, ""); },
  });
  els.log = logEl;
  return { ui: createUiStateController({ els }), els };
}

test("log keeps the newest lines and renders newest-first", () => {
  const { ui, els } = makeUi();
  for (let i = 1; i <= 10; i++) ui.log(`line ${i}`);
  assert.match(els.log.textContent, /line 10.*line 9.*line 1/s, "newest first, all 10 present");
  assert.match(els.log.textContent, /^\[[^\]]+\] line 10/, "entries are time-stamped");
});

test("log buffer is bounded: oldest lines are dropped beyond 400", () => {
  const { ui, els } = makeUi();
  for (let i = 1; i <= 450; i++) ui.log(`line ${i}`);
  assert.match(els.log.textContent, /line 450/);
  assert.doesNotMatch(els.log.textContent, /line 50[^\d]/, "line 50 and older must be dropped");
  assert.match(els.log.textContent, /line 51$/, "line 51 is the oldest survivor (450-400+1)");
});

test("logText exports every buffered entry in display order", () => {
  const { ui, els } = makeUi();
  ui.log("alpha");
  ui.log("beta");
  const exported = ui.logText();
  const rendered = els.log.textContent;
  for (const line of exported.split("\n")) {
    const body = line.replace(/^\[[^\]]+\]( \[(WARN|ERROR)\])? /, "");
    assert.ok(rendered.includes(body), `rendered log must contain: ${body}`);
  }
  assert.ok(rendered.indexOf("beta") < rendered.indexOf("alpha"), "newest-first order preserved");
});

test("warn/error kinds are colored and marked in both render and export", () => {
  const { ui, els } = makeUi();
  ui.log("普通信息");
  ui.log("注意级", "warn");
  ui.log("错误级", "error");
  assert.match(els.log.innerHTML, /log-line log-warn[^>]*>[^<]*注意级/, "warn line carries warn class");
  assert.match(els.log.innerHTML, /log-line log-error[^>]*>[^<]*错误级/, "error line carries error class");
  assert.doesNotMatch(els.log.innerHTML, /log-warn[^>]*>[^<]*普通信息/, "info line is not marked warn");
  assert.match(ui.logText(), /\[WARN\] 注意级/);
  assert.match(ui.logText(), /\[ERROR\] 错误级/);
  assert.doesNotMatch(ui.logText(), /\[WARN\] 普通信息/, "info lines carry no level mark");
});

test("log entries are HTML-escaped against file names and user data", () => {
  const { ui, els } = makeUi();
  ui.log(`导入 <img src=x onerror=alert(1)> & "quoted" <script>`);
  assert.doesNotMatch(els.log.innerHTML, /<img/);
  assert.match(els.log.innerHTML, /&lt;img/);
  assert.match(els.log.innerHTML, /&quot;quoted&quot;/);
  assert.match(ui.logText(), /<img src=x/, "export keeps the raw text for readability");
});

test("error-level log pops the bug-report guidance toast", () => {
  const { ui, els } = makeUi();
  let timers = 0;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers += 1; return originalSetTimeout(fn, 1); };
  try {
    ui.log("崩了", "error");
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  assert.match(els.toast.textContent, /复制日志/);
  assert.ok(timers > 0, "toast auto-dismiss timer armed");
});

test("guarded surfaces errors as error-level log entries", async () => {
  const { ui, els } = makeUi();
  await ui.guarded(async () => { throw new Error("boom"); });
  assert.equal(els.stateText.textContent, "错误");
  assert.match(els.statusLine.textContent, /boom/);
  assert.match(ui.logText(), /\[ERROR\] boom/);
});

test("updateWriteProgress clamps percent and tolerates unknown totals", () => {
  const { ui, els } = makeUi();
  els.progressLabel = { textContent: "" };
  els.progressFile = { textContent: "" };
  els.progressFill = { style: {} };
  els.progressPct = { textContent: "" };
  ui.updateWriteProgress("写入", "a.wav", 3, 4);
  assert.equal(els.progressPct.textContent, "75%");
  ui.updateWriteProgress("写入", "a.wav", 9, 4);
  assert.equal(els.progressPct.textContent, "100%", "clamped at 100%");
  ui.updateWriteProgress("写入", "a.wav", 0, 0);
  assert.equal(els.progressPct.textContent, "0%", "total=0 does not produce NaN");
});
