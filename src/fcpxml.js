// FCPXML 1.9 sidecar：把合好的 Poly WAV 交给剪辑软件的一条最小通路。
//
// 为什么不自己写 AAF：AAF 的结构复杂，而 FCPXML 是"素材 + 时间线"的通用描述，
// Final Cut Pro 原生支持，Resolve 也能导入。行业里从 FCP 到 Pro Tools 的
// 常规走法就是 FCPXML →（Resolve 或 X2Pro）→ AAF。自己造一个 AAF 写入器
// 要维护的兼容面大得多，收益却只有一个中间格式。
//
// 这里的 FCPXML 是**音频专用**的最小版本：
// - resources 里声明一个帧率格式（音频没有画面，格式只是时间线的时基）；
// - resources 里声明 Poly WAV 这个素材，带上真实的时长、采样率与通道数；
// - 时间线上放一个 asset-clip，位置 0。
//
// 通道角色没有写 audio-role-source：离散的麦克风分轨在 FCPXML 里没有标准角色
// 可对应，硬套 dialogue 之类的角色反而是错的。通道顺序与名字以
// 同目录的 _channels.json 为准，那是这个工具自己的通道映射记录。

/** 帧率 → FCPXML 用的有理数形式与格式名。 */
export function rationalFrameRate(fpsValue) {
  const text = String(fpsValue ?? "").trim();
  const known = {
    "24": { num: 24, den: 1, name: "FFVideoFormatRate24", drop: false },
    "25": { num: 25, den: 1, name: "FFVideoFormatRate25", drop: false },
    "30": { num: 30, den: 1, name: "FFVideoFormatRate30", drop: false },
    "23.976": { num: 24000, den: 1001, name: "FFVideoFormatRate2398", drop: false },
    "24000/1001": { num: 24000, den: 1001, name: "FFVideoFormatRate2398", drop: false },
    "29.97": { num: 30000, den: 1001, name: "FFVideoFormatRate2997", drop: true },
    "30000/1001": { num: 30000, den: 1001, name: "FFVideoFormatRate2997", drop: true },
    "59.94": { num: 60000, den: 1001, name: "FFVideoFormatRate5994", drop: true },
    "60000/1001": { num: 60000, den: 1001, name: "FFVideoFormatRate5994", drop: true },
  };
  if (known[text]) return known[text];
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return known["25"];
  const rounded = Math.round(parsed * 100) / 100;
  const fallback = Object.values(known).find(item => Math.abs(item.num / item.den - rounded) < 0.01);
  return fallback ?? known["25"];
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 确定性的 uid：同一个文件名每次导出得到同一个 uid。
 * FCP 用 uid 做资源标识，随机生成的话同一份素材反复导出会变成一堆不同的资源。
 */
function stableUid(seed) {
  let hash = 2166136261;
  const text = String(seed ?? "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // FNV 一次只有 32 位，凑不出 128 位的 uuid 形状：再混几轮把十六进制填满。
  let hex = "";
  let state = hash;
  while (hex.length < 32) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    hex += state.toString(16).padStart(8, "0");
  }
  hex = hex.slice(0, 32).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-A${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** FCPXML 的时间用有理数秒：帧数 × 分母 / 分子 秒。 */
function rationalDuration(frames, frameRate) {
  const numerator = Math.max(0, Math.round(frames)) * frameRate.den;
  return `${numerator}/${frameRate.num}s`;
}

/**
 * 生成 FCPXML 1.9。
 *
 * @param result  合并结果（要含 name / durationSamples / sampleRate / channels / tracks）
 * @param options { fpsValue, sourceName }
 */
export function fcpxmlTextForPoly(result, options = {}) {
  const frameRate = rationalFrameRate(options.fpsValue ?? "25");
  const sampleRate = Number(result.sampleRate) || 48000;
  const durationSeconds = Number(result.durationSamples) / sampleRate;
  const frames = Math.max(1, Math.round(durationSeconds * frameRate.num / frameRate.den));
  const duration = rationalDuration(frames, frameRate);
  const frameDuration = `${frameRate.den}/${frameRate.num}s`;
  const channels = Math.max(1, Number(result.channels) || 1);
  const audioLayout = channels === 1 ? "mono" : channels === 2 ? "stereo" : "surround";
  const audioRate = sampleRate === 44100 ? "44.1k" : sampleRate === 96000 ? "96k" : "48k";
  const sourceName = options.sourceName || result.name || "Poly.WAV";
  const takeName = sourceName.replace(/\.wav$/i, "");
  const uid = stableUid(`${sourceName}:${result.durationSamples}:${sampleRate}`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.9">',
    "  <resources>",
    `    <format id="r1" name="${frameRate.name}" frameDuration="${frameDuration}" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>`,
    `    <asset id="r2" name="${xmlEscape(sourceName)}" uid="${uid}" start="0s" duration="${duration}" hasAudio="1" format="r1" audioSources="1" audioChannels="${channels}">`,
    `      <media-rep kind="original-media" src="${xmlEscape(sourceName)}"/>`,
    "    </asset>",
    "  </resources>",
    "  <library>",
    `    <event name="SlateSync 导出">`,
    `      <project name="${xmlEscape(takeName)}">`,
    `        <sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="${frameRate.drop ? "DF" : "NDF"}" audioLayout="${audioLayout}" audioRate="${audioRate}">`,
    "          <spine>",
    `            <asset-clip ref="r2" offset="0s" name="${xmlEscape(sourceName)}" duration="${duration}" format="r1" audioSources="1" audioChannels="${channels}"/>`,
    "          </spine>",
    "        </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  ].join("\n");
}
