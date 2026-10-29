// 写入层的响度、chna 与抖动（src/wave-combine.js）
//
// 这里验的是"文件里到底有什么"：bext version 2 的响度字段被回填了没有、
// axml 在不在、chna 的通道分配对不对、抖动是不是确定性的。
// 测量算法本身的正确性在 test/loudness.test.mjs（对着 EBU 的参考值验）。

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord, MemoryWritable } from "./helpers.mjs";
import { readAudioSample } from "../src/wave-audio.js";
import { scanWave } from "../src/wave.js";
import { combineRepairKey, writeCombinedPolyToWritable } from "../src/wave-combine.js";

const keyOf = record => combineRepairKey({ record, channelIndex: 0 });

/** 在 RIFF 里找一个 chunk，返回它的数据字节。 */
function findChunk(bytes, id) {
  const tag = id.padEnd(4, " ");
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (name === tag) return bytes.slice(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  return null;
}

async function combine(records, options = {}) {
  const writable = new MemoryWritable();
  const result = await writeCombinedPolyToWritable("TAKE01", records, writable, "test_Poly.WAV", {
    profile: "resolve", fallbackFpsValue: "25", ...options,
  });
  const bytes = writable.bytes;
  const file = new File([bytes], "test_Poly.WAV");
  const parsed = await scanWave({ getFile: async () => file });
  const view = new DataView(await file.slice(parsed.dataOffset).arrayBuffer());
  const sample = (frame, channel) => readAudioSample(
    view, frame * parsed.blockAlign + channel * (parsed.blockAlign / parsed.channels), parsed,
  );
  return { result, bytes, parsed, sample };
}

const sine = (length, amplitude, frequencyHz, sampleRate = 48000) =>
  Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequencyHz * index / sampleRate));

test("W1 bext 升到 version 2，五个响度字段被回填", async () => {
  const frames = 48000 * 2;
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [sine(frames, 0.0707946, 1000)]),
  ]);
  const { bytes, result } = await combine(records);
  const bext = findChunk(bytes, "bext");
  assert.ok(bext, "文件里应当有 bext");
  const view = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
  assert.equal(view.getUint16(346, true), 2, "bext 应当是 version 2");
  // 1 kHz 正弦峰值 −23 dBFS，单通道积分响度应当是 −26.0 LUFS → −2600。
  assert.equal(view.getInt16(412, true), -2600, "积分响度字段应当被回填");
  // 真峰值是信号的幅度（−23 dBFS），跟响度（−26 LUFS，含 1/√2 与 K 加权）不是一回事。
  assert.equal(view.getInt16(416, true), -2300, "真峰值字段应当是 −23.0 dBTP");
  assert.equal(result.loudness.programChannel, 1);
  assert.ok(Math.abs(result.loudness.program.integrated - -26) < 0.2);
});

test("W2 axml 里也有同一组响度数", async () => {
  const frames = 48000 * 2;
  const records = await Promise.all([audioRecord("TAKE01_Tr1.WAV", [sine(frames, 0.0707946, 1000)])]);
  const { bytes } = await combine(records);
  const axml = findChunk(bytes, "axml");
  assert.ok(axml, "文件里应当有 axml");
  const text = new TextDecoder().decode(axml);
  assert.match(text, /<ebu_loudness_information>/);
  assert.match(text, /<integrated_loudness>-26\.\d<\/integrated_loudness>/);
});

test("W3 chna 通道分配：通道号与轨道名", async () => {
  const frames = 4800;
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [sine(frames, 0.2, 300)]),
    audioRecord("TAKE01_Tr2.WAV", [sine(frames, 0.3, 500)]),
  ]);
  const { bytes } = await combine(records);
  const chna = findChunk(bytes, "chna");
  assert.ok(chna, "文件里应当有 chna");
  const view = new DataView(chna.buffer, chna.byteOffset, chna.byteLength);
  assert.equal(view.getUint16(0, true), 2, "两条通道");
  assert.equal(view.getUint16(2, true), 1, "第一条轨道号");
  assert.equal(view.getUint16(4, true), 0xffff, "离散分轨没有标准扬声器位置");
  const name = new TextDecoder().decode(chna.slice(18, 18 + 64)).replace(/\0.*$/s, "");
  assert.equal(name, "Tr1");
});

test("W4 抖动：32 bit 浮点转 24 bit 时要抖，而且可复现", async () => {
  const frames = 4800;
  const values = Float32Array.from({ length: frames }, (_, index) => (index % 97) / 4096 - 0.01);
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [values], { sampleRate: 48000, bits: 32, float: true }),
  ]);
  const options = { profile: "resolve", fallbackFpsValue: "25" };
  const first = await combine(records, options);
  const second = await combine(records, options);
  assert.deepEqual([...first.bytes], [...second.bytes], "抖动必须是确定性的：同一份素材两次导出要一样");
  const readPcm24 = (bytes, frame, dataOffset) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = dataOffset + frame * 3;
    const pcm = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    return (pcm & 0x800000 ? pcm - 0x1000000 : pcm) / 8388608;
  };
  const raw = values[100];
  const written = readPcm24(first.bytes, 100, first.parsed.dataOffset);
  assert.ok(Math.abs(written - raw) < 1e-5, "抖动量应当在一个量化步长以内");
  assert.notEqual(written, Math.round(raw * 8388608) / 8388608, "加了抖动就不该正好落在量化格上");
});

test("W5 关掉响度：bext 字段是「没测」，也不写 axml", async () => {
  const frames = 4800;
  const records = await Promise.all([audioRecord("TAKE01_Tr1.WAV", [sine(frames, 0.2, 300)])]);
  const { bytes, result } = await combine(records, { loudness: { enabled: false } });
  const bext = findChunk(bytes, "bext");
  const view = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
  assert.equal(view.getInt16(412, true), -32768, "没测就写 0x8000");
  assert.equal(findChunk(bytes, "axml"), null, "没量就不该有 axml");
  assert.equal(result.loudness, undefined, "返回结构里也不该多出响度字段");
});
