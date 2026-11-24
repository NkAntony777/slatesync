// conform_check.v1 的回归测试。
//
// 两类：
//   1) 纯判定层（src/conform-check.js）—— 三态、证据链、容差、跨帧率归一。
//   2) CLI 端到端（scripts/conform-check.mjs）—— 真实退出码、真实 JSON 报告。
// 所有素材都是 scripts/make-conform-fixtures.mjs 现场生成的合成素材（文件名带 _stub），
// 未在真实拍摄素材上验证。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONFORM_VERDICTS,
  ConformInputError,
  DEFAULT_FRAME_TOLERANCE_FRAMES,
  buildConformReport,
  parseClipList,
  resolveExitCode,
} from "../src/conform-check.js";
import { framesToSamples, parseFps, timecodeToFrames } from "../src/timecode.js";
import { writeConformFixtures } from "../scripts/make-conform-fixtures.mjs";
// 临时目录纪律：落本仓内 .tmp/（D 盘）+ 四道钩子必删
// —— 见 docs/测试临时目录泄漏修复.md
import { makeTempDir } from "./tmp-helper.mjs";

const RATE = 48000;
const CLI = fileURLToPath(new URL("../scripts/conform-check.mjs", import.meta.url));

function samplesAt(timecode, fpsValue = "25") {
  const fps = parseFps(fpsValue);
  return framesToSamples(timecodeToFrames(timecode, fps), RATE, fps);
}

// 一个「文件事实」的最小 probe：判定层只吃这些字段，不读盘。
function probeOf(name, startTimecode, options = {}) {
  const { seconds = 6, fpsValue = "25", ltc = null, withBext = true, readable = true } = options;
  return {
    path: name,
    name,
    bytes: 1024,
    readable,
    sampleRate: readable ? RATE : null,
    channels: readable ? 1 : null,
    bitsPerSample: readable ? 16 : null,
    durationSamples: readable ? BigInt(Math.round(seconds * RATE)) : null,
    bext: withBext && readable
      ? { present: true, timeReference: samplesAt(startTimecode, fpsValue) }
      : { present: false, timeReference: null },
    ixml: { present: false, timeReference: null },
    ltc,
  };
}

function lockedLtc(timecode, fpsValue = "25", confidence = 0.92) {
  return {
    status: "locked",
    timecode,
    fpsValue,
    confidence,
    lockedFrames: 6,
    channelIndex: 0,
    samples: samplesAt(timecode, fpsValue).toString(),
  };
}

function clipListOf(clips, fps = "25") {
  return parseClipList(JSON.stringify({ schema: "clip_list.v1", fps, clips }));
}

function reportFor(clips, probes, options = {}, fps = "25") {
  return buildConformReport({ clipList: clipListOf(clips, fps), probes, options, mediaRoot: "media" });
}

function rowOf(clip, kind) {
  return clip.evidence.find((row) => row.kind === kind);
}

// ---------------------------------------------------------------------------
// 1. 输入契约
// ---------------------------------------------------------------------------

test("parseClipList 拒绝坏 schema、未知字段、坏时码、重复 id、倒置入出", () => {
  const good = { schema: "clip_list.v1", fps: "25", clips: [{ id: "a", name: "A.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:01:00" }] };
  assert.equal(parseClipList(JSON.stringify(good)).clips.length, 1);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, schema: "clip_list.v2" })), ConformInputError);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, tolerances: {} })), ConformInputError);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, clips: [{ ...good.clips[0], sourceTC: "10:00:00:00" }] })), ConformInputError);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, clips: [{ ...good.clips[0], sourceIn: "10:00:00:99" }] })), ConformInputError);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, clips: [good.clips[0], good.clips[0]] })), ConformInputError);
  assert.throws(() => parseClipList(JSON.stringify({ ...good, clips: [{ ...good.clips[0], sourceOut: "09:00:00:00" }] })), ConformInputError);
  assert.throws(() => parseClipList("{"), ConformInputError);
});

test("drop-frame 标签按 timecode.js 归一：00:01:00;02 是第 1800 帧而不是 1802 帧", () => {
  const list = clipListOf([
    { id: "df", name: "DF.WAV", sourceIn: "00:01:00;02", sourceOut: "00:01:01;02" },
  ], "29.97df");
  const claim = list.clips[0];
  assert.equal(claim.sourceIn.frames.toString(), "1800");
  assert.equal(claim.sourceIn.normalized, "00:01:00;02");
  assert.equal(claim.fps.drop, true);
});

// ---------------------------------------------------------------------------
// 2. 三态语义
// ---------------------------------------------------------------------------

test("只有文件名对上不算 supported：没有内容证据时是 unverified", () => {
  const report = reportFor(
    [{ id: "c1", name: "A001_stub.WAV", sourceIn: "10:00:01:00", sourceOut: "10:00:05:00" }],
    [probeOf("A001_stub.WAV", "10:00:00:00", { withBext: false })],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.UNVERIFIED);
  assert.equal(rowOf(clip, "identifier.filename").status, "pass");
  assert.ok(clip.reasons.includes("no-independent-witness"), clip.reasons.join(","));
  assert.equal(clip.evidence.filter((row) => row.status === "fail").length, 0);
});

test("内嵌时码覆盖声称区间时 supported，且 coverage 区分 inside / exact", () => {
  const report = reportFor(
    [
      { id: "inside", name: "A001_stub.WAV", sourceIn: "10:00:01:00", sourceOut: "10:00:05:00" },
      { id: "exact", name: "A001_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:05:00" },
    ],
    [probeOf("A001_stub.WAV", "10:00:00:00")],
  );
  assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.equal(rowOf(report.clips[0], "content.embedded-range").coverage, "inside");
  assert.equal(report.clips[1].verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.equal(rowOf(report.clips[1], "content.embedded-range").coverage, "exact");
});

test("连错 take：声称区间落在文件区间外 → conflict（两种方向都判 fail）", () => {
  const report = reportFor(
    [
      { id: "after", name: "A002_T001_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00" },
      { id: "before", name: "A002_T001_stub.WAV", sourceIn: "10:00:30:00", sourceOut: "10:00:34:00" },
    ],
    [probeOf("A002_T001_stub.WAV", "10:00:20:00")],
  );
  assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(report.clips[0], "content.embedded-range").coverage, "before-file");
  assert.ok(report.clips[0].reasons.includes("embedded-range-mismatch"));
  assert.equal(report.clips[1].verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(report.clips[1], "content.embedded-range").coverage, "after-file");
});

test("连错 take 时给出可操作的替代候选（文件名相近、时码不同一）", () => {
  const report = reportFor(
    [{ id: "wrong", name: "A002_T001_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00" }],
    [
      probeOf("A002_T001_stub.WAV", "10:00:20:00"),
      probeOf("A002_T002_stub.WAV", "10:00:00:00"),
      probeOf("A001_T001_stub.WAV", "10:00:00:00"),
    ],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.CONFLICT);
  const paths = clip.alternates.map((alternate) => alternate.path);
  assert.ok(paths.includes("A002_T002_stub.WAV"), paths.join(","));
  assert.equal(clip.alternates[0].startDeltaFrames, "0.000000000");
  assert.match(clip.suggestions[0], /覆盖清单声称的源区间/);
});

test("证据缺失：既没有内嵌时码也没有 LTC → unverified，既不是 supported 也不是 conflict", () => {
  const report = reportFor(
    [{ id: "c1", name: "C001_silent_stub.WAV", sourceIn: "12:00:00:00", sourceOut: "12:00:04:00" }],
    [probeOf("C001_silent_stub.WAV", "00:00:00:00", { withBext: false })],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.UNVERIFIED);
  assert.notEqual(clip.verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.notEqual(clip.verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(clip, "content.duration").status, "pass");
  assert.equal(rowOf(clip, "content.duration").strength, "weak");
  assert.equal(rowOf(clip, "content.embedded-range").status, "missing");
  assert.ok(clip.reasons.includes("no-embedded-timecode"));
});

test("媒体目录里没有这个文件 → unverified（媒体缺席不是证据反对）", () => {
  const report = reportFor(
    [{ id: "ghost", name: "Z999_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00" }],
    [probeOf("A001_stub.WAV", "10:00:00:00")],
  );
  assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.UNVERIFIED);
  assert.ok(report.clips[0].reasons.includes("media-not-found"));
});

test("LTC 单独就能支撑 supported（没有 bext 的文件）", () => {
  const report = reportFor(
    [{ id: "ltc", name: "B001_ltc_stub.WAV", sourceIn: "11:00:01:00", sourceOut: "11:00:05:00" }],
    [probeOf("B001_ltc_stub.WAV", "00:00:00:00", { withBext: false, ltc: lockedLtc("11:00:00:00") })],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.equal(rowOf(clip, "content.ltc-range").status, "pass");
  assert.equal(rowOf(clip, "content.ltc-range").strength, "strong");
});

test("LTC 置信度不足时不当证据用（宁可 missing，不拿错锁当见证）", () => {
  const report = reportFor(
    [{ id: "weak", name: "B001_ltc_stub.WAV", sourceIn: "11:00:01:00", sourceOut: "11:00:05:00" }],
    [probeOf("B001_ltc_stub.WAV", "00:00:00:00", { withBext: false, ltc: lockedLtc("11:00:00:00", "25", 0.31) })],
  );
  assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.UNVERIFIED);
  assert.equal(rowOf(report.clips[0], "content.ltc-range").status, "missing");
});

test("文件内部两条见证互相矛盾 → conflict（bext 09:00 vs LTC 09:30）", () => {
  const report = reportFor(
    [{ id: "internal", name: "D001_stub.WAV", sourceIn: "09:30:00:00", sourceOut: "09:30:04:00" }],
    [probeOf("D001_stub.WAV", "09:00:00:00", { ltc: lockedLtc("09:30:00:00") })],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(clip, "content.cross-evidence-agreement").status, "fail");
  assert.ok(clip.reasons.includes("internal-evidence-disagreement"));
});

test("清单自身自相矛盾（时间线 span ≠ 源 span）→ conflict", () => {
  const report = reportFor(
    [{
      id: "self",
      name: "A001_stub.WAV",
      sourceIn: "10:00:01:00",
      sourceOut: "10:00:05:00",
      timelineIn: "01:00:00:00",
      timelineOut: "01:00:10:00",
    }],
    [probeOf("A001_stub.WAV", "10:00:00:00")],
  );
  const clip = report.clips[0];
  assert.equal(clip.verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(clip, "identifier.timeline-span").status, "fail");
  assert.ok(clip.reasons.includes("timeline-span-mismatch"));
});

test("媒体目录里同名多份 → conflict（不替人挑）", () => {
  const report = reportFor(
    [{ id: "dup", name: "A001_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00" }],
    [probeOf("A001_stub.WAV", "10:00:00:00"), probeOf("A001_stub.WAV", "10:00:00:00")],
  );
  assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.CONFLICT);
  assert.ok(report.clips[0].reasons.includes("ambiguous-filename"));
});

// ---------------------------------------------------------------------------
// 3. 跨帧率 / drop-frame 归一
// ---------------------------------------------------------------------------

test("整数帧率混用：24 / 25 / 30 / 48 / 50 / 60 的同一标签都判 supported（帧数完全不同，秒数相同）", () => {
  const rates = ["24", "25", "30", "48", "50", "60"];
  const framesSeen = new Set();
  for (const fps of rates) {
    const report = reportFor(
      [{ id: "x-" + fps, name: "A001_stub.WAV", sourceIn: "10:00:01:00", sourceOut: "10:00:05:00", fps }],
      [probeOf("A001_stub.WAV", "10:00:00:00")],
      {},
      "25",
    );
    assert.equal(report.clips[0].verdict, CONFORM_VERDICTS.SUPPORTED, fps + " -> " + report.clips[0].reasons.join(","));
    assert.equal(rowOf(report.clips[0], "content.embedded-range").coverage, "inside", fps);
    framesSeen.add(report.clips[0].claim.sourceInFrames);
  }
  // 帧号各不相同（864024 / 900000 / 1080000 …），只有换算成秒之后才可比。
  assert.equal(framesSeen.size, rates.length);
});

test("23.976 不是 24：同一个帧号在两种速率下墙钟不同，工具必须区分", () => {
  // 864000 帧 @23.976 = 36036 s；同一帧号 @24 = 36000 s。相差 36 秒。
  const at23976 = probeOf("N_stub.WAV", "10:00:00:00", { fpsValue: "23.976" });
  const inside = reportFor(
    [{ id: "n1", name: "N_stub.WAV", sourceIn: "10:00:00:12", sourceOut: "10:00:04:00", fps: "23.976" }],
    [at23976], {}, "25",
  );
  assert.equal(inside.clips[0].verdict, CONFORM_VERDICTS.SUPPORTED, inside.clips[0].reasons.join(","));

  const confused = reportFor(
    [{ id: "n2", name: "N_stub.WAV", sourceIn: "10:00:00:00", sourceOut: "10:00:04:00", fps: "24" }],
    [at23976], {}, "25",
  );
  assert.equal(confused.clips[0].verdict, CONFORM_VERDICTS.CONFLICT);
  // 声称的入点（36000 s）早于文件起点（36036 s）：这个文件里没有这段。
  assert.equal(rowOf(confused.clips[0], "content.embedded-range").coverage, "before-file");
});

test("DF 帧号差必须被算出来：1800 帧 supported，1802 帧（差 2 帧）conflict", () => {
  const dfClaim = (id, inTc, outTc) => ({ id, name: "DF_stub.WAV", sourceIn: inTc, sourceOut: outTc });
  const at1800 = {
    ...probeOf("DF_stub.WAV", "00:00:00:00", { seconds: 6 }),
    bext: { present: true, timeReference: framesToSamples(1800n, RATE, parseFps("29.97df")) },
  };
  const at1802 = {
    ...probeOf("DF_stub.WAV", "00:00:00:00", { seconds: 6 }),
    bext: { present: true, timeReference: framesToSamples(1802n, RATE, parseFps("29.97df")) },
  };
  const ok = reportFor([dfClaim("a", "00:01:00;02", "00:01:04;02")], [at1800], {}, "29.97df");
  const bad = reportFor([dfClaim("b", "00:01:00;02", "00:01:04;02")], [at1802], {}, "29.97df");
  assert.equal(ok.clips[0].verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.equal(bad.clips[0].verdict, CONFORM_VERDICTS.CONFLICT);
});

// ---------------------------------------------------------------------------
// 4. 容差是活的（改阈值必须改变判定）
// ---------------------------------------------------------------------------

test("帧容差是活的：差 1 帧时 tolerance=1 通过、tolerance=0 conflict", () => {
  const clips = [{ id: "edge", name: "A001_stub.WAV", sourceIn: "09:59:59:24", sourceOut: "10:00:03:00" }];
  const probes = [probeOf("A001_stub.WAV", "10:00:00:00")];
  const loose = reportFor(clips, probes, { frameTolerance: DEFAULT_FRAME_TOLERANCE_FRAMES });
  const strict = reportFor(clips, probes, { frameTolerance: 0 });
  assert.equal(loose.clips[0].verdict, CONFORM_VERDICTS.SUPPORTED);
  assert.equal(strict.clips[0].verdict, CONFORM_VERDICTS.CONFLICT);
  assert.equal(rowOf(strict.clips[0], "content.embedded-range").status, "fail");
});

test("不可判定比例阈值是活的：ratio 0.5 时默认 0 判 1，放宽到 0.5 判 0", () => {
  const summary = { clips: 2, supported: 1, unverified: 1, conflict: 0, unverifiedRatio: 0.5 };
  assert.equal(resolveExitCode(summary, 0), 1);
  assert.equal(resolveExitCode(summary, 0.5), 0);
  assert.equal(resolveExitCode({ ...summary, conflict: 1, unverified: 0, unverifiedRatio: 0 }, 1), 1);
  assert.equal(resolveExitCode({ clips: 1, supported: 1, unverified: 0, conflict: 0, unverifiedRatio: 0 }, 0), 0);
});

// ---------------------------------------------------------------------------
// 5. CLI 端到端（真实退出码 + 真实 JSON 报告）
// ---------------------------------------------------------------------------

// 夹具目录整个测试文件共用 ⇒ scope:"file"（由 after 钩子删，afterEach 不动）
const root = makeTempDir("slatesync-conform-", { scope: "file" });
const fixtures = writeConformFixtures(root);
const mediaDir = fixtures.mediaDir;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: path.dirname(CLI) });
}
function listPath(name) {
  return path.join(root, name);
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("CLI 连错 take：conflict + 退出码 1", () => {
  const result = runCli([listPath("clip-list.wrong-take.json"), "--media", mediaDir, "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.contract, "conform_check.v1");
  assert.equal(report.clips[0].verdict, "conflict");
  assert.equal(report.exitCode, 1);
  assert.ok(report.clips[0].evidence.length >= 4);
});

test("CLI 证据缺失：unverified + 退出码 1；放宽阈值后退出码 0 但仍是 unverified", () => {
  const strict = runCli([listPath("clip-list.missing-evidence.json"), "--media", mediaDir, "--json"]);
  assert.equal(strict.status, 1, strict.stderr);
  const strictReport = JSON.parse(strict.stdout);
  assert.equal(strictReport.clips[0].verdict, "unverified");
  assert.equal(strictReport.summary.supported, 0);

  const relaxed = runCli([
    listPath("clip-list.missing-evidence.json"), "--media", mediaDir,
    "--max-unverified-ratio", "1", "--json",
  ]);
  assert.equal(relaxed.status, 0, relaxed.stderr);
  const relaxedReport = JSON.parse(relaxed.stdout);
  assert.equal(relaxedReport.clips[0].verdict, "unverified");
  assert.equal(relaxedReport.exitCode, 0);
});

test("CLI 全支撑：退出码 0", () => {
  const result = runCli([listPath("clip-list.all-supported.json"), "--media", mediaDir, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.supported, 2);
  assert.equal(report.summary.conflict, 0);
});

test("CLI 报告不写本机绝对路径（报告会被提交/贴出来）", () => {
  const out = path.join(root, "report.json");
  const result = runCli([listPath("clip-list.mixed.json"), "--media", mediaDir, "--quiet", "--report", out]);
  assert.equal(result.status, 1, result.stderr);
  const text = readFileSync(out, "utf8");
  assert.ok(!/[A-Za-z]:\\\\/.test(text), "报告里出现了盘符绝对路径");
  assert.ok(!text.includes(root), "报告里出现了临时目录绝对路径");
  const report = JSON.parse(text);
  assert.equal(report.mediaRoot, "media");
  assert.equal(report.run.ignoredNonWaveFiles >= 1, true);
});

test("CLI 输入问题是退出码 2（schema 不符 / 未知选项 / 媒体目录不存在）", () => {
  const badSchema = path.join(root, "bad-schema.json");
  writeFileSync(badSchema, JSON.stringify({ schema: "clip_list.v9", clips: [] }));
  assert.equal(runCli([badSchema, "--media", mediaDir]).status, 2);
  assert.equal(runCli([listPath("clip-list.mixed.json"), "--media", mediaDir, "--nope"]).status, 2);
  assert.equal(runCli([listPath("clip-list.mixed.json"), "--media", path.join(root, "not-here")]).status, 2);
  assert.equal(runCli([listPath("clip-list.mixed.json")]).status, 2);
});
