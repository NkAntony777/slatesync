// 运行日志环形缓冲与一键导出内容的回归测试。
import test from "node:test";
import assert from "node:assert/strict";

import { createUiStateController } from "../src/ui-state.js";

function makeUi() {
  const els = {
    stateText: { textContent: "", style: {} },
    log: { textContent: "" },
    toast: { textContent: "", classList: { add() {}, remove() {} } },
  };
  return { ui: createUiStateController({ els }), els };
}

test("log keeps the newest lines and renders newest-first", () => {
  const { ui, els } = makeUi();
  for (let i = 1; i <= 10; i++) ui.log(`line ${i}`);
  assert.match(els.log.textContent, /line 10.*line 9.*line 1/s, "newest first, all 10 present");
  assert.match(els.log.textContent, /^\[[^\]]+\] line 10/m, "entries are time-stamped");
});

test("log buffer is bounded: oldest lines are dropped beyond 400", () => {
  const { ui, els } = makeUi();
  for (let i = 1; i <= 450; i++) ui.log(`line ${i}`);
  assert.match(els.log.textContent, /line 450/);
  assert.doesNotMatch(els.log.textContent, /line 50[^\d]/, "line 50 and older must be dropped");
  assert.match(els.log.textContent, /line 51$/m, "line 51 is the oldest survivor (450-400+1)");
});

test("logText returns the full buffered log matching the on-screen content", () => {
  const { ui, els } = makeUi();
  ui.log("alpha");
  ui.log("beta");
  assert.equal(ui.logText(), els.log.textContent);
  assert.match(ui.logText(), /beta.*alpha/s);
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
