// Generate a demo Zoom-H8-style folder: two takes, LTC on Tr6.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeLtcAudio, encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";

const SR = 48000;
const out = resolve(process.argv[2] || "demo");
mkdirSync(join(out, "FOLDER01"), { recursive: true });

const take = (name, tc, delay = 0, ltcAmp = 0.4, voiceAmp = 0.15) => {
  const base = join(out, "FOLDER01");
  writeWavPcm16(join(base, `${name}_Tr1.WAV`), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8, amplitude: voiceAmp })], SR);
  writeWavPcm16(join(base, `${name}_Tr2.WAV`), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8, amplitude: voiceAmp })], SR);
  writeWavPcm16(join(base, `${name}_Tr6.WAV`), [encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: tc, durationSeconds: 8, amplitude: ltcAmp, startDelaySeconds: delay }).data], SR);
};

take("ZOOM0001", "01:23:45:00", 1.5);
take("ZOOM0002", "02:10:11:12", 0);
// ZOOM0003: no TC track at all (voice on Tr6 too)
const base = join(out, "FOLDER01");
writeWavPcm16(join(base, "ZOOM0003_Tr1.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);
writeWavPcm16(join(base, "ZOOM0003_Tr2.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);
writeWavPcm16(join(base, "ZOOM0003_Tr6.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);
// ZOOM0004: weak LTC on Tr6 (-50 dB)
writeWavPcm16(join(base, "ZOOM0004_Tr1.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);
writeWavPcm16(join(base, "ZOOM0004_Tr6.WAV"), [encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "07:45:00:00", durationSeconds: 8, amplitude: 0.003 }).data], SR);

console.log(`demo files written to ${out}\\FOLDER01`);
