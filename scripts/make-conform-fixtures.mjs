#!/usr/bin/env node
/**
 * 生成 conform_check.v1 的合成测试素材（**全部是 stub，不是真实拍摄素材**）。
 *
 * 为什么要有这个脚本：
 *   conform_check 要证明的是「连错 take 会被抓出来」，而这类反例很难要求用户
 *   把错的工程交出来。所以反例必须是可复现的合成素材：文件名带 _stub，
 *   报告里 syntheticStubMedia=true，README 里写明「未在真实拍摄素材上验证」。
 *
 * 素材里的一切都尽量复用项目自己的实现，避免「用两套实现互相对照」：
 *   - bext chunk 的字节布局用 src/wave-time-reference.js 的 bextChunkData /
 *     chunkHeader —— 也就是合板流程真正写回文件时用的那份实现。
 *   - LTC 音频用 test/ltc-encode.mjs 的 encodeLtcAudio（SMPTE ST 12-1 校验位已置位）。
 *   - 起始采样数用 src/timecode.js 的 timecodeToFrames / framesToSamples 算。
 *
 * 用法：
 *   node scripts/make-conform-fixtures.mjs --out test/artifacts/conform-stub
 */
import fs from "node:fs";
import path from "node:path";
import { bextChunkData, chunkHeader } from "../src/wave-time-reference.js";
import { framesToSamples, parseFps, timecodeToFrames } from "../src/timecode.js";
import { encodeLtcAudio } from "../test/ltc-encode.mjs";

export const FIXTURE_SAMPLE_RATE = 48000;
export const FIXTURE_FPS_VALUE = "25";

function tone(seconds, sampleRate = FIXTURE_SAMPLE_RATE, { frequency = 440, amplitude = 0.08 } = {}) {
  const total = Math.round(seconds * sampleRate);
  const data = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return data;
}

function silence(seconds, sampleRate = FIXTURE_SAMPLE_RATE) {
  return new Float32Array(Math.round(seconds * sampleRate));
}

/**
 * 拼一个 PCM16 单声道 WAV。chunks 顺序：RIFF / fmt / [bext] / data。
 * 字节布局照 EBU Tech 3285（bext 在 fmt 之后、data 之前）。
 */
function wavBytes(samples, { sampleRate = FIXTURE_SAMPLE_RATE, name = "stub", bextTimeReference = null } = {}) {
  const frames = samples.length;
  const dataSize = frames * 2;
  const bext = bextTimeReference === null ? null : bextChunkData({ name }, bextTimeReference);
  const bextTotal = bext ? 8 + bext.byteLength : 0;
  const riffSize = 4 + (8 + 16) + bextTotal + (8 + dataSize);
  const buffer = Buffer.alloc(8 + riffSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(riffSize, 4);
  buffer.write("WAVE", 8);
  let pos = 12;
  buffer.write("fmt ", pos);
  buffer.writeUInt32LE(16, pos + 4);
  buffer.writeUInt16LE(1, pos + 8);
  buffer.writeUInt16LE(1, pos + 10);
  buffer.writeUInt32LE(sampleRate, pos + 12);
  buffer.writeUInt32LE(sampleRate * 2, pos + 16);
  buffer.writeUInt16LE(2, pos + 20);
  buffer.writeUInt16LE(16, pos + 22);
  pos += 24;
  if (bext) {
    buffer.set(chunkHeader("bext", bext.byteLength), pos);
    buffer.set(bext, pos + 8);
    pos += bextTotal;
  }
  buffer.write("data", pos);
  buffer.writeUInt32LE(dataSize, pos + 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(value * 32767), pos + 8 + i * 2);
  }
  return buffer;
}

/** 时码 -> 该文件 bext.TimeReference 应该写的采样数（自午夜起）。 */
export function samplesForTimecode(timecode, fpsValue = FIXTURE_FPS_VALUE, sampleRate = FIXTURE_SAMPLE_RATE) {
  const fps = parseFps(fpsValue);
  return framesToSamples(timecodeToFrames(timecode, fps), sampleRate, fps);
}

function ltcAudio(startTc, durationSeconds, { amplitude = 0.6 } = {}) {
  return encodeLtcAudio({
    sampleRate: FIXTURE_SAMPLE_RATE,
    fps: Number(FIXTURE_FPS_VALUE),
    startTc,
    durationSeconds,
    amplitude,
  }).data;
}

export function writeConformFixtures(root) {
  const mediaDir = path.join(root, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const files = {};

  // 1) 正常 take：bext 起点 10:00:00:00，6 秒，无 LTC。
  files["A001_T001_stub.WAV"] = wavBytes(tone(6), {
    name: "A001_T001_stub.WAV",
    bextTimeReference: samplesForTimecode("10:00:00:00"),
  });

  // 2) 文件名极像、时码差 20 秒的另一条 take。这是「连错 take」负对照的关键：
  //    清单指向它的名字，但 10:00:00:00 那段素材在 A002_T002 里。
  files["A002_T001_stub.WAV"] = wavBytes(tone(6, FIXTURE_SAMPLE_RATE, { frequency: 523 }), {
    name: "A002_T001_stub.WAV",
    bextTimeReference: samplesForTimecode("10:00:20:00"),
  });
  files["A002_T002_stub.WAV"] = wavBytes(tone(6, FIXTURE_SAMPLE_RATE, { frequency: 523 }), {
    name: "A002_T002_stub.WAV",
    bextTimeReference: samplesForTimecode("10:00:00:00"),
  });

  // 3) 只有 LTC、没有 bext/iXML：唯一能支撑身份的独立见证就是音频里的时码。
  files["B001_T001_ltc_stub.WAV"] = wavBytes(ltcAudio("11:00:00:00", 6), {
    name: "B001_T001_ltc_stub.WAV",
    bextTimeReference: null,
  });

  // 4) 证据缺失：既没有内嵌时码，音频也是静音（LTC 也锁不上）。
  files["C001_T001_silent_stub.WAV"] = wavBytes(silence(6), {
    name: "C001_T001_silent_stub.WAV",
    bextTimeReference: null,
  });

  // 5) 文件内部两条见证互相矛盾：bext 说 09:00:00:00，LTC 说 09:30:00:00。
  files["D001_T001_mismatch_stub.WAV"] = wavBytes(ltcAudio("09:30:00:00", 6), {
    name: "D001_T001_mismatch_stub.WAV",
    bextTimeReference: samplesForTimecode("09:00:00:00"),
  });

  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(mediaDir, name), bytes);
  }

  const list = (clips, fps = FIXTURE_FPS_VALUE) => ({ schema: "clip_list.v1", fps, note: "合成素材（_stub），未在真实拍摄素材上验证", clips });
  const clipLists = {
    // 正例：两条都能拿到独立见证（一条靠 bext，一条靠 LTC）。
    "clip-list.all-supported.json": list([
      { id: "ok-bext-01", name: "A001_T001_stub.WAV", reel: "A001", sourceIn: "10:00:01:00", sourceOut: "10:00:05:00" },
      { id: "ok-ltc-02", name: "B001_T001_ltc_stub.WAV", reel: "B001", sourceIn: "11:00:01:00", sourceOut: "11:00:05:00" },
    ]),
    // 负对照 1：连错 take。名字对得上 A002_T001，但 10:00:00:00 那段在 A002_T002 里。
    "clip-list.wrong-take.json": list([
      { id: "wrong-take-01", name: "A002_T001_stub.WAV", reel: "A002", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00", note: "清单以为这是 A002_T002 的时码" },
    ]),
    // 负对照 2：证据缺失。文件在，但没有任何内容证据。
    "clip-list.missing-evidence.json": list([
      { id: "no-evidence-01", name: "C001_T001_silent_stub.WAV", sourceIn: "12:00:00:00", sourceOut: "12:00:04:00" },
    ]),
    // 负对照 3：文件内部两条见证互相矛盾。
    "clip-list.internal-disagreement.json": list([
      { id: "internal-01", name: "D001_T001_mismatch_stub.WAV", sourceIn: "09:30:00:00", sourceOut: "09:30:04:00" },
    ]),
    // 混合：一条 exit code 1 里同时出现三种态，给人类报告用。
    "clip-list.mixed.json": list([
      { id: "ok-bext-01", name: "A001_T001_stub.WAV", reel: "A001", sourceIn: "10:00:01:00", sourceOut: "10:00:05:00", timelineIn: "01:00:00:00", timelineOut: "01:00:04:00" },
      { id: "ok-ltc-02", name: "B001_T001_ltc_stub.WAV", reel: "B001", sourceIn: "11:00:01:00", sourceOut: "11:00:05:00" },
      { id: "wrong-take-03", name: "A002_T001_stub.WAV", reel: "A002", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00" },
      { id: "no-evidence-04", name: "C001_T001_silent_stub.WAV", sourceIn: "12:00:00:00", sourceOut: "12:00:04:00" },
      { id: "internal-05", name: "D001_T001_mismatch_stub.WAV", sourceIn: "09:30:00:00", sourceOut: "09:30:04:00" },
      { id: "missing-media-06", name: "Z999_T001_not_here_stub.WAV", sourceIn: "13:00:00:00", sourceOut: "13:00:04:00" },
    ]),
  };
  for (const [name, list] of Object.entries(clipLists)) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(list, null, 2) + "\n");
  }
  fs.writeFileSync(
    path.join(mediaDir, "README_stub.txt"),
    "合成素材（stub），由 scripts/make-conform-fixtures.mjs 生成，未在真实拍摄素材上验证。\n" +
      "A001/A002_T002: bext 10:00:00:00; A002_T001: bext 10:00:20:00; B001: 仅 LTC 11:00:00:00;\n" +
      "C001: 无时码无 LTC; D001: bext 09:00:00:00 与 LTC 09:30:00:00 互相矛盾。\n",
    "utf8",
  );
  return { mediaDir, clipListDir: root, clipLists: Object.keys(clipLists), mediaFiles: Object.keys(files) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : "test/artifacts/conform-stub";
  if (!out) {
    console.error("用法：node scripts/make-conform-fixtures.mjs --out <目录>");
    process.exit(2);
  }
  const root = path.resolve(out);
  const result = writeConformFixtures(root);
  console.log("已生成合成素材（_stub）：");
  console.log("  目录：" + root);
  console.log("  媒体：" + result.mediaFiles.length + " 个 WAV");
  console.log("  清单：" + result.clipLists.length + " 份");
  for (const name of result.clipLists) console.log("    - " + name);
  console.log("提醒：合成素材，未在真实拍摄素材上验证。");
}
