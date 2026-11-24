import { readFileSync } from "node:fs";
import { join } from "node:path";
import { File } from "node:buffer";
import { scanWave, readDataView } from "../src/wave.js";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { parseFps } from "../src/timecode.js";
import { encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";
// 临时目录纪律：落本仓内 .tmp/（D 盘）+ 退出必删
// —— 见 docs/测试临时目录泄漏修复.md
import { bootstrapTempDirs, cleanupTempDirs, makeTempDir } from "./tmp-store.mjs";

const SR = 48000;
bootstrapTempDirs();
const dir = makeTempDir("ltc-v-");
writeWavPcm16(join(dir, "v.wav"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 6 })], SR);
const file = new File([readFileSync(join(dir, "v.wav"))], "v.wav");
const record = await scanWave({ getFile: async () => file }, { relativePath: "v.wav", parentPath: "" });
const decoder = createLtcDecoder({ readDataView, candidateFpsValues: () => ["25"], defaultFpsValue: () => "25", fpsSelectLabel: v => v });
const auto = await decoder.detectAuto(record, parseFps("25"), {});
console.log("rejected:", JSON.stringify(auto.rejectedChannels));
console.log("channelReports:", JSON.stringify(auto.channelReports, null, 1));

// 临时目录必删（不留残留）。
cleanupTempDirs("all");
