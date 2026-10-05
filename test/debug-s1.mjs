import { join } from "node:path";
import { File } from "node:buffer";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scanWave, readDataView } from "../src/wave.js";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { parseFps } from "../src/timecode.js";
import { encodeLtcAudio, writeWavPcm16 } from "./ltc-encode.mjs";

const SR = 48000;
const dir = mkdtempSync(join(tmpdir(), "ltc-dbg-"));
const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "01:23:45:00", durationSeconds: 8, amplitude: 0.4, startDelaySeconds: 1.5 });
writeWavPcm16(join(dir, "ltc.wav"), [ltc.data], SR);
const file = new File([readFileSync(join(dir, "ltc.wav"))], "ltc.wav");
const record = await scanWave({ getFile: async () => file }, { relativePath: "ltc.wav", parentPath: "" });

const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => ["25"],
  defaultFpsValue: () => "25",
  fpsSelectLabel: v => v,
});
const auto = await decoder.detectAuto(record, parseFps("25"), {});
for (const r of auto.results) {
  console.log(`tc=${r.timecode} offset=${r.sampleOffset} frames-run=${r.lockedFrames} conf=${r.confidence.toFixed(2)} window=${r.windowStart}-${r.windowEnd} reverse=${r.reverse}`);
}
console.log("expected frame starts:");
for (const [tc, pos] of [...ltc.frameStarts.entries()].slice(0, 8)) console.log(`  ${tc} @ ${pos}`);
const last = [...ltc.frameStarts.entries()].at(-1);
console.log(`  ... last ${last[0]} @ ${last[1]}`);
