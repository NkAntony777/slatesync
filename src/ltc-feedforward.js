// Feed-forward timing LTC demodulator — zero-edge demodulation.
// Timing = argmax of NDA ML metric (sum of half-cell integrate-and-dump energy),
// estimated per short segment (handles dropout / vari-speed), then matched-filter
// soft LLR demod + soft sync-word correlation + expected-value sequential chain
// verification + cross-segment cluster voting.
import { parseFps, framesToSamples, timecodeToFrames, fpsRate } from "./timecode.js";

const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const SYNC_REV = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];

export function firBandpass(data, sampleRate, lo, hi, taps = 385) {
  const N = taps | 1, mid = (N - 1) / 2, h = new Float64Array(N);
  const sinc = x => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const lp = (fc, n) => 2 * fc / sampleRate * sinc(2 * fc * (n - mid) / sampleRate);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N - 1));
    h[n] = (lp(hi, n) - lp(lo, n)) * w;
    sum += h[n];
  }
  for (let n = 0; n < N; n++) h[n] /= sum;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let acc = 0;
    const b = i - mid;
    for (let n = 0; n < N; n++) {
      const k = b + n;
      if (k >= 0 && k < data.length) acc += h[n] * data[k];
    }
    out[i] = acc;
  }
  return out;
}

// prefix-sum helpers: mean of bp over [a,b), fractional-safe
function prefix(bp) {
  const P = new Float64Array(bp.length + 1);
  let s = 0;
  for (let i = 0; i < bp.length; i++) { s += bp[i]; P[i + 1] = s; }
  return P;
}

function wmean(P, a, b) {
  const ia = Math.round(a), ib = Math.round(b);
  if (ib <= ia) return 0;
  return (P[ib] - P[ia]) / (ib - ia);
}

// NDA timing metric (1): total half-cell energy. Peaks when the integration
// grid lands on the eye centres — but has a half-bit ambiguity.
function metricAt(P, segEnd, start, half, maxCells) {
  let m = 0, cells = 0;
  const g = 0.16; // guard margin at each half-cell edge
  for (let k = 0; ; k++) {
    const a = start + k * 2 * half;
    const b = a + half;
    if (b > segEnd) break;
    const h1 = wmean(P, a + half * g, b - half * g);
    const h2 = wmean(P, b + half * g, a + 2 * half - half * g);
    m += h1 * h1 + h2 * h2;
    cells++;
    if (cells >= maxCells) break;
  }
  return { m, cells };
}

// NDA timing metric (2): matched-filter energy sum(|x1-x2|-|x1+x2|)^2.
function metricMF(P, segEnd, start, half, maxCells) {
  let m = 0, cells = 0;
  const g = 0.18;
  for (let k = 0; ; k++) {
    const a = start + k * 2 * half;
    const b = a + half;
    if (b > segEnd) break;
    const x1 = wmean(P, a + half * g, b - half * g);
    const x2 = wmean(P, b + half * g, a + 2 * half - half * g);
    const d = Math.abs(x1 - x2) - Math.abs(x1 + x2);
    m += d * d;
    cells++;
    if (cells >= maxCells) break;
  }
  return { m, cells };
}

function estimateTiming(P, segStart, segEnd, half0) {
  const span = segEnd - segStart;
  const maxCells = Math.floor(span / (2 * half0)) - 1;
  let best = null;
  for (let ri = -10; ri <= 10; ri++) {
    const half = half0 * (1 + ri * 0.001);
    for (let pi = 0; pi < 8; pi++) {
      const start = segStart + pi * 2 * half / 8;
      const { m, cells } = metricAt(P, segEnd, start, half, maxCells);
      if (cells < 8) continue;
      if (!best || m > best.m) best = { m, half, start, cells };
    }
  }
  if (!best) return null;
  const { half } = best;
  let m2 = -1, start2 = best.start;
  for (let si = -4; si <= 4; si++) {
    const s = best.start + si * half / 4;
    const { m: mf } = metricMF(P, segEnd, s, half, maxCells);
    if (mf > m2) { m2 = mf; start2 = s; }
  }
  let m3 = -1, start3 = start2;
  for (let si = -4; si <= 4; si++) {
    const s = start2 + si * half / 16;
    const { m: mf } = metricMF(P, segEnd, s, half, maxCells);
    if (mf > m3) { m3 = mf; start3 = s; }
  }
  return { half, start: start3, m: best.m, cells: best.cells };
}

function demod(P, limit, start, half, maxCells) {
  const bits = [];
  const llrs = [];
  const pos = [];
  const g = 0.18;
  for (let k = 0; k < maxCells; k++) {
    const a = start + k * 2 * half;
    const b = a + half;
    const c = a + 2 * half;
    if (c > limit) break;
    const x1 = wmean(P, a + half * g, b - half * g);
    const x2 = wmean(P, b + half * g, c - half * g);
    const d = Math.abs(x1 - x2) - Math.abs(x1 + x2);
    const denom = Math.abs(x1) + Math.abs(x2) + 1e-12;
    const llr = d / denom;
    llrs.push(llr);
    bits.push(llr > 0 ? 1 : 0);
    pos.push(Math.round(a));
  }
  return { bits, llrs, pos };
}

function syncCandidates(bits, llrs) {
  const cands = [];
  for (let s = 0; s + 80 <= bits.length; s++) {
    const w = bits.slice(s + 64, s + 80);
    let match = true;
    for (let i = 0; i < 16; i++) { if (w[i] !== SYNC[i]) { match = false; break; } }
    if (match) {
      cands.push({ s, hard: true, corr: 1 });
      continue;
    }
    let corr = 0;
    for (let i = 0; i < 16; i++) {
      const l = llrs[s + 64 + i];
      corr += (SYNC[i] ? 1 : -1) * l;
    }
    const norm = corr / 16;
    if (Math.abs(norm) >= 0.62) {
      cands.push({ s, hard: false, corr: norm });
    }
  }
  return cands.sort((a, b) => (b.hard ? 2 : 0) + Math.abs(b.corr) - ((a.hard ? 2 : 0) + Math.abs(a.corr)));
}

function chainCount(llrs, s0, framesAvail, fpsVal = 25) {
  const F = Math.min(framesAvail, 8);
  const avgField = indexes => {
    let sum = 0;
    for (let f = 0; f < F; f++) {
      for (const idx of indexes) sum += llrs[s0 + f * 80 + idx];
    }
    return sum / F;
  };
  const softDigit = (avgLlr, maxVal) => {
    let best = { v: 0, cost: Infinity };
    for (let v = 0; v <= maxVal; v++) {
      let cost = 0;
      for (let p = 0; p < 4; p++) {
        const bit = (v >> p) & 1;
        if ((bit ? 1 : -1) * avgLlr < 0) cost += Math.abs(avgLlr);
      }
      if (cost < best.cost) best = { v, cost };
    }
    return best;
  };
  const hhT = softDigit(avgField([56, 57]), 2), hhU = softDigit(avgField([48, 49, 50, 51]), 9);
  const mmT = softDigit(avgField([40, 41, 42]), 5), mmU = softDigit(avgField([32, 33, 34, 35]), 9);
  const staticCost = hhT.cost + hhU.cost + mmT.cost + mmU.cost;
  if (staticCost > 1.2) return null;
  const hh = hhT.v * 10 + hhU.v, mm = mmT.v * 10 + mmU.v;
  if (hh > 23 || mm > 59) return null;
  const f1 = {
    ffT: softDigit(pick(llrs, s0, [8, 9]), 2), ffU: softDigit(pick(llrs, s0, [0, 1, 2, 3]), 9),
    ssT: softDigit(pick(llrs, s0, [24, 25, 26]), 5), ssU: softDigit(pick(llrs, s0, [16, 17, 18, 19]), 9),
  };
  const ss = f1.ssT.v * 10 + f1.ssU.v, ff = f1.ffT.v * 10 + f1.ffU.v;
  if (ss > 59 || ff >= fpsVal) return null;
  const V0 = ((hh * 60 + mm) * 60 + ss) * fpsVal + ff;
  let good = 0, checked = 0;
  for (let k = 1; k < framesAvail; k++) {
    const s = s0 + k * 80;
    if (s + 80 > llrs.length) break;
    const expect = V0 + k;
    const es = Math.floor(expect / fpsVal) % 60, ef = expect % fpsVal;
    const em = Math.floor(expect / (60 * fpsVal)) % 60;
    const digits = [
      [ef % 10, [0, 1, 2, 3]], [Math.floor(ef / 10), [8, 9]],
      [es % 10, [16, 17, 18, 19]], [Math.floor(es / 10), [24, 25, 26]],
      [em % 10, [32, 33, 34, 35]], [Math.floor(em / 10), [40, 41, 42]],
    ];
    let cost = 0;
    for (const [v, ix] of digits) {
      for (let p = 0; p < ix.length; p++) {
        const bit = (v >> p) & 1;
        const l = llrs[s + ix[p]];
        if ((bit ? 1 : -1) * l < 0) cost += Math.abs(l);
      }
    }
    checked++;
    if (cost <= 1.5) good++;
  }
  return { V0, good, checked, staticCost, hh, mm, ss, ff };
}

function pick(llrs, s, ix) { return ix.map(i => llrs[s + i]); }

function decodeSegment(bp, P, segStart, segEnd, half0, fpsVal = 25) {
  const span = segEnd - segStart;
  const est = estimateTiming(P, segStart, segEnd, half0);
  if (!est) return { noSignal: true };
  let raw = 0;
  const ia = Math.round(segStart), ib = Math.round(Math.min(segEnd, bp.length));
  for (let i = ia; i < ib; i++) raw += bp[i] * bp[i];
  const lockRatio = raw > 0 ? est.m * span / (raw * est.cells * 2) : 0;
  if (lockRatio < 0.4) return { noSignal: true, lockRatio };
  const maxCells = Math.floor((segEnd - est.start) / (2 * est.half));
  let best = null;
  for (const off of [0, est.half]) {
    const { bits, llrs, pos } = demod(P, bp.length, est.start + off, est.half, maxCells);
    if (bits.length < 160) continue;
    const cands = syncCandidates(bits, llrs);
    for (const c of cands.slice(0, 24)) {
      const framesAvail = Math.floor((bits.length - c.s) / 80);
      if (framesAvail < 6) continue;
      const ch = chainCount(llrs, c.s, framesAvail, fpsVal);
      if (!ch || ch.good < 5) continue;
      const sampleAtFrame0 = pos[c.s];
      const score = ch.good * 2 + (c.hard ? 8 : 0) + Math.abs(c.corr) * 6 - ch.staticCost;
      if (!best || score > best.score) best = { ...ch, hard: c.hard, corr: c.corr, sampleAtFrame0, score, lockRatio };
    }
  }
  if (!best) return { noLock: true, lockRatio };
  return { ...best, segStart };
}

export function decodeFeedForward(data, sampleRate = 48000, fpsNDF = 25) {
  const fps = typeof fpsNDF === "string" ? parseFps(fpsNDF) : (typeof fpsNDF === "number" ? parseFps(String(fpsNDF)) : fpsNDF);
  const fpsVal = Number(fpsRate(fps).n) / Number(fpsRate(fps).d);
  const bitSamples = sampleRate / (fpsVal * 80);
  const half0 = bitSamples / 2;
  const lo = (fpsVal * 80 / 2) * 0.7;
  const hi = Math.min((fpsVal * 80) * 1.3, sampleRate * 0.45);
  const bp = firBandpass(data, sampleRate, lo, hi);
  const P = prefix(bp);
  const SEG = Math.round(1.5 * sampleRate);
  const HOP = Math.round(0.75 * sampleRate);
  const spf = sampleRate / fpsVal;
  const ests = [];
  for (let st = 0; st + SEG * 0.6 <= data.length; st += HOP) {
    const r = decodeSegment(bp, P, st, Math.min(st + SEG, data.length), half0, Math.round(fpsVal));
    if (r.V0 !== undefined) {
      const fileStart = Number(r.V0) - r.sampleAtFrame0 / spf;
      ests.push({ ...r, fileStart });
    }
  }
  if (!ests.length) return null;
  const clusters = new Map();
  for (const e of ests) {
    const key = Math.round(e.fileStart);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(e);
  }
  let win = null;
  for (const [k, arr] of clusters) {
    if (!win || arr.length > win.arr.length) win = { k, arr };
  }
  if (!win || win.arr.length < 4) return null;
  let runner = 0;
  for (const [k, arr] of clusters) {
    if (arr !== win.arr && arr.length > runner) runner = arr.length;
  }
  if (win.arr.length < runner * 2) return null;
  const med = win.arr.map(e => e.fileStart).sort((a, b) => a - b)[Math.floor(win.arr.length / 2)];
  const rounded = Math.round(med);
  const timeRef = framesToSamples(BigInt(rounded), sampleRate, fps);
  return {
    fileStartFrame: med,
    timeRef,
    support: win.arr.length,
    total: ests.length,
    best: win.arr.reduce((a, b) => (a.score > b.score ? a : b)),
  };
}
