import { LTC_TUNING, normalizeLtcAnalysisSignal } from "./ltc-signal.js";
import { decodeLtcEdgesRobust } from "./ltc-robust.js";

export const LTC_WORKER_CODE = `
  const LITTLE = true;
  const LTC_TUNING = ${JSON.stringify(LTC_TUNING)};
  const T = LTC_TUNING;
  function normalizeLtcAnalysisSignal(data) {
    const T = LTC_TUNING.analysis;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const sample of data) {
      if (!Number.isFinite(sample)) return { data, analysisGain: 1, invalidSamples: true };
      min = Math.min(min, sample); max = Math.max(max, sample); sum += sample * sample;
    }
    if (!data.length) return { data, analysisGain: 1 };
    const peak = Math.max(Math.abs(min), Math.abs(max));
    const rms = Math.sqrt(sum / data.length);
    if (rms < T.rmsFloor || max - min < T.p2pFloor || (peak >= LTC_TUNING.peakFloor && max - min >= LTC_TUNING.p2pFloor)) {
      return { data, analysisGain: 1 };
    }
    const gain = Math.min(T.gainCap, T.gainTargetPeak / Math.max(peak, T.rmsFloor));
    const normalized = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) normalized[i] = data[i] * gain;
    return { data: normalized, analysisGain: gain };
  }
  const decodeLtcEdgesRobust = ${decodeLtcEdgesRobust.toString()};
  const LTC_SYNC_WORDS = ${JSON.stringify([
    "0011111111111101",
    "1011111111111100",
  ])};
  // Integer 16-bit sync keys, closed under bit reversal so one membership test
  // serves both polarities. Mirrors src/ltc-decoder.js exactly.
  const LTC_SYNC_KEYS = (() => {
    const keys = new Set();
    const toKey = word => { let key = 0; for (const char of word) key = ((key << 1) | (char === "1" ? 1 : 0)) & 0xffff; return key; };
    const reverse16 = key => { let out = 0; for (let i = 0; i < 16; i++) { out = (out << 1) | (key & 1); key >>>= 1; } return out; };
    for (const word of LTC_SYNC_WORDS) { keys.add(toKey(word)); keys.add(reverse16(toKey(word))); }
    return keys;
  })();
  function buildRollingSyncKeys(bits) {
    const length = bits.length;
    const keys = new Uint16Array(Math.max(0, length - 15));
    let key = 0;
    for (let i = 0; i < length; i++) {
      key = ((key << 1) | (bits[i] ? 1 : 0)) & 0xffff;
      if (i >= 15) keys[i - 15] = key;
    }
    return keys;
  }
  function syncAnchoredStarts(bits) {
    const starts = [];
    const keys = buildRollingSyncKeys(bits);
    for (let start = 0; start + 80 <= bits.length; start++) {
      if (LTC_SYNC_KEYS.has(keys[start + 64]) || LTC_SYNC_KEYS.has(keys[start])) starts.push(start);
    }
    return starts;
  }
  // Clock drift: see the long note in src/ltc-decoder.js. A correction is only
  // applied when it is both statistically supported and large enough to matter.
  const DRIFT = { deadband: 5e-4, max: 0.01, minWeight: 20000, maxJitter: 0.06, minCorrectionFrames: 0.25 };
  function createDriftTracker() { return { weight: 0, ratio: 1 }; }
  function observeDrift(tracker, observedHalfBitSamples, expectedHalfBitSamples, observedJitter, weight) {
    if (!(observedHalfBitSamples > 0) || !(expectedHalfBitSamples > 0)) return;
    if (observedJitter > DRIFT.maxJitter) return;
    if (!(weight > 0)) return;
    const ratio = observedHalfBitSamples / expectedHalfBitSamples;
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) > DRIFT.max) return;
    tracker.weight += weight;
    tracker.ratio += (ratio - tracker.ratio) * (weight / tracker.weight);
  }
  function driftRatioFor(tracker) {
    if (!tracker || tracker.weight < DRIFT.minWeight) return 1;
    const delta = Math.abs(tracker.ratio - 1);
    return delta < DRIFT.deadband || delta > DRIFT.max ? 1 : tracker.ratio;
  }
  function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a || 1n; }
  function abs(n) { return n < 0n ? -n : n; }
  function frac(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = gcd(abs(n), d); return { n: n / g, d: d / g }; }
  function mulFrac(a, b) { return frac(a.n * b.n, a.d * b.d); }
  function divFrac(a, b) { return frac(a.n * b.d, a.d * b.n); }
  function roundFrac(value) { return value.n >= 0n ? (value.n + value.d / 2n) / value.d : -((-value.n + value.d / 2n) / value.d); }
  function parseFps(value) {
    const presets = {
      "23.976": { rate: frac(24000n, 1001n), nominal: 24n, drop: false },
      "23.98": { rate: frac(24000n, 1001n), nominal: 24n, drop: false },
      "24": { rate: frac(24n), nominal: 24n, drop: false },
      "25": { rate: frac(25n), nominal: 25n, drop: false },
      "29.97": { rate: frac(30000n, 1001n), nominal: 30n, drop: false },
      "29.97df": { rate: frac(30000n, 1001n), nominal: 30n, drop: true },
      "30": { rate: frac(30n), nominal: 30n, drop: false },
      "48": { rate: frac(48n), nominal: 48n, drop: false },
      "50": { rate: frac(50n), nominal: 50n, drop: false },
      "59.94": { rate: frac(60000n, 1001n), nominal: 60n, drop: false },
      "59.94df": { rate: frac(60000n, 1001n), nominal: 60n, drop: true },
      "60": { rate: frac(60n), nominal: 60n, drop: false },
      "96": { rate: frac(96n), nominal: 96n, drop: false },
      "100": { rate: frac(100n), nominal: 100n, drop: false },
      "119.88": { rate: frac(120000n, 1001n), nominal: 120n, drop: false },
      "119.88df": { rate: frac(120000n, 1001n), nominal: 120n, drop: true },
      "120": { rate: frac(120n), nominal: 120n, drop: false },
    };
    return { ...presets[value], value };
  }
  function fpsRate(fps) { return fps.rate || fps; }
  function dropFramesFor(fps) {
    if (!fps.drop) return 0n;
    if (fps.nominal === 30n) return 2n;
    if (fps.nominal === 60n) return 4n;
    if (fps.nominal === 120n) return 8n;
    return 0n;
  }
  function timecodeToFrames(raw, fps) {
    const parts = raw.match(/\\d+/g).map(BigInt);
    const [hh, mm, ss, ff] = parts;
    const nominalFrames = (((hh * 60n + mm) * 60n) + ss) * fps.nominal + ff;
    const dropFrames = dropFramesFor(fps);
    if (!dropFrames) return nominalFrames;
    const totalMinutes = hh * 60n + mm;
    return nominalFrames - dropFrames * (totalMinutes - totalMinutes / 10n);
  }
  function framesToSamples(frames, sampleRate, fps) {
    return roundFrac(mulFrac(divFrac(frac(frames), fpsRate(fps)), frac(BigInt(sampleRate))));
  }
  function normalizeTimeReference(value, sampleRate) {
    const daySamples = BigInt(sampleRate) * 86400n;
    if (daySamples <= 0n) throw new Error("invalid sample rate");
    return ((value % daySamples) + daySamples) % daySamples;
  }
  function frameDigitsFor(fps) { return fps.nominal >= 100n ? 3 : 2; }
  function timecodeSeparator(fps) { return fps.drop ? ";" : ":"; }
  function readAudioSample(view, offset, record) {
    const isFloat = record.isFloat || record.audioFormat === 3;
    if (isFloat && record.bitsPerSample === 32) return view.getFloat32(offset, LITTLE);
    if (isFloat && record.bitsPerSample === 64) return view.getFloat64(offset, LITTLE);
    if (record.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
    if (record.bitsPerSample === 16) return view.getInt16(offset, LITTLE) / 32768;
    if (record.bitsPerSample === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    if (record.bitsPerSample === 32) return view.getInt32(offset, LITTLE) / 2147483648;
    throw new Error("unsupported bit depth");
  }
  const LtcWorkerDecoder = {
    syncWords: new Set(["0011111111111101", "1011111111111100"]),
    readChannel(buffer, record, channelIndex) {
      const view = new DataView(buffer);
      const samples = Math.floor(view.byteLength / record.blockAlign);
      const bytesPerSample = record.bitsPerSample / 8;
      const channelByteOffset = channelIndex * bytesPerSample;
      const data = new Float32Array(samples);
      let min = Infinity, max = -Infinity, sumSquares = 0, clipped = 0;
      for (let i = 0; i < samples; i++) {
        const sample = readAudioSample(view, i * record.blockAlign + channelByteOffset, record);
        data[i] = sample;
        min = Math.min(min, sample);
        max = Math.max(max, sample);
        sumSquares += sample * sample;
        if (Math.abs(sample) > 0.98) clipped++;
      }
      const filtered = this.highPass(data, record.sampleRate);
      const analysis = normalizeLtcAnalysisSignal(filtered);
      return { ...this.channelStats(analysis.data), data: analysis.data, analysisGain: analysis.analysisGain, rawPeak: Math.max(Math.abs(min), Math.abs(max)), rawP2p: max - min, rawRms: Math.sqrt(sumSquares / Math.max(1, samples)), rawClippedRatio: clipped / Math.max(1, samples) };
    },
    highPass(data, sampleRate, cutoff = 120) {
      if (!data.length) return data;
      const out = new Float32Array(data.length);
      const dt = 1 / sampleRate;
      const rc = 1 / (2 * Math.PI * cutoff);
      const alpha = rc / (rc + dt);
      let previousIn = data[0], previousOut = 0;
      for (let i = 1; i < data.length; i++) {
        const value = alpha * (previousOut + data[i] - previousIn);
        out[i] = value;
        previousIn = data[i];
        previousOut = value;
      }
      return out;
    },
    lowPass(data, sampleRate, cutoff = 9000) {
      if (!data.length) return data;
      const out = new Float32Array(data.length);
      const dt = 1 / sampleRate;
      const rc = 1 / (2 * Math.PI * cutoff);
      const alpha = dt / (rc + dt);
      let previousOut = data[0];
      out[0] = previousOut;
      for (let i = 1; i < data.length; i++) {
        previousOut += alpha * (data[i] - previousOut);
        out[i] = previousOut;
      }
      return out;
    },
    conditionLtcSignal(channel, sampleRate, options = {}) {
      const highPassCutoff = options.highPassCutoff || 300;
      const lowPassCutoff = options.lowPassCutoff || 9000;
      const gainTarget = options.gainTarget || 0.32;
      const drive = options.drive || 2.2;
      const profile = options.profile || "balanced";
      const highPassed = this.highPass(channel.data, sampleRate, highPassCutoff);
      const lowPassed = this.lowPass(highPassed, sampleRate, Math.min(lowPassCutoff, sampleRate * 0.45));
      const stats = this.channelStats(lowPassed);
      const gain = Math.min(T.analysis.conditioningGainCap, gainTarget / Math.max(stats.rms, T.analysis.rmsFloor));
      const norm = Math.tanh(drive);
      const data = new Float32Array(lowPassed.length);
      for (let i = 0; i < lowPassed.length; i++) data[i] = Math.tanh(lowPassed[i] * gain * drive) / norm;
      return { ...this.channelStats(data), data, rawPeak: channel.rawPeak, rawRms: channel.rawRms, conditioned: true, conditionProfile: profile };
    },
    channelVariants(channel, sampleRate) {
      return [
        { ...channel, conditioned: false },
        this.conditionLtcSignal(channel, sampleRate),
        this.conditionLtcSignal(channel, sampleRate, { highPassCutoff: 600, lowPassCutoff: 7000, gainTarget: 0.2, drive: 1.2, profile: "interference" }),
      ];
    },
    channelStats(data, start = 0, end = data.length) {
      let min = Infinity, max = -Infinity, sumSquares = 0, clipped = 0;
      const length = Math.max(0, end - start);
      for (let i = start; i < end; i++) {
        const sample = data[i];
        min = Math.min(min, sample);
        max = Math.max(max, sample);
        sumSquares += sample * sample;
        if (Math.abs(sample) > 0.98) clipped++;
      }
      if (!length) return { min: 0, max: 0, peak: 0, p2p: 0, rms: 0, clippedRatio: 0 };
      return { min, max, peak: Math.max(Math.abs(min), Math.abs(max)), p2p: max - min, rms: Math.sqrt(sumSquares / length), clippedRatio: clipped / length };
    },
    channelWindows(channel, sampleRate) {
      const windowSamples = Math.max(sampleRate * 4, 1);
      const hopSamples = Math.max(sampleRate * 2, 1);
      if (channel.data.length <= windowSamples) return [{ ...this.channelStats(channel.data), data: channel.data, baseSample: 0, windowStart: 0, windowEnd: channel.data.length }];
      const windows = [];
      for (let start = 0; start < channel.data.length; start += hopSamples) {
        const end = Math.min(channel.data.length, start + windowSamples);
        if (end - start < sampleRate) break;
        windows.push({ ...this.channelStats(channel.data, start, end), data: channel.data.subarray(start, end), baseSample: start, windowStart: start, windowEnd: end });
        if (end === channel.data.length) break;
      }
      return windows;
    },
    quickRejectChannel(channel, sampleRate) {
      if (channel.peak < T.peakFloor || channel.p2p < T.p2pFloor) return { reject: true, reason: "level" };
      const totalSamples = channel.data.length;
      if (totalSamples < sampleRate) return { reject: false, reason: "short" };
      const stats = this.channelStats(channel.data, 0, totalSamples);
      if (stats.peak < T.peakFloor || stats.p2p < T.p2pFloor) return { reject: true, reason: "window-level" };
      const center = (stats.max + stats.min) / 2;
      const hysteresis = Math.max(stats.p2p * T.hysteresis.p2p, stats.rms * T.hysteresis.rms, T.hysteresis.floor);
      const minHalf = sampleRate / (T.maxFps * 80 * 2) * T.minHalfScale;
      const maxHalf = sampleRate / (T.minFps * 80 * 2) * T.maxHalfScale;
      const windowSamples = sampleRate * 2;
      const hopSamples = sampleRate;
      const bucketCount = Math.max(1, Math.ceil(Math.max(1, totalSamples - windowSamples) / hopSamples) + 1);
      const intervalsByBucket = new Uint32Array(bucketCount);
      const plausibleByBucket = new Uint32Array(bucketCount);
      let intervals = 0, plausible = 0;
      let state = channel.data[0] >= center ? 1 : -1;
      let lastEdge = null;
      for (let i = 1; i < totalSamples; i++) {
        const sample = channel.data[i];
        const nextState = sample > center + hysteresis ? 1 : sample < center - hysteresis ? -1 : state;
        if (nextState !== state) {
          if (lastEdge !== null) {
            const interval = i - lastEdge;
            const bucket = Math.min(bucketCount - 1, Math.floor(i / hopSamples));
            intervalsByBucket[bucket]++;
            intervals++;
            if (interval >= minHalf && interval <= maxHalf) {
              plausibleByBucket[bucket]++;
              plausible++;
            }
          }
          lastEdge = i;
        }
        state = nextState;
      }
      let bestIntervals = 0, bestPlausible = 0;
      for (let i = 0; i < bucketCount; i++) {
        const windowIntervals = intervalsByBucket[i] + (intervalsByBucket[i + 1] || 0);
        const windowPlausible = plausibleByBucket[i] + (plausibleByBucket[i + 1] || 0);
        if (windowPlausible > bestPlausible) {
          bestPlausible = windowPlausible;
          bestIntervals = windowIntervals;
        }
      }
      if (bestIntervals < T.edgeIntervalMin) return { reject: true, reason: "few-ltc-edges" };
      if (bestPlausible < T.edgePlausibleMin || bestPlausible / Math.max(1, bestIntervals) < T.edgePlausibleRatio) return { reject: true, reason: "aperiodic" };
      return { reject: false, reason: "plausible", edges: bestPlausible };
    },
    estimateHalfBitSamples(channel, sampleRate) {
      let best = null;
      for (const window of this.channelWindows(channel, sampleRate)) {
        const stats = window;
        if (stats.peak < T.peakFloor || stats.p2p < T.p2pFloor) continue;
        const center = (stats.max + stats.min) / 2;
        const hysteresis = Math.max(stats.p2p * T.hysteresis.p2p, stats.rms * T.hysteresis.rms, T.hysteresis.floor);
        const minHalf = sampleRate / (T.maxFps * 80 * 2) * T.minHalfScale;
        const maxHalf = sampleRate / (T.minFps * 80 * 2) * T.maxHalfScale;
        const intervals = [];
        let state = window.data[0] >= center ? 1 : -1;
        let lastEdge = null;
        for (let i = 1; i < window.data.length; i++) {
          const sample = window.data[i];
          const nextState = sample > center + hysteresis ? 1 : sample < center - hysteresis ? -1 : state;
          if (nextState !== state) {
            if (lastEdge !== null) {
              const interval = i - lastEdge;
              if (interval >= minHalf && interval <= maxHalf) intervals.push(interval);
            }
            lastEdge = i;
          }
          state = nextState;
        }
        if (intervals.length < 700) continue;
        intervals.sort((a, b) => a - b);
        const median = intervals[Math.floor(intervals.length / 2)];
        const half = intervals.filter(value => Math.abs(value - median) / median < 0.18);
        if (half.length < 500) continue;
        const mean = half.reduce((sum, value) => sum + value, 0) / half.length;
        const jitter = Math.sqrt(half.reduce((sum, value) => sum + (value - mean) ** 2, 0) / half.length) / Math.max(mean, 1);
        const score = half.length * (1 - Math.min(jitter, 0.5));
        if (!best || score > best.score) best = { halfBitSamples: mean, score, jitter, count: half.length };
      }
      return best;
    },
    fpsCandidatesForChannel(channel, sampleRate, preferredValue, values) {
      const selected = new Set([preferredValue]);
      const estimate = this.estimateHalfBitSamples(channel, sampleRate);
      if (!estimate) return values;
      const ranked = values
        .map(value => {
          const fps = parseFps(value);
          const fpsValue = Number(fps.rate.n) / Number(fps.rate.d);
          const expectedHalf = sampleRate / (fpsValue * 80 * 2);
          return { value, error: Math.abs(expectedHalf - estimate.halfBitSamples) / expectedHalf };
        })
        .sort((a, b) => a.error - b.error);
      for (const item of ranked.slice(0, 4)) selected.add(item.value);
      for (const item of [...selected]) {
        if (item === "29.97") selected.add("29.97df");
        if (item === "29.97df") selected.add("29.97");
        if (item === "59.94") selected.add("59.94df");
        if (item === "59.94df") selected.add("59.94");
        if (item === "119.88") selected.add("119.88df");
        if (item === "119.88df") selected.add("119.88");
      }
      return ranked
        .filter(item => selected.has(item.value))
        .sort((a, b) => a.error - b.error)
        .map(item => item.value);
    },
    findEdges(channel, expectedHalfBitSamples) {
      if (channel.peak < T.peakFloor || channel.p2p < T.p2pFloor) return [];
      const center = (channel.max + channel.min) / 2;
      const hysteresis = Math.max(channel.p2p * T.hysteresis.p2p, channel.rms * T.hysteresis.rms, T.hysteresis.floor);
      const minEdgeDistance = Math.max(2, expectedHalfBitSamples * 0.35);
      const baseSample = channel.baseSample || 0;
      const edges = [];
      let state = channel.data[0] >= center ? 1 : -1;
      let lastEdge = -Infinity;
      for (let i = 1; i < channel.data.length; i++) {
        const sample = channel.data[i];
        const nextState = sample > center + hysteresis ? 1 : sample < center - hysteresis ? -1 : state;
        if (nextState !== state && i - lastEdge >= minEdgeDistance) {
          const prev = channel.data[i - 1];
          const denom = sample - prev;
          const crossing = denom === 0 ? i : (i - 1) + (center - prev) / denom;
          edges.push(crossing + baseSample);
          lastEdge = crossing;
        }
        state = nextState;
      }
      return edges;
    },
    decodeBits(edges, expectedHalfBitSamples) {
      return decodeLtcEdgesRobust(edges, expectedHalfBitSamples);
    },
    decodeSoftGrid(channel, bitSamples, phase, radius) {
      const bits = [], bitStarts = [], bitEnds = [], margins = [];
      const baseSample = channel.baseSample || 0;
      const half = bitSamples / 2;
      for (let start = phase; start + bitSamples < channel.data.length; start += bitSamples) {
        let first = 0, second = 0, firstWeight = 0, secondWeight = 0;
        const firstCenter = start + half * 0.5, secondCenter = start + half * 1.5;
        for (let offset = -radius; offset <= radius; offset++) {
          const firstIndex = Math.round(firstCenter + offset), secondIndex = Math.round(secondCenter + offset);
          if (firstIndex >= 0 && firstIndex < channel.data.length) { first += channel.data[firstIndex]; firstWeight++; }
          if (secondIndex >= 0 && secondIndex < channel.data.length) { second += channel.data[secondIndex]; secondWeight++; }
        }
        first /= Math.max(1, firstWeight);
        second /= Math.max(1, secondWeight);
        const zeroScore = Math.abs(first + second), oneScore = Math.abs(first - second);
        bits.push(oneScore > zeroScore ? 1 : 0);
        bitStarts.push(baseSample + start);
        bitEnds.push(baseSample + start + bitSamples);
        margins.push(Math.abs(oneScore - zeroScore) / (Math.abs(first) + Math.abs(second) + 1e-9));
      }
      return { bits, bitStarts, bitEnds, margins, rejected: 0, trackedHalfBitSamples: half, observedHalfBitSamples: half, observedJitter: 0 };
    },
    softPhaseCandidates(channel, bitSamples) {
      const phaseStep = 0.5;
      const radius = Math.max(1, Math.floor(bitSamples * 0.08));
      const phases = [];
      const edgeStrength = pos => {
        let before = 0, after = 0, weight = 0;
        for (let offset = 1; offset <= radius; offset++) {
          const left = Math.round(pos - offset), right = Math.round(pos + offset);
          if (left >= 0 && right < channel.data.length) {
            before += channel.data[left];
            after += channel.data[right];
            weight++;
          }
        }
        return Math.abs(after / Math.max(1, weight) - before / Math.max(1, weight));
      };
      for (let phase = 0; phase < bitSamples; phase += phaseStep) {
        let score = 0, count = 0;
        const maxChecks = 1200;
        const stride = Math.max(1, Math.floor((channel.data.length / bitSamples) / maxChecks));
        for (let bit = 1; phase + bit * bitSamples < channel.data.length - radius; bit += stride) {
          score += edgeStrength(phase + bit * bitSamples);
          count++;
        }
        phases.push({ phase, score: score / Math.max(1, count) });
      }
      const selected = new Set();
      for (const item of phases.sort((a, b) => b.score - a.score).slice(0, 24)) {
        for (const offset of [-phaseStep, 0, phaseStep]) {
          let phase = item.phase + offset;
          while (phase < 0) phase += bitSamples;
          while (phase >= bitSamples) phase -= bitSamples;
          selected.add(Number(phase.toFixed(3)));
        }
      }
      return [...selected].sort((a, b) => a - b);
    },
    softSyncMatch(bits, margins) {
      let best = null;
      for (const word of this.syncWords) {
        let errors = 0, penalty = 0;
        for (let i = 0; i < word.length; i++) {
          const expected = word[i] === "1" ? 1 : 0;
          if (bits[i] !== expected) {
            errors++;
            penalty += margins[i] || 0;
          }
        }
        const score = errors * T.soft.syncErrorWeight + penalty;
        if (!best || score < best.score) best = { errors, penalty, score };
      }
      if (!best) return null;
      if (best.errors === 0) return { ...best, confidence: 1 };
      if (best.errors <= 2 && best.penalty <= 1.25) return { ...best, confidence: Math.max(0, 1 - best.score / T.soft.syncScoreScale) };
      return null;
    },
    softFrameAt(decoded, start, fps, reverse = false, strictDrop = true) {
      if (start < 0 || start + 80 > decoded.bits.length) return null;
      const bits = decoded.bits.slice(start, start + 80);
      const margins = decoded.margins.slice(start, start + 80);
      const candidateBits = reverse ? bits.slice().reverse() : bits;
      const candidateMargins = reverse ? margins.slice().reverse() : margins;
      const sync = this.softSyncMatch(candidateBits.slice(64, 80), candidateMargins.slice(64, 80));
      if (!sync) return null;
      const frame = this.parseFrame(candidateBits, fps) || this.softParseFrame(candidateBits, candidateMargins, fps);
      if (!frame || (strictDrop && frame.drop !== Boolean(fps.drop))) return null;
      const bitMargin = candidateMargins.reduce((sum, value) => sum + value, 0) / Math.max(1, candidateMargins.length);
      const digitConfidence = frame.softDigitCost == null ? 1 : Math.max(0, 1 - frame.softDigitCost / 2);
      return { ...frame, bitStart: start, sampleStart: decoded.bitStarts[start], sampleEnd: decoded.bitEnds[start + 79], reverse, softSyncErrors: sync.errors, softSyncPenalty: sync.penalty, softBitMargin: bitMargin, softFrameConfidence: Math.max(0, Math.min(1, bitMargin * 0.58 + sync.confidence * 0.27 + digitConfidence * 0.15)) };
    },
    softBcdValue(bits, margins, onesIndexes, tensIndexes, maxValue) {
      let best = null;
      const costFor = (indexes, value) => {
        let cost = 0, errors = 0;
        for (let place = 0; place < indexes.length; place++) {
          const expected = (value >> place) & 1;
          const index = indexes[place];
          if (bits[index] !== expected) {
            cost += margins[index] || 0;
            errors++;
          }
        }
        return { cost, errors };
      };
      for (let value = 0; value <= maxValue; value++) {
        const ones = value % 10, tens = Math.floor(value / 10);
        const onesCost = costFor(onesIndexes, ones);
        const tensCost = costFor(tensIndexes, tens);
        const candidate = { value, cost: onesCost.cost + tensCost.cost, errors: onesCost.errors + tensCost.errors };
        if (!best || candidate.cost < best.cost) best = candidate;
      }
      return best;
    },
    softParseFrame(bits, margins, fps) {
      const nominal = Number(fps.nominal);
      const ff = this.softBcdValue(bits, margins, [0, 1, 2, 3], [8, 9], nominal - 1);
      const ss = this.softBcdValue(bits, margins, [16, 17, 18, 19], [24, 25, 26], 59);
      const mm = this.softBcdValue(bits, margins, [32, 33, 34, 35], [40, 41, 42], 59);
      const hh = this.softBcdValue(bits, margins, [48, 49, 50, 51], [56, 57], 23);
      const dropCost = bits[10] === Boolean(fps.drop) ? { cost: 0, errors: 0 } : { cost: margins[10] || 0, errors: 1 };
      const softDigitCost = ff.cost + ss.cost + mm.cost + hh.cost + dropCost.cost;
      const softDigitErrors = ff.errors + ss.errors + mm.errors + hh.errors + dropCost.errors;
      if (softDigitCost > T.soft.digitCostMax || softDigitErrors > T.soft.digitErrorsMax) return null;
      const timecode = String(hh.value).padStart(2, "0") + ":" + String(mm.value).padStart(2, "0") + ":" + String(ss.value).padStart(2, "0") + timecodeSeparator(fps) + String(ff.value).padStart(frameDigitsFor(fps), "0");
      try {
        return { timecode, frames: timecodeToFrames(timecode, fps), drop: Boolean(fps.drop), softDigitCost, softDigitErrors };
      } catch (error) {
        return null;
      }
    },
    chooseSoftSyncCandidate(channel, record, fps, stats, expectedHalfBitSamples, strictDrop = true) {
      const SOFT_MIN_RUN_FRAMES = 3;
      const SOFT_MIN_SUPPORT = 3;
      const SOFT_CONFIRM_RUN_FRAMES = 6;
      const bitSamples = expectedHalfBitSamples * 2;
      const radius = Math.max(1, Math.floor(expectedHalfBitSamples * 0.35));
      const candidates = [];
      const absBigInt = value => value < 0n ? -value : value;
      for (const phase of this.softPhaseCandidates(channel, bitSamples)) {
        const decoded = this.decodeSoftGrid(channel, bitSamples, phase, radius);
        const frames = [];
        for (let start = 0; start + 80 <= decoded.bits.length; start++) {
          const frame = this.softFrameAt(decoded, start, fps, false, strictDrop);
          if (!frame) continue;
          const sampleOffset = Math.max(0, Math.round(frame.sampleStart || 0));
          const newTimeReference = normalizeTimeReference(framesToSamples(frame.frames, record.sampleRate, fps) - BigInt(sampleOffset), record.sampleRate);
          const frameMargins = decoded.margins.slice(start, start + 80);
          const softMargin = frameMargins.reduce((sum, value) => sum + value, 0) / Math.max(1, frameMargins.length);
          if (softMargin < T.soft.frameMarginMin) continue;
          frames.push({ ...frame, sampleOffset, newTimeReference, softMargin });
          candidates.push({ ...frame, sampleOffset, newTimeReference, softMargin, measuredHalfBitSamples: expectedHalfBitSamples, halfBitError: T.halfBitError.halfScoreSpan, rejectRatio: 0, observedJitter: 0 });
        }
        const frameByStart = new Map(frames.map(frame => [frame.bitStart, frame]));
        for (const first of frames) {
          const run = [first];
          for (let offset = 1; offset < 6; offset++) {
            const next = frameByStart.get(first.bitStart + offset * 80);
            if (!next) break;
            const expected = first.frames + BigInt(offset);
            if (next.frames !== expected) break;
            const expectedSample = first.sampleOffset + Math.round(offset * 80 * bitSamples);
            if (Math.abs(next.sampleOffset - expectedSample) > Math.max(8, bitSamples * 0.75)) break;
            run.push(next);
          }
          if (run.length < SOFT_MIN_RUN_FRAMES) continue;
          const last = run[run.length - 1];
          const sampleOffset = Math.max(0, Math.round(first.sampleStart || 0));
          const newTimeReference = normalizeTimeReference(framesToSamples(first.frames, record.sampleRate, fps) - BigInt(sampleOffset), record.sampleRate);
          const softMargin = run.reduce((sum, frame) => sum + frame.softMargin, 0) / run.length;
          const softFrameConfidence = run.reduce((sum, frame) => sum + frame.softFrameConfidence, 0) / run.length;
          candidates.push({ ...first, sampleOffset, newTimeReference, softMargin, softFrameConfidence, softRunFrames: run.length, measuredHalfBitSamples: (last.sampleEnd - first.sampleStart) / Math.max(1, run.length * 80 * 2), halfBitError: 0.0045, rejectRatio: 0, observedJitter: 0 });
        }
      }
      let best = null;
      for (const candidate of candidates) {
        const cluster = candidates.filter(item => item.timecode === candidate.timecode && absBigInt(item.newTimeReference - candidate.newTimeReference) <= 4n);
        const runFrames = candidate.softRunFrames || 1;
        if (runFrames < SOFT_MIN_RUN_FRAMES || cluster.length < SOFT_MIN_SUPPORT) continue;
        const clusterMargin = cluster.reduce((sum, item) => sum + item.softMargin, 0) / cluster.length;
        if (clusterMargin < 0.64) continue;
        const frameConfidence = cluster.reduce((sum, item) => sum + (item.softFrameConfidence || 0), 0) / cluster.length;
        const confidence = Math.max(0, Math.min(0.76, 0.42 + clusterMargin * 0.12 + frameConfidence * 0.1 + Math.min(cluster.length, 12) * 0.007 + Math.min(runFrames, 4) * 0.035));
        const softCandidate = { ...candidate, frames: candidate.frames.toString(), newTimeReference: candidate.newTimeReference.toString(), confidence, lockedFrames: runFrames, softSync: true, softSyncSupport: cluster.length, softSyncMargin: clusterMargin, softFrameConfidence: frameConfidence, requiresConfirmation: true, softConfirmOnly: runFrames < SOFT_CONFIRM_RUN_FRAMES, diagnostics: { peak: stats.peak, rms: stats.rms, p2p: stats.p2p, decodedBits: 80, rejectedEdges: 0, observedJitter: 0, measuredHalfBitSamples: expectedHalfBitSamples, halfBitError: candidate.halfBitError, rejectRatio: 0, softSyncSupport: cluster.length, softSyncMargin: clusterMargin, softFrameConfidence: frameConfidence, windowStart: stats.windowStart || 0, windowEnd: stats.windowEnd || stats.data?.length || 0 } };
        const quality = this.qualityFor(softCandidate);
        softCandidate.qualityLabel = quality.label; softCandidate.qualityRank = quality.rank;
        if (!best || softCandidate.lockedFrames > best.lockedFrames || (softCandidate.lockedFrames === best.lockedFrames && softCandidate.softSyncSupport > best.softSyncSupport) || (softCandidate.lockedFrames === best.lockedFrames && softCandidate.softSyncSupport === best.softSyncSupport && softCandidate.softSyncMargin > best.softSyncMargin)) best = softCandidate;
      }
      return best;
    },
    hasSync(bits) { return this.syncWords.has(bits.slice(64, 80).join("")); },
    parseFrame(bits, fps) {
      const value = indexes => indexes.reduce((sum, index, place) => sum + (bits[index] ? 2 ** place : 0), 0);
      const ff = value([0, 1, 2, 3]) + value([8, 9]) * 10;
      const ss = value([16, 17, 18, 19]) + value([24, 25, 26]) * 10;
      const mm = value([32, 33, 34, 35]) + value([40, 41, 42]) * 10;
      const hh = value([48, 49, 50, 51]) + value([56, 57]) * 10;
      if (hh > 23 || mm > 59 || ss > 59 || ff >= Number(fps.nominal)) return null;
      const timecode = String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + timecodeSeparator(fps) + String(ff).padStart(frameDigitsFor(fps), "0");
      try { return { timecode, frames: timecodeToFrames(timecode, fps), drop: Boolean(bits[10]) }; } catch (error) { return null; }
    },
    frameAt(decoded, start, fps, reverse = false, strictDrop = true) {
      if (start < 0 || start + 80 > decoded.bits.length) return null;
      const bits = decoded.bits.slice(start, start + 80);
      const candidateBits = reverse ? bits.slice().reverse() : bits;
      if (!this.hasSync(candidateBits)) return null;
      const frame = this.parseFrame(candidateBits, fps);
      if (!frame || (strictDrop && frame.drop !== Boolean(fps.drop))) return null;
      return { ...frame, bitStart: start, sampleStart: decoded.bitStarts[start], sampleEnd: decoded.bitEnds[start + 79], reverse };
    },
    consecutiveRun(decoded, start, fps, reverse = false, strictDrop = true) {
      const frames = [];
      for (let offset = 0; offset < 12; offset++) {
        const frame = this.frameAt(decoded, start + offset * 80, fps, reverse, strictDrop);
        if (!frame) break;
        if (frames.length) {
          const expected = reverse ? frames[frames.length - 1].frames - 1n : frames[frames.length - 1].frames + 1n;
          if (frame.frames !== expected) break;
        }
        frames.push(frame);
      }
      return frames;
    },
    qualityFor(candidate) {
      if (candidate.softSync && (candidate.softConfirmOnly || candidate.lockedFrames < T.quality.lowSoftFrames)) return { label: "低", rank: 1 };
      if (candidate.confidence >= T.quality.highConfidence && candidate.lockedFrames >= T.quality.highFrames && candidate.halfBitError <= T.halfBitError.high && candidate.rejectRatio <= T.quality.highReject) return { label: "高", rank: 3 };
      if (candidate.confidence >= T.quality.mediumConfidence && candidate.lockedFrames >= T.quality.mediumFrames && candidate.halfBitError <= T.halfBitError.medium && candidate.rejectRatio <= T.quality.mediumReject) return { label: "中", rank: 2 };
      return { label: "低", rank: 1 };
    },
    isHighQualityCandidate(candidate) {
      return candidate?.qualityRank >= 3 && candidate.lockedFrames >= T.quality.highFrames && candidate.halfBitError <= T.halfBitError.high && candidate.rejectRatio <= T.quality.highReject && candidate.confidence >= T.quality.highConfidence;
    },
    isDefinitiveCandidate(candidate) {
      return this.isHighQualityCandidate(candidate) && candidate.halfBitError <= T.halfBitError.definitive;
    },
    compareResults(a, b) {
      if ((b.qualityRank || 0) !== (a.qualityRank || 0)) return (b.qualityRank || 0) - (a.qualityRank || 0);
      if (Math.abs((a.halfBitError || 1) - (b.halfBitError || 1)) > T.halfBitError.definitive) return (a.halfBitError || 1) - (b.halfBitError || 1);
      if ((b.lockedFrames || 0) !== (a.lockedFrames || 0)) return (b.lockedFrames || 0) - (a.lockedFrames || 0);
      if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
      if (Boolean(a.reverse) !== Boolean(b.reverse)) return Number(a.reverse) - Number(b.reverse);
      return (a.sampleOffset || 0) - (b.sampleOffset || 0);
    },
    chooseCandidate(decoded, record, fps, stats, expectedHalfBitSamples, strictDrop = true, driftRatio = 1) {
      const fpsValue = Number(fps.rate.n) / Number(fps.rate.d);
      let best = null;
      for (const start of syncAnchoredStarts(decoded.bits)) {
        for (const reverse of [false, true]) {
          const run = this.consecutiveRun(decoded, start, fps, reverse, strictDrop);
          if (run.length < 2) continue;
          const first = run[0], last = run[run.length - 1];
          // Drift-correct the file-start offset; see src/ltc-decoder.js.
          const rawSampleOffset = Math.max(0, Math.round(first.sampleStart || 0));
          const samplesPerFrame = record.sampleRate / fpsValue;
          const corrected = Math.max(0, Math.round(rawSampleOffset / driftRatio));
          const sampleOffset = Math.abs(corrected - rawSampleOffset) >= samplesPerFrame * DRIFT.minCorrectionFrames ? corrected : rawSampleOffset;
          const newTimeReference = normalizeTimeReference(framesToSamples(first.frames, record.sampleRate, fps) - BigInt(sampleOffset), record.sampleRate);
          const measuredHalfBitSamples = (last.sampleEnd - first.sampleStart) / Math.max(1, run.length * 80 * 2);
          const halfBitError = Math.abs(measuredHalfBitSamples - expectedHalfBitSamples) / expectedHalfBitSamples;
          const rejectRatio = decoded.rejected / Math.max(1, decoded.rejected + decoded.bits.length);
          const lockScore = Math.min(1, run.length / 8);
          const halfScore = Math.max(0, Math.min(1, 1 - halfBitError / T.halfBitError.halfScoreSpan));
          const consistencyScore = Math.max(0, Math.min(1, 1 - (decoded.observedJitter || 0) / 0.18));
          const edgeScore = Math.min(1, decoded.bits.length / 320);
          const levelScore = Math.min(1, stats.p2p / 0.6);
          const confidence = Math.max(0, Math.min(1, lockScore * 0.3 + halfScore * 0.3 + consistencyScore * 0.12 + edgeScore * 0.12 + levelScore * 0.12 - rejectRatio * 0.18 + 0.04));
          const candidate = { ...first, frames: first.frames.toString(), sampleOffset, newTimeReference: newTimeReference.toString(), confidence, lockedFrames: run.length, reverse, measuredHalfBitSamples, halfBitError, rejectRatio, observedJitter: decoded.observedJitter, driftRatio, driftPpm: Math.round((driftRatio - 1) * 1e6), windowStart: stats.windowStart || 0, windowEnd: stats.windowEnd || stats.data?.length || 0, diagnostics: { peak: stats.peak, rms: stats.rms, p2p: stats.p2p, decodedBits: decoded.bits.length, rejectedEdges: decoded.rejected, observedJitter: decoded.observedJitter, measuredHalfBitSamples, halfBitError, rejectRatio, driftRatio, driftPpm: Math.round((driftRatio - 1) * 1e6), windowStart: stats.windowStart || 0, windowEnd: stats.windowEnd || stats.data?.length || 0 } };
          const quality = this.qualityFor(candidate);
          candidate.qualityLabel = quality.label; candidate.qualityRank = quality.rank;
          if (!best || this.compareResults(candidate, best) < 0) best = candidate;
        }
      }
      return best;
    },
    // Frame-rate independent work: conditioning and windowing are computed once
    // per channel instead of once per candidate frame rate.
    prepareChannelAnalysis(channel, sampleRate) {
      return this.channelVariants(channel, sampleRate).map(variant => ({ variant, windows: this.channelWindows(variant, sampleRate) }));
    },
    detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples, strictDrop = true, allowSoftSync = false, prepared = null, driftTracker = null) {
      const tracker = driftTracker || createDriftTracker();
      const preparedVariants = prepared || this.prepareChannelAnalysis(channel, record.sampleRate);
      let best = null;
      for (const { variant, windows } of preparedVariants) {
        for (const window of windows) {
          const edges = this.findEdges(window, expectedHalfBitSamples);
          if (edges.length < 160) continue;
          const decoded = this.decodeBits(edges, expectedHalfBitSamples);
          observeDrift(tracker, decoded.observedHalfBitSamples, expectedHalfBitSamples, decoded.observedJitter, decoded.observedCount || 0);
          const candidate = this.chooseCandidate(decoded, record, fps, window, expectedHalfBitSamples, strictDrop, driftRatioFor(tracker));
          if (!candidate) continue;
          if (variant.conditioned && candidate.lockedFrames < 3) continue;
          candidate.conditioned = Boolean(variant.conditioned);
          candidate.conditionProfile = variant.conditionProfile || "raw";
          if (!best || this.compareResults(candidate, best) < 0) best = candidate;
          if (this.isHighQualityCandidate(best)) return { ...best, channelIndex, channelLabel: String(channelIndex + 1), halfBitSamples: expectedHalfBitSamples };
        }
      }
      // Soft fallback also runs on the conditioned variants (see src/ltc-decoder.js).
      if (!best && allowSoftSync) {
        for (const { variant, windows } of preparedVariants) {
          for (const window of windows) {
            const candidate = this.chooseSoftSyncCandidate(window, record, fps, window, expectedHalfBitSamples, strictDrop);
            if (!candidate) continue;
            candidate.conditioned = Boolean(variant.conditioned);
            candidate.conditionProfile = variant.conditionProfile || "raw";
            if (!best || this.compareResults(candidate, best) < 0) best = candidate;
          }
          if (best && (best.lockedFrames || 0) >= 4) break;
        }
      }
      return best ? { ...best, channelIndex, channelLabel: String(channelIndex + 1), halfBitSamples: expectedHalfBitSamples } : null;
    },
    detectAuto(buffer, record, preferredValue, values, options = {}) {
      const results = [], rejectedChannels = [], channelReports = [];
      const allowSoftSync = options.allowSoftSync === true;
      for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
        const channel = this.readChannel(buffer, record, channelIndex);
        const quick = this.quickRejectChannel(channel, record.sampleRate);
        const halfBitEstimate = quick.reject && quick.reason !== "level" && quick.reason !== "short"
          ? this.estimateHalfBitSamples(channel, record.sampleRate)
          : null;
        const strongHalfBitEstimate = quick.reject && quick.reason === "aperiodic"
          ? halfBitEstimate
          : null;
        const canDeepScan = strongHalfBitEstimate &&
          strongHalfBitEstimate.count >= 3000 &&
          strongHalfBitEstimate.jitter <= 0.08;
        const skipped = quick.reject && !canDeepScan && !allowSoftSync;
        const reportEntry = {
          channelIndex,
          channelLabel: String(channelIndex + 1),
          rejectReason: quick.reject ? quick.reason : null,
          scanned: !skipped,
          analysisGain: channel.analysisGain || 1,
          peak: channel.rawPeak,
          rms: channel.rawRms,
          p2p: channel.rawP2p != null ? channel.rawP2p : channel.p2p,
          clippedRatio: channel.rawClippedRatio || 0,
          halfBitEstimate: halfBitEstimate ? { halfBitSamples: halfBitEstimate.halfBitSamples, jitter: halfBitEstimate.jitter, count: halfBitEstimate.count } : null,
          candidateCount: 0,
        };
        channelReports.push(reportEntry);
        if (skipped) {
          rejectedChannels.push({ channelIndex, channelLabel: String(channelIndex + 1), rejectReason: quick.reason });
          continue;
        }
        const candidateValues = this.fpsCandidatesForChannel(channel, record.sampleRate, preferredValue, values);
        const prepared = this.prepareChannelAnalysis(channel, record.sampleRate);
        const driftTracker = createDriftTracker();
        const resultsBefore = results.length;
        for (const value of candidateValues) {
          const fps = parseFps(value);
          const fpsValue = Number(fps.rate.n) / Number(fps.rate.d);
          const expectedHalfBitSamples = record.sampleRate / (fpsValue * 80 * 2);
          let result = this.detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples, true, allowSoftSync && value === preferredValue, prepared, driftTracker);
          if (!result && value === preferredValue) {
            const retrySoftSync = allowSoftSync && Boolean(fps.drop);
            result = this.detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples, false, retrySoftSync, prepared, driftTracker);
            if (result) result.dropMismatch = result.drop !== Boolean(fps.drop);
          }
          if (result) {
            const item = { ...result, analysisGain: channel.analysisGain || 1, rawPeak: channel.rawPeak, fpsValue: value, preferred: value === preferredValue };
            results.push(item);
            reportEntry.candidateCount = results.length - resultsBefore;
            if ((value === preferredValue && this.isHighQualityCandidate(item)) || this.isDefinitiveCandidate(item)) {
              return { best: item, preferred: item.fpsValue === preferredValue ? item : null, results, rejectedChannels, channelReports };
            }
          }
        }
        reportEntry.candidateCount = results.length - resultsBefore;
      }
      results.sort((a, b) => {
        if (Boolean(a.dropMismatch) !== Boolean(b.dropMismatch)) return Number(a.dropMismatch) - Number(b.dropMismatch);
        return this.compareResults(a, b);
      });
      return { best: results[0] || null, preferred: results.find(result => result.fpsValue === preferredValue) || null, results, rejectedChannels, channelReports };
    },
  };
  self.onmessage = event => {
    const { id, buffer, record, preferredValue, values, allowSoftSync } = event.data;
    try {
      self.postMessage({ id, ok: true, result: LtcWorkerDecoder.detectAuto(buffer, record, preferredValue, values, { allowSoftSync }) });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error.message || String(error) });
    }
  };
`;

export class WorkerPool {
  constructor(code, size) {
    this.url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    this.workers = Array.from({ length: size }, () => ({ worker: new Worker(this.url), busy: false }));
    this.queue = [];
    this.nextId = 1;
  }

  run(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, transfer, resolve, reject });
      this.pump();
    });
  }

  pump() {
    const slot = this.workers.find(item => !item.busy);
    if (!slot || !this.queue.length) return;
    const task = this.queue.shift();
    const id = this.nextId++;
    slot.busy = true;
    slot.worker.onmessage = event => {
      if (event.data.id !== id) return;
      slot.busy = false;
      event.data.ok ? task.resolve(event.data.result) : task.reject(new Error(event.data.error));
      this.pump();
    };
    slot.worker.onerror = error => {
      slot.busy = false;
      task.reject(error);
      this.pump();
    };
    slot.worker.postMessage({ id, ...task.payload }, task.transfer);
  }
}
