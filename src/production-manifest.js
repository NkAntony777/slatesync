// 生产级清单（跨 take 总账）。
//
// 为什么要有这个模块：现在每导出一个 take，就写三个 sidecar
// （_合板说明.txt / _channels.json / .fcpxml，见 poly-combine-controller.js 的 polySidecarNamesFor），
// 每一份都只讲"这一个 take 怎么样"。收件人拿到一个几十个 take 的项目时，
// 仍然得自己把这些逐 take 的文件拼成"这次拍摄到底交付了什么、哪个 take 没交、为什么没交"。
// 这个模块把逐 take 的交付记录汇总成一份总账：一次导出、一处可查。
//
// 边界（沿用仓库既有规矩）：
// - 纯函数：不碰 DOM、不碰文件系统、不引入 npm 依赖，可以直接 node --test 调用；
// - 绝不抛错：单个 take 缺字段就当缺（给 null），整份清单照样出得来；
// - 测不出来就不给结果：响度极值在没有可用读数时是 null，不猜、不拿 0 顶替；
// - 原始字段不丢：调用方给的东西原样带进 takes[]，只补 status 这一个派生字段。
//
// 这个文件是总账的"数据层"。它不决定谁是 take、怎么命名 sidecar——那些约定在
// grouping.js / poly-combine-controller.js / wave-combine.js 里，这里只做汇总，不另起一套命名规则。

export const MANIFEST_SCHEMA = "slatesync/production-manifest/v1";

// 问题的严重程度排序权重；数字越小越靠前。与 take-health.js 的 SEVERITY_ORDER 同一口径。
const LEVEL_ORDER = Object.freeze({ error: 0, warn: 1 });

// CSV 的显示精度：沿用既有 sidecar 的显示约定（响度 0.1 LU、时长毫秒），不把浮点噪声留给收件人。
const LOUDNESS_DECIMALS = 1;
const SECONDS_DECIMALS = 3;

// CSV 的列顺序。这是给人看的总账表的列，不是 manifest 的字段顺序：
// 前 9 列是"这次拍摄"的账头（每个 take 行都重复一遍），后面是逐 take 的明细。
// 为什么不拆成"一段汇总 + 一段明细"两个 CSV 块：收件人用 Excel 打开一个表，
// 列数不齐的两段会被当成坏文件；重复账头行则随时可以按 status 筛选、透视。
const CSV_HEADERS = Object.freeze([
  "project", "generated_at", "takes", "delivered", "skipped",
  "total_channels", "total_duration_seconds", "loudness_min", "loudness_max",
  "take_key", "take_label", "output_name", "status",
  "channels", "sample_rate", "bits_per_sample", "duration_samples", "duration_seconds",
  "timecode", "fps", "loudness_integrated", "loudness_true_peak",
  "reasons", "sidecars", "problems",
]);

// ---------------------------------------------------------------- 基础工具

/** 有限数 → number，否则 null。字符串数字也认（界面上来的值常常是字符串）。 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** 标识类字段：去首尾空白，空串按缺字段处理；非文本值转成文本。 */
function optionalText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * 采样数：JSON 里不能有 BigInt（JSON.stringify 会直接抛），
 * 所以大整数按字符串存，既不丢精度也能进 JSON。
 * 数字原样保留；数字字符串保留字符串形态，避免大数被 float 截断。
 */
function normalizeSampleCount(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    return Number.isFinite(Number(text)) ? text : null;
  }
  return null;
}

// "delivered" 的宽松解析。
// 关键点：字符串 "false" 在 JS 里是 truthy，直接 `if (take.delivered)` 会把"明确没交"判成"交了"。
// 只有明确的肯定词才算交付；认不出来的值一律按未交付处理——宁可少报交付，也不要虚报交付。
const DELIVERED_TRUE = new Set(["true", "1", "yes", "y", "delivered"]);
const DELIVERED_FALSE = new Set(["false", "0", "no", "n", "skipped", ""]);

function toDelivered(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (DELIVERED_TRUE.has(text)) return true;
    if (DELIVERED_FALSE.has(text)) return false;
    return false;
  }
  return false;
}

/**
 * 把一条问题/理由转成一句人话。
 * 调用方可能给字符串，也可能给 take-health.js 那种结构化 finding（{ code, title, detail }），
 * 这里按 message → title → detail → reason → code 的顺序取第一个可用的文本字段。
 */
function messageOf(entry) {
  if (entry === null || entry === undefined) return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (typeof entry === "object") {
    for (const key of ["message", "title", "detail", "reason", "code"]) {
      const value = entry[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

/** 文本数组归一化：非数组当空数组，空文本丢掉。 */
function normalizeTextList(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const entry of value) {
    const text = messageOf(entry);
    if (text) list.push(text);
  }
  return list;
}

/** sidecar 文件名数组：只保留文本，其余类型丢掉（文件名没有别的合理解释）。 */
function normalizeNameList(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) list.push(entry.trim());
  }
  return list;
}

/** 响度：只保留契约里的两项；缺项给 null，不拿 0 冒充读数。 */
function normalizeLoudness(value) {
  if (!value || typeof value !== "object") return null;
  return {
    integrated: toFiniteNumber(value.integrated),
    truePeak: toFiniteNumber(value.truePeak),
  };
}

/** 体检结果：{ errors, warns, infos }，缺哪项都是空数组；整个 health 缺失则 null。 */
function normalizeHealth(value) {
  if (!value || typeof value !== "object") return null;
  return {
    errors: normalizeTextList(value.errors),
    warns: normalizeTextList(value.warns),
    infos: normalizeTextList(value.infos),
  };
}

/**
 * 逐 take 的问题生成顺序：health 的 error → 未交付理由 → health 的 warn。
 * 为什么 error 排在理由前面：理由解释"为什么没交"，体检 error 说明"交出去的东西本身有问题"，
 * 后者更需要收件人先看见。同一条 take 内保持这个顺序，整份清单再按严重程度全局排序。
 */
function problemsForTake(take) {
  const delivered = toDelivered(take?.delivered);
  const health = normalizeHealth(take?.health);
  const reasons = normalizeTextList(take?.reasons);
  const problems = [];
  for (const message of health ? health.errors : []) problems.push({ level: "error", message });
  if (!delivered) {
    if (reasons.length) {
      for (const reason of reasons) problems.push({ level: "warn", message: reason });
    } else {
      // 跳过但没写理由：也得在账上留一行，否则这个 take 会在收件人眼里凭空消失。
      problems.push({ level: "warn", message: "未交付（没有记录原因）" });
    }
  }
  for (const message of health ? health.warns : []) problems.push({ level: "warn", message });
  return problems;
}

/** 一个 take 的时长（秒）。采样率缺失或非法就返回 null——不拿别的 take 的采样率顶替。 */
function takeSeconds(take) {
  const rawSamples = take?.durationSamples;
  if (rawSamples === null || rawSamples === undefined || rawSamples === "") return null;
  const samples = toFiniteNumber(rawSamples);
  const rate = toFiniteNumber(take?.sampleRate);
  if (samples === null || rate === null || rate <= 0) return null;
  return samples / rate;
}

/** 归一化一个 take：原始字段全部保留，缺的补 null，末尾加上 status。 */
function normalizeTake(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const delivered = toDelivered(source.delivered);
  return {
    ...source,
    takeKey: optionalText(source.takeKey),
    takeLabel: optionalText(source.takeLabel),
    outputName: optionalText(source.outputName),
    delivered,
    channels: toFiniteNumber(source.channels),
    durationSamples: normalizeSampleCount(source.durationSamples),
    sampleRate: toFiniteNumber(source.sampleRate),
    bitsPerSample: toFiniteNumber(source.bitsPerSample),
    timecode: optionalText(source.timecode),
    fps: optionalText(source.fps),
    loudness: normalizeLoudness(source.loudness),
    health: normalizeHealth(source.health),
    reasons: normalizeTextList(source.reasons),
    sidecars: normalizeNameList(source.sidecars),
    status: delivered ? "delivered" : "skipped",
  };
}

// ---------------------------------------------------------------- 对外 API

/**
 * 把逐 take 的交付记录汇总成一份跨 take 的总账。
 *
 * @param {Array} takes 每个 take 一条：
 *   { takeKey, takeLabel, outputName, delivered: boolean, channels, durationSamples,
 *     sampleRate, bitsPerSample, timecode, fps,
 *     loudness: { integrated, truePeak } | null,
 *     health: { errors, warns, infos } | null,
 *     reasons: string[], sidecars: string[] }
 * @param {object} options { projectLabel, generatedAt }
 * @returns {object} manifest
 */
export function buildProductionManifest(takes, options = {}) {
  const list = Array.isArray(takes) ? takes : [];
  const rows = list.map(raw => normalizeTake(raw));

  const problems = [];
  let seq = 0;
  let delivered = 0;
  let skipped = 0;
  let totalChannels = 0;
  let totalSeconds = 0;
  let loudnessMin = Infinity;
  let loudnessMax = -Infinity;
  let loudnessCount = 0;

  rows.forEach(row => {
    if (row.delivered) {
      delivered += 1;
      // 总通道数只算已交付的 take：没交出去的通道不在这批交付里。
      // 通道数缺失按 0 计——它是"已知通道数的和"，缺字段不猜。
      totalChannels += row.channels === null ? 0 : row.channels;
      // 逐 take 各自用自己的采样率算秒数再相加。
      // 不能拿总帧数除以某一个采样率：一个项目里混了 48k 与 96k 时那样算出来的时长是错的。
      const seconds = takeSeconds(row);
      if (seconds !== null) totalSeconds += seconds;
      const integrated = row.loudness ? row.loudness.integrated : null;
      if (typeof integrated === "number" && Number.isFinite(integrated)) {
        if (integrated < loudnessMin) loudnessMin = integrated;
        if (integrated > loudnessMax) loudnessMax = integrated;
        loudnessCount += 1;
      }
    } else {
      skipped += 1;
    }
    for (const problem of problemsForTake(row)) {
      problems.push({ takeKey: row.takeKey, level: problem.level, message: problem.message, seq: seq++ });
    }
  });

  // 排序口径：error 全部排在 warn 前面；同级按 take 在输入里的顺序排（seq 是产生次序，单调递增）。
  // 这样"先看不能用的东西，再看可以用的"，而且同一批 warn 的先后与 takes[] 的顺序一致，
  // 收件人顺着 take 列表读下来就能对上号。
  problems.sort((a, b) => (LEVEL_ORDER[a.level] ?? 2) - (LEVEL_ORDER[b.level] ?? 2) || a.seq - b.seq);

  const loudnessRange = loudnessCount > 0 ? { min: loudnessMin, max: loudnessMax } : null;

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: resolveGeneratedAt(options.generatedAt),
    project: optionalText(options.projectLabel),
    summary: {
      takes: rows.length,
      delivered,
      skipped,
      totalChannels,
      // 毫秒精度即可：再细是浮点累加噪声，不是信息。
      durationSeconds: Math.round(totalSeconds * 1000) / 1000,
      loudnessRange,
      problems: problems.map(item => ({ takeKey: item.takeKey, level: item.level, message: item.message })),
    },
    takes: rows,
  };
}

/** generatedAt：调用方给了就用（测试要确定性），否则取当前时刻。 */
function resolveGeneratedAt(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date().toISOString();
}

// ---------------------------------------------------------------- CSV

/**
 * RFC 4180 的字段转义：含逗号、引号、CR 或 LF 就整体加引号，里面的引号翻倍。
 * 空值写成空单元格（不是字符串 "null"）——总账里"没有这个字段"和"字段的值是 null"是两回事。
 * 不加 BOM：BOM 由写文件的人加（记事本读 UTF-8 中文需要），这里加一次、那里加一次都会多。
 */
function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 秒：固定 3 位小数（沿用 metadata-export.js 的 formatDuration 精度）。 */
function formatSeconds(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "";
  return number.toFixed(SECONDS_DECIMALS);
}

/** 响度：固定 1 位小数（沿用 sync-workflow.js 的响度显示精度）。 */
function formatLoudness(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "";
  return number.toFixed(LOUDNESS_DECIMALS);
}

/**
 * 一行的交付状态。
 * manifest 里的 takes[] 一定带 status；但 CSV 也要能吃手工拼的 manifest，
 * 所以 status 缺失时退回看 delivered。delivered 这个字段本身都没有，就留空——
 * "没有 delivered 字段"和"delivered 为 false"不是一回事，不能一律判成 skipped。
 */
function statusOf(take) {
  if (take?.status === "delivered" || take?.status === "skipped") return take.status;
  const delivered = take?.delivered;
  if (delivered === undefined || delivered === null) return "";
  return toDelivered(delivered) ? "delivered" : "skipped";
}

/**
 * 把 manifest 转成 CSV 文本。
 *
 * 每行一个 take；problems 列由该 take 自己的 reasons/health 现算，
 * 不靠 takeKey 回连 summary.problems——takeKey 可能缺失或重复，回连会张冠李戴。
 * 汇总列（project / generated_at / 计数 / 总时长 / 响度极值）在每行重复一遍，
 * 让单行也是自描述的，收件人不必先看另一张表才知道这批文件属于哪次拍摄。
 */
export function productionManifestCsv(manifest) {
  const source = manifest && typeof manifest === "object" ? manifest : {};
  const summary = source.summary && typeof source.summary === "object" ? source.summary : {};
  const takes = Array.isArray(source.takes) ? source.takes : [];
  const range = summary.loudnessRange && typeof summary.loudnessRange === "object" ? summary.loudnessRange : null;

  const account = {
    project: optionalText(source.project) ?? "",
    generated_at: optionalText(source.generatedAt) ?? "",
    takes: summary.takes ?? takes.length,
    delivered: summary.delivered ?? 0,
    skipped: summary.skipped ?? 0,
    total_channels: summary.totalChannels ?? 0,
    total_duration_seconds: formatSeconds(summary.durationSeconds),
    loudness_min: range ? formatLoudness(range.min) : "",
    loudness_max: range ? formatLoudness(range.max) : "",
  };

  const rows = takes.map(take => ({
    ...account,
    take_key: optionalText(take?.takeKey) ?? "",
    take_label: optionalText(take?.takeLabel) ?? "",
    output_name: optionalText(take?.outputName) ?? "",
    status: statusOf(take),
    channels: take?.channels ?? "",
    sample_rate: take?.sampleRate ?? "",
    bits_per_sample: take?.bitsPerSample ?? "",
    duration_samples: take?.durationSamples ?? "",
    duration_seconds: formatSeconds(takeSeconds(take)),
    timecode: optionalText(take?.timecode) ?? "",
    fps: optionalText(take?.fps) ?? "",
    loudness_integrated: formatLoudness(take?.loudness?.integrated),
    loudness_true_peak: formatLoudness(take?.loudness?.truePeak),
    reasons: normalizeTextList(take?.reasons).join("; "),
    sidecars: normalizeNameList(take?.sidecars).join("; "),
    problems: problemsForTake(take)
      .map(problem => `${problem.level}: ${problem.message}`)
      .join("; "),
  }));

  // 空总账也要留一行（take 各列留空）：否则收件人拿到一个只有表头的文件，
  // 分不清是"这次拍摄没有 take"还是"导出失败了"。
  if (!rows.length) {
    rows.push({ ...account });
    for (const header of CSV_HEADERS) {
      if (!(header in rows[0])) rows[0][header] = "";
    }
  }

  return [
    CSV_HEADERS.join(","),
    ...rows.map(row => CSV_HEADERS.map(header => csvField(row[header])).join(",")),
  ].join("\r\n");
}
