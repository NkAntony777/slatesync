#!/usr/bin/env node
/**
 * 端到端校验本轮新增的合板体验 UI：输出配置（方案/通道/SyncRef）、合并前 take 体检、
 * 验收清单容器、per-take 帧率覆盖编辑器、写入备份面板。
 *
 * 与 verify-single-file.mjs 的区别：那个只验旧链路能否启动和解码，这个专门验新面板
 * 能否真实渲染和响应用户操作。两者都跑，才能覆盖「新代码没有把老功能跑坏」和
 * 「新功能真的能用」这两件事。
 *
 * 用法：node test/verify-new-ui.mjs [dist/bwf-timecode-singlefile-v1.5.0.html]
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
// 同一 take 的三条分轨，才能让「输出通道列表」有内容可渲染。
const fixtures = ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV"];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok " : "  FAIL"} ${name}${detail ? `\n       ${detail}` : ""}`);
};

console.log(`new-ui verify: ${path.relative(root, file)}`);
const { size } = await stat(file);
console.log(`size: ${(size / 1024).toFixed(0)} KB\n`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

// 合成 DataTransfer 里 item.getAsFileSystemHandle() 恒为 null，桩一个最小 file handle。
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
page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", error => pageErrors.push(error.message));

await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => window.__audioTcAppStarted === true, null, { timeout: 20000 });

// 1. 全部新 DOM 节点必须存在（静态接线检查，W5b 的单测只做了源码级断言）。
const NEW_IDS = [
  "exportOptionsCard", "exportProfileInput", "exportProfileButton", "exportProfileMenu",
  "exportProfileHint", "exportReferenceField", "exportReferenceInput", "exportReferenceHint",
  "exportChannelList", "exportChannelSummary", "exportChannelsAllBtn", "exportChannelsNoneBtn",
  "exportDirectoryBtn", "exportDirectoryLabel", "exportRememberDirectoryInput",
  "combineExclusionNotice", "combineHealthNotice",
  "backupCard", "backupBeforeWriteInput", "backupPlanSummary", "backupUnbackedNotice",
  "fpsSourceCard", "fpsSourceSummary", "fpsOverrideList", "fpsOverrideAddInput",
  "fpsOverrideAddBtn", "fpsOverrideClearAllBtn", "fpsOverrideHint",
  "takeHealthSection", "takeHealthSummary", "takeHealthBody", "takeHealthErrorsOnlyInput",
  "acceptanceSection", "acceptanceSummary", "acceptanceBody", "acceptanceCloseBtn",
];
const missingIds = await page.evaluate(
  ids => ids.filter(id => !document.getElementById(id)),
  NEW_IDS,
);
check("新 UI 的 36 个 DOM 节点全部存在", missingIds.length === 0,
  missingIds.length ? `缺失 ${missingIds.length} 个：${missingIds.join(", ")}` : `共 ${NEW_IDS.length} 个`);

// 2. 输出方案必须是全部 5 个，而不再是写死的 resolve。
const profileValues = await page.evaluate(() =>
  Array.from(document.getElementById("exportProfileInput")?.options || []).map(o => o.value),
);
const expectedProfiles = ["resolve", "sidus", "pluraleyes", "syncaila", "archive"];
check("输出方案下拉含全部 5 个方案", expectedProfiles.every(p => profileValues.includes(p)),
  `实际：${profileValues.join(", ") || "(空)"}`);

// 3. 拖入同一 take 的三条分轨。
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
  await page.waitForFunction(() => !document.getElementById("extractLtcBtn")?.disabled, null, { timeout: 30000 });
  imported = true;
} catch { /* 落到断言 */ }
check("拖入 3 条分轨并完成 take 分组", imported,
  imported ? "" : `extractLtcBtn 仍禁用，status=${(await page.textContent("#statusLine").catch(() => "")) || "(无)"}`);

// 4. 通道列表必须按 take 渲染出可勾选的源通道。
const channelRows = await page.evaluate(() =>
  document.getElementById("exportChannelList")?.querySelectorAll("input[type=checkbox]").length || 0,
);
check("输出通道列表渲染出可勾选通道", channelRows > 0, `勾选项 ${channelRows} 个`);

// 5. 通道全选 / 全不空 按钮真的改变状态。
let togglesWork = false;
let detail5 = "";
try {
  await page.click("#exportChannelsNoneBtn");
  await page.waitForTimeout(150);
  const afterNone = await page.evaluate(() =>
    Array.from(document.getElementById("exportChannelList").querySelectorAll("input[type=checkbox]"))
      .filter(c => c.checked).length);
  await page.click("#exportChannelsAllBtn");
  await page.waitForTimeout(150);
  const afterAll = await page.evaluate(() =>
    Array.from(document.getElementById("exportChannelList").querySelectorAll("input[type=checkbox]"))
      .filter(c => c.checked).length);
  togglesWork = afterNone === 0 && afterAll > 0;
  detail5 = `全不空后勾选 ${afterNone} 个，全选后 ${afterAll} 个`;
} catch (error) { detail5 = `交互抛错：${error.message}`; }
check("通道全选 / 全不空按钮生效", togglesWork, detail5);

// 6. 切到需要 SyncRef 的方案时，参考声道字段必须出现；切回 resolve 时必须隐藏。
let syncrefToggle = false;
let detail6 = "";
try {
  const visible = async () => await page.evaluate(() => {
    const el = document.getElementById("exportReferenceField");
    return Boolean(el) && !el.hidden && el.getAttribute("aria-hidden") !== "true"
      && getComputedStyle(el).display !== "none";
  });
  const before = await visible();
  await page.selectOption("#exportProfileInput", "pluraleyes");
  await page.waitForTimeout(250);
  const onPlural = await visible();
  await page.selectOption("#exportProfileInput", "resolve");
  await page.waitForTimeout(250);
  const backOnResolve = await visible();
  syncrefToggle = before === false && onPlural === true && backOnResolve === false;
  detail6 = `resolve 初始可见=${before}；pluraleyes 可见=${onPlural}；切回 resolve 可见=${backOnResolve}`;
} catch (error) { detail6 = `切换方案抛错：${error.message}`; }
check("SyncRef 参考声道字段随方案正确显隐", syncrefToggle, detail6);

// 7. 帧率来源面板：应区分三种来源，并提供 per-take 覆盖编辑器。
const fpsState = await page.evaluate(() => ({
  sourceCardOpen: !document.getElementById("fpsSourceCard")?.hidden,
  summary: (document.getElementById("fpsSourceSummary")?.textContent || "").trim(),
  addOptions: document.getElementById("fpsOverrideAddInput")?.options.length || 0,
}));
check("帧率来源面板可见且提供 per-take 覆盖入口",
  fpsState.sourceCardOpen && fpsState.addOptions > 0,
  `summary="${fpsState.summary}"，可覆盖 take ${fpsState.addOptions} 个`);

// 8. 备份面板：默认开启，并展示成本预估。
const backupState = await page.evaluate(() => ({
  checked: document.getElementById("backupBeforeWriteInput")?.checked,
  summary: (document.getElementById("backupPlanSummary")?.textContent || "").trim(),
}));
check("写入备份默认开启且显示成本预估", backupState.checked === true && backupState.summary.length > 0,
  `checked=${backupState.checked}，summary="${backupState.summary}"`);

// 9. 跑一次 LTC 提取，体检面板应当出现（原来这一步只产出 LTC 诊断）。
await page.selectOption("#fpsInput", "25").catch(() => {});
await page.evaluate(() => {
  const select = document.getElementById("fpsInput");
  const match = Array.from(select.options).find(o => o.value.startsWith("25"));
  if (match) { select.value = match.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
});
await page.click("#extractLtcBtn");
let finished = true;
try {
  await page.waitForFunction(
    () => !/正在/.test(document.getElementById("statusLine")?.textContent || ""),
    null, { timeout: 120000 },
  );
} catch { finished = false; }
check("LTC 提取流程正常结束", finished,
  `statusLine = "${(await page.textContent("#statusLine").catch(() => "")) || ""}"`);

const health = await page.evaluate(() => {
  const section = document.getElementById("takeHealthSection");
  return {
    visible: Boolean(section) && !section.hidden && getComputedStyle(section).display !== "none",
    summary: (document.getElementById("takeHealthSummary")?.textContent || "").trim(),
    bodyLength: (document.getElementById("takeHealthBody")?.textContent || "").trim().length,
  };
});
check("合并前 take 体检面板在提取后出现并有内容",
  health.visible && health.bodyLength > 0,
  `summary="${health.summary}"，正文长度 ${health.bodyLength}`);

// 10. 「只显示 error」筛选必须真的过滤。
let filterWorks = false;
let detail10 = "";
try {
  await page.check("#takeHealthErrorsOnlyInput");
  await page.waitForTimeout(200);
  const on = await page.evaluate(() => (document.getElementById("takeHealthBody")?.textContent || "").trim().length);
  await page.uncheck("#takeHealthErrorsOnlyInput");
  await page.waitForTimeout(200);
  const off = await page.evaluate(() => (document.getElementById("takeHealthBody")?.textContent || "").trim().length);
  // 允许两者相等（该 take 恰好没有 error），但不允许「勾选后反而变长」。
  filterWorks = on <= off;
  detail10 = `勾选后长度 ${on}，取消后长度 ${off}`;
} catch (error) { detail10 = `筛选抛错：${error.message}`; }
check("体检「只显示 error」筛选不产生反向结果", filterWorks, detail10);

// 11. 验收清单面板在合并前应保持隐藏（还没有导出结果，没有清单可显示）。
const acceptanceBefore = await page.evaluate(() => {
  const el = document.getElementById("acceptanceSection");
  return Boolean(el) && (el.hidden || getComputedStyle(el).display === "none");
});
check("验收清单面板在导出前保持隐藏（不空展示）", acceptanceBefore);

check("无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无控制台 error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
