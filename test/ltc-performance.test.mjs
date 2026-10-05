// Performance regression gate for detectAuto.
//
// The frame-rate-independent hoist in src/ltc-decoder.js (prepareChannelAnalysis
// runs channelVariants once per channel instead of once per candidate frame
// rate) and the rolling 16-bit sync keys were both wall-clock wins, and neither
// is visible in any functional assertion: a decoder that goes back to
// re-conditioning the full signal per candidate frame rate still returns the
// right timecode. This file pins the cost so that regression fails here.
//
// Calibration (Node 24.12.0, Windows, 60s 48kHz mono fixtures, 9 candidate fps
// values). Best of three interleaved rounds, after the optimisation, measured on
// an idle box and again while the other test files run in parallel (which is how
// `node --test` executes this file, so that is the number that matters):
//
//                     idle     parallel   ceiling
//   clean 25fps       915 ms    1394 ms   3400 ms
//   clean 30fps      1962 ms    2496 ms   5500 ms
//   weak 25fps       1003 ms    1785 ms   4000 ms
//   voice negative   1805 ms    2770 ms   6000 ms
//
// The same fixtures measured 4761 / 6585 ms (clean 25fps / voice) before the
// optimisation, so those two ceilings also sit below the pre-change cost: a full
// return to the old per-fps conditioning path fails the gate. clean30 and weak25
// are set for runner tolerance only - their pre/post gap is narrower than their
// run-to-run spread, so no ceiling could both tolerate a loaded box and reject
// the old code on those two alone.
//
// Timing method: best of three rounds per fixture. Load on a shared CI box can
// only ever make a run slower, so the minimum is the most stable statistic to
// gate on; a median would flake on a busy runner without catching anything the
// minimum misses.

import test from "node:test";
import assert from "node:assert/strict";
import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio, encodeVoiceLike } from "./ltc-encode.mjs";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { readDataView } from "../src/wave.js";
import { parseFps } from "../src/timecode.js";

const VALUES = ["23.976", "24", "25", "29.97", "29.97df", "30", "50", "59.94", "60"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: value => value,
});

const RUNS = 3;
const CEILING = { clean25: 3400, clean30: 5500, weak25: 4000, voice: 6000 };
// A negative case that scans every frame rate must not cost disproportionately
// more than a clean one that early-exits in its first window. Both sides are
// timed in the same interleaved rounds, so the ratio is measured under identical
// machine load; observed 1.8-2.9.
const MAX_NEGATIVE_RATIO = 4;

const CASES = [
  { key: "clean25", name: "clean 25fps 60s", preferred: "25", expectLock: true, data: () => encodeLtcAudio({ fps: 25, durationSeconds: 60, amplitude: 0.5 }).data },
  { key: "clean30", name: "clean 30fps 60s", preferred: "30", expectLock: true, data: () => encodeLtcAudio({ fps: 30, durationSeconds: 60, amplitude: 0.5 }).data },
  { key: "weak25", name: "weak 25fps 60s (analysis gain)", preferred: "25", expectLock: true, data: () => encodeLtcAudio({ fps: 25, durationSeconds: 60, amplitude: 0.001 }).data },
  { key: "voice", name: "voice negative 60s", preferred: "25", expectLock: false, data: () => encodeVoiceLike({ sampleRate: 48000, durationSeconds: 60, amplitude: 0.2 }) },
];

// Interleaved rounds: every case is timed once per round instead of draining one
// fixture before the next, so no single case is penalised by the heap state the
// previous ones left behind.
const records = new Map();
for (const testCase of CASES) records.set(testCase.key, await audioRecord(`${testCase.key}.wav`, [testCase.data()]));
const measurements = new Map(CASES.map(testCase => [testCase.key, { samples: [], lock: null }]));
for (let round = 0; round < RUNS; round++) {
  for (const testCase of CASES) {
    const start = performance.now();
    const auto = await decoder.detectAuto(records.get(testCase.key), parseFps(testCase.preferred), { allowSoftSync: false });
    const entry = measurements.get(testCase.key);
    entry.samples.push(performance.now() - start);
    entry.lock = auto.best ? `${auto.best.timecode}@${auto.best.fpsValue}/${auto.best.qualityLabel}` : null;
  }
}
for (const entry of measurements.values()) {
  entry.best = Math.min(...entry.samples);
  entry.samples = entry.samples.map(value => Math.round(value));
}

for (const testCase of CASES) {
  test(`detectAuto stays under ${CEILING[testCase.key]}ms: ${testCase.name}`, () => {
    const measurement = measurements.get(testCase.key);
    const summary = `${testCase.name} runs=${measurement.samples.join("/")}ms lock=${measurement.lock}`;
    if (testCase.expectLock) {
      assert.ok(measurement.lock, `${summary}: fixture must still lock, otherwise the timing is meaningless`);
    } else {
      assert.equal(measurement.lock, null, `${summary}: negative material must stay rejected`);
    }
    assert.ok(measurement.best <= CEILING[testCase.key], `${summary}: best ${measurement.best}ms exceeds ceiling ${CEILING[testCase.key]}ms`);
  });
}

test("negative material does not cost disproportionately more than a clean lock", () => {
  const clean = measurements.get("clean25").best;
  const negative = measurements.get("voice").best;
  const ratio = negative / clean;
  console.log(`  clean25=${clean}ms voice=${negative}ms ratio=${ratio.toFixed(2)} (limit ${MAX_NEGATIVE_RATIO})`);
  assert.ok(ratio <= MAX_NEGATIVE_RATIO, `voice/clean ratio ${ratio.toFixed(2)} exceeds ${MAX_NEGATIVE_RATIO} (clean=${clean}ms voice=${negative}ms)`);
});

test("performance gate calibration", () => {
  for (const testCase of CASES) {
    const measurement = measurements.get(testCase.key);
    console.log(`  ${testCase.key.padEnd(9)} ${measurement.samples.join(" / ")} ms  (ceiling ${CEILING[testCase.key]}ms, headroom ${(CEILING[testCase.key] / measurement.best).toFixed(2)}x)`);
  }
  assert.equal(RUNS, 3);
});
