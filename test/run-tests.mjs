// End-to-end test: synthesize Zoom-style WAV takes (one LTC track), decode, diagnose.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { File } from "node:buffer";

import { scanWave, readDataView } from "../src/wave.js";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { parseFps, fpsRate, samplesToTimecode, framesToSamples, timecodeToFrames } from "../src/timecode.js";
import { detectTakeGroupKeys, recordsByGroupFor, groupKeyFor, takeGroupCount } from "../src/grouping.js";
import { buildTakeDiagnostics } from "../src/ltc-diagnostics.js";
import { writeCombinedPolyToWritable } from "../src/wave-combine.js";
import { encodeLtcAudio, encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";

class MemWritable {
  constructor() { this.data = new Uint8Array(0); this.closed = false; }
  ensure(size) {
    if (this.data.byteLength >= size) return;
    const next = new Uint8Array(size);
    next.set(this.data);
    this.data = next;
  }
  async write(chunk) {
    if (chunk?.type === "write") {
      const bytes = chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data);
      const pos = Number(chunk.position ?? this.data.byteLength);
      this.ensure(pos + bytes.byteLength);
      this.data.set(bytes, pos);
    } else if (chunk?.type === "seek") {
      this.pos = Number(chunk.position);
    } else if (chunk?.type === "truncate") {
      this.ensure(0);
      this.data = this.data.slice(0, Number(chunk.size));
    } else if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const pos = this.pos ?? this.data.byteLength;
      this.ensure(pos + bytes.byteLength);
      this.data.set(bytes, pos);
    }
  }
  async truncate(size) { this.data = this.data.slice(0, Number(size)); }
  async close() { this.closed = true; }
}

const SR = 48000;
const dir = mkdtempSync(join(tmpdir(), "ltc-test-"));
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const FPS_VALUES = ["23.976", "24", "25", "29.97", "29.97df", "30", "48", "50", "59.94", "59.94df", "60", "96", "100", "119.88", "119.88df", "120"];
const decoder = createLtcDecoder({
  readDataView,
  candidateFpsValues: () => FPS_VALUES,
  defaultFpsValue: () => "25",
  fpsSelectLabel: v => v,
});

async function recordFor(path, name, parentPath = "FOLDER01") {
  const buf = writeFileSync ? null : null;
  const file = new File([await import("node:fs").then(fs => fs.readFileSync(path))], name);
  const handle = { name, getFile: async () => file };
  return scanWave(handle, { relativePath: `${parentPath}/${name}`, parentPath });
}

async function detect(record, preferredValue = "25") {
  return decoder.detectAuto(record, parseFps(preferredValue), { allowSoftSync: false });
}

function reportEntry(record, auto, pass = "full") {
  const slim = item => item && ({
    fpsValue: item.fpsValue, fpsLabel: item.fpsLabel, timecode: item.timecode,
    confidence: item.confidence, qualityRank: item.qualityRank, qualityLabel: item.qualityLabel,
    lockedFrames: item.lockedFrames, halfBitError: item.halfBitError, rejectRatio: item.rejectRatio,
    dropMismatch: item.dropMismatch, reverse: item.reverse, sampleOffset: item.sampleOffset,
    channelIndex: item.channelIndex, channelLabel: item.channelLabel, softSync: Boolean(item.softSync),
    diagnostics: item.diagnostics, observedJitter: item.observedJitter,
  });
  return {
    record, pass, error: null,
    channelReports: auto?.channelReports || [],
    rejectedChannels: auto?.rejectedChannels || [],
    candidates: (auto?.results || []).map(slim),
    best: slim(auto?.best), preferred: slim(auto?.preferred),
  };
}

function expectedStartSamples(tcText, fpsValue, sampleRate) {
  return framesToSamples(timecodeToFrames(tcText, parseFps(fpsValue)), sampleRate, parseFps(fpsValue));
}

console.log(`test dir: ${dir}\n`);

// ---------- scenario 1: clean take, LTC on Tr6 ----------
{
  console.log("== S1 clean take, LTC on Tr6 @25, delay 1.5s ==");
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "01:23:45:00", durationSeconds: 8, amplitude: 0.4, startDelaySeconds: 1.5 });
  writeWavPcm16(join(dir, "ZOOM0001_Tr6.WAV"), [ltc.data], SR);
  writeWavPcm16(join(dir, "ZOOM0001_Tr1.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);
  writeWavPcm16(join(dir, "ZOOM0001_Tr2.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 8 })], SR);

  const rec = await recordFor(join(dir, "ZOOM0001_Tr6.WAV"), "ZOOM0001_Tr6.WAV");
  const auto = await detect(rec, "25");
  check("S1 detected", !!auto?.best);
  if (auto?.best) {
    const expected = expectedStartSamples("01:23:45:00", "25", SR) - BigInt(Math.round(1.5 * SR));
    const diff = auto.best.newTimeReference - expected;
    check("S1 start TC offset within 1 frame", diff >= -48n && diff <= 48n,
      `diff=${diff} decoded=${auto.best.timecode}@${auto.best.sampleOffset}`);
    console.log(`    decoded ${auto.best.timecode} fps=${auto.best.fpsValue} q=${auto.best.qualityLabel} conf=${auto.best.confidence.toFixed(2)} frames=${auto.best.lockedFrames}`);
  }

  const voice = await recordFor(join(dir, "ZOOM0001_Tr1.WAV"), "ZOOM0001_Tr1.WAV");
  const autoVoice = await detect(voice, "25");
  check("S1 voice track not mistaken for LTC", !autoVoice?.best, autoVoice?.best?.timecode || "");
}

// ---------- scenario 2: take with no LTC at all ----------
{
  console.log("== S2 no LTC anywhere ==");
  writeWavPcm16(join(dir, "ZOOM0002_Tr1.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 6 })], SR);
  writeWavPcm16(join(dir, "ZOOM0002_Tr2.WAV"), [encodeVoiceLike({ sampleRate: SR, durationSeconds: 6 })], SR);
  const rec = await recordFor(join(dir, "ZOOM0002_Tr1.WAV"), "ZOOM0002_Tr1.WAV");
  const auto = await detect(rec, "25");
  const diag = buildTakeDiagnostics({
    takeKey: "FOLDER01/zoom0002", label: "ZOOM0002",
    groupRecords: [rec],
    report: [reportEntry(rec, auto)],
    detected: null, fpsValue: "25",
  });
  check("S2 status fail", diag.status === "fail", diag.status);
  check("S2 produces suggestions", diag.issues.some(i => i.suggestions?.length), JSON.stringify(diag.issues.map(i => i.code)));
  console.log(`    issues: ${diag.issues.map(i => i.code).join(", ")}`);
}

// ---------- scenario 3: LTC too quiet ----------
{
  console.log("== S3 LTC at -58dBFS ==");
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "03:00:00:00", durationSeconds: 6, amplitude: 0.0012 });
  writeWavPcm16(join(dir, "ZOOM0003_Tr6.WAV"), [ltc.data], SR);
  const rec = await recordFor(join(dir, "ZOOM0003_Tr6.WAV"), "ZOOM0003_Tr6.WAV");
  const auto = await detect(rec, "25");
  const diag = buildTakeDiagnostics({
    takeKey: "FOLDER01/zoom0003", label: "ZOOM0003",
    groupRecords: [rec],
    report: [reportEntry(rec, auto)],
    detected: null, fpsValue: "25",
  });
  check("S3 fails", diag.status === "fail");
  check("S3 mentions level", diag.issues.some(i => ["all-silent", "weak-candidates", "scanned-no-lock", "not-scanned"].includes(i.code)),
    diag.issues.map(i => i.code).join(","));
  console.log(`    issues: ${diag.issues.map(i => `${i.code}(${i.severity})`).join(", ")}`);
}

// ---------- scenario 4: clipped LTC ----------
{
  console.log("== S4 clipped LTC (amp 1.6) ==");
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "05:00:00:00", durationSeconds: 6, amplitude: 1.6 });
  writeWavPcm16(join(dir, "ZOOM0004_Tr6.WAV"), [ltc.data], SR);
  const rec = await recordFor(join(dir, "ZOOM0004_Tr6.WAV"), "ZOOM0004_Tr6.WAV");
  const auto = await detect(rec, "25");
  const detected = auto?.best ? { ...auto.best, sourceRecord: rec } : null;
  const diag = buildTakeDiagnostics({
    takeKey: "FOLDER01/zoom0004", label: "ZOOM0004",
    groupRecords: [rec],
    report: [reportEntry(rec, auto)],
    detected, fpsValue: "25",
  });
  check("S4 still decodes despite clipping", !!auto?.best);
  if (detected) {
    const expected = expectedStartSamples("05:00:00:00", "25", SR);
    const diff = detected.newTimeReference - expected;
    check("S4 start TC within 1 frame", diff >= -48n && diff <= 48n, `diff=${diff}`);
  }
  console.log(`    issues: ${diag.issues.map(i => `${i.code}(${i.severity})`).join(", ")}`);
}

// ---------- scenario 5: 29.97 DF ----------
{
  console.log("== S5 LTC 29.97 DF ==");
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 30000 / 1001, nominalFps: 30, startTc: "10:30:00:00", durationSeconds: 6, amplitude: 0.4, drop: true });
  writeWavPcm16(join(dir, "ZOOM0005_Tr6.WAV"), [ltc.data], SR);
  const rec = await recordFor(join(dir, "ZOOM0005_Tr6.WAV"), "ZOOM0005_Tr6.WAV");
  const auto = await detect(rec, "29.97df");
  check("S5 detected", !!auto?.best);
  if (auto?.best) {
    check("S5 fps=29.97df", auto.best.fpsValue === "29.97df", auto.best.fpsValue);
    const expected = expectedStartSamples("10:30:00:00", "29.97df", SR);
    const diff = auto.best.newTimeReference - expected;
    check("S5 start TC within 1 frame", diff >= -30n && diff <= 30n, `diff=${diff} tc=${auto.best.timecode}`);
  }
}

// ---------- scenario 6: LTC only at the end ----------
{
  console.log("== S6 LTC only last 2s of 8s file ==");
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "12:00:00:00", durationSeconds: 8, amplitude: 0.4, startDelaySeconds: 6 });
  writeWavPcm16(join(dir, "ZOOM0006_Tr6.WAV"), [ltc.data], SR);
  const rec = await recordFor(join(dir, "ZOOM0006_Tr6.WAV"), "ZOOM0006_Tr6.WAV");
  const auto = await detect(rec, "25");
  check("S6 detected (full scan)", !!auto?.best);
  if (auto?.best) {
    const expected = expectedStartSamples("12:00:00:00", "25", SR) - BigInt(Math.round(6 * SR));
    const diff = auto.best.newTimeReference - expected;
    check("S6 start TC within 2 frames", diff >= -96n && diff <= 96n, `diff=${diff} tc=${auto.best.timecode}`);
    const detected = { ...auto.best, sourceRecord: rec };
    const diag = buildTakeDiagnostics({
      takeKey: "FOLDER01/zoom0006", label: "ZOOM0006",
      groupRecords: [rec],
      report: [reportEntry(rec, auto)],
      detected, fpsValue: "25",
    });
    check("S6 late-start noted", diag.issues.some(i => i.code === "late-start"), diag.issues.map(i => i.code).join(","));
  }
}

// ---------- scenario 7: grouping — multiple takes in one folder ----------
{
  console.log("== S7 grouping: 3 takes in one folder ==");
  const mk = (name, dur = 6 * SR, parentPath = "FOLDER01") => ({
    name, relativePath: `${parentPath}/${name}`, parentPath,
    sampleRate: SR, bitsPerSample: 16, audioFormat: 1, channels: 1,
    durationSamples: BigInt(dur), dataSize: dur * 2, dataOffset: 44, blockAlign: 2, hasBext: false,
  });
  const list = [
    mk("ZOOM0001_Tr1.WAV"), mk("ZOOM0001_Tr2.WAV"), mk("ZOOM0001_Tr6.WAV"),
    mk("ZOOM0002_Tr1.WAV", 9 * SR), mk("ZOOM0002_Tr6.WAV", 9 * SR),
    mk("ZOOM0003_Tr1.WAV", 3 * SR), mk("ZOOM0003_Tr6.WAV", 3 * SR + 2400), // slightly diff duration
    mk("ZOOM0004.WAV"), // stereo-mix style, no suffix
  ];
  const groups = detectTakeGroupKeys(list);
  check("S7 three takes detected", takeGroupCount(groups) === 3, `count=${takeGroupCount(groups)}`);
  const byGroup = recordsByGroupFor(list, groups);
  const sizes = Array.from(byGroup.values()).map(g => g.length).sort();
  check("S7 group sizes 1,2,2,3", sizes.join(",") === "1,2,2,3", sizes.join(","));
  check("S7 ZOOM0003 grouped despite slight duration diff",
    groupKeyFor(list.find(r => r.name === "ZOOM0003_Tr1.WAV"), groups) === groupKeyFor(list.find(r => r.name === "ZOOM0003_Tr6.WAV"), groups));
  check("S7 plain file ungrouped",
    groupKeyFor(list.find(r => r.name === "ZOOM0004.WAV"), groups) === "FOLDER01/ZOOM0004.WAV");
}

// ---------- scenario 8: duration-mismatch diagnostics ----------
{
  console.log("== S8 duration mismatch flagged ==");
  const mk = (name, dur) => ({
    name, relativePath: `FOLDER01/${name}`, parentPath: "FOLDER01",
    sampleRate: SR, bitsPerSample: 16, audioFormat: 1, channels: 1,
    durationSamples: BigInt(dur), dataSize: dur * 2, dataOffset: 44, blockAlign: 2, hasBext: false,
  });
  const diag = buildTakeDiagnostics({
    takeKey: "FOLDER01/zoom0008", label: "ZOOM0008",
    groupRecords: [mk("ZOOM0008_Tr1.WAV", 6 * SR), mk("ZOOM0008_Tr6.WAV", 4 * SR)],
    report: [], detected: null, fpsValue: "25",
  });
  check("S8 duration-mismatch error", diag.issues.some(i => i.code === "duration-mismatch" && i.severity === "error"),
    diag.issues.map(i => i.code).join(","));
}

// ---------- scenario 9: combine take into poly WAV with LTC-derived TC ----------
{
  console.log("== S9 mono take -> Poly WAV with LTC start TC ==");
  const names = ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV"];
  const recs = await Promise.all(names.map(n => recordFor(join(dir, n), n)));
  const tr = expectedStartSamples("01:23:45:00", "25", SR) - BigInt(Math.round(1.5 * SR));
  const ltcRecs = recs.map(r => ({ ...r, oldTimeReference: tr }));
  const writable = new MemWritable();
  const muted = new Set([`FOLDER01/ZOOM0001_Tr6.WAV:0`]);
  const out = await writeCombinedPolyToWritable("FOLDER01/zoom0001", ltcRecs, writable, "ZOOM0001_Poly.WAV", {
    groupLabel: r => r.name,
    fallbackFpsValue: "25",
    mutedSourceChannels: muted,
    profile: "archive",
  });
  const poly = new File([writable.data], "ZOOM0001_Poly.WAV");
  const polyRec = await scanWave({ getFile: async () => poly }, { relativePath: "ZOOM0001_Poly.WAV", parentPath: "" });
  check("S9 poly has 3 channels", polyRec.channels === 3, `${polyRec.channels}`);
  check("S9 bext TimeReference = LTC start", polyRec.oldTimeReference === tr, `${polyRec.oldTimeReference} vs ${tr}`);
  check("S9 iXML has track list", Boolean(polyRec.ixmlInfo));

  const srcTr1 = await readDataView(recs[0].file, recs[0].dataOffset, 2 * 96000);
  const polyView = await readDataView(poly, polyRec.dataOffset, 2 * 96000 * 3);
  let same = 0, tr6Zero = true, tr1Match = true;
  for (let i = 0; i < 96000; i++) {
    const src = srcTr1.getInt16(i * 2, true);
    const ch0 = polyView.getInt16(i * 6, true);
    const ch2 = polyView.getInt16(i * 6 + 4, true);
    if (src !== ch0) tr1Match = false;
    if (ch2 !== 0) tr6Zero = false;
    if (src === ch0) same++;
  }
  check("S9 ch0 == Tr1 audio", tr1Match);
  check("S9 ch2 (Tr6) muted to silence", tr6Zero);

  // resolve profile physically excludes the confirmed LTC channel
  const w2 = new MemWritable();
  const out2 = await writeCombinedPolyToWritable("FOLDER01/zoom0001", ltcRecs, w2, "ZOOM0001_Poly2.WAV", {
    groupLabel: r => r.name,
    fallbackFpsValue: "25",
    mutedSourceChannels: muted,
    profile: "resolve",
  });
  const poly2 = new File([w2.data], "ZOOM0001_Poly2.WAV");
  const polyRec2 = await scanWave({ getFile: async () => poly2 }, { relativePath: "ZOOM0001_Poly2.WAV", parentPath: "" });
  check("S9 resolve excludes LTC track", polyRec2.channels === 2 && out2.excludedTracks.length === 1,
    `ch=${polyRec2.channels} excluded=${out2.excludedTracks.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
