#!/usr/bin/env node
/**
 * 把 index.html + src/*.js + src/style.css 打包成一个「双击即用」的单文件 HTML。
 *
 * 设计约束（都经过 file:// 实测，Chromium 141 / Windows）：
 *   - file:// 在 Chrome/Edge 属于 secure context，File System Access API
 *     (showSaveFilePicker / showDirectoryPicker) 可用，所以「写回时码」「保存 Poly」
 *     这条核心链路不降级。
 *   - Service Worker 无法从内联脚本注册（必须是同源独立脚本），单文件版因此不提供
 *     PWA 离线缓存；pwa.js 本身对非 http(s) 协议已有优雅降级分支。
 *   - 顶层存在 await，因此保留 <script type="module"> + ESM 输出，而不是 IIFE。
 *   - LTC worker 早已用 Blob URL 从模板字符串创建（ltc-worker.js 的 LTC_WORKER_CODE），
 *     无需额外文件。
 *
 * 用法：
 *   node scripts/build-single-file.mjs --repo https://github.com/<owner>/<repo>
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(token.slice(2), true);
    else { out.set(token.slice(2), next); i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoUrl = String(args.get("repo") || process.env.REPO_URL || "").replace(/\/+$/, "");
const upstreamUrl = "https://github.com/xnpeter/Audio-TC-Change";
const outDir = path.resolve(root, String(args.get("out-dir") || "dist"));
const minify = args.get("minify") !== "false";

if (!repoUrl) {
  console.error("缺少 --repo <github 仓库地址>。例如：\n  node scripts/build-single-file.mjs --repo https://github.com/<owner>/<repo>");
  process.exit(1);
}

const read = (rel) => readFile(path.join(root, rel), "utf8");

const html = await read("index.html");
const swSource = await read("bwf-timecode-sw.js");
const cssSource = await read("src/style.css");
const iconSvg = await read("bwf-timecode-icon.svg");

// 版本号沿用 Service Worker 的 CACHE_NAME，保证单文件版与仓库版本同源可追溯。
// 必须保留完整 CACHE_NAME（含 "v" 前缀）：app-version.js 的正则要求版本号前有 "v"，
// 只保留数字会让版本退化成 "dev"。
const cacheName = swSource.match(/CACHE_NAME\s*=\s*["']([^"']+)["']/)?.[1];
const version = cacheName?.match(/v(\d[\d.]*)["']?$/)?.[1];
if (!cacheName || !version) throw new Error("无法从 bwf-timecode-sw.js 的 CACHE_NAME 解析版本号");
const tag = `v${version}`;

// 1) 抽出内联 module 脚本 —— 保留 <script type="module">，因为脚本里有顶层 await。
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) throw new Error("index.html 中未找到 <script type=\"module\"> 内联脚本");

// 2) 打包 JS。bundle 后不再有 import 残留，内联执行不需要任何 fetch。
const bundled = await build({
  stdin: {
    contents: moduleMatch[1],
    resolveDir: root,
    sourcefile: "app-entry.js",
    loader: "js",
  },
  bundle: true,
  format: "esm",
  target: ["chrome110", "edge110", "firefox110", "safari16"],
  write: false,
  minify,
  legalComments: "inline",
  charset: "utf8",
  logLevel: "warning",
});

// 3) 压缩 CSS。
const bundledCss = await build({
  stdin: { contents: cssSource, sourcefile: "style.css", loader: "css" },
  minify,
  write: false,
  charset: "utf8",
  logLevel: "warning",
});

const js = bundled.outputFiles[0].text;
const css = bundledCss.outputFiles[0].text;

/**
 * 版本 shim：src/app-version.js 通过 fetch("./bwf-timecode-sw.js") 读取版本号，
 * 单文件里没有这个文件。这里拦一层该 URL，返回等价的 CACHE_NAME 文本，
 * 避免改动应用源码。
 */
const versionShim = `/* single-file build: version shim */
const __BUILD_TAG = ${JSON.stringify(tag)};
const __nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url.includes("bwf-timecode-sw.js")) {
    return Promise.resolve(new Response(
      ${JSON.stringify(`const CACHE_NAME = "${cacheName}";`)},
      { status: 200, headers: { "Content-Type": "text/javascript" } },
    ));
  }
  return __nativeFetch(input, init);
};
`;

let out = html;

// 注意：下面所有 replace 都用函数形式返回替换内容。字符串替换里 "$&" / "$'" /
// "$`" 会被当成替换模式展开，而打包后的 JS 与 CSS 里这些字符很常见，会静默损坏产物。

// 4) 样式内联。
const styleTag = `<link rel="stylesheet" href="./src/style.css">`;
if (!out.includes(styleTag)) throw new Error("index.html 中未找到 style.css 引用");
out = out.replace(styleTag, () => `<style>\n${css}\n</style>`);

// 5) 图标改为内联 data URI；manifest 与 apple-touch-icon 依赖同源文件，单文件版移除。
const iconDataUri = `data:image/svg+xml,${encodeURIComponent(iconSvg)}`;
out = out.replace(
  '<link rel="icon" href="./bwf-timecode-icon.svg" type="image/svg+xml">',
  () => `<link rel="icon" href="${iconDataUri}" type="image/svg+xml">`,
);
out = out.replace(/<link rel="manifest"[^>]*>\s*/g, "");
out = out.replace(/<link rel="apple-touch-icon"[^>]*>\s*/g, "");

// 6) 单文件版可以直接双击打开，原提示「请通过本地 HTTP 服务打开」是错的。
out = out.replace(
  '? "请通过本地 HTTP 服务打开：python3 -m http.server 8765 --bind 127.0.0.1，然后访问 http://127.0.0.1:8765/"',
  '? "应用脚本未能加载，请刷新页面或检查浏览器控制台"',
);

// 7) 打包脚本（保留顶层 await 的 module 形态）。
out = out.replace(moduleMatch[0], () => `<script type="module">\n${versionShim}${js}\n</script>`);

// 8) 署名：上游 MIT 项目必须保留，本仓库来源单独标明。
const attribution = `
        <p class="build-provenance">单文件版 ${tag} · 构建自 <a href="${repoUrl}" target="_blank" rel="noopener noreferrer">${repoUrl.replace(/^https?:\/\//, "")}</a> · 双击即可离线运行，文件不上传</p>`;
const copyrightLine = '<p class="copyright">LTC 合板助手 | 基于 Audio TC Change (MIT) by 诺米 扩展诊断功能</p>';
if (!out.includes(copyrightLine)) throw new Error("index.html 中未找到页脚版权行");
out = out.replace(copyrightLine, () => copyrightLine + attribution);

// 署名与单文件版专属样式。
out = out.replace("</style>", () => `.build-provenance { margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: #8ea0b4; text-align: center; }
.build-provenance a { color: #7fc4ff; text-decoration: none; }
.build-provenance a:hover { text-decoration: underline; }
</style>`);

if (minify) {
  out = out
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n");
}

await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `bwf-timecode-singlefile-${tag}.html`);
await writeFile(outFile, out, "utf8");

const { size } = await stat(outFile);
console.log(`✓ 单文件构建完成`);
console.log(`  版本    ${tag}`);
console.log(`  输出    ${path.relative(root, outFile)}`);
console.log(`  体积    ${(size / 1024).toFixed(0)} KB`);
console.log(`  来源    ${repoUrl}`);
console.log(`  上游    ${upstreamUrl} (MIT, 诺米)`);
console.log(`\n  本地校验：双击打开，或 node test/verify-single-file.mjs ${path.basename(outFile)}`);
