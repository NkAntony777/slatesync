// CMX3600 EDL 解析器（src/edl-cmx3600.js）与 --edl 入口的回归测试。
//
// 三类：
//   1) 解析层：真实形状 EDL 的逐条期望（手算）、丢帧帧号、注释保留、文件名解析。
//   2) 严格性：坏 EDL 必须抛错并带行号，绝不静默跳过一行。
//   3) CLI 端到端：--edl → clip_list → 三态报告，真实退出码。
//
// 素材全部是 scripts/make-conform-fixtures.mjs 现场生成的合成素材（文件名带 _stub），
// EDL 是手写的合成表，未在真实剪辑室的表上验证。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CMX3600_PARSER,
  EdlParseError,
  baseNameOf,
  edlToClipList,
  extractClipName,
  parseCmx3600Edl,
} from "../src/edl-cmx3600.js";
import { ConformInputError, normalizeClipList, parseClipList } from "../src/conform-check.js";
import { writeConformFixtures } from "../scripts/make-conform-fixtures.mjs";

const CLI = fileURLToPath(new URL("../scripts/conform-check.mjs", import.meta.url));
const EDL_DIR = fileURLToPath(new URL("./fixtures/edl/", import.meta.url));

function edlText(name) {
  return readFileSync(path.join(EDL_DIR, name), "utf8");
}
function parseFixture(name, options = {}) {
  return parseCmx3600Edl(edlText(name), { fileName: name, ...options });
}

// ---------------------------------------------------------------------------
// 1. 真实形状 EDL：逐条与手算期望相符
// ---------------------------------------------------------------------------

test("turnover EDL：5 条事件里 4 条音频进 clip，源入出与手算帧号逐条相符", () => {
  const parsed = parseFixture("turnover_25fps.edl");

  assert.equal(parsed.parser, CMX3600_PARSER);
  assert.equal(parsed.title, "SLATESYNC TURNOVER TEST");
  assert.equal(parsed.fcm, "NON-DROP FRAME");
  assert.equal(parsed.fpsValue, "25");
  assert.equal(parsed.fpsSource, "default");
  assert.equal(parsed.dropFrame, false);

  // 事件层：5 条，其中 001 是 V（仅视频），被明确排除并计数。
  assert.equal(parsed.counts.events, 5);
  assert.equal(parsed.counts.audioEvents, 4);
  assert.equal(parsed.counts.videoOnlyEventsExcluded, 1);
  assert.deepEqual(parsed.counts.videoOnlyEventIds, ["001"]);
  assert.equal(parsed.counts.dissolves, 1);
  assert.equal(parsed.counts.namesResolved, 4);
  assert.equal(parsed.counts.namesUnresolved, 0);
  assert.equal(parsed.counts.duplicateEventNumbers, 0);

  // 手算期望（25 fps，非丢帧）：帧号 = (时:分:秒) * 25 + 帧。
  //   002 10:00:00:12 -> 10:00:04:12  = 900012 -> 900112（跨度 100 帧 = 4 秒）
  //   003 10:00:00:00 -> 10:00:03:00  = 900000 -> 900075（跨度 75 帧 = 3 秒）
  //   004 10:00:03:00 -> 10:00:06:00  = 900075 -> 900150（跨度 75 帧），带 dissolve 24
  //   005 11:00:00:12 -> 11:00:04:12  = 990012 -> 990112（跨度 100 帧）
  const expected = [
    { id: "002", reel: "A001", in: "10:00:00:12", out: "10:00:04:12", inFrames: "900012", outFrames: "900112", span: 100n, dissolve: null },
    { id: "003", reel: "A002", in: "10:00:00:00", out: "10:00:03:00", inFrames: "900000", outFrames: "900075", span: 75n, dissolve: null },
    { id: "004", reel: "A002", in: "10:00:03:00", out: "10:00:06:00", inFrames: "900075", outFrames: "900150", span: 75n, dissolve: 24 },
    { id: "005", reel: "B001", in: "11:00:00:12", out: "11:00:04:12", inFrames: "990012", outFrames: "990112", span: 100n, dissolve: null },
  ];
  const clips = edlToClipList(parsed).clips;
  assert.equal(clips.length, expected.length);
  for (const [index, want] of expected.entries()) {
    const clip = clips[index];
    assert.equal(clip.id, want.id);
    assert.equal(clip.reel, want.reel);
    assert.equal(clip.sourceIn, want.in);
    assert.equal(clip.sourceOut, want.out);
    assert.equal(parsed.audioEvents[index].sourceIn.frames.toString(), want.inFrames);
    assert.equal(parsed.audioEvents[index].sourceOut.frames.toString(), want.outFrames);
    assert.equal(
      (parsed.audioEvents[index].sourceOut.frames - parsed.audioEvents[index].sourceIn.frames).toString(),
      want.span.toString(),
    );
    assert.equal(parsed.audioEvents[index].dissolveFrames, want.dissolve);
  }
  // 004 是 dissolve：帧数在 note 里留痕，且没有把转场当成硬切悄悄吞掉。
  assert.match(clips[2].note, /trans=D;dissolveFrames=24/);
  assert.match(clips[0].note, /trans=C/);
  // 录制入出映射到 timelineIn/Out（让校验层能查清单自身是否自相矛盾）。
  assert.equal(clips[0].timelineIn, "01:00:00:12");
  assert.equal(clips[3].timelineOut, "01:00:14:12");
  // 每条 clip 的源跨度与录制跨度相等：真实 EDL 的 cut/dissolve 都该如此。
  for (const clip of clips) {
    const src = parsed.audioEvents.find((event) => event.id === clip.id);
    assert.equal(
      (src.sourceOut.frames - src.sourceIn.frames).toString(),
      (src.recordOut.frames - src.recordIn.frames).toString(),
    );
  }
});

test("丢帧：00:00:59;28 / 00:01:00;04 按 29.97df 解成第 1798 / 1802 帧（不是 1798/1800）", () => {
  const parsed = parseFixture("dropframe_2997df.edl");
  assert.equal(parsed.fpsValue, "29.97df");
  assert.equal(parsed.fpsSource, "default-dropframe");
  assert.equal(parsed.dropFrame, true);

  const event = parsed.audioEvents[0];
  // 00:00:59;28 -> 59*30+28 = 1798
  assert.equal(event.sourceIn.frames.toString(), "1798");
  // 00:01:00;02 才是 1800（DF 在整分钟丢掉 00/01 两帧）；;04 是 1802。
  assert.equal(event.sourceOut.frames.toString(), "1802");
  // 01:00:00;00 -> 60*60*30 - 2*(60-6) = 108000 - 108 = 107892
  assert.equal(event.recordIn.frames.toString(), "107892");
  // 规范形态保留分号：DF 的同一帧号用冒号写会变义。
  assert.equal(event.sourceIn.normalized, "00:00:59;28");
  assert.equal(edlToClipList(parsed).fps, "29.97df");
});

test("真实形状 + 丢帧同一份表：reel AX / 3 条事件 / dissolve / 分号时码 / 注释，帧号逐条手算相符", () => {
  const parsed = parseFixture("turnover_2997df.edl");
  assert.equal(parsed.fpsValue, "29.97df");
  assert.equal(parsed.fpsSource, "default-dropframe");
  assert.equal(parsed.fcm, "DROP FRAME");
  assert.equal(parsed.counts.events, 3);
  assert.equal(parsed.counts.audioEvents, 3);
  assert.equal(parsed.counts.videoOnlyEventsExcluded, 0);
  assert.equal(parsed.counts.dissolves, 1);
  assert.equal(parsed.counts.comments, 7);
  assert.equal(parsed.counts.namesResolved, 3);
  assert.deepEqual(parsed.audioEvents.map((event) => event.reel), ["AX", "AX", "AX"]);

  // 手算（29.97df，每分钟丢 2 帧，每 10 分钟只丢 9*2 帧）：
  //   001 10:00:00;10 -> 36000*30+10 - 2*(600-60) = 1078930
  //       10:00:04;00 -> 36004*30     - 1080        = 1079040（跨度 110）
  //   002 10:00:04;00 -> 1079040 ; 10:00:06;00 -> 36006*30 - 1080 = 1079100（跨度 60）
  //   003 11:00:00;18 -> 11*3600*30+18 - 2*(660-66) = 1186830
  //       11:00:02;28 -> 39602*30+28  - 1188       = 1186900（跨度 70）
  const frames = [
    ["001", "1078930", "1079040", 110],
    ["002", "1079040", "1079100", 60],
    ["003", "1186830", "1186900", 70],
  ];
  for (const [index, item] of frames.entries()) {
    const [id, inFrames, outFrames, span] = item;
    const event = parsed.audioEvents[index];
    assert.equal(event.id, id);
    assert.equal(event.sourceIn.frames.toString(), inFrames, id + " 源入帧号");
    assert.equal(event.sourceOut.frames.toString(), outFrames, id + " 源出帧号");
    assert.equal((event.sourceOut.frames - event.sourceIn.frames).toString(), String(span));
    // 源跨度与录制跨度相等（真实 cut/dissolve 都如此），否则 timeline-span 会判自相矛盾。
    assert.equal((event.recordOut.frames - event.recordIn.frames).toString(), String(span));
  }

  // dissolve：24 帧，帧数不超过事件跨度，且 note 里留痕。
  const dissolve = parsed.audioEvents.find((event) => event.id === "002");
  assert.equal(dissolve.dissolveFrames, 24);
  // 002 在源文件第 8 行（1-based，L7 是空行）；行号供人直接跳转，不用 0-based。
  assert.deepEqual(parsed.dissolves, [{ id: "002", line: 8, frames: 24, reel: "AX" }]);
  assert.match(edlToClipList(parsed).clips[1].note, /trans=D;dissolveFrames=24/);
  // 规范形态保留分号：丢帧标签不能用冒号写。
  assert.match(parsed.audioEvents[0].sourceIn.normalized, /;10$/);
});

test("注释行全保留：* LOC 之类不参与命名的注释也不丢，且能同时带 FROM/TO 两条名字", () => {
  const parsed = parseFixture("turnover_25fps.edl");
  assert.equal(parsed.counts.comments, 8);
  assert.equal(parsed.headerComments.length, 0);

  const first = parsed.audioEvents.find((event) => event.id === "002");
  assert.equal(first.comments.length, 2);
  assert.equal(first.comments[0].text, "* FROM CLIP NAME: A001_T001_stub.WAV");
  assert.equal(first.comments[1].text, "* SOURCE FILE: /vol/media/A001_T001_stub.WAV");
  // 注释行号是原文行号（从 1 开始），便于人工回查。
  assert.equal(first.comments[0].line, 9);

  // 视频轨事件的注释也保留（A001C001_240101.R3D + LOC），只是不参与音频判定。
  const video = parsed.videoOnlyEvents[0];
  assert.equal(video.id, "001");
  assert.equal(video.comments.length, 2);
  assert.match(video.comments[1].text, /^\* LOC: /);

  // dissolve 事件同时写了 FROM 与 TO：两条都留着，主名取 FROM。
  const dissolve = parsed.audioEvents.find((event) => event.id === "004");
  assert.equal(dissolve.nameHits.length, 2);
  assert.equal(dissolve.name, "A002_T002_stub.WAV");
  assert.equal(dissolve.nameSource, "FROM CLIP NAME");
  assert.ok(dissolve.nameHits.some((hit) => hit.name === "B001_T001_ltc_stub.WAV"));
});

test("文件名只从显式注释键取：路径取 basename，取不到就留空，绝不猜", () => {
  assert.equal(baseNameOf("/vol/media/A001_T001_stub.WAV"), "A001_T001_stub.WAV");
  assert.equal(baseNameOf("C:\\media\\A001.WAV"), "A001.WAV");
  assert.equal(baseNameOf('"A001_T001_stub.WAV"'), "A001_T001_stub.WAV");

  assert.deepEqual(extractClipName("FROM CLIP NAME: A001_T001_stub.WAV").name, "A001_T001_stub.WAV");
  assert.deepEqual(extractClipName("TO CLIP NAME: B001.WAV").role, "to");
  assert.equal(extractClipName("LOC: 01:00:01:12 RED 4.5K"), null);
  assert.equal(extractClipName("EFFECTS NAME IS CROSS DISSOLVE"), null);

  const parsed = parseFixture("no-clip-name.edl");
  const event = parsed.audioEvents[0];
  assert.equal(event.name, "");
  assert.equal(event.nameSource, null);
  assert.equal(parsed.counts.namesUnresolved, 1);
  assert.equal(parsed.counts.namesResolved, 0);
  // 关键：留空而不是「AX」这种卷号冒充文件名。
  const clip = edlToClipList(parsed).clips[0];
  assert.equal(clip.name, "");
  assert.match(clip.note, /nameUnresolved/);
});

// ---------------------------------------------------------------------------
// 2. 严格性：坏 EDL 必须报错并带行号，不许静默跳过
// ---------------------------------------------------------------------------

test("坏 EDL 全部抛 EdlParseError，且都带行号与具体原因", () => {
  const cases = [
    { file: "bad-field-count.edl", line: 4, match: /字段数不对：cut 事件需要 8 个字段，实际 7 个/ },
    { file: "bad-timecode.edl", line: 4, match: /时码非法：.*10:00:00:99.*帧数必须小于 25/ },
    { file: "bad-wipe.edl", line: 4, match: /不支持的转场类型 W/ },
    { file: "bad-motion-memo.edl", line: 4, match: /不支持变速\/冻结备忘行（M2）/ },
    { file: "bad-mixed-separators.edl", line: 0, match: /混用了丢帧.*与非丢帧/ },
    { file: "bad-video-only.edl", line: 0, match: /只有视频轨事件.*没有任何音频轨事件/ },
  ];
  for (const item of cases) {
    let caught = null;
    try {
      parseFixture(item.file);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof EdlParseError, item.file + " 应该抛 EdlParseError");
    assert.ok(caught.issues.length >= 1, item.file + " 至少要有一条 issue");
    const issue = caught.issues.find((entry) => item.match.test(entry.message));
    assert.ok(issue, item.file + " 的 issue 文案不匹配，实际：" + caught.issues.map((i) => i.message).join(" | "));
    if (item.line > 0) assert.equal(issue.line, item.line, item.file + " 的行号不对");
  }
});

test("不认识的记录类型与重复事件号：前者报错带行号，后者加 #2 后缀保 id 唯一", () => {
  const unknown = "TITLE: X\nFCM: NON-DROP FRAME\n\nEFFECTS NAME IS CROSS DISSOLVE\n001  AX  A  C  00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00\n";
  assert.throws(
    () => parseCmx3600Edl(unknown),
    (error) => error instanceof EdlParseError
      && error.issues.some((issue) => issue.line === 4 && /无法识别的记录类型/.test(issue.message)),
  );

  const dup = "TITLE: D\nFCM: NON-DROP FRAME\n\n002  AX  A  C  00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00\n"
    + "002  AX  A  C  00:00:01:00 00:00:02:00 01:00:01:00 01:00:02:00\n";
  const parsed = parseCmx3600Edl(dup);
  assert.deepEqual(parsed.audioEvents.map((event) => event.id), ["002", "002#2"]);
  assert.equal(parsed.counts.duplicateEventNumbers, 1);
  assert.match(edlToClipList(parsed).clips[1].note, /dupOf=002/);
});

test("dissolve 自检：帧数超过事件跨度、或 D 行缺帧数，都报错", () => {
  const tooLong = "TITLE: T\nFCM: NON-DROP FRAME\n\n001  AX  A  D  100 00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00\n";
  assert.throws(
    () => parseCmx3600Edl(tooLong),
    (error) => error instanceof EdlParseError && error.issues.some((i) => /超过该事件的源跨度/.test(i.message)),
  );
  const missingFrames = "TITLE: T\nFCM: NON-DROP FRAME\n\n001  AX  A  D  00:00:00:00 00:00:01:00 01:00:00:00 01:00:02:00\n";
  assert.throws(
    () => parseCmx3600Edl(missingFrames),
    (error) => error instanceof EdlParseError && error.issues.some((i) => /dissolve 事件需要 9 个字段/.test(i.message)),
  );
});

test("FCM 与参数打架时明确报错，并给出可执行的下一步（不替你挑一种解释）", () => {
  // FCM 说丢帧，但没有任何分号：可疑，要求显式声明。
  const dropNoSemi = "TITLE: T\nFCM: DROP FRAME\n\n001  AX  A  C  00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00\n";
  assert.throws(
    () => parseCmx3600Edl(dropNoSemi),
    (error) => error instanceof EdlParseError
      && error.issues.some((i) => /FCM 声明 DROP FRAME，但没有任何时码使用分号/.test(i.message)),
  );
  // 给了非丢帧的 29.97 参数，但时码有分号：文件自身矛盾，报错并建议改传 29.97df。
  assert.throws(
    () => parseFixture("dropframe_2997df.edl", { fps: "29.97" }),
    (error) => error instanceof EdlParseError
      && error.issues.some((i) => /请改传 29\.97df/.test(i.message)),
  );
  // 25 fps 根本没有丢帧变体：也不该硬升，直接说清楚。
  assert.throws(
    () => parseFixture("dropframe_2997df.edl", { fps: "25" }),
    (error) => error instanceof EdlParseError
      && error.issues.some((i) => /对应的速率不支持丢帧/.test(i.message)),
  );
  // 参数正确时正常解析。
  const ok = parseFixture("dropframe_2997df.edl", { fps: "29.97df" });
  assert.equal(ok.fpsSource, "cli");
  assert.equal(ok.audioEvents[0].sourceIn.frames.toString(), "1798");
});

// ---------------------------------------------------------------------------
// 3. 投影契约：派生清单能被既有 schema 接受，且没有放宽文件入口
// ---------------------------------------------------------------------------

test("派生的 clip_list.v1 通过 normalizeClipList（allowUnresolvedName），但文件入口仍拒绝空 name", () => {
  const parsed = parseFixture("turnover_25fps.edl");
  const list = edlToClipList(parsed);
  assert.equal(list.schema, "clip_list.v1");
  assert.equal(list.fps, "25");
  assert.equal(list.clips.length, 4);

  const normalized = normalizeClipList(list, { allowUnresolvedName: true });
  assert.equal(normalized.clips.length, 4);
  assert.equal(normalized.clips[0].id, "002");
  assert.equal(normalized.clips[0].name, "A001_T001_stub.WAV");

  // 默认模式（读文件走的就是这条路）必须仍然拒绝空 name：schema 语义没被放宽。
  const withEmptyName = { schema: "clip_list.v1", clips: [{ id: "x", name: "", sourceIn: "00:00:00:00", sourceOut: "00:00:01:00" }] };
  assert.throws(() => parseClipList(JSON.stringify(withEmptyName)), ConformInputError);
  assert.throws(() => normalizeClipList(withEmptyName), ConformInputError);
  // 允许模式下空 name 保留为空串（不是 null，也不是猜出来的名字）。
  assert.equal(normalizeClipList(withEmptyName, { allowUnresolvedName: true }).clips[0].name, "");
});

test("解析器是纯函数：不 import 任何 node: 内置模块（浏览器里也能跑）", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/edl-cmx3600.js", import.meta.url)), "utf8");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["./timecode.js"]);
  assert.ok(!/from\s+"node:/.test(source), "解析器里不应 import node: 内置模块");
});

// ---------------------------------------------------------------------------
// 4. CLI 端到端：--edl → clip_list → 三态报告
// ---------------------------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), "slatesync-edl-"));
const fixtures = writeConformFixtures(root);
const mediaDir = fixtures.mediaDir;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: path.dirname(CLI) });
}
function edlPath(name) {
  return path.join(EDL_DIR, name);
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("CLI --edl：EDL → 三态报告，退出码 0，run.source 计数正确，syntheticStubMedia 为 true", () => {
  const result = runCli(["--edl", edlPath("turnover_25fps.edl"), "--media", mediaDir, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.contract, "conform_check.v1");
  assert.equal(report.clipListSchema, "clip_list.v1");
  assert.equal(report.syntheticStubMedia, true);
  assert.deepEqual(
    { clips: report.summary.clips, supported: report.summary.supported, unverified: report.summary.unverified, conflict: report.summary.conflict },
    { clips: 4, supported: 4, unverified: 0, conflict: 0 },
  );
  assert.deepEqual(report.clips.map((clip) => clip.id), ["002", "003", "004", "005"]);
  assert.equal(report.exitCode, 0);

  // run 是 CLI 溯源块：EDL 的解析事实全在这里，判定契约字段没被污染。
  const source = report.run.source;
  assert.equal(source.kind, "edl-cmx3600");
  assert.equal(source.parser, "cmx3600.v1");
  assert.equal(source.events, 5);
  assert.equal(source.audioEvents, 4);
  assert.equal(source.videoOnlyEventsExcluded, 1);
  assert.deepEqual(source.videoOnlyEventIds, ["001"]);
  assert.equal(source.dissolves, 1);
  assert.equal(source.comments, 8);
  assert.equal(source.namesUnresolved, 0);
  assert.equal(source.fps, "25");
  assert.equal(source.file, "turnover_25fps.edl");
  // 报告不带本机绝对路径。
  assert.ok(!result.stdout.includes(root), "报告里出现了临时目录绝对路径");
});

test("CLI 按扩展名识别 .edl（位置参数），结果与 --edl 完全一致", () => {
  const byFlag = runCli(["--edl", edlPath("turnover_25fps.edl"), "--media", mediaDir, "--json"]);
  const byExtension = runCli([edlPath("turnover_25fps.edl"), "--media", mediaDir, "--json"]);
  assert.equal(byExtension.status, 0, byExtension.stderr);
  const a = JSON.parse(byFlag.stdout);
  const b = JSON.parse(byExtension.stdout);
  assert.deepEqual(b.summary, a.summary);
  assert.deepEqual(b.clips.map((clip) => clip.verdict), a.clips.map((clip) => clip.verdict));
  assert.deepEqual(b.run.source, a.run.source);
});

test("完整链路：EDL → --emit-clip-list → 再跑该 clip_list，摘要与判定逐条一致", () => {
  const outList = path.join(root, "from-edl.json");
  const step1 = runCli([
    "--edl", edlPath("turnover_25fps.edl"), "--media", mediaDir,
    "--emit-clip-list", outList, "--quiet", "--json",
  ]);
  assert.equal(step1.status, 0, step1.stderr);
  const emitted = JSON.parse(readFileSync(outList, "utf8"));
  assert.equal(emitted.schema, "clip_list.v1");
  assert.equal(emitted.clips.length, 4);

  const step2 = runCli([outList, "--media", mediaDir, "--json"]);
  assert.equal(step2.status, 0, step2.stderr);
  const viaList = JSON.parse(step2.stdout);
  const viaEdl = JSON.parse(step1.stdout);
  assert.deepEqual(viaList.summary, viaEdl.summary);
  assert.deepEqual(viaList.clips.map((clip) => clip.id), ["002", "003", "004", "005"]);
  assert.deepEqual(viaList.clips.map((clip) => clip.verdict), ["supported", "supported", "supported", "supported"]);
  assert.equal(viaList.syntheticStubMedia, true);
  // 第二条链路没有 run.source（输入是 clip_list，不是 EDL）：溯源不谎报。
  assert.equal(viaList.run.source, undefined);
});

test("CLI 坏 EDL：退出码 2，stderr 给出具体行号与原因（时码超帧 / 字段缺失）", () => {
  const badTc = runCli(["--edl", edlPath("bad-timecode.edl"), "--media", mediaDir]);
  assert.equal(badTc.status, 2, badTc.stdout);
  assert.match(badTc.stderr, /行 4/);
  assert.match(badTc.stderr, /时码非法/);
  assert.match(badTc.stderr, /10:00:00:99/);
  assert.match(badTc.stderr, /帧数必须小于 25/);

  const badFields = runCli(["--edl", edlPath("bad-field-count.edl"), "--media", mediaDir]);
  assert.equal(badFields.status, 2, badFields.stdout);
  assert.match(badFields.stderr, /行 4/);
  assert.match(badFields.stderr, /字段数不对：cut 事件需要 8 个字段，实际 7 个/);

  // 坏 EDL 不产生半份报告：stdout 里不该有 JSON。
  assert.equal(badTc.stdout.trim(), "");
});

test("CLI 只有视频轨的 EDL：退出码 2（本层只验音频，不假装验过）", () => {
  const result = runCli(["--edl", edlPath("bad-video-only.edl"), "--media", mediaDir]);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /没有任何音频轨事件/);
});

test("CLI 没有文件名的事件：判 unverified（不是 supported），原因与计数都写明", () => {
  const result = runCli(["--edl", edlPath("no-clip-name.edl"), "--media", mediaDir, "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.clips[0].verdict, "unverified");
  assert.ok(report.clips[0].reasons.includes("no-filename-in-edl"));
  assert.ok(!report.clips[0].reasons.includes("media-not-found"));
  assert.equal(report.run.source.namesUnresolved, 1);
  // 默认阈值 0 下 unverified 让退出码变 1；显式放宽后仍是 unverified，但退出码 0。
  const relaxed = runCli([
    "--edl", edlPath("no-clip-name.edl"), "--media", mediaDir, "--max-unverified-ratio", "1", "--json",
  ]);
  assert.equal(relaxed.status, 0, relaxed.stderr);
  assert.equal(JSON.parse(relaxed.stdout).clips[0].verdict, "unverified");
});

test("CLI 用法错一律退出码 2：--edl 与位置参数同时给、--edl-fps 无 EDL、EDL 文件不存在", () => {
  const both = runCli([
    "--edl", edlPath("turnover_25fps.edl"),
    path.join(root, "clip-list.mixed.json"), "--media", mediaDir,
  ]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--edl 与位置参数不能同时给/);

  const orphanFps = runCli([path.join(root, "clip-list.mixed.json"), "--media", mediaDir, "--edl-fps", "25"]);
  assert.equal(orphanFps.status, 2);
  assert.match(orphanFps.stderr, /--edl-fps 只在 EDL 输入下有意义/);

  const missing = runCli(["--edl", path.join(root, "nope.edl"), "--media", mediaDir]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /读不到 EDL/);

  const badFps = runCli(["--edl", edlPath("turnover_25fps.edl"), "--media", mediaDir, "--edl-fps", "24.5x"]);
  assert.equal(badFps.status, 2);
});

test("既有 clip_list 入口不受影响：477 行之前的三种态与退出码照旧", () => {
  const ok = runCli([path.join(root, "clip-list.all-supported.json"), "--media", mediaDir, "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).run.source, undefined);

  const wrong = runCli([path.join(root, "clip-list.wrong-take.json"), "--media", mediaDir, "--json"]);
  assert.equal(wrong.status, 1, wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).clips[0].verdict, "conflict");

  // 手写清单里空 name 仍然退出码 2：schema 没有被 EDL 路径顺手放宽。
  const emptyName = path.join(root, "empty-name.json");
  writeFileSync(emptyName, JSON.stringify({
    schema: "clip_list.v1",
    fps: "25",
    clips: [{ id: "x", name: "", sourceIn: "00:00:00:00", sourceOut: "00:00:01:00" }],
  }));
  assert.equal(runCli([emptyName, "--media", mediaDir]).status, 2);
});
