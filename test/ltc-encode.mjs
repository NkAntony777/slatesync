// Minimal SMPTE LTC (biphase mark) audio encoder + PCM16 WAV writer for tests.
import { writeFileSync } from "node:fs";

const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

export function ltcFrameBits({ hh, mm, ss, ff, drop = false }) {
  const bits = new Array(80).fill(0);
  const put = (pos, value, width) => {
    for (let i = 0; i < width; i++) bits[pos + i] = (value >> i) & 1;
  };
  put(0, ff % 10, 4);
  put(8, Math.floor(ff / 10), 2);
  bits[10] = drop ? 1 : 0;
  put(16, ss % 10, 4);
  put(24, Math.floor(ss / 10), 3);
  put(32, mm % 10, 4);
  put(40, Math.floor(mm / 10), 3);
  put(48, hh % 10, 4);
  put(56, Math.floor(hh / 10), 2);
  for (let i = 0; i < 16; i++) bits[64 + i] = SYNC[i];
  return bits;
}

export function parseTc(text) {
  const [hh, mm, ss, ff] = text.split(/[:;]/).map(Number);
  return { hh, mm, ss, ff };
}

export function incrementTc({ hh, mm, ss, ff, nominal, drop }) {
  ff++;
  if (ff >= nominal) { ff = 0; ss++; }
  if (ss >= 60) { ss = 0; mm++; }
  if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  // Skip labels after entering the minute, not before the second/minute rollover.
  if (drop && ss === 0 && mm % 10 !== 0 && ff === 0) ff = Math.round(nominal / 30) * 2;
  return { hh, mm, ss, ff, nominal, drop };
}

// Returns Float32Array samples, plus map of each frame's bit-0 start sample.
export function encodeLtcAudio({
  sampleRate = 48000,
  fps = 25,
  startTc = "01:00:00:00",
  durationSeconds = 10,
  amplitude = 0.5,
  startDelaySeconds = 0,
  drop = false,
  nominalFps = null,
}) {
  const nominal = nominalFps ?? Math.round(fps);
  const bitSamples = sampleRate / (fps * 80);
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const startSample = Math.round(startDelaySeconds * sampleRate);
  const data = new Float32Array(totalSamples);

  let tc = { ...parseTc(startTc), nominal, drop };
  let pos = startSample;
  let level = 1;
  const frameStarts = new Map();

  while (pos < totalSamples) {
    frameStarts.set(`${tc.hh}:${tc.mm}:${tc.ss}:${tc.ff}`, pos);
    const bits = ltcFrameBits(tc);
    for (let b = 0; b < 80; b++) {
      const cellStart = pos + b * bitSamples;
      const mid = cellStart + bitSamples / 2;
      const cellEnd = cellStart + bitSamples;
      level = -level; // transition at cell boundary
      for (let i = Math.round(cellStart); i < Math.round(mid) && i < totalSamples; i++) {
        if (i >= 0) data[i] = level * amplitude;
      }
      if (bits[b]) {
        level = -level; // mid-cell transition for "1"
      }
      for (let i = Math.round(mid); i < Math.round(cellEnd) && i < totalSamples; i++) {
        if (i >= 0) data[i] = level * amplitude;
      }
    }
    pos += 80 * bitSamples;
    tc = { ...tc, ...incrementTc(tc) };
  }
  return { data, frameStarts, bitSamples };
}

export function encodeVoiceLike({ sampleRate = 48000, durationSeconds = 10, amplitude = 0.2 }) {
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const data = new Float32Array(totalSamples);
  let rng = 12345;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x40000000 - 1;
  };
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const syllable = Math.sin(2 * Math.PI * 3.7 * t) > -0.2 ? 1 : 0.15;
    data[i] = amplitude * syllable * (0.5 * rand() + 0.3 * Math.sin(2 * Math.PI * 137 * t) + 0.2 * Math.sin(2 * Math.PI * 311 * t));
  }
  return data;
}

export function writeWavPcm16(path, channelsData, sampleRate) {
  const channels = channelsData.length;
  const samples = channelsData[0].length;
  const blockAlign = channels * 2;
  const dataSize = samples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const v = Math.max(-1, Math.min(1, channelsData[ch][i]));
      buffer.writeInt16LE(Math.round(v * 32767), 44 + i * blockAlign + ch * 2);
    }
  }
  writeFileSync(path, buffer);
  return buffer;
}
