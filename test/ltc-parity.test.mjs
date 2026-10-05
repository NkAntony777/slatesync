// Differential fuzz: the main-thread decoder and the hand-maintained Worker copy
// in src/ltc-worker.js (LTC_WORKER_CODE) must stay bit-identical.
//
// src/ltc-worker.js inlines a second copy of the whole decoder -- the rolling
// 16-bit sync keys, the per-channel `prepared` analysis hoist and the
// `driftRatio` plumbing were each added twice by hand. Any edit that lands in
// only one copy changes decode results in a Worker run and nothing in a
// main-thread run, which is exactly the class of bug no single-threaded test
// can see. This file drives the same fixture through both paths and compares
// the reported lock field by field.
//
// Matrix: every candidate frame rate x three amplitudes (clean / marginal /
// sub-quantisation) x rotating start delays x drop-frame on and off, plus the
// five negative materials. Cases are generated from a fixed seed so a failure
// reproduces exactly; rerun with the printed seed to isolate one case.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio, encodeVoiceLike } from "./ltc-encode.mjs";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { LTC_WORKER_CODE } from "../src/ltc-worker.js";
import { readDataView } from "../src/wave.js";
import { parseFps, framesToSamples, timecodeToFrames, fpsRate } from "../src/timecode.js";

const SEED = 0x5c1a7e;
const VALUES = ["23.976", "24", "25", "29.97", "29.97df", "30", "50", "59.94", "60"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: value => value,
});

// mulberry32: small, fast, and reproducible from the seed alone.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function detectBoth(record, preferred, allowSoftSync = false) {
  // The Worker must receive the same candidate order the main thread builds for
  // itself, which is what src/ltc-controller.js does before calling the pool:
  // preferred first, then the rest. Handing the Worker the raw list changes
  // which fps value wins a tie (29.97 vs 29.97df) and makes the two paths
  // disagree for reasons that have nothing to do with the duplicated decoder.
  const values = [preferred, ...VALUES.filter(value => value !== preferred)];
  const main = await decoder.detectAuto(record, parseFps(preferred), { allowSoftSync });
  let message;
  const context = vm.createContext({
    self: { postMessage: result => { message = result; } },
    Float32Array, DataView, Math, BigInt, Number, String, Set, Map, Array,
  });
  vm.runInContext(LTC_WORKER_CODE, context);
  const buffer = await record.file.slice(record.dataOffset, record.dataOffset + record.dataSize).arrayBuffer();
  context.self.onmessage({
    data: {
      id: 1,
      buffer,
      record: {
        sampleRate: record.sampleRate, channels: record.channels,
        bitsPerSample: record.bitsPerSample, audioFormat: record.audioFormat,
        isFloat: record.isFloat, blockAlign: record.blockAlign,
      },
      preferredValue: preferred,
      values,
      allowSoftSync,
    },
  });
  assert.equal(message.ok, true, message.error);
  return [main, message.result];
}

function reference(value, startTc, delaySeconds, sampleRate = 48000) {
  const fps = parseFps(value);
  return framesToSamples(timecodeToFrames(startTc, fps), sampleRate, fps) - BigInt(Math.round(delaySeconds * sampleRate));
}

// Field-by-field parity. The Worker serialises BigInt fields to strings, so
// every comparison below normalises through BigInt/String first.
function assertParity(main, worker, label) {
  if (!main.best || !worker.best) {
    assert.equal(Boolean(main.best), Boolean(worker.best), `${label}: one side has no lock`);
    assert.equal(main.best, worker.best, `${label}: one side has no lock`);
    return;
  }
  assert.equal(worker.best.timecode, main.best.timecode, `${label}: timecode`);
  assert.equal(String(worker.best.newTimeReference), String(main.best.newTimeReference), `${label}: newTimeReference`);
  assert.equal(worker.best.fpsValue, main.best.fpsValue, `${label}: fpsValue`);
  assert.equal(worker.best.lockedFrames, main.best.lockedFrames, `${label}: lockedFrames`);
  assert.ok(
    Math.abs(worker.best.halfBitError - main.best.halfBitError) <= 1e-12,
    `${label}: halfBitError ${main.best.halfBitError} vs ${worker.best.halfBitError}`,
  );
  assert.equal(worker.best.driftPpm, main.best.driftPpm, `${label}: driftPpm`);
  // The correction itself, not just the reported number.
  assert.equal(worker.best.sampleOffset, main.best.sampleOffset, `${label}: sampleOffset`);
  assert.equal(worker.best.driftRatio, main.best.driftRatio, `${label}: driftRatio`);
  assert.equal(worker.best.qualityRank, main.best.qualityRank, `${label}: qualityRank`);
  assert.equal(worker.best.conditionProfile, main.best.conditionProfile, `${label}: conditionProfile`);
  assert.equal(main.results.length, worker.results.length, `${label}: candidate count`);
  for (const field of ["fpsValue", "lockedFrames", "qualityRank", "sampleOffset", "driftPpm", "driftRatio"]) {
    for (let i = 0; i < main.results.length; i++) {
      assert.equal(worker.results[i][field], main.results[i][field], `${label}: results[${i}].${field}`);
    }
  }
}

// ---------------------------------------------------------------- positive matrix
const FPS_CASES = [
  { value: "23.976", rate: 24000 / 1001, nominal: 24, drop: false },
  { value: "24", rate: 24, nominal: 24, drop: false },
  { value: "25", rate: 25, nominal: 25, drop: false },
  { value: "29.97", rate: 30000 / 1001, nominal: 30, drop: false },
  { value: "29.97df", rate: 30000 / 1001, nominal: 30, drop: true },
  { value: "30", rate: 30, nominal: 30, drop: false },
  { value: "50", rate: 50, nominal: 50, drop: false },
  { value: "59.94", rate: 60000 / 1001, nominal: 60, drop: false },
  { value: "60", rate: 60, nominal: 60, drop: false },
];
const AMPLITUDES = [0.5, 0.002, 0.00003];
const DELAYS = [0, 0.35, 1];
const START_TC = "01:00:00:00";

// Full fps x amplitude cross product, with the delay axis rotated by the seeded
// PRNG so every delay is exercised without paying 3x for it.
const positiveCases = (() => {
  const random = mulberry32(SEED);
  const cases = [];
  for (const spec of FPS_CASES) {
    for (const amplitude of AMPLITUDES) {
      const delay = DELAYS[Math.floor(random() * DELAYS.length)];
      cases.push({ ...spec, amplitude, delay, dropFlip: false, float: false });
    }
  }
  // Drop-flag mismatches: the strict pass rejects every frame, the retry locks
  // with dropMismatch set. Both copies must agree on that fallback too.
  cases.push({ ...FPS_CASES[3], amplitude: 0.5, delay: 0, dropFlip: true, float: false });
  cases.push({ ...FPS_CASES[4], amplitude: 0.002, delay: 0.35, dropFlip: true, float: false });
  // Float32 PCM path (readAudioSample branch differs from integer PCM).
  cases.push({ ...FPS_CASES[2], amplitude: 0.00001, delay: 0, dropFlip: false, float: true });
  return cases;
})();

for (const spec of positiveCases) {
  const drop = spec.dropFlip ? !spec.drop : spec.drop;
  const label = `${spec.value} amp=${spec.amplitude} delay=${spec.delay}s drop=${drop}${spec.dropFlip ? " (mismatch)" : ""}${spec.float ? " float32" : ""}`;
  test(`parity: ${label}`, async () => {
    const { data } = encodeLtcAudio({
      fps: spec.rate, nominalFps: spec.nominal, startTc: START_TC,
      durationSeconds: 2, amplitude: spec.amplitude, startDelaySeconds: spec.delay, drop,
    });
    const record = await audioRecord("parity.wav", [data], spec.float ? { bits: 32, float: true } : {});
    const [main, worker] = await detectBoth(record, spec.value);
    assertParity(main, worker, label);
    assert.ok(main.best, `${label}: expected a lock`);
    assert.equal(main.best.fpsValue, spec.value, `${label}: fpsValue`);
    assert.equal(Boolean(main.best.dropMismatch), Boolean(spec.dropFlip), `${label}: dropMismatch flag`);
    const frameSamples = 48000 / (Number(fpsRate(parseFps(spec.value)).n) / Number(fpsRate(parseFps(spec.value)).d));
    const error = Math.abs(Number(BigInt(main.best.newTimeReference) - reference(spec.value, START_TC, spec.delay)));
    assert.ok(error <= 2 * frameSamples, `${label}: start error ${error} samples exceeds two frames`);
  });
}

// ---------------------------------------------------------------- negatives
const NEGATIVES = [
  { kind: "silence", data: () => new Float32Array(48000) },
  { kind: "voice", data: () => encodeVoiceLike({ sampleRate: 48000, durationSeconds: 1, amplitude: 0.2 }) },
  { kind: "voice-quiet", data: () => encodeVoiceLike({ sampleRate: 48000, durationSeconds: 1, amplitude: 0.0003 }) },
  { kind: "white-noise", data: () => noise(48000, 0.001, 713) },
  { kind: "sine", data: () => sine(48000, 1000, 0.001) },
  { kind: "sub-quantization-ltc", data: () => encodeLtcAudio({ durationSeconds: 1, amplitude: 0.000001 }).data },
];

function noise(length, amplitude, seed) {
  const data = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = (state / 4294967296 - 0.5) * amplitude;
  }
  return data;
}
function sine(length, hz, amplitude) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin((i * 2 * Math.PI * hz) / 48000) * amplitude;
  return data;
}

for (const negative of NEGATIVES) {
  for (const allowSoftSync of [false, true]) {
    test(`parity negative: ${negative.kind} (softSync=${allowSoftSync})`, async () => {
      const record = await audioRecord("negative.wav", [negative.data()]);
      const [main, worker] = await detectBoth(record, "25", allowSoftSync);
      assertParity(main, worker, `${negative.kind}/${allowSoftSync}`);
      assert.equal(main.best, null, `${negative.kind}: must not be accepted as LTC`);
      assert.equal(worker.best, null, `${negative.kind}: worker must not be accepted as LTC`);
    });
  }
}

test("parity matrix summary", () => {
  console.log(`  parity matrix: ${positiveCases.length} lock cases + ${NEGATIVES.length * 2} negative cases, seed=0x${SEED.toString(16)}`);
  assert.equal(positiveCases.length, 30);
  assert.equal(NEGATIVES.length, 6);
});
