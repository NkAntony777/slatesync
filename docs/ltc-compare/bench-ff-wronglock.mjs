// Wrong-lock regression suite for the feed-forward LTC decoder.
// Mirrors the repo P0 regression shape (8 seeds x interference levels) plus a
// white-noise frontier sweep. Any lock whose timecode is off by > 1 frame is
// a WRONG lock — the suite must print WRONG=0.
// Run: node docs/ltc-compare/bench-ff-wronglock.mjs  (from repo root)
import { encodeLtcAudio, encodeVoiceLike } from "file:///D:/game/den/test/ltc-encode.mjs";
import { parseFps, framesToSamples, timecodeToFrames } from "file:///D:/game/den/src/timecode.js";
import { decodeFile } from "./ff-decoder.mjs";

const SR = 48000, DUR = 6;
const EXPECTED = framesToSamples(timecodeToFrames("01:00:00:00", parseFps("25")), SR, parseFps("25"));

let ok = 0, wrong = 0, miss = 0;
const t0 = Date.now();
// voice suite: LTC 0.03 + voice level + deterministic per-seed pseudo-noise 0.02
for (let seed = 1; seed <= 8; seed++) {
  for (const level of [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.60]) {
    const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.03 }).data;
    const v = encodeVoiceLike({ durationSeconds: DUR, amplitude: level });
    for (let i = 0; i < d.length; i++) d[i] += v[i] + 0.02 * (Math.sin(i * 12.9898 + seed * 78.233) * 0.5);
    const b = decodeFile(d, 25);
    if (!b) { miss++; continue; }
    const errF = Number(b.timeRef - EXPECTED) / 1920;
    if (Math.abs(errF) <= 1.01) ok++;
    else { wrong++; console.log(`WRONG seed=${seed} level=${level} err=${errF.toFixed(1)} support=${b.support}/${b.total}`); }
  }
}
console.log(`voice wronglock: ok=${ok} WRONG=${wrong} no-lock=${miss}  (${Date.now() - t0}ms)`);

// white-noise suite: LTC 0.05 + white level, LCG noise per seed
ok = 0; wrong = 0; miss = 0;
for (let seed = 1; seed <= 8; seed++) {
  for (const level of [0.15, 0.20, 0.25, 0.30]) {
    const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.05 }).data;
    let s = seed * 2654435761 >>> 0;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] += level * (s / 4294967296 * 2 - 1); }
    const b = decodeFile(d, 25);
    if (!b) { miss++; continue; }
    const errF = Number(b.timeRef - EXPECTED) / 1920;
    if (Math.abs(errF) <= 1.01) ok++;
    else { wrong++; console.log(`WRONG seed=${seed} white=${level} err=${errF.toFixed(1)} support=${b.support}/${b.total}`); }
  }
}
console.log(`white wronglock: ok=${ok} WRONG=${wrong} no-lock=${miss}`);
