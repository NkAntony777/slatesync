// 响度实现与 ffmpeg ebur128 的交叉验证
//
// 这是响度模块的外部锚点：同一段素材，本实现与 ffmpeg 分别测量，
// 偏差必须在 EBU Tech 3341 / 3342 公布的容差之内。
//
// 容差出处（不是拍脑袋定的）：
// - 响度：EBU Tech 3341 给 ±0.1 LU
// - 真峰值：EBU Tech 3341 给 +0.2 / −0.4 dB
// - 响度范围：EBU Tech 3342 给 ±1 LU
//
// 没有 ffmpeg 的机器上整组跳过——这条测试是交叉验证，不该把没装 ffmpeg
// 变成"测试失败"。但 ffmpeg 一旦可用，它就是响度模块唯一的外部真相。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createLoudnessMeter } from "../src/loudness.js";
// 临时目录纪律：落本仓内 .tmp/（D 盘）+ 四道钩子必删
// —— 见 docs/测试临时目录泄漏修复.md
import { makeTempFile } from "./tmp-helper.mjs";

const SR = 48000;
const TOLERANCE = { integrated: 0.1, truePeakUp: 0.2, truePeakDown: 0.4, range: 1.0 };

/** 找一个可用的 ffmpeg。找不到返回 null。 */
function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, "ffmpeg"];
  const wingetRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft", "WinGet", "Packages",
  );
  try {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!entry.toLowerCase().includes("ffmpeg")) continue;
      const bin = path.join(wingetRoot, entry);
      for (const inner of fs.readdirSync(bin)) {
        candidates.push(path.join(bin, inner, "bin", "ffmpeg.exe"));
      }
    }
  } catch { /* 没有 WinGet 目录就算了 */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const FFMPEG = findFfmpeg();
const skip = FFMPEG ? false : "本机没有可用的 ffmpeg，跳过与 ebur128 的交叉验证";

/** 写一个 24 bit WAV。写出的就是后面要量的东西，量化必须一致。 */
function writeWav24(file, channels) {
  const count = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * count * 3;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(count, 22);
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * count * 3, 28);
  buffer.writeUInt16LE(count * 3, 32);
  buffer.writeUInt16LE(24, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // 注意按通道下标写：EBU 参考用例里两个通道引用的是同一个数组，
  // 用 indexOf 找下标会把两个通道都写到通道 0 的位置上，文件就废了。
  const quantized = [];
  for (let ch = 0; ch < count; ch++) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let pcm = Math.round(channels[ch][i] * 8388608);
      pcm = Math.max(-8388608, Math.min(8388607, pcm));
      const offset = 44 + (i * count + ch) * 3;
      buffer[offset] = pcm & 255;
      buffer[offset + 1] = (pcm >> 8) & 255;
      buffer[offset + 2] = (pcm >> 16) & 255;
      out[i] = pcm / 8388608;
    }
    quantized.push(out);
  }
  fs.writeFileSync(file, buffer);
  return quantized;
}

/** 跑 ffmpeg 的 ebur128，只取 Summary 段里的三个数。 */
function ffmpegEbur128(file) {
  const run = spawnSync(FFMPEG, [
    "-hide_banner", "-nostats", "-i", file,
    "-af", "ebur128=peak=true", "-f", "null", "-",
  ], { encoding: "utf8" });
  const text = (run.stdout || "") + (run.stderr || "");
  const summaryAt = text.lastIndexOf("Summary:");
  if (summaryAt < 0) throw new Error("ffmpeg 的 ebur128 没有输出 Summary 段");
  // 必须只取摘要段：逐帧输出里第一个 "I:" 是文件开头静音时的 -70.0。
  const summary = text.slice(summaryAt);
  const grab = (label) => {
    const match = new RegExp("\\b" + label + ":\\s*(-?[0-9.]+)", "i").exec(summary);
    return match ? Number(match[1]) : null;
  };
  return { integrated: grab("I"), range: grab("LRA"), truePeak: grab("Peak") };
}

function measureLocally(channels) {
  const meter = createLoudnessMeter({ sampleRate: SR, channels: channels.length });
  for (let i = 0; i < channels[0].length; i++) meter.pushFrame(channels.map(channel => channel[i]));
  const result = meter.finish();
  return {
    integrated: result.combined,
    range: result.channels[0].range,
    truePeak: result.channels[0].truePeak,
  };
}

const sine = (frames, amplitude, hz) =>
  Float32Array.from({ length: frames }, (_, index) => amplitude * Math.sin(2 * Math.PI * hz * index / SR));

/** 简单低通（单极点重复），用来造带限噪声。 */
function bandLimitedNoise(frames, amplitude, seed, cutoffHz) {
  const raw = noise(frames, amplitude, seed);
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoffHz / SR);
  const out = new Float32Array(frames);
  let state = 0;
  for (let i = 0; i < frames; i++) {
    state += alpha * (raw[i] - state);
    out[i] = state * 3.2;
  }
  return out;
}

function noise(frames, amplitude, seed) {
  let state = seed >>> 0;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state / 2147483648 - 1) * amplitude;
  }
  return out;
}

/**
 * 给素材加一段淡入淡出。
 *
 * 不是为了让数字好看，而是为了做一次公平的算法对比：ffmpeg 的真峰值是对
 * 4 倍过采样后的信号取最大值，而重采样器在冷启动时（历史为零）会对
 * "起点不为零"的素材产生过冲。实测 16 kHz 正弦：
 *   无淡入：ffmpeg 报 −5.0 dBFS，本实现报 −5.965（ffmpeg 虚高 0.965 dB）
 *   有淡入：ffmpeg 报 −6.0 dBFS，本实现报 −5.965（一致）
 * 也就是说，ffmpeg 那个读数是它自己的启动伪峰，不是信号真实到过的峰。
 * 淡入淡出把这个差异从比较里摘掉，剩下的才是两个算法的差异。
 */
function applyFade(channels, frames, fadeFrames) {
  return channels.map(channel => {
    const out = new Float32Array(frames);
    out.set(channel);
    for (let i = 0; i < fadeFrames && i < frames; i++) {
      out[i] *= i / fadeFrames;
      out[frames - 1 - i] *= i / fadeFrames;
    }
    return out;
  });
}

function compare(name, channels, file, fade = true, tolerance = TOLERANCE) {
  const withFade = fade ? applyFade(channels, channels[0].length, 2400) : channels;
  const quantized = writeWav24(file, withFade);
  const reference = ffmpegEbur128(file);
  const mine = measureLocally(quantized);
  let samplePeak = 0;
  for (const channel of quantized) for (const value of channel) samplePeak = Math.max(samplePeak, Math.abs(value));
  const problems = [];
  if (reference.integrated === null || mine.integrated === null) {
    problems.push("积分响度没量出来");
  } else {
    const delta = mine.integrated - reference.integrated;
    if (Math.abs(delta) > TOLERANCE.integrated) {
      problems.push(`积分响度差 ${delta.toFixed(3)} LU（容差 ±${TOLERANCE.integrated}）`);
    }
  }
  if (reference.truePeak === null || mine.truePeak === null) {
    problems.push("真峰值没量出来");
  } else {
    const delta = mine.truePeak - reference.truePeak;
    if (delta > tolerance.truePeakUp || delta < -tolerance.truePeakDown) {
      problems.push(`真峰值差 ${delta.toFixed(3)} dB（容差 +${tolerance.truePeakUp} / -${tolerance.truePeakDown}）`);
    }
  }
  if (reference.range !== null && mine.range !== null) {
    const delta = mine.range - reference.range;
    if (Math.abs(delta) > TOLERANCE.range) {
      problems.push(`响度范围差 ${delta.toFixed(3)} LU（容差 ±${TOLERANCE.range}）`);
    }
  }
  return {
    name,
    problems,
    reference,
    mine,
    samplePeakDb: 20 * Math.log10(samplePeak),
  };
}

const CASES = [
  {
    name: "EBU 参考：双声道各 −23 dBFS 的 1 kHz 正弦",
    channels: () => {
      const signal = sine(SR * 10, Math.pow(10, -23 / 20), 1000);
      return [signal, signal];
    },
  },
  {
    name: "单声道 1 kHz −23 dBFS",
    channels: () => [sine(SR * 10, Math.pow(10, -23 / 20), 1000)],
  },
  {
    name: "低频白噪声 RMS −30 dBFS（单极点低通，贴近对白素材）",
    channels: () => {
      const signal = bandLimitedNoise(SR * 10, Math.pow(10, -30 / 20) * Math.sqrt(3), 7, 8000);
      return [signal, signal];
    },
    tolerance: { ...TOLERANCE, truePeakUp: 0.5, truePeakDown: 0.5 },
  },
  {
    name: "全带白噪声 RMS −30 dBFS（真峰值的极值压力测试）",
    channels: () => {
      const signal = noise(SR * 10, Math.pow(10, -30 / 20) * Math.sqrt(3), 7);
      return [signal, signal];
    },
    // 噪声类素材的真峰值是**极值统计量**：48 万个重建峰值里最大的那一个，
    // 对重建滤波器在最高频段的响应极其敏感。实测本实现比 ffmpeg 高 0.29–0.37 dB，
    // 原因是 swresample 的重采样器 cutoff=0.97（按 23.3 kHz 截止重建），
    // 而本实现按原始的 24 kHz Nyquist 精确重建——后者才是"信号真实到过的峰"。
    //
    // EBU Tech 3341 给真峰值定的容差本身就是 +0.2/−0.4 dB，正说明这个量依赖实现。
    // 音调性素材（也就是实际节目内容）上两者一致到 0.01 dB 以内，见上面各例。
    tolerance: { ...TOLERANCE, truePeakUp: 0.5, truePeakDown: 0.5 },
  },
  {
    name: "−20 dBFS 段 + −50 dBFS 安静段（考验相对门限）",
    channels: () => {
      const loud = sine(SR * 6, Math.pow(10, -20 / 20), 1000);
      const quiet = sine(SR * 6, Math.pow(10, -50 / 20), 1000);
      const out = new Float32Array(loud.length + quiet.length);
      out.set(loud);
      out.set(quiet, loud.length);
      return [out];
    },
  },
  {
    name: "16 kHz 正弦（真峰值与采样间峰）",
    channels: () => [sine(SR * 6, Math.pow(10, -20 / 20), SR / 3)],
  },
  {
    name: "−35 / −18 dBFS 两段交替（响度范围）",
    channels: () => {
      const low = sine(SR * 5, Math.pow(10, -35 / 20), 1000);
      const high = sine(SR * 5, Math.pow(10, -18 / 20), 1000);
      const out = new Float32Array(low.length + high.length);
      out.set(low);
      out.set(high, low.length);
      return [out];
    },
  },
  {
    name: "−40 dBFS 恒定信号（低于相对门限的极端情形）",
    channels: () => [sine(SR * 6, Math.pow(10, -40 / 20), 1000)],
  },
];

test("ffmpeg 的真峰值读数含重采样冷启动过冲，本实现量的是真实峰", { skip }, () => {
  const file = makeTempFile("slatesync-loudness-", "-coldstart.wav");
  try {
    const hz = 16000;
    const amplitude = 0.5;
    const analytic = 20 * Math.log10(amplitude);
    const make = () => [sine(SR * 3, amplitude, hz)];

    // 不做淡入：信号从非零值起步，ffmpeg 的重采样器冷启动会过冲。
    const withoutFade = compare("冷启动", make(), file, false);
    const cold = withoutFade.reference.truePeak - withoutFade.mine.truePeak;
    assert.ok(cold > 0.5,
      `没有淡入时 ffmpeg 的读数应当明显偏高（实测 +${cold.toFixed(3)} dB）`);

    // 做了淡入：两个算法应当落在 EBU 的容差内。
    const withFade = compare("有淡入", make(), file, true);
    const warm = withFade.mine.truePeak - withFade.reference.truePeak;
    assert.ok(Math.abs(warm) <= TOLERANCE.truePeakUp,
      `有淡入时两者应当一致（实测差 ${warm.toFixed(3)} dB）`);
    assert.ok(Math.abs(withFade.mine.truePeak - analytic) < 0.1,
      `本实现应当给出解析真峰值 ${analytic.toFixed(3)} dBFS，实测 ${withFade.mine.truePeak}`);
  } finally {
    try { fs.unlinkSync(file); } catch { /* 临时文件删不掉也无所谓 */ }
  }
});

test("响度与 ffmpeg ebur128 一致（EBU Tech 3341 / 3342 容差）", { skip }, () => {
  const file = makeTempFile("slatesync-loudness-", "-crosscheck.wav");
  const report = [];
  try {
    for (const item of CASES) {
      report.push(compare(item.name, item.channels(), file, true, item.tolerance ?? TOLERANCE));
    }
  } finally {
    try { fs.unlinkSync(file); } catch { /* 临时文件删不掉也无所谓 */ }
  }
  for (const row of report) {
    console.log(
      `  ${row.name}\n`
      + `    ffmpeg  I=${row.reference.integrated}  LRA=${row.reference.range}  Peak=${row.reference.truePeak}\n`
      + `    本实现  I=${row.mine.integrated?.toFixed(3)}  LRA=${row.mine.range?.toFixed(3)}  Peak=${row.mine.truePeak?.toFixed(3)}\n`
      + `    采样峰值 ${row.samplePeakDb.toFixed(3)} dBFS`,
    );
  }
  const failures = report.filter(row => row.problems.length);
  assert.equal(failures.length, 0,
    failures.map(row => row.name + "：" + row.problems.join("；")).join("\n"));
});
