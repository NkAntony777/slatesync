// Feed-forward timing LTC demodulator — no edges anywhere.
// Timing = argmax of NDA ML metric (sum of half-cell integrate-and-dump energy),
// estimated per short segment (handles dropout / vari-speed), then matched-filter
// soft LLR demod + soft sync-word correlation + expected-value sequential chain
// verification + cross-segment cluster voting.
import { parseFps, framesToSamples, timecodeToFrames } from "file:///D:/game/den/src/timecode.js";

const SR = 48000, DUR = 6;
const EXPECTED = framesToSamples(timecodeToFrames("01:00:00:00", parseFps("25")), SR, parseFps("25"));
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const SYNC_REV = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }

function firBandpass(data, sampleRate, lo, hi, taps = 385) {
  const N = taps | 1, mid = (N - 1) / 2, h = new Float64Array(N);
  const sinc = x => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const lp = (fc, n) => 2 * fc / sampleRate * sinc(2 * fc * (n - mid) / sampleRate);
  let sum = 0;
  for (let n = 0; n < N; n++) { const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N - 1)); h[n] = (lp(hi, n) - lp(lo, n)) * w; sum += h[n]; }
  for (let n = 0; n < N; n++) h[n] /= sum;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) { let acc = 0; const b = i - mid;
    for (let n = 0; n < N; n++) { const k = b + n; if (k >= 0 && k < data.length) acc += h[n] * data[k]; }
    out[i] = acc; }
  return out;
}

// ---- prefix-sum helpers: mean of bp over [a,b), fractional-safe ----
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
// grid lands on the eye centres — but has a half-bit ambiguity: the offset
// grid (straddling bit boundaries) gives the same energy for BMC, because
// there is a transition at EVERY bit boundary.
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
// Same value for 0-bits (|x1+x2| large) and 1-bits (|x1-x2| large), but the
// half-bit-offset grid scores strictly lower (x1,x2 anti-correlated there by
// construction). Use to resolve the phase-class ambiguity of metric 1.
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
  // 1) coarse rate search ±1% with the energy metric (phase-class agnostic)
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
  // 2) phase-class + phase: maximize the BMC matched-filter metric
  let m2 = -1, start2 = best.start;
  for (let pi = 0; pi < 8; pi++) {
    const s = segStart + pi * 2 * half / 8;
    const r = metricMF(P, segEnd, s, half, maxCells);
    if (r.cells >= 8 && r.m > m2) { m2 = r.m; start2 = s; }
  }
  for (let it = 0; it < 2; it++) {
    const step = 2 * half / 16;
    for (const d of [-2, -1, 1, 2]) {
      const s = start2 + d * step;
      const r = metricMF(P, segEnd, s, half, maxCells);
      if (r.cells >= 8 && r.m > m2) { m2 = r.m; start2 = s; }
    }
  }
  return { half, start: start2, m: best.m, cells: maxCells };
}

function demod(P, dataLen, start, half, maxCells) {
  const bits = [], llrs = [], pos = [];
  const g = 0.18;
  for (let k = 0; ; k++) {
    const a = start + k * 2 * half;
    const b = a + half;
    if (b > dataLen) break;
    const x1 = wmean(P, a + half * g, b - half * g);
    const x2 = wmean(P, b + half * g, a + 2 * half - half * g);
    const one = Math.abs(x1 - x2), zero = Math.abs(x1 + x2);
    const norm = Math.abs(x1) + Math.abs(x2) + 1e-12;
    const llr = (one - zero) / norm;
    bits.push(llr > 0 ? 1 : 0);
    llrs.push(llr);
    pos.push(a);
    if (bits.length >= maxCells) break;
  }
  return { bits, llrs, pos };
}

// soft sync-word correlation; returns candidate start positions sorted by |corr|
function bitsNonConstant(bits) {
  for (let i = 1; i < bits.length; i++) if (bits[i] !== bits[0]) return true;
  return false;
}

function syncCandidates(bits, llrs) {
  const out = [];
  for (let s = 0; s + 80 <= bits.length; s++) {
    for (const [w, sign] of [[SYNC, 1], [SYNC_REV, -1]]) {
      let hard = true, corr = 0;
      for (let i = 0; i < 16; i++) {
        const b = bits[s + 64 + i];
        if (b !== w[i]) hard = false;
        corr += llrs[s + 64 + i] * (w[i] ? 1 : -1);
      }
      corr /= 16;
      if (hard) out.push({ s, corr, hard, sign });
      else if (Math.abs(corr) >= 0.62) out.push({ s, corr, hard: false, sign });
    }
  }
  out.sort((a, b) => (b.hard - a.hard) || (Math.abs(b.corr) - Math.abs(a.corr)));
  return out;
}

// digit-wise soft decode over an array of per-bit LLR values
function softDigit(vals, maxV) {
  let best = null;
  for (let v = 0; v <= maxV; v++) {
    let cost = 0;
    for (let p = 0; p < vals.length; p++) {
      const bit = (v >> p) & 1;
      if ((bit ? 1 : -1) * vals[p] < 0) cost += Math.abs(vals[p]);
    }
    if (!best || cost < best.cost) best = { v, cost };
  }
  return best;
}
function frameValueAt(llrs, s) {
  const ffT = softDigit(pick(llrs, s, [8, 9]), 2); const ffU = softDigit(pick(llrs, s, [0, 1, 2, 3]), 9);
  const ssT = softDigit(pick(llrs, s, [24, 25, 26]), 5); const ssU = softDigit(pick(llrs, s, [16, 17, 18, 19]), 9);
  const mmT = softDigit(pick(llrs, s, [40, 41, 42]), 5); const mmU = softDigit(pick(llrs, s, [32, 33, 34, 35]), 9);
  const hhT = softDigit(pick(llrs, s, [56, 57]), 2); const hhU = softDigit(pick(llrs, s, [48, 49, 50, 51]), 9);
  const hh = hhT.v * 10 + hhU.v, mm = mmT.v * 10 + mmU.v, ss = ssT.v * 10 + ssU.v, ff = ffT.v * 10 + ffU.v;
  if (hh > 23 || mm > 59 || ss > 59 || ff >= 25) return null;
  const cost = ffT.cost + ffU.cost + ssT.cost + ssU.cost + mmT.cost + mmU.cost + hhT.cost + hhU.cost;
  return { hh, mm, ss, ff, frames: ((hh * 60 + mm) * 60 + ss) * 25 + ff, cost };
}

// chain verification with cross-frame static-digit averaging. hh/mm digits are
// constant across the frames inside one segment, so decode them once from the
// average LLR over the first few frames — a marginal single-frame bit (the
// classic "hour digit dropped" failure) can't drag the whole chain wrong.
function chainCount(llrs, s0, framesAvail, fpsNDF) {
  const F = Math.min(framesAvail, 8);
  const avgField = ix => {
    const out = new Array(ix.length);
    for (let p = 0; p < ix.length; p++) {
      let s = 0;
      for (let k = 0; k < F; k++) s += llrs[s0 + k * 80 + ix[p]];
      out[p] = s / F;
    }
    return out;
  };
  const hhT = softDigit(avgField([56, 57]), 2), hhU = softDigit(avgField([48, 49, 50, 51]), 9);
  const mmT = softDigit(avgField([40, 41, 42]), 5), mmU = softDigit(avgField([32, 33, 34, 35]), 9);
  const staticCost = hhT.cost + hhU.cost + mmT.cost + mmU.cost;
  if (staticCost > 1.2) return null;
  const hh = hhT.v * 10 + hhU.v, mm = mmT.v * 10 + mmU.v;
  if (hh > 23 || mm > 59) return null;
  // dynamic digits of the first frame
  const f1 = {
    ffT: softDigit(pick(llrs, s0, [8, 9]), 2), ffU: softDigit(pick(llrs, s0, [0, 1, 2, 3]), 9),
    ssT: softDigit(pick(llrs, s0, [24, 25, 26]), 5), ssU: softDigit(pick(llrs, s0, [16, 17, 18, 19]), 9),
  };
  const ss = f1.ssT.v * 10 + f1.ssU.v, ff = f1.ffT.v * 10 + f1.ffU.v;
  if (ss > 59 || ff >= 25) return null;
  const V0 = ((hh * 60 + mm) * 60 + ss) * 25 + ff;
  let good = 0, checked = 0;
  for (let k = 1; k < framesAvail; k++) {
    const s = s0 + k * 80;
    if (s + 80 > llrs.length) break;
    const expect = V0 + k;
    const es = Math.floor(expect / 25) % 60, ef = expect % 25;
    const em = Math.floor(expect / (60 * 25)) % 60;
    const digits = [[ef % 10, [0, 1, 2, 3]], [Math.floor(ef / 10), [8, 9]],
      [es % 10, [16, 17, 18, 19]], [Math.floor(es / 10), [24, 25, 26]],
      [em % 10, [32, 33, 34, 35]], [Math.floor(em / 10), [40, 41, 42]]];
    let cost = 0;
    for (const [v, ix] of digits) {
      for (let p = 0; p < ix.length; p++) {
        const bit = (v >> p) & 1;
        const l = llrs[s + ix[p]];
        if ((bit ? 1 : -1) * l < 0) cost += Math.abs(l);
      }
    }
    checked++;
    if (cost <= 1.5) good++; // ~1 flipped low-|llr| bit tolerated per frame
  }
  return { V0, good, checked, staticCost };
}
function pick(llrs, s, ix) { return ix.map(i => llrs[s + i]); }

function decodeSegment(bp, P, segStart, segEnd, half0) {
  const span = segEnd - segStart;
  const est = estimateTiming(P, segStart, segEnd, half0);
  if (!est) return { noSignal: true };
  // lock ratio: energy captured by the half-cell means vs raw bandpassed
  // energy over the segment. Periodic LTC concentrates energy inside the
  // eye windows (ratio ~1.3 clean, >>1 pathological); white noise spreads
  // uniformly (ratio ~1/window = 0.12). Threshold 0.4 sits far between.
  let raw = 0;
  const ia = Math.round(segStart), ib = Math.round(Math.min(segEnd, bp.length));
  for (let i = ia; i < ib; i++) raw += bp[i] * bp[i];
  const lockRatio = raw > 0 ? est.m * span / (raw * est.cells * 2) : 0;
  if (lockRatio < 0.4) return { noSignal: true, lockRatio };
  const maxCells = Math.floor((segEnd - est.start) / (2 * est.half));
  // Demod BOTH phase classes: the energy metric cannot distinguish the bit
  // grid from the half-bit-straddle grid (every bit boundary transitions).
  // Data decides — the class whose sync+chain verifies wins.
  let best = null;
  for (const off of [0, est.half]) {
    const { bits, llrs, pos } = demod(P, bp.length, est.start + off, est.half, maxCells);
    if (bits.length < 160) continue;
    const cands = syncCandidates(bits, llrs);
    for (const c of cands.slice(0, 24)) {
      const framesAvail = Math.floor((bits.length - c.s) / 80);
      if (framesAvail < 6) continue;
      const ch = chainCount(llrs, c.s, framesAvail, 25);
      if (!ch || ch.good < 5) continue;
      const sampleAtFrame0 = pos[c.s];
      const score = ch.good * 2 + (c.hard ? 8 : 0) + Math.abs(c.corr) * 6 - ch.staticCost;
      if (!best || score > best.score) best = { ...ch, hard: c.hard, corr: c.corr, sampleAtFrame0, score, lockRatio };
    }
  }
  if (!best) return { noLock: true, lockRatio };
  return { ...best, segStart };
}

function decodeFile(data, fpsNDF) {
  const bitSamples = SR / (fpsNDF * 80);
  const half0 = bitSamples / 2;
  const lo = (fpsNDF * 80 / 2) * 0.7, hi = Math.min((fpsNDF * 80) * 1.3, SR * 0.45);
  const bp = firBandpass(data, SR, lo, hi);
  const P = prefix(bp);
  const SEG = 1.5 * SR, HOP = 0.75 * SR;
  const spf = SR / fpsNDF;
  const ests = [];
  for (let st = 0; st + SEG * 0.6 <= data.length; st += HOP) {
    const r = decodeSegment(bp, P, st, Math.min(st + SEG, data.length), half0);
    if (r.V0 !== undefined) {
      // extrapolate to file sample 0: frame value V0 lives at sample sampleAtFrame0
      const fileStart = Number(r.V0) - r.sampleAtFrame0 / spf;
      ests.push({ ...r, fileStart });
    }
  }
  if (!ests.length) return null;
  // cluster by rounded file-start frame; largest cluster wins
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
  // cluster dominance: a lock is only reported when the winning cluster is
  // unambiguous. A lone minority cluster with weak support is exactly how
  // "wrong but self-consistent" reads slip through.
  let runner = 0;
  for (const [k, arr] of clusters) if (arr !== win.arr && arr.length > runner) runner = arr.length;
  if (win.arr.length < runner * 2) return null;
  // Sub-frame precision of the estimate is far below the timing resolution;
  // round to the integer frame to avoid floor()+negative-frac artifacts.
  const med = win.arr.map(e => e.fileStart).sort((a, b) => a - b)[Math.floor(win.arr.length / 2)];
  const best = win.arr.reduce((a, b) => (a.score > b.score ? a : b));
  const rounded = Math.round(med);
  const timeRef = framesToSamples(BigInt(rounded), SR, parseFps("25"));
  return { fileStartFrame: med, timeRef, support: win.arr.length, total: ests.length, best };
}

export { decodeFile };
