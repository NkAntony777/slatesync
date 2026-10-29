// 生产级清单（src/production-manifest.js）
//
// 钉死的是"总账"这件事本身：这次拍摄交付了什么、哪个 take 没交、为什么没交。
// 覆盖三条主线：
// - 汇总规则：计数、总通道、逐 take 各自的采样率算时长、响度极值；
// - problems：跳过的理由与体检结果怎么汇、怎么排（error 在前，同级按 take 顺序）；
// - CSV：列数固定、RFC 4180 转义、delivered 与 skipped 都出现、不带 BOM。
//
// 另外钉死两条工程约束：畸形输入（缺 takeKey / loudness 为 null / health 为 null / 整条不是对象）
// 一律不抛错；输入对象不被就地改写。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MANIFEST_SCHEMA,
  buildProductionManifest,
  productionManifestCsv,
} from "../src/production-manifest.js";

const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function take(extra = {}) {
  return {
    takeKey: "T1",
    takeLabel: "Take 1",
    outputName: "T1_Poly.WAV",
    delivered: true,
    channels: 4,
    durationSamples: 48000,
    sampleRate: 48000,
    bitsPerSample: 24,
    timecode: "01:00:00:00",
    fps: "25",
    loudness: { integrated: -23.4, truePeak: -1.2 },
    health: null,
    reasons: [],
    sidecars: ["T1_Poly_合板说明.txt", "T1_Poly_channels.json", "T1_Poly.fcpxml"],
    ...extra,
  };
}

/** CSV 解析器（RFC 4180）：引号内的逗号与换行不算分隔符，双写引号还原成一个引号。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') { quoted = true; index += 1; continue; }
    if (char === ",") { row.push(field); field = ""; index += 1; continue; }
    if (char === "\r" && text[index + 1] === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; index += 2; continue;
    }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; index += 1; continue; }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const EXPECTED_HEADERS = [
  "project", "generated_at", "takes", "delivered", "skipped",
  "total_channels", "total_duration_seconds", "loudness_min", "loudness_max",
  "take_key", "take_label", "output_name", "status",
  "channels", "sample_rate", "bits_per_sample", "duration_samples", "duration_seconds",
  "timecode", "fps", "loudness_integrated", "loudness_true_peak",
  "reasons", "sidecars", "problems",
];

function column(header, name) {
  const index = header.indexOf(name);
  assert.notEqual(index, -1, `CSV 里应当有列 ${name}`);
  return index;
}

test("M1 全部交付：计数、总通道、时长、响度极值", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", channels: 4, durationSamples: 48000, loudness: { integrated: -23.4, truePeak: -1.2 } }),
    take({ takeKey: "B", channels: 2, durationSamples: 96000, loudness: { integrated: -20, truePeak: -2 } }),
  ], { projectLabel: "2026-01-01 棚拍", generatedAt: FIXED_TIME });

  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.generatedAt, FIXED_TIME);
  assert.equal(manifest.project, "2026-01-01 棚拍");
  assert.equal(manifest.summary.takes, 2);
  assert.equal(manifest.summary.delivered, 2);
  assert.equal(manifest.summary.skipped, 0);
  assert.equal(manifest.summary.totalChannels, 6);
  assert.equal(manifest.summary.durationSeconds, 3);
  assert.deepEqual(manifest.summary.loudnessRange, { min: -23.4, max: -20 });
  assert.deepEqual(manifest.summary.problems, []);
  assert.equal(manifest.takes.length, 2);
  assert.equal(manifest.takes[0].status, "delivered");
});

test("M2 混合交付与跳过：status 与计数分开", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A" }),
    take({ takeKey: "B", delivered: false, reasons: ["LTC 没有锁定，起始时码不可信"] }),
  ], { generatedAt: FIXED_TIME });

  assert.equal(manifest.summary.takes, 2);
  assert.equal(manifest.summary.delivered, 1);
  assert.equal(manifest.summary.skipped, 1);
  assert.equal(manifest.takes[0].status, "delivered");
  assert.equal(manifest.takes[1].status, "skipped");
  assert.deepEqual(manifest.takes[1].reasons, ["LTC 没有锁定，起始时码不可信"]);
});

test("M3 problems 汇总：跳过的理由、health 的 error/warn 都进账，info 不进", () => {
  const manifest = buildProductionManifest([
    take({
      takeKey: "A",
      delivered: false,
      reasons: ["没交：录音机没开机"],
      health: { errors: ["分轨采样率不一致"], warns: ["LTC 电平偏低"], infos: ["还没跑 LTC 检测"] },
    }),
  ], { generatedAt: FIXED_TIME });

  assert.deepEqual(manifest.summary.problems, [
    { takeKey: "A", level: "error", message: "分轨采样率不一致" },
    { takeKey: "A", level: "warn", message: "没交：录音机没开机" },
    { takeKey: "A", level: "warn", message: "LTC 电平偏低" },
  ]);
});

test("M4 problems 排序：error 全部在前，同级按 take 顺序", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "T1", health: { errors: ["E1"], warns: ["W1"] } }),
    take({ takeKey: "T2", delivered: false, reasons: ["R2"], health: { errors: ["E2"] } }),
  ], { generatedAt: FIXED_TIME });

  assert.deepEqual(
    manifest.summary.problems.map(item => `${item.takeKey}/${item.level}/${item.message}`),
    ["T1/error/E1", "T2/error/E2", "T1/warn/W1", "T2/warn/R2"],
  );
});

test("M5 跳过但没写理由：也留一条占位，不让 take 从账上消失", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", delivered: false, reasons: [] }),
  ], { generatedAt: FIXED_TIME });

  assert.equal(manifest.summary.problems.length, 1);
  assert.equal(manifest.summary.problems[0].level, "warn");
  assert.match(manifest.summary.problems[0].message, /未交付/);
});

test("M6 loudnessRange：只算 delivered 且读数有限，一个都没有时是 null", () => {
  const empty = buildProductionManifest([
    take({ takeKey: "A", loudness: null }),
    take({ takeKey: "B", loudness: { integrated: null, truePeak: null } }),
    take({ takeKey: "C", loudness: { integrated: Number.NaN, truePeak: -1 } }),
  ], { generatedAt: FIXED_TIME });
  assert.equal(empty.summary.loudnessRange, null);

  // 未交付的 take 不参与极值：它没有交付出去，读数不在"这次交付了什么"的账上。
  const partial = buildProductionManifest([
    take({ takeKey: "A", loudness: { integrated: -23, truePeak: -1 } }),
    take({ takeKey: "B", delivered: false, loudness: { integrated: -10, truePeak: -1 } }),
  ], { generatedAt: FIXED_TIME });
  assert.deepEqual(partial.summary.loudnessRange, { min: -23, max: -23 });
});

test("M7 durationSeconds：逐 take 各用自己的采样率算完再相加", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", durationSamples: 44100, sampleRate: 44100 }),
    take({ takeKey: "B", durationSamples: 48000, sampleRate: 48000 }),
  ], { generatedAt: FIXED_TIME });

  // 两个 1 秒；拿总帧数除以某一个采样率会算成 92100/48000 = 1.91875 秒。
  assert.equal(manifest.summary.durationSeconds, 2);
});

test("M8 durationSeconds：未交付的 take 不计入时长", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", durationSamples: 48000, sampleRate: 48000 }),
    take({ takeKey: "B", delivered: false, durationSamples: 48000, sampleRate: 48000 }),
  ], { generatedAt: FIXED_TIME });
  assert.equal(manifest.summary.durationSeconds, 1);
});

test("M9 CSV：列数固定，delivered 与 skipped 都出现", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A" }),
    take({ takeKey: "B", delivered: false, reasons: ["没交"] }),
  ], { projectLabel: "2026-01-01 棚拍", generatedAt: FIXED_TIME });

  const rows = parseCsv(productionManifestCsv(manifest));
  assert.deepEqual(rows[0], EXPECTED_HEADERS);
  for (const row of rows) assert.equal(row.length, EXPECTED_HEADERS.length);

  const statusIndex = column(rows[0], "status");
  const statuses = rows.slice(1).map(row => row[statusIndex]);
  assert.ok(statuses.includes("delivered"));
  assert.ok(statuses.includes("skipped"));
});

test("M10 CSV：汇总列重复在每一行，账头信息不会丢", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", channels: 4, durationSamples: 48000, loudness: { integrated: -23.4, truePeak: -1.2 } }),
  ], { projectLabel: "2026-01-01 棚拍", generatedAt: FIXED_TIME });

  const rows = parseCsv(productionManifestCsv(manifest));
  const header = rows[0];
  assert.equal(rows[1][column(header, "project")], "2026-01-01 棚拍");
  assert.equal(rows[1][column(header, "generated_at")], FIXED_TIME);
  assert.equal(rows[1][column(header, "takes")], "1");
  assert.equal(rows[1][column(header, "delivered")], "1");
  assert.equal(rows[1][column(header, "skipped")], "0");
  assert.equal(rows[1][column(header, "total_channels")], "4");
  assert.equal(rows[1][column(header, "total_duration_seconds")], "1.000");
  assert.equal(rows[1][column(header, "loudness_min")], "-23.4");
  assert.equal(rows[1][column(header, "duration_seconds")], "1.000");
});

test("M11 CSV：逗号与引号按 RFC 4180 转义", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", takeLabel: 'A, B "C"', reasons: ["第一行\n第二行"] }),
  ], { generatedAt: FIXED_TIME });

  const csv = productionManifestCsv(manifest);
  assert.match(csv, /"A, B ""C"""/);

  const rows = parseCsv(csv);
  const header = rows[0];
  assert.equal(rows[1][column(header, "take_label")], 'A, B "C"');
  assert.equal(rows[1][column(header, "reasons")], "第一行\n第二行");
  // 带换行的字段整体被引号包住，行数不会被它撑开。
  assert.equal(rows.length, 2);
});

test("M12 CSV：problems 列带级别前缀，reasons 列保留原始理由", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", delivered: false, reasons: ["没交"], health: { errors: ["E1"] } }),
  ], { generatedAt: FIXED_TIME });

  const rows = parseCsv(productionManifestCsv(manifest));
  const header = rows[0];
  assert.equal(rows[1][column(header, "reasons")], "没交");
  assert.equal(rows[1][column(header, "problems")], "error: E1; warn: 没交");
});

test("M13 CSV：不带 BOM", () => {
  const csv = productionManifestCsv(buildProductionManifest([take()], { generatedAt: FIXED_TIME }));
  assert.ok(!csv.startsWith("\uFEFF"), "BOM 由写文件的人加，CSV 文本本身不带");
});

test("M14 CSV：空总账也留表头与一行空账", () => {
  const rows = parseCsv(productionManifestCsv(buildProductionManifest([], { generatedAt: FIXED_TIME })));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, EXPECTED_HEADERS.length);
  assert.equal(rows[1].length, EXPECTED_HEADERS.length);
  assert.equal(rows[1][column(rows[0], "takes")], "0");
  assert.equal(rows[1][column(rows[0], "status")], "");
});

test("M15 畸形输入不抛错：缺 takeKey、loudness 为 null、health 为 null、整条不是对象", () => {
  let manifest = null;
  assert.doesNotThrow(() => {
    manifest = buildProductionManifest([
      { delivered: true },
      { takeKey: "B", loudness: null, health: null },
      null,
      "不是对象",
    ], { generatedAt: FIXED_TIME });
  });

  assert.equal(manifest.summary.takes, 4);
  assert.equal(manifest.summary.delivered, 1);
  assert.equal(manifest.takes[0].takeKey, null);
  assert.equal(manifest.takes[0].loudness, null);
  assert.equal(manifest.takes[0].health, null);
  assert.deepEqual(manifest.takes[0].reasons, []);
  assert.deepEqual(manifest.takes[0].sidecars, []);
  assert.equal(manifest.takes[0].status, "delivered");
  // 整条不是对象的，按"没有 delivered 字段"处理：不猜它是交付了还是没交。
  assert.equal(manifest.takes[2].status, "skipped");
  assert.equal(manifest.takes[3].status, "skipped");
  assert.equal(manifest.summary.loudnessRange, null);
  assert.doesNotThrow(() => JSON.stringify(manifest));

  // 整个 takes 是 null / undefined 也要出得来。
  assert.equal(buildProductionManifest(null, { generatedAt: FIXED_TIME }).summary.takes, 0);
  assert.equal(buildProductionManifest(undefined, { generatedAt: FIXED_TIME }).summary.takes, 0);
  assert.doesNotThrow(() => productionManifestCsv(null));
});

test("M16 delivered 的宽松解析：字符串 \"false\" 不算交付", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", delivered: "false" }),
    take({ takeKey: "B", delivered: "true" }),
  ], { generatedAt: FIXED_TIME });

  assert.equal(manifest.summary.delivered, 1);
  assert.equal(manifest.summary.skipped, 1);
  assert.equal(manifest.takes[0].status, "skipped");
  assert.equal(manifest.takes[1].status, "delivered");
});

test("M17 原始字段原样保留，只多一个 status；输入对象不被就地改写", () => {
  const original = take({ takeKey: "A", extraField: "自己加的字段" });
  const manifest = buildProductionManifest([original], { generatedAt: FIXED_TIME });

  assert.equal(manifest.takes[0].extraField, "自己加的字段");
  assert.equal(manifest.takes[0].outputName, "T1_Poly.WAV");
  assert.equal(manifest.takes[0].status, "delivered");
  assert.equal(original.status, undefined, "不能往调用方的对象上写 status");
  assert.equal(original.delivered, true);
});

test("M18 BigInt 采样数转成字符串，manifest 仍然能 JSON 化", () => {
  const manifest = buildProductionManifest([
    take({ takeKey: "A", durationSamples: 48000n }),
  ], { generatedAt: FIXED_TIME });

  assert.equal(manifest.takes[0].durationSamples, "48000");
  assert.equal(manifest.summary.durationSeconds, 1);
  assert.doesNotThrow(() => JSON.stringify(manifest));
});
