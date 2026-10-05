#!/usr/bin/env node
/**
 * 端到端校验单文件版：以 file:// 打开 dist/*.html，检查控制台无错误、应用启动成功、
 * 版本号来自内联 shim，并用 demo 素材真实跑一次 LTC 提取（含 Blob URL Worker）。
 *
 * 用法：node test/verify-single-file.mjs [dist/bwf-timecode-singlefile-v1.5.0.html]
 */
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Playwright 只在开发机安装（本地或全局），不属于工具本身的运行时依赖。
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require("playwright"); } catch { /* 继续尝试全局安装 */ }
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  return require(path.join(globalRoot, "playwright"));
}
const { chromium } = loadPlaywright();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const target = path.resolve(root, process.argv[2] || "dist");
const file = (await stat(target).catch(() => null))?.isFile()
  ? target
  : path.join(target, `bwf-timecode-singlefile-v${(await readFile(path.join(root, "bwf-timecode-sw.js"), "utf8"))
      .match(/CACHE_NAME\s*=\s*["'][^"']*?v([\d.]+)["']/)[1]}.html`);

const demoDir = path.join(root, "demo", "FOLDER01");
const fixtures = ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr6.WAV"];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok " : "  FAIL"} ${name}${detail ? `\n       ${detail}` : ""}`);
};

console.log(`single-file verify: ${path.relative(root, file)}`);
const { size } = await stat(file);
console.log(`size: ${(size / 1024).toFixed(0)} KB\n`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

// 合成 DataTransfer 里 item.getAsFileSystemHandle() 恒为 null（它只在操作系统真实拖拽时
// 才有值），而应用导入优先走该分支。这里桩一个最小 file handle，让真实导入/解码链路跑通。
await page.addInitScript(() => {
  DataTransferItem.prototype.getAsFileSystemHandle = function () {
    const file = this.getAsFile();
    if (!file) return Promise.resolve(null);
    return Promise.resolve({ kind: "file", name: file.name, getFile: async () => file });
  };
});
page.on("dialog", dialog => dialog.accept().catch(() => {}));

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", error => pageErrors.push(error.message));
page.on("requestfailed", request => failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`));

// 关键约束：整页必须零外部请求，证明「单文件」是自足的。
const externalRequests = [];
page.on("request", request => {
  const url = request.url();
  if (!url.startsWith("file:") && !url.startsWith("blob:") && !url.startsWith("data:")) externalRequests.push(url);
});

await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => window.__audioTcAppStarted === true, null, { timeout: 20000 });

check("应用启动成功（内联 module 执行）", true);
check("file:// 下无外部网络请求", externalRequests.length === 0, externalRequests.join(", "));

// renderAppVersion 是异步的：badge 要等 shim 里的 fetch resolve 后才写入。
let version = "";
try {
  await page.waitForFunction(
    () => /^v\d+\.\d+\.\d+$/.test(document.getElementById("appVersionBadge")?.textContent?.trim() || ""),
    null, { timeout: 15000 },
  );
  version = (await page.textContent("#appVersionBadge"))?.trim() || "";
} catch {
  version = (await page.textContent("#appVersionBadge"))?.trim() || "(空)";
}
check("版本号由内联 shim 提供", /^v\d+\.\d+\.\d+$/.test(version), `badge = "${version}"`);

const hasSavePicker = await page.evaluate(() => "showSaveFilePicker" in window);
const hasDirPicker = await page.evaluate(() => "showDirectoryPicker" in window);
check("File System Access 可用（写回时码 / 保存 Poly 不降级）", hasSavePicker && hasDirPicker,
  `showSaveFilePicker=${hasSavePicker} showDirectoryPicker=${hasDirPicker}`);

// 真实跑一次 LTC 提取：拖入 demo 的节目轨 + LTC 轨，点「从音轨提取时码」。
const files = [];
for (const name of fixtures) {
  const buffer = await readFile(path.join(demoDir, name));
  files.push({ name, base64: buffer.toString("base64") });
}

const dataTransfer = await page.evaluateHandle(items => {
  const dt = new DataTransfer();
  for (const { name, base64 } of items) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    dt.items.add(new File([bytes], name, { type: "audio/wav" }));
  }
  return dt;
}, files);

await page.dispatchEvent(".app", "drop", { dataTransfer });
let imported = false;
try {
  await page.waitForFunction(
    () => !document.getElementById("extractLtcBtn")?.disabled,
    null, { timeout: 30000 },
  );
  imported = true;
} catch { /* 落到断言 */ }
const bodyText = await page.innerText("body");
check("拖入 demo 素材并生成 take 分组", imported && /ZOOM0001/.test(bodyText),
  imported ? "" : `extractLtcBtn 仍禁用，status=${(await page.textContent("#statusLine").catch(() => "")) || "(无)"}`);

// LTC 轨 Tr6 是 25 fps（见 test/gen-demo.mjs），而界面默认 24.00。若不先对齐帧率，
// 检测结束后会弹「LTC 帧率可能不匹配」确认框并等待用户选择，流程不会自行结束。
await page.selectOption("#fpsInput", "25").catch(() => {});
await page.evaluate(() => {
  const select = document.getElementById("fpsInput");
  const match = Array.from(select.options).find(o => o.value.startsWith("25"));
  if (match) { select.value = match.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
});

// LTC 轨 Tr6 的起始时码是 01:23:45:xx。
// 注意不能只匹配任意时码：导入后页面本来就有 00:00:00:00 / 00:00:08:00 这类时长值，
// 那样会在解码开始前就误判通过。这里精确等待 LTC 解码出的 01:23:45:xx。
await page.click("#extractLtcBtn");

// 先等整轮扫描结束：解码出 TC 后还会继续复核其余轨，状态会一直停在「正在…」。
let finished = true;
try {
  await page.waitForFunction(
    () => !/正在/.test(document.getElementById("statusLine")?.textContent || ""),
    null, { timeout: 120000 },
  );
} catch { finished = false; }

const finalStatus = (await page.textContent("#statusLine").catch(() => "")) || "";
const bodyNow = await page.innerText("body");
const decodedLtc = (bodyNow.match(/01:23:45:\d{2}/g) || []).slice(0, 3);

check("Blob URL Worker 完成 LTC 解码并回填 01:23:45:xx", decodedLtc.length > 0,
  decodedLtc.length ? `解码到 ${decodedLtc.join(", ")}` : "未在页面上发现 LTC 解码结果");
check("LTC 提取流程正常结束（状态离开进行中）", finished, `statusLine = "${finalStatus}"`);
check("状态文案报告了已检测到的 LTC 数量", /已检测到\s*\d+\s*个/.test(finalStatus),
  `statusLine = "${finalStatus}"`);

check("无未捕获异常", pageErrors.length === 0, pageErrors.join(" | "));
check("无控制台 error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
check("无失败的网络请求", failedRequests.length === 0, failedRequests.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
