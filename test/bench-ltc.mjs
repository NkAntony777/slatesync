// Manual benchmark, not part of the explicit test run: `node test/bench-ltc.mjs`
// (optionally `node test/bench-ltc.mjs 10 60` for a shorter sweep).
//
// Prints decode wall time and realtime factor for 10s / 60s / 300s / 900s takes
// so a change to the scan cost can be compared across takes of realistic
// length. Two things to keep in mind when reading the numbers:
//
//   - detectAuto reads at most the first 60s of a record (readChannel's
//     scanSeconds default), so decode time is flat past 60s by design. What
//     grows with file length is the scanWave cost, reported separately.
//   - takes longer than one block are built by tiling a 60s LTC block, which
//     puts a discontinuity at every block boundary. That is irrelevant for
//     timing (the decoder locks in the first window) but the timecode of a tiled
//     take is not continuous, so this script never asserts on decoded values.

import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio } from "./ltc-encode.mjs";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { readDataView } from "../src/wave.js";
import { parseFps } from "../src/timecode.js";

const VALUES = ["23.976", "24", "25", "29.97", "29.97df", "30", "50", "59.94", "60"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: value => value,
});

const BLOCK_SECONDS = 60;
const SIZES = process.argv.slice(2).map(Number).filter(value => Number.isFinite(value) && value > 0);
if (!SIZES.length) SIZES.push(10, 60, 300, 900);

function tiledLtc(totalSeconds) {
  const { data: block } = encodeLtcAudio({ fps: 25, startTc: "01:00:00:00", durationSeconds: Math.min(totalSeconds, BLOCK_SECONDS), amplitude: 0.5 });
  if (totalSeconds <= BLOCK_SECONDS) return block;
  const total = Math.round(totalSeconds * 48000);
  const data = new Float32Array(total);
  for (let offset = 0; offset < total; offset += block.length) {
    data.set(block.subarray(0, Math.min(block.length, total - offset)), offset);
  }
  return data;
}

console.log(`node ${process.version}  ${SIZES.join("s / ")}s takes, 48kHz mono, ${VALUES.length} candidate fps values\n`);
console.log("  take     scan     decode   realtime  lock");

for (const seconds of SIZES) {
  const data = tiledLtc(seconds);
  const scanStart = performance.now();
  const record = await audioRecord("bench.wav", [data]);
  const scanMs = performance.now() - scanStart;

  const decodeStart = performance.now();
  const auto = await decoder.detectAuto(record, parseFps("25"), { allowSoftSync: false });
  const decodeMs = performance.now() - decodeStart;

  const realtime = seconds / (decodeMs / 1000);
  console.log(
    `  ${String(seconds).padStart(4)}s ${scanMs.toFixed(0).padStart(7)}ms ${decodeMs.toFixed(0).padStart(8)}ms ` +
    `${realtime.toFixed(1).padStart(9)}x  ${auto.best ? `${auto.best.timecode}@${auto.best.fpsValue}/${auto.best.qualityLabel}` : "NO LOCK"}`,
  );
}

const { rss } = process.memoryUsage();
console.log(`\n  peak rss ${(rss / (1024 * 1024)).toFixed(0)} MB`);
