// 房间声补白与等功率交叉淡化在写入层的落地（src/wave-combine.js 的 repair 通道）
//
// 两条契约在这里锁死：
// 1. 默认关闭。补白在没开房间声时仍然是数字静音，开着交叉淡化时仍然只改接缝那一小段。
//    "没勾 = 与改动前逐字节相同"是仓库对所有会改音频的开关的共同要求。
// 2. 亚采样偏移真的被用上了。原来纯偏移（driftRatio === 1）的小数部分会被取整丢掉，
//    这里用"插值结果严格落在两个源采样之间"来证明它确实参与了取样。

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord, MemoryWritable } from "./helpers.mjs";
import { readAudioSample } from "../src/wave-audio.js";
import { scanWave } from "../src/wave.js";
import { combineRepairKey, writeCombinedPolyToWritable } from "../src/wave-combine.js";

const ramp = length => Float32Array.from({ length }, (_, index) => index / 4096);
const constant = (length, value) => new Float32Array(length).fill(value);
const sine = (length, amplitude, frequencyHz, sampleRate = 48000) =>
  Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequencyHz * index / sampleRate));

const keyOf = record => combineRepairKey({ record, channelIndex: 0 });

// 计划形状照抄真实字段名：写入层吃的就是这些字段。
const plan = ({
  leadSamples = 0,
  skipSamples = 0,
  driftRatio = 1,
  polarity = 1,
  trimSamples = 0,
  leadExact,
  leadFraction,
  contentStart,
  contentEnd,
  roomTone,
} = {}) => {
  const exact = leadExact ?? leadSamples;
  return {
    startSamples: -leadSamples,
    leadSamples,
    leadExact: exact,
    leadFraction: leadFraction ?? exact - leadSamples,
    skipSamples: Math.max(0, skipSamples),
    padSamples: Math.max(0, leadSamples),
    driftRatio,
    polarity,
    trimSamples,
    ...(contentStart === undefined ? {} : { contentStart }),
    ...(contentEnd === undefined ? {} : { contentEnd }),
    ...(roomTone ? { roomTone } : {}),
    needsResample: Math.abs(driftRatio - 1) > 1e-5,
    needsOffset: Math.abs(leadSamples) > 0.5,
  };
};

async function combine(records, options = {}) {
  const writable = new MemoryWritable();
  const result = await writeCombinedPolyToWritable("TAKE01", records, writable, "test_Poly.WAV", {
    profile: "archive", fallbackFpsValue: "25", ...options,
  });
  const file = new File([writable.bytes], "test_Poly.WAV");
  const parsed = await scanWave({ getFile: async () => file });
  const view = new DataView(await file.slice(parsed.dataOffset).arrayBuffer());
  const sample = (frame, channel) => readAudioSample(view, frame * parsed.blockAlign + channel * (parsed.blockAlign / parsed.channels), parsed);
  return { result, parsed, bytes: writable.bytes, sample, view };
}

// 晚开机 late 个采样：target 是 reference 去掉开头的切片，输出长度仍取参考轨。
async function lateTake(frames, late, target) {
  const reference = ramp(frames);
  const second = target ?? reference.subarray(late);
  return Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [reference]),
    audioRecord("TAKE01_Tr2.WAV", [second]),
  ]);
}

test("W1 补白默认仍是数字静音：没开房间声时补白区必须逐字节为 0", async () => {
  const frames = 512, late = 96;
  const records = await lateTake(frames, late);
  const { sample } = await combine(records, {
    repair: {
      enabled: true,
      referenceKey: keyOf(records[0]),
      outputSamples: frames,
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  for (let frame = 0; frame < late; frame++) {
    assert.equal(sample(frame, 1), 0, `第 ${frame} 帧的补白应当是数字静音`);
  }
  // 内容本身不能被补白逻辑动到。
  // target 是 reference 去掉开头 late 个采样的切片，所以 target[frame - late] = reference[frame]。
  for (let frame = late; frame < frames; frame++) {
    assert.ok(Math.abs(sample(frame, 1) - frame / 4096) < 1 / 32768,
      `第 ${frame} 帧：期望 ${frame / 4096}，实测 ${sample(frame, 1)}`);
  }
});

test("W2 房间声补白：补白区换成房间声，而不是数字静音", async () => {
  const frames = 512, late = 96;
  const records = await lateTake(frames, late);
  const template = sine(256, 0.02, 300);
  const { sample, result } = await combine(records, {
    repair: {
      enabled: true,
      referenceKey: keyOf(records[0]),
      outputSamples: frames,
      roomTone: { enabled: true },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late, roomTone: { loop: template, rms: 0.0141, startFrame: 0 } }) },
    },
  });
  for (let frame = 0; frame < late; frame++) {
    assert.ok(Math.abs(sample(frame, 1) - template[frame]) < 1 / 32768,
      `第 ${frame} 帧：期望房间声 ${template[frame]}，实测 ${sample(frame, 1)}`);
  }
  assert.ok(sample(late - 1, 1) !== 0, "补白区不该再是静音");
  assert.equal(result.repairs[0].roomToneApplied, true, "报告里要写明房间声用上了");
});

test("W3 等功率交叉淡化：接缝不再有台阶（这是交叉淡化存在的全部理由）", async () => {
  const frames = 512, late = 96, crossfade = 32;
  // 用恒定直流当内容：接缝处的台阶一眼就能看出来。
  const records = await lateTake(frames, late, constant(frames - late, 0.5));

  const hard = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  const hardStep = Math.abs(hard.sample(late, 1) - hard.sample(late - 1, 1));
  assert.ok(hardStep > 0.4, `不淡化时接缝应当是个大台阶，实测 ${hardStep}`);

  const faded = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      crossfade: { enabled: true, samples: crossfade },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  const fadeStep = Math.abs(faded.sample(late, 1) - faded.sample(late - 1, 1));
  assert.ok(fadeStep < hardStep / 4, `淡化后接缝台阶应当显著变小：${fadeStep} vs ${hardStep}`);
  // 淡化窗口的起点：内容从 0 淡入（等功率曲线的起点增益是 0）。
  assert.ok(Math.abs(faded.sample(late, 1)) < 1 / 32768, "淡化起点应当是补白那一侧的电平");
  // 窗口之外内容必须完好，不能被淡化吃掉。
  assert.ok(Math.abs(faded.sample(late + crossfade, 1) - 0.5) < 1 / 32768,
    `淡化窗口结束（${late + crossfade}）之后内容应当恢复原值，实测 ${faded.sample(late + crossfade, 1)}`);
  assert.equal(faded.result.repairs[0].crossfadeApplied, true);
});

test("W4 房间声 + 交叉淡化：接缝两侧连续过渡，且补白区始终有房间声", async () => {
  const frames = 512, late = 96, crossfade = 32;
  const records = await lateTake(frames, late, constant(frames - late, 0.5));
  const template = constant(256, 0.02);
  const { sample } = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      crossfade: { enabled: true, samples: crossfade },
      roomTone: { enabled: true },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late, roomTone: { loop: template, rms: 0.02, startFrame: 0 } }) },
    },
  });
  // 补白区是房间声。
  assert.ok(Math.abs(sample(0, 1) - 0.02) < 1 / 32768);
  // 接缝处从房间声平滑过渡到内容：等功率混合的两端都不该出现台阶。
  for (let frame = late - 2; frame <= late + 2; frame++) {
    assert.ok(Math.abs(sample(frame, 1) - sample(frame - 1, 1)) < 0.05,
      `接缝第 ${frame} 帧有台阶：${sample(frame - 1, 1)} → ${sample(frame, 1)}`);
  }
  // 内容区恢复原值。
  assert.ok(Math.abs(sample(late + crossfade, 1) - 0.5) < 1 / 32768);
});

test("W5 找不到可信房间声时退回静音：绝不拿勉强的素材凑数", async () => {
  const frames = 512, late = 96;
  const records = await lateTake(frames, late);
  // 开了房间声，但计划里没有模板（读盘那层没找到可信片段）。
  const { sample, result } = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      roomTone: { enabled: true },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  assert.equal(sample(0, 1), 0, "没有模板时补白必须退回数字静音");
  assert.equal(result.repairs[0].roomToneApplied, false, "报告里要如实写明房间声没用上");
});

test("W6 亚采样偏移真的被用上：插值结果严格落在两个源采样之间", async () => {
  const frames = 512;
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [ramp(frames)]),
    audioRecord("TAKE01_Tr2.WAV", [ramp(frames)]),
  ]);
  // 纯偏移 0.5 个采样：整数部分是 0，小数部分是 0.5。
  // 改动前这个 0.5 会被 Math.round 丢掉，内容整整偏一帧。
  const { sample } = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      plans: { [keyOf(records[1])]: plan({ leadSamples: 0, leadExact: 0.5, leadFraction: 0.5 }) },
    },
  });
  const first = sample(0, 1);
  const second = sample(1, 1);
  const third = sample(2, 1);
  assert.ok(second > first, `第 1 帧应当比第 0 帧大：${first} → ${second}`);
  assert.ok(third > second, `第 2 帧应当比第 1 帧大：${second} → ${third}`);
  // 关键：第 1 帧既不等于第 0 帧也不等于第 2 帧——说明它确实插值了。
  assert.ok(Math.abs(second - first) > 1 / 32768, "第 1 帧不该等于第 0 帧");
  assert.ok(Math.abs(third - second) > 1 / 32768, "第 1 帧不该等于第 2 帧");
  // 0.5 采样的位移应当让内容比原来晚半拍：第 1 帧约等于源的第 0.5 个采样。
  assert.ok(Math.abs(second - 0.5 / 4096) < 2 / 32768,
    `第 1 帧应当约等于源 0.5 采样处（${0.5 / 4096}），实测 ${second}`);
});

test("W7 两项都关着时输出与改动前一致：补白是静音、内容逐采样原样", async () => {
  const frames = 512, late = 96;
  const records = await lateTake(frames, late);
  const { bytes, sample } = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      crossfade: { enabled: false, samples: 32 },
      roomTone: { enabled: false },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  assert.ok(bytes.byteLength > 0);
  for (let frame = 0; frame < late; frame++) assert.equal(sample(frame, 1), 0);
  for (let frame = late; frame < frames; frame++) {
    assert.ok(Math.abs(sample(frame, 1) - frame / 4096) < 1 / 32768);
  }
});

test("W8 开关为关时写入层完全不碰音频：逐字节惰性", async () => {
  const frames = 512, late = 96;
  // 等长素材：合板对"分轨时长不同"的轨本来就要求先做对齐修复，
  // 没开修复时连合板都过不去，所以基线要用等长的这一组。
  const equal = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [ramp(frames)]),
    audioRecord("TAKE01_Tr2.WAV", [ramp(frames)]),
  ]);
  const plain = await combine(equal);

  // 没开对齐修复，但把两个细化项都打开：输出必须与改动前逐字节相同。
  const disabled = await combine(equal, {
    repair: { enabled: false, crossfade: { enabled: true, samples: 32 }, roomTone: { enabled: true } },
  });
  assert.deepEqual([...disabled.bytes], [...plain.bytes], "对齐修复没开时，细化项不许动任何字节");

  // 开了对齐修复但两个细化项都是关的：补白仍然是数字静音，内容逐采样原样。
  const records = await lateTake(frames, late);
  const refined = await combine(records, {
    repair: {
      enabled: true, referenceKey: keyOf(records[0]), outputSamples: frames,
      crossfade: { enabled: false, samples: 32 }, roomTone: { enabled: false },
      plans: { [keyOf(records[1])]: plan({ leadSamples: late }) },
    },
  });
  assert.equal(refined.sample(0, 1), 0, "细化项关着时补白不得变成房间声");
  for (let frame = late; frame < frames; frame++) {
    assert.ok(Math.abs(refined.sample(frame, 1) - frame / 4096) < 1 / 32768);
  }
});
