// Clock-drift handling in the LTC decoder.
//
// The decoder carries a running observed/expected bit-period ratio and, once a
// window's correction is both statistically supported and larger than a quarter
// frame, divides the lock offset by it. Two properties matter and are pinned
// here:
//
//   1. when it engages it must actually improve the start timecode. The error it
//      removes is k * frameSamples * ppm, where k is the frame index of the lock,
//      so it only exists for a lock taken well into the file - the decoder
//      early-exits on the first high-quality lock, which normally happens inside
//      the first window, before the tracker has enough observations to vote.
//   2. when it does not have that support it must be completely inert. A wrong
//      correction is worse than none, so drift-free material has to come out
//      bit-identical to the uncorrected arithmetic.
//
// The fixture encoder below is local because it needs two things the shared
// test/ltc-encode.mjs does not provide: a *uniform* clock skew (every bit period
// in the file scaled, which is what a recorder whose sample clock differs from
// the LTC clock actually produces - encodeLtcAudio's driftPpm scales only the
// step between frames and leaves the intra-frame bit period nominal, so it is a
// frame-rate offset rather than a clock offset) and a gapped head that stops
// the decoder from forming a 12-frame run before the clock skew has had time to
// accumulate observations.

import test from "node:test";
import assert from "node:assert/strict";
import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio, ltcFrameBits, parseTc, incrementTc } from "./ltc-encode.mjs";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { readDataView } from "../src/wave.js";
import { parseFps, framesToSamples, timecodeToFrames } from "../src/timecode.js";

const VALUES = ["25"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: value => value,
});

const SAMPLE_RATE = 48000;
const FPS = 25;
const FRAME_SAMPLES = SAMPLE_RATE / FPS;
const START_TC = "01:00:00:00";
const REFERENCE = framesToSamples(timecodeToFrames(START_TC, parseFps("25")), SAMPLE_RATE, parseFps("25"));

// A gap longer than 12 frames inside every window stops consecutiveRun from ever
// completing, which is what a take with dropouts at the head looks like: valid
// LTC bit stream, no usable run, so the scan continues and the drift tracker
// keeps accumulating.
const GAP = { every: 0.8, seconds: 0.6, until: 20 };

function encodeSkewedLtc({
  durationSeconds,
  driftPpm = 0,
  amplitude = 0.5,
  gap = null,
  startTc = START_TC,
} = {}) {
  // Uniform skew: the recorder clock runs driftPpm away from the LTC clock, so
  // one LTC bit period occupies bitSamples * (1 - ppm/1e6) samples in the file.
  const bitSamples = (SAMPLE_RATE / (FPS * 80)) * (1 - driftPpm / 1e6);
  const frameStep = 80 * bitSamples;
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const data = new Float32Array(totalSamples);
  let tc = { ...parseTc(startTc), nominal: FPS, drop: false };
  let pos = 0;
  let level = 1;
  while (pos < totalSamples) {
    const time = pos / SAMPLE_RATE;
    const gapped = gap && time < gap.until && time % gap.every < gap.seconds;
    if (!gapped) {
      const bits = ltcFrameBits(tc);
      for (let bit = 0; bit < 80; bit++) {
        const cellStart = pos + bit * bitSamples;
        const mid = cellStart + bitSamples / 2;
        level = -level; // transition on the cell boundary
        for (let i = Math.round(cellStart); i < Math.round(mid) && i < totalSamples; i++) data[i] = level * amplitude;
        if (bits[bit]) level = -level; // mid-cell transition for a 1
        for (let i = Math.round(mid); i < Math.round(cellStart + bitSamples) && i < totalSamples; i++) data[i] = level * amplitude;
      }
    }
    pos += frameStep;
    tc = { ...tc, ...incrementTc(tc) };
  }
  return data;
}

async function detect(data) {
  const record = await audioRecord("drift.wav", [data]);
  return decoder.detectAuto(record, parseFps("25"), { allowSoftSync: false });
}

const frameIndexOf = timecode => {
  const { hh, mm, ss, ff } = parseTc(timecode);
  return ((hh * 60 + mm) * 60 + ss) * FPS + ff;
};
const errorOf = best => Number(BigInt(best.newTimeReference) - REFERENCE);

test("drift correction engages on a skewed recorder and removes most of the start error", async () => {
  const driftPpm = 2000;
  const auto = await detect(encodeSkewedLtc({ durationSeconds: 30, driftPpm, gap: GAP }));
  const best = auto.best;
  assert.ok(best, "expected a lock on the gapped 25fps take");

  const frameIndex = frameIndexOf(best.timecode) - frameIndexOf(START_TC);
  const uncorrectedError = frameIndex * FRAME_SAMPLES * driftPpm / 1e6;
  const error = errorOf(best);
  console.log(
    `  lock=${best.timecode} (frame ${frameIndex}) driftPpm=${best.driftPpm} ` +
    `uncorrectedError=${uncorrectedError.toFixed(0)} correctedError=${error} samples`,
  );

  // The lock has to be far enough into the file for the correction to matter.
  assert.ok(frameIndex >= 100, `lock at frame ${frameIndex} is too early to exercise the correction`);
  // The estimate tracks the applied skew (within 500 ppm of it).
  assert.ok(best.driftPpm < 0, `expected the ratio to report a fast recorder, got ${best.driftPpm}`);
  assert.ok(Math.abs(best.driftPpm + driftPpm) <= 500, `driftPpm ${best.driftPpm} is not within 500ppm of ${-driftPpm}`);
  // The correction really was applied: the offset now sits on the nominal frame
  // grid, and the offset it replaced is where the skewed clock put the frame.
  const rawOffset = best.sampleOffset * best.driftRatio;
  assert.ok(
    Math.abs(best.sampleOffset - frameIndex * FRAME_SAMPLES) <= 0.25 * FRAME_SAMPLES,
    `corrected offset ${best.sampleOffset} is not the nominal position ${frameIndex * FRAME_SAMPLES}`,
  );
  assert.ok(
    Math.abs(rawOffset - frameIndex * FRAME_SAMPLES * (1 - driftPpm / 1e6)) <= 2,
    `pre-correction offset ${rawOffset} does not match the skewed position ${frameIndex * FRAME_SAMPLES * (1 - driftPpm / 1e6)}`,
  );
  // ...and the start timecode is correspondingly closer to the truth.
  assert.ok(Math.abs(error) <= 0.15 * uncorrectedError, `corrected error ${error} vs uncorrected ${uncorrectedError.toFixed(0)}`);
  assert.ok(Math.abs(error) <= 0.1 * FRAME_SAMPLES, `corrected error ${error} is not sub-frame`);
});

test("drift-free material is decoded exactly as the uncorrected arithmetic would", async () => {
  // Same shape as the engaging case, no skew: the tracker must not invent a
  // ratio, and the offset must stay where the signal actually is.
  for (const [name, options] of [
    ["gapped head", { gap: GAP }],
    ["continuous", {}],
  ]) {
    const auto = await detect(encodeSkewedLtc({ durationSeconds: 30, ...options }));
    assert.ok(auto.best, `${name}: expected a lock`);
    assert.equal(auto.best.driftPpm, 0, `${name}: driftPpm must stay 0 without a skew`);
    assert.equal(auto.best.driftRatio, 1, `${name}: driftRatio must stay 1 without a skew`);
    assert.ok(Math.abs(errorOf(auto.best)) <= 2, `${name}: start error ${errorOf(auto.best)} samples`);
  }
});

test("a skewed recorder that locks in the first window is left uncorrected and stays sub-frame", async () => {
  // This is the case the drift correction cannot help with: the high-quality
  // lock lands in the first window, so the tracker holds fewer observations
  // than DRIFT.minWeight and reports no ratio. The residual error is the
  // uncorrected k * frameSamples * ppm term, which has to stay sub-frame here.
  const driftPpm = 3000;
  const auto = await detect(encodeSkewedLtc({ durationSeconds: 30, driftPpm }));
  const best = auto.best;
  assert.ok(best, "expected a lock");
  const frameIndex = frameIndexOf(best.timecode) - frameIndexOf(START_TC);
  const error = errorOf(best);
  console.log(`  early lock=${best.timecode} (frame ${frameIndex}) driftPpm=${best.driftPpm} error=${error} samples`);
  assert.equal(best.driftPpm, 0, "an early lock has no baseline to correct against");
  assert.ok(Math.abs(error) <= FRAME_SAMPLES, `error ${error} samples exceeds one frame`);
  assert.ok(Math.abs(error) <= 1.2 * frameIndex * FRAME_SAMPLES * driftPpm / 1e6, `error ${error} is larger than the modelled uncorrected term`);
});

test("characterisation: the shared encoder's driftPpm option leaves the correction inert", async () => {
  // test/ltc-encode.mjs scales only the step between frames, so at 2000ppm the
  // bit stream still carries nominal-length bits inside every frame; the lock
  // also happens in the first window. Both keep driftPpm at 0. Pinned so that a
  // future change to either behaviour shows up as a diff here.
  const auto = await detect(encodeLtcAudio({ fps: 25, durationSeconds: 30, amplitude: 0.5, driftPpm: 2000 }).data);
  assert.ok(auto.best, "expected a lock");
  assert.equal(auto.best.driftPpm, 0, "documented inert: no supported correction for this fixture");
  assert.ok(Math.abs(errorOf(auto.best)) <= FRAME_SAMPLES, `error ${errorOf(auto.best)} samples exceeds one frame`);
});
