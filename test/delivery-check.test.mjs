// 交付自检（src/delivery-check.js）。
//
// 这个模块读的是**写出去的字节**，不是内存里的计划。所以测试的重点不是"能跑通"，
// 而是钉死三件事：
// 1. 一份正常的 Poly 读回来，九项全 pass——证明模块和真正的写入端说同一套话；
// 2. 文件被弄坏时（响度字段改坏、缺 axml、缺 chna）能被抓出来判 fail；
// 3. 畸形字节（截断、长度乱填、根本不是 WAV）不抛错，只收敛成 fail / manual。

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord, MemoryWritable } from "./helpers.mjs";
import { writeCombinedPolyToWritable } from "../src/wave-combine.js";
import { DELIVERY_CHECK_IDS, DELIVERY_CHECK_STATES, checkWrittenPoly, readWaveChunks } from "../src/delivery-check.js";

const SAMPLE_RATE = 48000;
const SECONDS = 5;
const FRAMES = SAMPLE_RATE * SECONDS;

/** 1 kHz 正弦，0.3 Hz 幅度包络：包络让短时响度有起伏，响度范围才是真值而不是 0。 */
const tone = () => Float32Array.from({ length: FRAMES }, (_, index) => {
  const t = index / SAMPLE_RATE;
  return 0.07 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t)) * Math.sin(2 * Math.PI * 1000 * t);
});

async function writePoly(options = {}) {
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [tone()], { sampleRate: SAMPLE_RATE, bits: 32, float: true }),
    audioRecord("TAKE01_Tr2.WAV", [tone()], { sampleRate: SAMPLE_RATE, bits: 32, float: true }),
  ]);
  const writable = new MemoryWritable();
  const result = await writeCombinedPolyToWritable("TAKE01", records, writable, "TAKE01_Poly.WAV", {
    profile: "resolve", fallbackFpsValue: "25", ...options,
  });
  return { bytes: writable.bytes, result };
}

/** 完整的期望值：九项都有依据可核。 */
function expectedFor(result) {
  const program = result.loudness?.program ?? {};
  return {
    channels: 2,
    sampleRate: SAMPLE_RATE,
    bitsPerSample: 24,
    durationSamples: FRAMES,
    trackNames: ["Tr1", "Tr2"],
    loudness: {
      integrated: program.integrated ?? null,
      truePeak: program.truePeak ?? null,
      range: program.range ?? null,
      maxMomentary: program.maxMomentary ?? null,
      maxShortTerm: program.maxShortTerm ?? null,
    },
    loudnessTarget: { integrated: -23, truePeak: -1 },
    ditherExpected: true,
    bextVersion: 2,
  };
}

const statesOf = report => Object.fromEntries(report.checks.map(item => [item.id, item.state]));
const checkOf = (report, id) => {
  const found = report.checks.find(item => item.id === id);
  assert.ok(found, `清单里缺少 ${id}`);
  return found;
};

/** 把 RIFF 拆成 chunk 列表（测试自己拆一遍，免得只信被测模块的解析）。 */
function splitChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let position = 12;
  while (position + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[position], bytes[position + 1], bytes[position + 2], bytes[position + 3]);
    const size = view.getUint32(position + 4, true);
    chunks.push({ id, data: bytes.slice(position + 8, position + 8 + size) });
    position += 8 + size + (size & 1);
  }
  return chunks;
}

/** 重新拼一个 RIFF（用来造"少了某个 chunk 的文件"）。 */
function rebuild(chunks) {
  let size = 4;
  for (const chunk of chunks) size += 8 + chunk.data.length + (chunk.data.length & 1);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  tag(0, "RIFF");
  view.setUint32(4, size, true);
  tag(8, "WAVE");
  let position = 12;
  for (const chunk of chunks) {
    tag(position, chunk.id);
    view.setUint32(position + 4, chunk.data.length, true);
    out.set(chunk.data, position + 8);
    position += 8 + chunk.data.length + (chunk.data.length & 1);
  }
  return out;
}

/** 去掉某个 chunk，其余原样。 */
function withoutChunk(bytes, id) {
  return rebuild(splitChunks(bytes).filter(chunk => chunk.id !== id));
}

/** 某个 chunk 的数据段在文件里的起点（用来就地改字节）。 */
function chunkDataOffset(bytes, id) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 12;
  while (position + 8 <= bytes.length) {
    const name = String.fromCharCode(bytes[position], bytes[position + 1], bytes[position + 2], bytes[position + 3]);
    const size = view.getUint32(position + 4, true);
    if (name === id) return position + 8;
    position += 8 + size + (size & 1);
  }
  return -1;
}

test("D1 正常的 Poly：九项全 pass", async () => {
  const { bytes, result } = await writePoly();
  const report = checkWrittenPoly(bytes, expectedFor(result));
  const states = statesOf(report);
  assert.deepEqual(states, {
    "bwf-structure": "pass",
    "loudness-matches": "pass",
    "true-peak-ceiling": "pass",
    "axml-present": "pass",
    "chna-matches": "pass",
    "channel-count": "pass",
    "sample-rate-bit-depth": "pass",
    duration: "pass",
    "dither-policy": "pass",
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { pass: 9, fail: 0, manual: 0, na: 0, total: 9 });
  assert.deepEqual(report.checks.map(item => item.id), [...DELIVERY_CHECK_IDS]);
});

test("D2 纯函数：不改写入参，两次调用结果一致", async () => {
  const { bytes, result } = await writePoly();
  const before = bytes.slice();
  const first = checkWrittenPoly(bytes, expectedFor(result));
  const second = checkWrittenPoly(bytes, expectedFor(result));
  assert.deepEqual([...bytes], [...before], "自检不能改写传进来的字节");
  assert.deepEqual(first, second);
});

test("D3 bext 里的积分响度被改坏 → loudness-matches 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bextOffset = chunkDataOffset(bytes, "bext");
  view.setInt16(bextOffset + 412, -3000, true);   // 412 是积分响度（LUFS×100）
  const report = checkWrittenPoly(bytes, expectedFor(result));
  assert.equal(checkOf(report, "loudness-matches").state, "fail");
  assert.equal(checkOf(report, "bwf-structure").state, "pass", "字段不是「没测」，结构本身没坏");
  assert.equal(report.ok, false);
});

test("D4 bext 里的响度字段被写成「没测」（0x8000）→ bwf-structure 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bextOffset = chunkDataOffset(bytes, "bext");
  view.setInt16(bextOffset + 412, 0x8000, true);
  const report = checkWrittenPoly(bytes, expectedFor(result));
  assert.equal(checkOf(report, "bwf-structure").state, "fail");
  assert.equal(checkOf(report, "loudness-matches").state, "fail");
  assert.match(checkOf(report, "bwf-structure").detail, /0x8000/);
});

test("D5 真峰值被改坏到超出交付上限 → true-peak-ceiling 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bextOffset = chunkDataOffset(bytes, "bext");
  view.setInt16(bextOffset + 416, 200, true);      // 416 是真峰值（dBTP×100）：+2.0 dBTP
  const expected = expectedFor(result);
  const report = checkWrittenPoly(bytes, expected);
  assert.equal(checkOf(report, "true-peak-ceiling").state, "fail");
  assert.equal(checkOf(report, "loudness-matches").state, "fail", "读数与测量值也不一致了");
});

test("D6 缺 axml → axml-present 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const broken = withoutChunk(bytes, "axml");
  const report = checkWrittenPoly(broken, expectedFor(result));
  assert.equal(checkOf(report, "axml-present").state, "fail");
  assert.equal(checkOf(report, "bwf-structure").state, "pass", "bext 还在，结构本身没坏");
  assert.equal(report.ok, false);
});

test("D7 缺 chna → chna-matches 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const broken = withoutChunk(bytes, "chna");
  const report = checkWrittenPoly(broken, expectedFor(result));
  assert.equal(checkOf(report, "chna-matches").state, "fail");
  assert.equal(report.ok, false);
});

test("D8 chna 的轨道名对不上 → chna-matches 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chnaOffset = chunkDataOffset(bytes, "chna");
  // 第一条记录的轨道名在 2 + 16 字节处：把 "Tr1" 改成 "Xr1"。
  for (let index = 0; index < 3; index++) view.setUint8(chnaOffset + 18 + index, "Xr1".charCodeAt(index));
  const report = checkWrittenPoly(bytes, expectedFor(result));
  assert.equal(checkOf(report, "chna-matches").state, "fail");
  assert.match(checkOf(report, "chna-matches").detail, /Tr1/);
});

test("D9 通道数 / 采样率 / 位深 / 时长对不上 → 对应项判 fail", async () => {
  const { bytes, result } = await writePoly();
  const expected = expectedFor(result);
  const report = checkWrittenPoly(bytes, { ...expected, channels: 3, sampleRate: 44100, bitsPerSample: 16, durationSamples: FRAMES + 1000 });
  assert.equal(checkOf(report, "channel-count").state, "fail");
  assert.equal(checkOf(report, "sample-rate-bit-depth").state, "fail");
  assert.equal(checkOf(report, "duration").state, "fail");
  assert.equal(report.summary.fail, 3);
});

test("D10 expected 缺字段 → 相关项降级为 manual / na，不判 fail", async () => {
  const { bytes } = await writePoly();
  const report = checkWrittenPoly(bytes, {});
  const states = statesOf(report);
  assert.equal(states["bwf-structure"], "manual");
  assert.equal(states["loudness-matches"], "manual");
  assert.equal(states["true-peak-ceiling"], "manual");
  assert.equal(states["chna-matches"], "manual");
  assert.equal(states["channel-count"], "manual");
  assert.equal(states["sample-rate-bit-depth"], "manual");
  assert.equal(states["duration"], "manual");
  assert.equal(states["dither-policy"], "na", "没给 ditherExpected：本次有没有位深下降不知道，本项不适用");
  assert.equal(states["axml-present"], "pass", "axml 在不在、内容对不对是文件自身的事实，不依赖 expected");
  assert.equal(report.summary.fail, 0);
  assert.equal(report.ok, true);
});

test("D11 expected 给错值（通道数错、时长错）→ 对应项判 fail", async () => {
  const { bytes, result } = await writePoly();
  const expected = expectedFor(result);
  const report = checkWrittenPoly(bytes, { ...expected, channels: 5, durationSamples: FRAMES - 1 });
  assert.equal(checkOf(report, "channel-count").state, "fail");
  assert.equal(checkOf(report, "duration").state, "fail");
});

test("D12 降位深要抖但输出不是 24 bit → dither-policy 判 fail", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmtOffset = chunkDataOffset(bytes, "fmt ");
  view.setUint16(fmtOffset + 14, 16, true);        // 把输出位深改成 16 bit
  const report = checkWrittenPoly(bytes, expectedFor(result));
  assert.equal(checkOf(report, "dither-policy").state, "fail");
  assert.equal(checkOf(report, "sample-rate-bit-depth").state, "fail");
});

test("D13 畸形输入不抛错：截断、乱填、根本不是 WAV", async () => {
  const { bytes, result } = await writePoly();
  const expected = expectedFor(result);
  const inputs = [
    new Uint8Array(0),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    bytes.slice(0, 100),                                   // 截在 bext 里面
    bytes.slice(0, Math.floor(bytes.length / 2)),           // 截在 data 里面
  ];
  for (const input of inputs) {
    const report = checkWrittenPoly(input, expected);
    assert.equal(report.checks.length, DELIVERY_CHECK_IDS.length);
    assert.equal(report.summary.total, DELIVERY_CHECK_IDS.length);
    assert.equal(report.ok, false, "坏文件不该判成 ok");
    for (const item of report.checks) {
      assert.ok(Object.values(DELIVERY_CHECK_STATES).includes(item.state), `非法 state：${item.state}`);
      assert.ok(item.detail.length > 0, "每项都要说清楚为什么");
    }
  }
});

test("D14 chunk 长度字段乱填 → 不抛错，也不误判成正常文件", async () => {
  const { bytes, result } = await writePoly();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chnaOffset = chunkDataOffset(bytes, "chna");
  view.setUint32(chnaOffset - 4, 0x7fffffff, true);        // chna 长度写成 2 GB
  const report = checkWrittenPoly(bytes, expectedFor(result));
  assert.equal(report.checks.length, DELIVERY_CHECK_IDS.length);
  assert.equal(report.ok, false);
});

test("D15 readWaveChunks：找出所有 chunk，且不是 WAV 时返回空表", async () => {
  const { bytes } = await writePoly();
  const chunks = readWaveChunks(bytes);
  assert.ok(chunks instanceof Map);
  for (const id of ["bext", "iXML", "chna", "fmt ", "data", "axml"]) {
    assert.ok(chunks.has(id), `缺少 chunk：${id}`);
  }
  assert.equal(chunks.get("bext").length, 858);
  assert.equal(chunks.get("chna").length, 2 + 2 * 80);
  assert.equal(readWaveChunks(new Uint8Array([1, 2, 3])).size, 0);
  assert.equal(readWaveChunks(null).size, 0);
});

test("D16 关掉响度测量写出的文件：没有 axml，响度项降级为 manual 而不是瞎判 fail", async () => {
  const { bytes } = await writePoly({ loudness: { enabled: false } });
  const report = checkWrittenPoly(bytes, {
    channels: 2, sampleRate: SAMPLE_RATE, bitsPerSample: 24, durationSamples: FRAMES,
    trackNames: ["Tr1", "Tr2"], bextVersion: 2,
  });
  const states = statesOf(report);
  assert.equal(states["axml-present"], "manual", "没测过响度就没有 axml，工具不能因此判 fail");
  assert.equal(states["bwf-structure"], "manual", "expected.loudness 没给，五个响度字段核不了");
  assert.equal(states["chna-matches"], "pass");
  assert.equal(states["duration"], "pass");
  assert.equal(states["dither-policy"], "na");
  assert.equal(report.summary.fail, 0);
});
