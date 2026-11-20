// conform_check.v1 的 HTML 报告回归测试。
//
// 这份测试守三件事：
//   1) 报告是**单文件自包含**的静态件：没有外链、没有脚本、没有外部资源。
//      —— 它会被当邮件附件发到别人机器上，多一个外链就意味着收件人的机器会偷偷联网。
//   2) 报告把三态和证据链**真的画出来**：三态各有独立视觉标识（unverified 必须醒目，
//      不能和 supported 混在一起），证据链每个字段（kind/strength/status/expected/
//      measured/deltaSeconds/deltaFrames/toleranceFrames/coverage/detail/readBy）
//      都在 HTML 里，不是「数据都在 JSON 里，HTML 只画了张漂亮的空表」。
//   3) 这些断言**必须能失败**：最后一个用例会真的改坏渲染器（删掉证据链段落），
//      确认同一套断言会红。没有这一条，前两条就只是「写的时候小心一点」。
//
// 所有素材都是 scripts/make-conform-fixtures.mjs 现场生成的合成素材（文件名带 _stub），
// 未在真实拍摄素材上验证。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSelfContainedHtml, renderConformHtml } from "../src/conform-report-html.js";
import { writeConformFixtures } from "../scripts/make-conform-fixtures.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = fileURLToPath(new URL("../scripts/conform-check.mjs", import.meta.url));
const BACKSLASH = String.fromCharCode(92);

// 统计子串出现次数（比正则更直白，也不会被转义坑绊倒）。
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const root = mkdtempSync(path.join(tmpdir(), "slatesync-conform-html-"));
const fixtures = writeConformFixtures(root);
const mediaDir = fixtures.mediaDir;
const jsonOut = path.join(root, "report.json");
const htmlOut = path.join(root, "report.html");

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: path.dirname(CLI) });
}

// 报告对象：直接跑 CLI 拿真实的 JSON 报告，不手搓——手搓的形状会骗人。
const cliRun = runCli([
  path.join(root, "clip-list.mixed.json"), "--media", mediaDir,
  "--quiet", "--report", jsonOut, "--html", htmlOut,
]);
const report = JSON.parse(readFileSync(jsonOut, "utf8"));
const html = readFileSync(htmlOut, "utf8");

test.after(() => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 共享断言集：正向用例用它守住渲染器，反向用例用同一个它验证「改坏了必失败」。
// ---------------------------------------------------------------------------

function assertUnverifiedIsDistinct(html) {
  // 三态各有一张总览卡片，色调类互不相同。
  assert.ok(html.includes('class="card t-ok"'), "总览缺少 supported 卡片");
  assert.ok(html.includes('class="card t-warn"'), "总览缺少 unverified 卡片");
  assert.ok(html.includes('class="card t-bad"'), "总览缺少 conflict 卡片");
  // 样式表里三态是三套不同的颜色，不是同一套换了名字。
  const okColor = /--ok:(#[0-9a-f]{6})/.exec(html);
  const warnColor = /--warn:(#[0-9a-f]{6})/.exec(html);
  const badColor = /--bad:(#[0-9a-f]{6})/.exec(html);
  assert.ok(okColor && warnColor && badColor, "样式表缺少三态颜色变量");
  assert.notEqual(okColor[1], warnColor[1], "unverified 和 supported 用了同一个颜色");
  assert.notEqual(warnColor[1], badColor[1], "unverified 和 conflict 用了同一个颜色");
  // unverified 的视觉权重高于 supported：粗边框 + 独立阴影，不会被绿色盖住。
  assert.ok(
    html.includes(".card.t-warn{border:2px solid var(--warn-line)"),
    "unverified 卡片缺少独立的醒目样式",
  );
  assert.ok(
    html.includes(".card.t-ok{border:1px solid var(--ok-line)"),
    "supported 卡片样式与约定不符",
  );
  // 有一个专门讲「判不了」的专区，把 unverified 从 supported 堆里拎出来。
  assert.ok(html.includes('class="focus t-warn"'), "缺少判不了条目专区");
  assert.ok(html.includes('id="unverified-focus"'), "缺少判不了条目专区锚点");
  // 总览里 unverifiedRatio 单列，且用 warn 标识。
  assert.ok(html.includes("unverifiedRatio"), "总览没有单列 unverifiedRatio");
  assert.ok(html.includes('<span class="badge v-warn">'), "unverifiedRatio 没有用 warn 标识");
}

function articleOf(html, id) {
  const start = html.indexOf('id="clip-' + id + '"');
  if (start < 0) return null;
  const end = html.indexOf("</article>", start);
  return html.slice(start, end < 0 ? undefined : end);
}

function assertReportHtml(html, report) {
  // A. 单文件自包含
  assertSelfContainedHtml(html);
  assert.equal(countOf(html, "http://"), 0, "渲染结果里出现了 http://");
  assert.equal(countOf(html, "https://"), 0, "渲染结果里出现了 https://");
  assert.equal(countOf(html, "<script"), 0, "渲染结果里出现了 <script");
  assert.equal(countOf(html, "<link"), 0, "渲染结果里出现了 <link");
  assert.equal(countOf(html, "<img"), 0, "渲染结果里出现了 <img");
  assert.equal(countOf(html, "url("), 0, "CSS 里出现了 url()");
  assert.equal(countOf(html, "@import"), 0, "CSS 里出现了 @import");

  // B. 三态各有独立视觉标识，unverified 不会被当成通过
  assertUnverifiedIsDistinct(html);

  // C. 证据链字段：每一行证据的 kind/strength/status 都真的进了 HTML，
  //    并且字段名本身出现在页面上（能被人照着 JSON 逐项核对）。
  for (const clip of report.clips) {
    for (const row of clip.evidence) {
      assert.ok(
        html.includes('data-evidence-kind="' + row.kind + '"'),
        "证据 kind 没出现在 HTML：" + row.kind,
      );
      assert.ok(
        html.includes('data-evidence-strength="' + row.strength + '"'),
        "证据 strength 没出现在 HTML：" + row.strength,
      );
      assert.ok(
        html.includes('data-evidence-status="' + row.status + '"'),
        "证据 status 没出现在 HTML：" + row.status,
      );
    }
  }
  for (const field of [
    "kind", "strength", "status", "expected", "measured", "deltaSeconds",
    "deltaFrames", "toleranceFrames", "coverage", "detail", "readBy",
  ]) {
    assert.ok(html.includes(field), "证据链字段没出现在 HTML：" + field);
  }

  // D. 总览：clip 总数、三态计数、unverifiedRatio、failOn 档位、退出码语义、媒体扫描
  assert.ok(html.includes("clip 总数"), "总览缺 clip 总数");
  assert.ok(html.includes("failOn 档位"), "总览缺 failOn 档位");
  assert.ok(html.includes("退出码语义"), "总览缺退出码语义");
  assert.ok(html.includes("媒体目录扫描情况"), "总览缺媒体目录扫描情况");
  assert.ok(html.includes("全部 clip 都有独立证据支撑"), "总览缺退出码 0 的语义");
  assert.ok(html.includes("存在证据矛盾（conflict），或不可判定比例超过阈值"), "总览缺退出码 1 的语义");
  assert.ok(html.includes("输入不可读 / 用法错 / schema 不符"), "总览缺退出码 2 的语义");

  // E. 逐条 clip 展开：候选、替代项、建议、skipped 单列
  assert.equal(countOf(html, 'class="clip v-'), report.clips.length, "clip 展开数量对不上");
  for (const clip of report.clips) {
    const article = articleOf(html, clip.id);
    assert.ok(article, "HTML 里找不到 clip 段落：" + clip.id);
    assert.ok(article.includes("candidates"), "clip 段落缺候选块：" + clip.id);
    assert.ok(article.includes("alternates"), "clip 段落缺替代项块：" + clip.id);
    assert.ok(article.includes("suggestions"), "clip 段落缺建议块：" + clip.id);
    assert.ok(article.includes("readBy"), "clip 段落缺 readBy：" + clip.id);
  }
  assert.ok(html.includes('id="skipped"'), "缺 skipped / 媒体缺席单列");
}

// ---------------------------------------------------------------------------
// 1. 单文件自包含
// ---------------------------------------------------------------------------

test("HTML 报告是单文件自包含的静态件：0 处 http(s)://、0 处 <script、0 个外部资源", () => {
  assert.equal(countOf(html, "http://"), 0, "渲染结果里出现了 http://");
  assert.equal(countOf(html, "https://"), 0, "渲染结果里出现了 https://");
  assert.equal(countOf(html, "<script"), 0, "渲染结果里出现了 <script");
  assert.equal(countOf(html, "<link"), 0, "渲染结果里出现了 <link>");
  assert.equal(countOf(html, "<img"), 0, "渲染结果里出现了 <img>");
  assert.equal(countOf(html, "<iframe"), 0, "渲染结果里出现了 <iframe>");
  assert.equal(countOf(html, "url("), 0, "CSS 里出现了 url()");
  assert.equal(countOf(html, "@import"), 0, "CSS 里出现了 @import");
  assert.equal(countOf(html, "src="), 0, "渲染结果里出现了 src= 外部资源引用");
  assertSelfContainedHtml(html);
});

test("HTML 报告就是这一个文件：样式内联，不引外部字体/图片/CDN", () => {
  assert.ok(html.includes("<style>"), "样式没有内联");
  assert.equal(countOf(html, "<style"), 1, "样式块数量不对");
  assert.ok(html.startsWith("<!DOCTYPE html>"), "不是完整的 HTML 文档");
  assert.ok(html.trimEnd().endsWith("</html>"), "HTML 文档没写完");
  // 单文件：除了这一个 HTML，没有别的东西被引用。
  const refs = html.match(/(src|href)\s*=/gi) || [];
  assert.equal(refs.length, 0, "HTML 里还有外部引用：" + refs.join(", "));
});

// ---------------------------------------------------------------------------
// 2. 三态标识
// ---------------------------------------------------------------------------

test("三态各有独立视觉标识：unverified 是醒目的一档，不会和 supported 混在一起", () => {
  assertUnverifiedIsDistinct(html);
  // 三态都真的出现过（这份混合清单里三种态都有）。
  for (const verdict of ["supported", "unverified", "conflict"]) {
    assert.ok(html.includes(">" + verdict + "<"), "三态里少了：" + verdict);
  }
  // 总览单列 unverifiedRatio，且与 clip 总数对得上。
  assert.equal(report.summary.unverified, 2);
  assert.equal(report.summary.supported, 2);
  assert.equal(report.summary.conflict, 2);
  assert.ok(html.includes("33.33%"), "总览里的不可判定比例不对：" + report.summary.unverifiedRatio);
});

// ---------------------------------------------------------------------------
// 3. 证据链逐行展开
// ---------------------------------------------------------------------------

test("证据链逐行展开：kind/strength/status/expected/measured/delta/容差/coverage/detail/readBy 都在 HTML 里", () => {
  assertReportHtml(html, report);
  // 抽查一条具体的证据行：字段名和值都在。
  const row = report.clips[0].evidence.find((item) => item.kind === "content.embedded-range");
  assert.ok(row, "第一条 clip 没有 content.embedded-range 证据");
  assert.ok(html.includes("content.embedded-range"), "证据 kind 没出现");
  assert.ok(html.includes("deltaSeconds"), "deltaSeconds 字段名没出现");
  assert.ok(html.includes("toleranceFrames"), "toleranceFrames 字段名没出现");
  assert.ok(html.includes("coverage"), "coverage 字段名没出现");
  assert.ok(html.includes("readBy"), "readBy 字段名没出现");
});

test("sourceIn/sourceOut 给出规范化时码 + 原始标签 + drop 标记", () => {
  for (const clip of report.clips) {
    const article = articleOf(html, clip.id);
    assert.ok(article.includes(clip.claim.sourceIn), "缺规范化 sourceIn：" + clip.id);
    assert.ok(article.includes(clip.claim.sourceInRaw), "缺原始 sourceIn 标签：" + clip.id);
    assert.ok(article.includes(clip.claim.sourceOut), "缺规范化 sourceOut：" + clip.id);
    assert.ok(article.includes(clip.claim.sourceOutRaw), "缺原始 sourceOut 标签：" + clip.id);
    assert.ok(article.includes("drop-frame"), "缺 drop-frame 标记：" + clip.id);
  }
});

// ---------------------------------------------------------------------------
// 4. 候选 / 替代项 / 建议 / skipped
// ---------------------------------------------------------------------------

test("候选与替代项都画出来：命中了谁、还有谁没被选", () => {
  const wrongTake = report.clips.find((clip) => clip.verdict === "conflict");
  assert.ok(wrongTake, "混合清单里没有 conflict 条目");
  const article = articleOf(html, wrongTake.id);
  assert.ok(article.includes(wrongTake.candidates[0].path), "没画出命中的候选文件");
  assert.ok(wrongTake.alternates.length > 0, "conflict 条目本该有替代项");
  for (const alternate of wrongTake.alternates) {
    assert.ok(article.includes(alternate.path), "没画出替代项：" + alternate.path);
  }
  assert.ok(article.includes(wrongTake.suggestions[0]), "没画出建议");
});

test("skipped / 媒体缺席单列，并写明原因码", () => {
  assert.ok(html.includes('id="skipped"'), "缺 skipped 单列");
  const missing = report.clips.find((clip) => clip.reasons.includes("media-not-found"));
  assert.ok(missing, "混合清单里没有 media-not-found 条目");
  assert.ok(html.includes("media-not-found"), "skipped 段落没写原因码");
});

// ---------------------------------------------------------------------------
// 5. 同源 + 纯函数
// ---------------------------------------------------------------------------

test("JSON 与 HTML 出自同一份 report 对象：重新渲染逐字节一致", () => {
  assert.equal(html, renderConformHtml(report));
});

test("渲染是纯函数：同一份 report 渲染两次结果一致，且不动 report 本身", () => {
  const snapshot = JSON.stringify(report);
  const first = renderConformHtml(report);
  const second = renderConformHtml(report);
  assert.equal(first, second);
  assert.equal(JSON.stringify(report), snapshot, "渲染过程改动了 report 对象");
});

test("HTML 不引入新判定：clip 数量与每条结论都和 JSON 一致", () => {
  assert.equal(countOf(html, 'class="clip v-'), report.clips.length);
  for (const clip of report.clips) {
    const article = articleOf(html, clip.id);
    assert.ok(article.includes(">" + clip.verdict + "<"), "结论不一致：" + clip.id);
  }
});

// ---------------------------------------------------------------------------
// 6. 故意改坏渲染 ⇒ 同一套断言必须失败
// ---------------------------------------------------------------------------

const MUTATE_START = "/* EVIDENCE-BLOCK-START */";
const MUTATE_END = "/* EVIDENCE-BLOCK-END */";

function mutateRenderer(source) {
  const start = source.indexOf(MUTATE_START);
  const end = source.indexOf(MUTATE_END);
  assert.ok(start >= 0 && end > start, "渲染器里找不到变异锚点，变异用例失去意义");
  return (
    source.slice(0, start + MUTATE_START.length) +
    "\n    const evidenceHtml = '';\n    " +
    source.slice(end)
  );
}

test("故意改坏渲染（删掉证据链段落）⇒ 同一套断言必须失败", async () => {
  const sourcePath = path.join(REPO_ROOT, "src", "conform-report-html.js");
  const source = readFileSync(sourcePath, "utf8");
  const mutantPath = path.join(root, "mutant-renderer.mjs");
  // 变异体要放在能解析得到 ./conform-check.js 的地方：把 import 改成绝对 file URL。
  const conformCheckUrl = pathToFileURL(path.join(REPO_ROOT, "src", "conform-check.js")).href;
  const mutantSource = mutateRenderer(source).replace(
    '"./conform-check.js"',
    JSON.stringify(conformCheckUrl),
  );
  writeFileSync(mutantPath, mutantSource, "utf8");
  const mutant = await import(pathToFileURL(mutantPath).href);

  const mutantHtml = mutant.renderConformHtml(report);
  // 变异体确实把证据链删掉了（否则这个用例什么也证明不了）。
  assert.equal(mutantHtml.includes("content.embedded-range"), false, "变异体没有真的删掉证据链");
  // 同一套断言在变异体上必须红。
  assert.throws(() => assertReportHtml(mutantHtml, report), /证据 kind 没出现在 HTML/);
});

// ---------------------------------------------------------------------------
// 7. CLI 行为与零依赖
// ---------------------------------------------------------------------------

test("CLI --html 与 --json/--report 可同时产出，退出码语义不变", () => {
  assert.equal(cliRun.status, 1, cliRun.stderr);
  assert.ok(existsSync(htmlOut), "CLI 没有写出 HTML 文件");
  assert.ok(existsSync(jsonOut), "CLI 没有写出 JSON 文件");
  assert.equal(report.exitCode, 1);
  assert.equal(report.exitCode, report.summary.conflict > 0 ? 1 : 0);
  assert.equal(report.syntheticStubMedia, true, "合成素材标记丢了");
});

test("HTML 报告不写本机绝对路径（它会被当邮件附件发出去）", () => {
  assert.ok(!html.includes(root), "HTML 里出现了临时目录绝对路径");
  assert.ok(!html.includes(":" + BACKSLASH), "HTML 里出现了盘符路径");
});

test("零新增运行时依赖：渲染模块只 import 仓库内已有模块，package.json 无运行时依赖", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(
    pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0,
    "package.json 出现了运行时依赖",
  );
  const source = readFileSync(path.join(REPO_ROOT, "src", "conform-report-html.js"), "utf8");
  const specifiers = Array.from(source.matchAll(/from\s+"([^"]+)"/g)).map((match) => match[1]);
  assert.deepEqual(specifiers, ["./conform-check.js"], "渲染模块引入了预期外的依赖");
});
