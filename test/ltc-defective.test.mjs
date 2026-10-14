// 缺陷/受损 LTC 的读取回归。字段反馈核心诉求：解码器必须能跨过坏帧锁定、
// 容忍硬削波，且微弱信号不再需要用户去点隐藏的兜底按钮（自动兜底重试的
// 判定函数在此单测）。错锁纪律不放松（docs/LTC识别强化方案.md §4.1/§6）：
// 桥接只允许端点解析干净、时码递增精确的 run，桥接帧不计入 lockedFrames。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio, ltcFrameBits, applyLtcParity } from "./ltc-encode.mjs";
import { createLtcDecoder, ltcFrameParityOk } from "../src/ltc-decoder.js";
import { shouldAutoSoftRetry } from "../src/ltc-controller.js";
import { LTC_WORKER_CODE } from "../src/ltc-worker.js";
import { readDataView } from "../src/wave.js";
import { parseFps, framesToSamples, timecodeToFrames } from "../src/timecode.js";

const VALUES = ["23.976", "24", "25", "29.97", "29.97df", "30"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: value => value,
});

async function detectBoth(record, preferred = "25", allowSoftSync = false) {
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
      values: [preferred, ...VALUES.filter(value => value !== preferred)],
      allowSoftSync,
    },
  });
  assert.equal(message.ok, true, message.error);
  return [main, message.result];
}

// 把一帧每个 bit cell 的中段清零，只留 cell 交界的小段波形。边沿路径会把该
// 帧解成 80 个 0 位：同步字必挂（帧不可解析），但位流不错位、后续帧仍落在
// 80 位网格上——这是"受损但占位"的缺陷帧，正是桥接要跨过的类型。
function corruptFrame(data, frameStartSample, bitSamples) {
  for (let b = 0; b < 80; b++) {
    const from = Math.round(frameStartSample + (b + 0.15) * bitSamples);
    const to = Math.round(frameStartSample + (b + 0.85) * bitSamples);
    for (let i = from; i < to && i < data.length; i++) {
      if (i >= 0) data[i] = 0;
    }
  }
}

function encodedCorrupt({ value, fps, nominal, drop, corruptIndexes, durationSeconds }) {
  const encoded = encodeLtcAudio({
    fps, nominalFps: nominal, startTc: "01:23:45:00",
    durationSeconds, amplitude: 0.3, drop,
  });
  const starts = [...encoded.frameStarts.values()].sort((a, b) => a - b);
  for (const index of corruptIndexes) corruptFrame(encoded.data, starts[index], encoded.bitSamples);
  return encoded;
}

const START_TC = "01:23:45:00";
const FPS_SPECS = [
  { value: "25", fps: 25, nominal: 25, drop: false },
  { value: "29.97df", fps: 30000 / 1001, nominal: 30, drop: true },
];

for (const spec of FPS_SPECS) {
  const fps = parseFps(spec.value);
  const expected = framesToSamples(timecodeToFrames(START_TC, fps), 48000, fps);

  test(`defective: 1 corrupt frame mid-take still locks exactly (${spec.value})`, async () => {
    const { data } = encodedCorrupt({ ...spec, durationSeconds: 6, corruptIndexes: [2] });
    const record = await audioRecord("defective-1.wav", [data]);
    const both = await detectBoth(record, spec.value);
    for (const auto of both) {
      assert.ok(auto.best, `${spec.value}: corrupt frame must not break the lock`);
      assert.equal(auto.best.fpsValue, spec.value);
      assert.equal(Boolean(auto.best.softSync), false, `${spec.value}: hard path lock expected`);
      assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference) - expected)) <= 2,
        `${spec.value}: ${auto.best.timecode} is not the exact start reference`);
    }
    assert.equal(BigInt(both[1].best.newTimeReference), BigInt(both[0].best.newTimeReference));
  });

  test(`defective: 2 non-adjacent corrupt frames still lock exactly (${spec.value})`, async () => {
    const { data } = encodedCorrupt({ ...spec, durationSeconds: 6, corruptIndexes: [2, 6] });
    const record = await audioRecord("defective-2.wav", [data]);
    const both = await detectBoth(record, spec.value);
    for (const auto of both) {
      assert.ok(auto.best, `${spec.value}: two corrupt frames must not break the lock`);
      assert.equal(auto.best.fpsValue, spec.value);
      assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference) - expected)) <= 2,
        `${spec.value}: ${auto.best.timecode} is not the exact start reference`);
    }
    assert.equal(BigInt(both[1].best.newTimeReference), BigInt(both[0].best.newTimeReference));
  });
}

test("defective: bridged run wins on a short take and worker mirrors it", async () => {
  // 0.5 s ≈ 12 帧：坏帧之后凑不满 12 帧干净 run，桥接 run（真实帧更多）胜出。
  // 这是唯一一种桥接候选会成为 best 的情形，用来在端到端层面钉住桥接路径
  // 在主线程与 Worker 副本里同时生效。
  const fps = parseFps("25");
  const expected = framesToSamples(timecodeToFrames(START_TC, fps), 48000, fps);
  const { data } = encodedCorrupt({ value: "25", fps: 25, nominal: 25, drop: false, durationSeconds: 0.5, corruptIndexes: [2] });
  const record = await audioRecord("defective-bridge.wav", [data]);
  const both = await detectBoth(record, "25");
  for (const auto of both) {
    assert.ok(auto.best, "short defective take must still lock");
    assert.ok(auto.best.bridgedFrames >= 1, `bridging must engage, got ${auto.best.bridgedFrames}`);
    assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference) - expected)) <= 2,
      `${auto.best.timecode} is not the exact start reference`);
  }
  assert.equal(both[1].best.bridgedFrames, both[0].best.bridgedFrames, "worker must mirror bridgedFrames");
  assert.equal(BigInt(both[1].best.newTimeReference), BigInt(both[0].best.newTimeReference));
});

test("defective: hard-clipped LTC still locks exactly", async () => {
  const fps = parseFps("25");
  const expected = framesToSamples(timecodeToFrames(START_TC, fps), 48000, fps);
  const { data } = encodeLtcAudio({ startTc: START_TC, durationSeconds: 6, amplitude: 0.3 });
  const clip = 0.3 * 0.3; // ±0.09：远低于 0.3 幅度，削平大部分波形
  for (let i = 0; i < data.length; i++) data[i] = Math.max(-clip, Math.min(clip, data[i]));
  const record = await audioRecord("defective-clip.wav", [data]);
  const both = await detectBoth(record, "25");
  for (const auto of both) {
    assert.ok(auto.best, "clipped LTC must still lock");
    assert.equal(auto.best.fpsValue, "25");
    assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference) - expected)) <= 2,
      `${auto.best.timecode} is not the exact start reference`);
  }
});

// 桥接的单元级钉扎：端到端下干净 run 总是优先于桥接 run（这是对的——干净
// 证据更强），所以桥接机制本身在 consecutiveRun 层面验证。
async function decodeFirstFrames(spec, corruptIndexes) {
  const { data } = encodedCorrupt({ ...spec, durationSeconds: 6, corruptIndexes });
  const record = await audioRecord("defective-unit.wav", [data]);
  const channel = await decoder.readChannel(record, 0);
  const fpsValue = Number(spec.fps);
  const expectedHalf = 48000 / (fpsValue * 80 * 2);
  const window = decoder.channelWindows(channel, 48000)[0];
  const edges = decoder.findEdges(window, expectedHalf);
  const decoded = decoder.decodeBits(edges, expectedHalf);
  const fps = parseFps(spec.value);
  let firstIndex = -1;
  for (let i = 0; i + 80 <= decoded.bits.length; i++) {
    if (decoder.frameAt(decoded, i, fps)) { firstIndex = i; break; }
  }
  assert.notEqual(firstIndex, -1, "fixture must contain one parseable frame");
  return { decoded, fps, firstIndex };
}

test("bridging: consecutiveRun steps over a parity-plausible corrupt frame", async () => {
  const spec = FPS_SPECS[0];
  const { decoded, fps, firstIndex } = await decodeFirstFrames(spec, [2]);
  const corruptSlice = decoded.bits.slice(firstIndex + 80, firstIndex + 160);
  assert.equal(ltcFrameParityOk(corruptSlice, fps), true, "zeroed frame is even-parity: bridgeable at 25 fps");
  const run = decoder.consecutiveRun(decoded, firstIndex, fps);
  assert.equal(run.bridgedFrames, 1, `expected one bridged frame, got ${run.bridgedFrames}`);
  // 端点时码必须精确自洽：01 → 03（跨过坏帧 02）→ 04 → ...，坏帧不占 lockedFrames。
  assert.deepEqual(run.frames.map(frame => frame.timecode), [
    "01:23:45:01", "01:23:45:03", "01:23:45:04", "01:23:45:05", "01:23:45:06",
    "01:23:45:07", "01:23:45:08", "01:23:45:09", "01:23:45:10", "01:23:45:11",
    "01:23:45:12",
  ]);
});

test("bridging: ST 12-1 parity veto stops bridges across definitely-bad gaps", async () => {
  const spec = FPS_SPECS[1];
  const { decoded, fps, firstIndex } = await decodeFirstFrames(spec, [2]);
  const corruptSlice = decoded.bits.slice(firstIndex + 80, firstIndex + 160);
  assert.equal(ltcFrameParityOk(corruptSlice, fps), false, "zeroed frame is even but 29.97df requires odd: veto");
  const run = decoder.consecutiveRun(decoded, firstIndex, fps);
  assert.equal(run.bridgedFrames, 0, "parity-vetoed gap must not be bridged");
  assert.equal(run.frames.length, 1, "run must stop at the vetoed gap");
});

test("bridging: bridged candidates are never definitive-tier", () => {
  const clean = { qualityRank: 3, lockedFrames: 12, halfBitError: 0, rejectRatio: 0, confidence: 0.99, bridgedFrames: 0 };
  const bridged = { ...clean, bridgedFrames: 1 };
  assert.equal(decoder.isDefinitiveCandidate(clean), true, "clean run stays definitive");
  assert.equal(decoder.isDefinitiveCandidate(bridged), false, "bridged run must stay below definitive");
  assert.equal(decoder.isHighQualityCandidate(bridged), true, "bridging is only capped, not downgraded");
});

test("parity: ST 12-1 helper accepts encoder frames and rejects one-bit flips", () => {
  const fps25 = parseFps("25");
  const fps30 = parseFps("30");
  const fpsDf = parseFps("29.97df");
  const frame25 = applyLtcParity(ltcFrameBits({ hh: 1, mm: 23, ss: 45, ff: 0 }), 25);
  assert.equal(ltcFrameParityOk(frame25, fps25), true, "encoder-produced 25fps frame must pass");
  const flipped25 = frame25.slice();
  flipped25[3] ^= 1;
  assert.equal(ltcFrameParityOk(flipped25, fps25), false, "one arbitrary data-bit flip must fail");
  const frame30 = applyLtcParity(ltcFrameBits({ hh: 1, mm: 23, ss: 45, ff: 0 }), 30);
  assert.equal(ltcFrameParityOk(frame30, fps30), true, "encoder-produced 30fps frame must pass");
  const flipped30 = frame30.slice();
  flipped30[41] ^= 1;
  assert.equal(ltcFrameParityOk(flipped30, fps30), false);
  const frameDf = applyLtcParity(ltcFrameBits({ hh: 1, mm: 23, ss: 45, ff: 0, drop: true }), 30);
  assert.equal(ltcFrameParityOk(frameDf, fpsDf), true, "DF frame uses bit 59 like every non-25 rate");
  assert.equal(ltcFrameParityOk(frame25.slice(0, 79), fps25), null, "fewer than 80 bits is unknown, not a failure");
});

test("auto soft retry: only recoverable failure classes are retried", () => {
  // 接近静音：没有信号能量，增强识别无米下锅——不重试。
  assert.equal(shouldAutoSoftRetry([{ channelReports: [{ peak: 0 }] }]), false);
  // 扫描出错：文件/读取问题，重试无意义——不重试。
  assert.equal(shouldAutoSoftRetry([{ channelReports: [{ peak: 0.3 }] }], new Error("bad wav")), false);
  // 没有任何扫描记录：无从判断——不重试。
  assert.equal(shouldAutoSoftRetry([]), false);
  assert.equal(shouldAutoSoftRetry(null), false);
  // 低电平/非周期/无锁定：信号存在但常规路径锁不住——自动兜底值得试。
  assert.equal(shouldAutoSoftRetry([{ channelReports: [{ peak: 0.002 }] }]), true);
  assert.equal(shouldAutoSoftRetry([{ channelReports: [{ peak: 0.2, rejectReason: "aperiodic" }] }]), true);
  assert.equal(shouldAutoSoftRetry([{ channelReports: [{ peak: 0.3, rejectReason: null }] }]), true);
  // fast + full 多轮合并判断：任一记录失败类别可救即重试。
  assert.equal(shouldAutoSoftRetry([
    { channelReports: [{ peak: 0.3, rejectReason: "aperiodic" }] },
    { channelReports: [{ peak: 0.3 }] },
  ]), true);
});
