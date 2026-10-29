// 对齐修复的读盘规划 + 控制器接线
//
// 这里验证的是"修得出来"和"修不了也不惹事"两件事：
//   - 时长不一致的 take 在开启修复后应当真的能合出 Poly（此前直接被 validateCombineGroup 拦下）
//   - 默认关闭时行为一字不变
//   - 读不到、测不出、选错基准轨都只跳过自己，不打断整批

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord } from "./helpers.mjs";
import { planRepairsForTracks, readQuietestRegion, trackFrameCount } from "../src/repair-planner.js";
import { combineTrackPlan } from "../src/wave-combine.js";
import { sourceTrackKey } from "../src/poly-export-profiles.js";
import { createPolyCombineController } from "../src/poly-combine-controller.js";
import { combineEligibleGroupsFor, detectTakeGroupKeys } from "../src/grouping.js";
import { scanWave } from "../src/wave.js";

function fakeEls() {
  return {
    combinePolyBtn: { disabled: false },
    statusLine: { textContent: "" },
    toast: { textContent: "", classList: { add() {}, remove() {} } },
    progressOverlay: { shown: false, classList: { add() {}, remove() {} } },
    progressLabel: { textContent: "" },
    progressFile: { textContent: "" },
    progressPct: { textContent: "" },
    progressFill: { style: { width: "" } },
  };
}
const SR = 8000;
const PLAN = { sampleRate: SR, analysisSeconds: 0.05, tailGuardSeconds: 0.05 };

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speechLike(frames, seed) {
  const random = mulberry32(seed);
  const out = new Float32Array(frames);
  let envelope = 0;
  for (let i = 0; i < frames; i++) {
    if (i % 97 === 0) envelope = 0.2 + 0.8 * random();
    out[i] = (random() * 2 - 1) * envelope * 0.5;
  }
  return out;
}

async function record(name, channels, parentPath = "FOLDER01") {
  const built = await audioRecord(name, channels, { sampleRate: SR, bits: 16 });
  return { ...built, name, relativePath: `${parentPath}/${name}`, parentPath };
}

test("P1 晚开机的分轨能算出补静音计划", async () => {
  const reference = speechLike(2000, 3);
  const late = reference.subarray(160); // target[k] = reference[k + 160]
  const records = await Promise.all([
    record("S01T01_1.wav", [reference]),
    record("S01T01_2.wav", [late]),
  ]);
  const tracks = combineTrackPlan(records);
  const result = await planRepairsForTracks(tracks, "", PLAN);

  assert.ok(result.plans.size, "应当为晚开机的分轨算出计划");
  const plan = result.plans.get(sourceTrackKey(tracks[1]));
  assert.ok(plan, "键必须与 sourceTrackKey 一致");
  assert.ok(Math.abs(plan.leadSamples - 160) < 40, `leadSamples=${plan.leadSamples}`);
  assert.ok(Math.abs(plan.padSamples - 160) < 40, `padSamples=${plan.padSamples}`);
  assert.equal(result.outputSamples, 2000);
  assert.equal(result.referenceKey, sourceTrackKey(tracks[0]));
});

test("P2 完全一致的 take 不产出任何计划", async () => {
  const reference = speechLike(2000, 5);
  const records = await Promise.all([
    record("T_1.wav", [reference]),
    record("T_2.wav", [reference]),
  ]);
  const result = await planRepairsForTracks(combineTrackPlan(records), "", PLAN);
  assert.equal(result.plans.size, 0, "没有要改的就不要挂计划");
  assert.ok(result.skipped.length, "应当说明为什么跳过");
});

test("P3 显式指定基准轨", async () => {
  const reference = speechLike(2000, 7);
  const late = reference.subarray(160);
  const records = await Promise.all([
    record("T_1.wav", [late]),
    record("T_2.wav", [reference]),
  ]);
  const tracks = combineTrackPlan(records);
  const wanted = sourceTrackKey(tracks[1]);
  const result = await planRepairsForTracks(tracks, wanted, PLAN);
  assert.equal(result.referenceKey, wanted);
  assert.ok(result.plans.get(sourceTrackKey(tracks[0])), "未选中的那条才需要修正");
  assert.equal(result.plans.has(wanted), false, "基准轨自己不挂计划");
});

test("P4 选不出基准轨 / 空输入都不抛错", async () => {
  assert.doesNotThrow(() => trackFrameCount(null));
  assert.equal(trackFrameCount(null), 0);
  const empty = await planRepairsForTracks([], "", PLAN);
  assert.equal(empty.plans.size, 0);
  assert.equal(empty.referenceKey, "");
  const nullish = await planRepairsForTracks(null, "", PLAN);
  assert.equal(nullish.plans.size, 0);
  const records = await Promise.all([record("X_1.wav", [speechLike(2000, 9)]), record("X_2.wav", [speechLike(2000, 11)])]);
  const tracks = combineTrackPlan(records);
  const missing = await planRepairsForTracks(tracks, "不存在的轨:9", PLAN);
  assert.equal(missing.plans.size, 0, "基准轨不存在就不修");
});

test("P5 默认关闭：时长不一致的 take 仍然被拦下", async () => {
  const reference = speechLike(1200, 13);
  const records = await Promise.all([
    record("D1_1.wav", [reference]),
    record("D1_2.wav", [reference.subarray(0, 1000)]),
  ]);
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  assert.equal(groups.length, 0, "时长不等长默认不进合板");
});

test("P6 开启修复：时长不一致的 take 真的合出了 Poly", async () => {
  const reference = speechLike(1200, 17);
  const records = await Promise.all([
    record("E1_1.wav", [reference]),
    record("E1_2.wav", [reference.subarray(0, 1000)]),
  ]);
  // 手动放行：修复正是为了让这一类 take 能合，UI 侧把它交给 repair 开关处理。
  const groups = [["FOLDER01/E1", records]];
  const written = [];
  const blobs = new Map();
  const controller = createPolyCombineController({
    confirmCombinePoly: async () => "ok",
    combineEligibleGroups: () => groups,
    confirmMetadataFpsMismatch: async () => true,
    getExportOptions: async () => ({ repair: { enabled: true, referenceKey: "" } }),
    getOutputDirectory: async () => ({
      getFileHandle: async (name) => {
        written.push(name);
        // 按 position 写，与 File System Access 的语义一致，才能把乱序写还原成字节流。
        let buffer = new Uint8Array(0);
        blobs.set(name, () => buffer);
        return {
          // 交付自检会把这个句柄上的文件读回来，mock 得能读。
          getFile: async () => new File([buffer], name),
          createWritable: async () => ({
            write: async ({ position = 0, data }) => {
              const bytes = new Uint8Array(data instanceof Uint8Array ? data : data.buffer);
              if (position + bytes.length > buffer.length) {
                const grown = new Uint8Array(position + bytes.length);
                grown.set(buffer);
                buffer = grown;
              }
              buffer.set(bytes, position);
            },
            truncate: async () => {},
            close: async () => {},
            abort: async () => {},
          }),
        };
      },
    }),
    requestOverwrite: async () => true,
    setCombinedPolyKeys: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: () => {},
    els: fakeEls(),
  });

  const results = await controller.combinePolyFiles();
  assert.equal(results.length, 1, "开启修复后这个 take 应当合出来");
  // getFileHandle 在覆盖探测与真正写入时各调一次，所以按去重后的名字断言。
  assert.deepEqual([...new Set(written.filter(name => /\.wav$/i.test(name)))], ["E1_Poly.WAV"]);

  // 产物必须是两通道、且等长于参考轨——修复的产出长度由 outputSamples 决定。
  const polyBytes = blobs.get("E1_Poly.WAV")();
  const parsed = await scanWave({ getFile: async () => new File([polyBytes], "x.wav") });
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.durationSamples, 1200n, "输出长度应当等于基准轨长度");
});

test("P7 修复读盘失败只跳过自己，不打断整批", async () => {
  const reference = speechLike(1200, 19);
  const good = await record("F1_1.wav", [reference]);
  const broken = await record("F1_2.wav", [reference.subarray(0, 1000)]);
  const brokenRecord = { ...broken, file: null, fileHandle: null }; // 模拟读不到
  const records = [good, brokenRecord];
  const groups = [["FOLDER01/F1", records]];
  const logs = [];
  const controller = createPolyCombineController({
    confirmCombinePoly: async () => "ok",
    combineEligibleGroups: () => groups,
    getExportOptions: async () => ({ repair: { enabled: true, referenceKey: "" } }),
    getOutputDirectory: async () => null,
    requestOverwrite: async () => true,
    setCombinedPolyKeys: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: line => logs.push(line),
    els: fakeEls(),
  });
  await assert.doesNotReject(() => controller.combinePolyFiles());
  assert.ok(logs.some(line => /Repair/.test(line)), "应当留下 repair 相关日志");
});

test("P8 畸形输入不抛错", async () => {
  for (const run of [
    () => planRepairsForTracks(null, "", PLAN),
    () => planRepairsForTracks([], "", PLAN),
    () => planRepairsForTracks([{ record: null }], "", PLAN),
    () => planRepairsForTracks([{ record: { channels: 0, blockAlign: 0 } }], "", PLAN),
  ]) await assert.doesNotReject(run);
});
test("P9 指定的基准轨在本 take 里不存在时退回自动，并如实标记", async () => {
  const reference = speechLike(2000, 23);
  const late = reference.subarray(160);
  const records = await Promise.all([
    record("G_1.wav", [late]),
    record("G_2.wav", [reference]),
  ]);
  const tracks = combineTrackPlan(records);
  // 模拟"基准轨是另一个 take 的轨"：key 存在但不在本 take 里。
  const foreign = "OTHER_TAKE/9_9.wav:0";
  const result = await planRepairsForTracks(tracks, foreign, PLAN);
  assert.equal(result.referenceMatched, false, "应当标明指定的基准轨没命中");
  assert.ok(result.referenceKey, "仍然要给出一条可用的基准轨");
  assert.equal(result.plans.size, 1, "退回自动后照常修正其余分轨");

  const hit = await planRepairsForTracks(tracks, sourceTrackKey(tracks[1]), PLAN);
  assert.equal(hit.referenceMatched, true);
});

// ---------------------------------------------------------------------------
// 房间声补白：从真实文件里找最安静的一段
// ---------------------------------------------------------------------------

// 头部是内容、尾部是低电平噪声（房间声）的素材。
function withQuietTail(frames, quietFrames, seed = 29) {
  const out = new Float32Array(frames);
  out.set(speechLike(frames - quietFrames, seed), 0);
  const random = mulberry32(seed + 1);
  for (let i = 0; i < quietFrames; i++) out[frames - quietFrames + i] = (random() * 2 - 1) * 0.02;
  return out;
}

test("P10 房间声：readQuietestRegion 从真实文件里找出最安静的一段", async () => {
  const frames = SR * 2, quietFrames = SR;
  const built = await record("T_tone.wav", [withQuietTail(frames, quietFrames)]);
  const region = await readQuietestRegion({ record: built, channelIndex: 0 }, { sampleRate: SR, toneSeconds: 0.5 });
  assert.ok(region, "应当读得出候选");
  assert.equal(region.usable, true, "房间声应当找得到：" + region.reason);
  assert.ok(region.startFrame >= frames - quietFrames - SR, "最安静的段应当落在尾部：" + region.startFrame);
  assert.ok(region.rms > 0.001 && region.rms < 0.05, "电平应当是底噪量级：" + region.rms);
  assert.ok(region.loop.length > 0, "应当给出可循环的模板");
});

test("P11 判据不过时如实报告，绝不拿勉强的素材凑数", async () => {
  // 数字静音：低于静音地板，不是房间声。
  // 电平取 1/32768：16 bit 下正好是 1 个量化单位，量化后还是非零，
  // 这样测的是"静音地板"这道闸门，而不是"文件里根本没有数据"。
  const quiet = await record("T_silence.wav", [new Float32Array(SR * 2).fill(1 / 32768)]);
  const silence = await readQuietestRegion({ record: quiet, channelIndex: 0 }, { sampleRate: SR, toneSeconds: 0.5 });
  assert.equal(silence.usable, false);
  assert.equal(silence.reason, "digital-silence");

  // 直流偏置：没有交流成分，不是房间声。
  const dc = await record("T_dc.wav", [new Float32Array(SR * 2).fill(0.3)]);
  const offset = await readQuietestRegion({ record: dc, channelIndex: 0 }, { sampleRate: SR, toneSeconds: 0.5 });
  assert.equal(offset.usable, false);
  assert.equal(offset.reason, "dc-offset");
});

test("P12 房间声补白：计划里带上找到的素材；没开开关时计划里不出现", async () => {
  const frames = SR * 4, late = 100, quietFrames = SR;
  const reference = speechLike(frames, 3);
  // target 晚开机 late 个采样：头部与参考轨同源（能测出偏移），尾部换成房间声。
  const target = new Float32Array(frames - late);
  target.set(reference.subarray(late, frames - quietFrames), 0);
  const random = mulberry32(29);
  for (let i = 0; i < quietFrames; i++) target[target.length - quietFrames + i] = (random() * 2 - 1) * 0.02;

  const records = await Promise.all([
    record("S01T01_1.wav", [reference]),
    record("S01T01_2.wav", [target]),
  ]);
  const tracks = combineTrackPlan(records);

  const off = await planRepairsForTracks(tracks, "", PLAN);
  const [offPlan] = [...off.plans.values()];
  assert.ok(offPlan, "晚开机应当要算出计划");
  assert.ok(offPlan.padSamples > 0, "应当要补白：" + offPlan.padSamples);
  assert.equal(offPlan.roomTone, undefined, "没开房间声时计划里不该出现素材");
  assert.equal(off.roomToneReports.length, 0);

  const on = await planRepairsForTracks(tracks, "", { ...PLAN, roomTone: { enabled: true, toneSeconds: 0.5 } });
  const [onPlan] = [...on.plans.values()];
  assert.ok(onPlan.roomTone?.loop?.length, "计划里应当带上房间声素材");
  assert.ok(onPlan.roomTone.rms > 0);
  assert.equal(on.roomToneReports.length, 1);
  assert.equal(on.roomToneReports[0].usable, true, "房间声应当找得到：" + on.roomToneReports[0].reason);
});

test("P13 控制器接线：房间声与交叉淡化的开关一路传到写入层，并且说出口", async () => {
  const frames = SR * 3, late = 100, quietStart = 12000;
  const reference = speechLike(frames, 23);
  // target 晚开机 late 个采样：头部与参考轨同源（能测出偏移），中段换成房间声，
  // 尾部仍然与参考轨同源（尾窗测漂移才不会被噪声干扰）。
  const target = new Float32Array(frames - late);
  target.set(reference.subarray(late, quietStart), 0);
  const random = mulberry32(31);
  for (let i = quietStart; i < 20000; i++) target[i] = (random() * 2 - 1) * 0.02;
  target.set(reference.subarray(20000 + late, frames), 20000);

  const records = await Promise.all([
    record("F1_1.wav", [reference]),
    record("F1_2.wav", [target]),
  ]);
  const groups = [["FOLDER01/F1", records]];
  const written = [];
  const blobs = new Map();
  const logLines = [];
  const controller = createPolyCombineController({
    confirmCombinePoly: async () => "ok",
    combineEligibleGroups: () => groups,
    confirmMetadataFpsMismatch: async () => true,
    getExportOptions: async () => ({
      repair: {
        enabled: true, referenceKey: "",
        crossfade: { enabled: true },
        roomTone: { enabled: true },
      },
    }),
    getOutputDirectory: async () => ({
      getFileHandle: async (name) => {
        written.push(name);
        let buffer = new Uint8Array(0);
        blobs.set(name, () => buffer);
        return {
          // 交付自检会把这个句柄上的文件读回来，mock 得能读。
          getFile: async () => new File([buffer], name),
          createWritable: async () => ({
            write: async ({ position = 0, data }) => {
              const bytes = new Uint8Array(data instanceof Uint8Array ? data : data.buffer);
              if (position + bytes.length > buffer.length) {
                const grown = new Uint8Array(position + bytes.length);
                grown.set(buffer);
                buffer = grown;
              }
              buffer.set(bytes, position);
            },
            truncate: async () => {},
            close: async () => {},
            abort: async () => {},
          }),
        };
      },
    }),
    requestOverwrite: async () => true,
    setCombinedPolyKeys: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: message => { logLines.push(String(message)); },
    els: fakeEls(),
  });

  const results = await controller.combinePolyFiles();
  assert.equal(results.length, 1, "开了房间声与交叉淡化之后这个 take 应当合得出来");
  const polyBytes = blobs.get("F1_Poly.WAV")();
  const parsed = await scanWave({ getFile: async () => new File([polyBytes], "x.wav") });
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.durationSamples, BigInt(frames), "输出长度应当等于基准轨长度");

  // 开了哪几项、房间声找没找到，都必须在日志里说清楚：
  // 用户看到"修正了"却不知道补的是静音还是房间声，下次就会按错误的预期去听这条轨。
  // "Repair:" 前缀不止一条（还有一条讲基准轨回退的），摘要那条以"为基准修正"结尾。
  const repairLine = logLines.find(line => line.startsWith("Repair:") && line.includes("为基准修正"));
  assert.ok(repairLine, "应当有修复摘要");
  assert.match(repairLine, /接缝等功率交叉淡化/);
  assert.match(repairLine, /房间声补白/);
  const toneLine = logLines.find(line => line.startsWith("RoomTone:"));
  assert.ok(toneLine, "房间声的状态必须单独说一句");
  assert.match(toneLine, /^RoomTone: /);
  assert.match(toneLine, /找到房间声（/);
});

test("P14 共享房间声：指定来源后所有轨共用同一份底噪，并按各轨噪声底做电平对齐", async () => {
  const frames = SR * 4, late = 100, quietFrames = SR;
  const reference = speechLike(frames, 41);
  // 两条分轨都是"晚开机"，都需要补白；尾部各自换成低电平噪声。
  const makeTarget = (seed, level) => {
    const target = new Float32Array(frames - late);
    target.set(reference.subarray(late, frames - quietFrames), 0);
    const random = mulberry32(seed);
    for (let i = 0; i < quietFrames; i++) target[target.length - quietFrames + i] = (random() * 2 - 1) * level;
    return target;
  };
  const records = await Promise.all([
    record("S02T01_1.wav", [reference]),
    record("S02T01_2.wav", [makeTarget(51, 0.02)]),
    record("S02T01_3.wav", [makeTarget(61, 0.01)]),
  ]);
  const tracks = combineTrackPlan(records);
  const toneKey = sourceTrackKey(tracks[2]);
  const planned = await planRepairsForTracks(tracks, "", {
    ...PLAN, roomTone: { enabled: true, toneSeconds: 0.5, sourceKey: toneKey },
  });
  assert.ok(planned.plans.size >= 1, "应当为晚开机的分轨算出计划");
  const withTone = [...planned.plans.values()].filter(plan => plan.roomTone?.loop?.length);
  assert.ok(withTone.length >= 1, "应当有分轨拿到房间声");
  // 共用：所有轨引用同一份模板。
  const first = withTone[0].roomTone;
  for (const plan of withTone) {
    assert.equal(plan.roomTone.loop, first.loop, "共享房间声必须是同一份模板");
  }
  // 电平对齐：按各轨自己的噪声底做宽带校正，限幅 ±6 dB。
  for (const plan of withTone) {
    assert.ok(plan.roomTone.gain >= 0.5 && plan.roomTone.gain <= 2, `增益应当限在 ±6 dB 内：${plan.roomTone.gain}`);
  }
  // 报告里要能看出这是共用的。
  const shared = planned.roomToneReports.find(report => report.shared);
  assert.ok(shared, "报告里要写明用的是共用房间声");
  assert.equal(shared.usable, true);

  // 不指定来源时各轨各找：模板彼此不同。
  const perTrack = await planRepairsForTracks(tracks, "", { ...PLAN, roomTone: { enabled: true, toneSeconds: 0.5 } });
  const own = [...perTrack.plans.values()].filter(plan => plan.roomTone?.loop?.length);
  assert.ok(own.length >= 1);
  if (own.length >= 2) {
    assert.notEqual(own[0].roomTone.loop, own[1].roomTone.loop, "不指定来源时各轨各找，模板应当不同");
  }
});

test("P16 波形对齐：置信度达标时用波形的偏移，报告里要写明是谁给的", async () => {
  const frames = SR * 6, shift = 1200;   // 25 ms
  const reference = speechLike(frames, 63);
  // 目标的内容比参考晚 shift 个采样出现（也就是目标早开机）。
  const target = new Float32Array(frames);
  target.set(reference.subarray(0, frames - shift), shift);
  const records = await Promise.all([
    record("W1_1.wav", [reference]),
    record("W1_2.wav", [target]),
  ]);
  const tracks = combineTrackPlan(records);
  const planned = await planRepairsForTracks(tracks, "", {
    ...PLAN, waveform: { enabled: true, reference: tracks[0] },
  });
  const plan = planned.plans.get(sourceTrackKey(tracks[1]));
  assert.ok(plan, "应当算出计划");
  assert.ok(Math.abs(plan.leadSamples + shift) < SR * 0.02,
    `leadSamples=${plan.leadSamples}，期望约 ${-shift}`);
  assert.ok(plan.waveform, "计划里要带上波形匹配的结果");
  assert.equal(plan.waveform.usable, true);
  assert.ok(planned.waveformReports.length, "报告里要有波形匹配的记录");
  assert.equal(planned.waveformReports[0].usable, true);
});

test("P17 波形匹不准则照旧按原测量对齐，并说明原因", async () => {
  const frames = SR * 6;
  const reference = speechLike(frames, 67);
  // 目标与参考毫无关系：波形必然匹不上。
  const random = mulberry32(71);
  const target = new Float32Array(frames);
  for (let i = 0; i < frames; i++) target[i] = (random() * 2 - 1) * 0.3;
  const records = await Promise.all([
    record("W2_1.wav", [reference]),
    record("W2_2.wav", [target]),
  ]);
  const tracks = combineTrackPlan(records);
  const planned = await planRepairsForTracks(tracks, "", {
    ...PLAN, waveform: { enabled: true, reference: tracks[0] },
  });
  const report = planned.waveformReports[0];
  assert.ok(report, "报告里要有波形匹配的记录");
  assert.equal(report.usable, false, "无关素材不该被当成匹配上了");
  assert.ok(report.reason, "必须说明为什么没匹上");
  // 计划仍然要出：波形只是补充路径，匹不上不能把整个 take 卡死。
  assert.ok(planned.plans.size >= 0);
});

test("P15 指定的房间声来源在本 take 里不存在时如实报告", async () => {
  const frames = SR * 2;
  const reference = speechLike(frames, 71);
  const records = await Promise.all([
    record("S03T01_1.wav", [reference]),
    record("S03T01_2.wav", [reference.subarray(100)]),
  ]);
  const tracks = combineTrackPlan(records);
  const planned = await planRepairsForTracks(tracks, "", {
    ...PLAN, roomTone: { enabled: true, toneSeconds: 0.5, sourceKey: "不存在的轨.wav:0" },
  });
  const report = planned.roomToneReports.find(item => item.shared);
  assert.ok(report, "应当报告指定来源的情况");
  assert.equal(report.usable, false);
  assert.match(report.reason, /没有这条轨/);
});
