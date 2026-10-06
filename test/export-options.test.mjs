import test from "node:test";
import assert from "node:assert/strict";
import { audioRecord } from "./helpers.mjs";
import {
  TAKE_EXCLUSION_REASONS,
  buildExportChoices,
  buildExportOptions,
  createRememberedDirectoryStore,
  defaultCheckedForChannel,
  describeDroppedTakes,
  directoryPermission,
  droppedTakesNoticeText,
  droppedTakesSummaryText,
  effectiveKeptKeys,
  referenceChannelCandidates,
  resolveCheckedKeys,
  summarizeExportSelection,
} from "../src/confirm-flows.js";
import {
  existingOutputNames,
  partitionCollidingNames,
  polyOutputNameFor,
  polyReferenceOutputNameFor,
  polySidecarNamesFor,
} from "../src/poly-combine-controller.js";
import { polyProfileOptions, polyExportProfile, sourceTrackKey } from "../src/poly-export-profiles.js";
import { combineEligibleGroupsFor, detectTakeGroupKeys, recordsByGroupFor } from "../src/grouping.js";
import { validateCombineGroup } from "../src/wave-combine.js";

async function silent(frames) {
  return new Float64Array(frames);
}

async function take(prefix, { frames = 480, tracks = 2, shortenLastTrack = false } = {}) {
  const records = [];
  for (let i = 1; i <= tracks; i++) {
    const length = shortenLastTrack && i === tracks ? Math.floor(frames / 2) : frames;
    const record = await audioRecord(`${prefix}_Tr${i}.wav`, [await silent(length)], { sampleRate: 48000, bits: 16 });
    records.push({ ...record, parentPath: `${prefix}`, relativePath: `${prefix}_Tr${i}.wav`, name: `${prefix}_Tr${i}.wav` });
  }
  return records;
}


test("export channel keys use recordKey:channelIndex and match poly-export-profiles sourceTrackKey", async () => {
  const records = await take("take01");
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const choices = buildExportChoices(groups, { ltcResults: new Map() });
  assert.equal(choices.takes.length, 1);
  assert.deepEqual(choices.allKeys, ["take01_Tr1.wav:0", "take01_Tr2.wav:0"]);
  const [onlyTake] = choices.takes;
  for (const channel of onlyTake.channels) {
    assert.match(channel.key, /^[^\s:]+:\d+$/);
    // key 必须和 poly-export-profiles.js 的 sourceTrackKey() 完全一致，否则上游会报"输出通道不存在"
    assert.equal(channel.key, sourceTrackKey({ record: { relativePath: channel.recordKey }, channelIndex: channel.channelIndex }));
    assert.equal(channel.takeKey, onlyTake.takeKey);
  }
});

test("multichannel source records expand to one channel row each, in combine order", async () => {
  const stereo = await audioRecord("take02_Tr12.wav", [await silent(64), await silent(64)], { sampleRate: 48000, bits: 16 });
  const mono = await audioRecord("take02_Tr1.wav", [await silent(64)], { sampleRate: 48000, bits: 16 });
  const records = ([
    { ...stereo, parentPath: "take02", relativePath: "take02_Tr12.wav", name: "take02_Tr12.wav" },
    { ...mono, parentPath: "take02", relativePath: "take02_Tr1.wav", name: "take02_Tr1.wav" },
  ]);
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const choices = buildExportChoices(groups);
  assert.deepEqual(choices.allKeys, ["take02_Tr1.wav:0", "take02_Tr12.wav:0", "take02_Tr12.wav:1"]);
});

test("only detected LTC channels are flagged; a Tr6 file name alone is not LTC", async () => {
  const records = await take("take03", { tracks: 6 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const unflagged = buildExportChoices(groups);
  assert.equal(unflagged.confirmedLtcKeys.size, 0);
  assert.ok(unflagged.allKeys.includes("take03_Tr6.wav:0"));
  assert.ok(unflagged.takes[0].channels.every(channel => channel.confirmedLtc === false));

  // 只有 LTC 检测结论（ok + sourceRecord + channelIndex）才算数
  const ltcResults = new Map([["take03_Tr6.wav", { ok: true, sourceRecord: records[5], channelIndex: 0, startTimecode: "01:00:00:00" }]]);
  const flagged = buildExportChoices(groups, { ltcResults });
  assert.deepEqual(Array.from(flagged.confirmedLtcKeys), ["take03_Tr6.wav:0"]);
  const ltcChannel = flagged.takes[0].channels.find(channel => channel.key === "take03_Tr6.wav:0");
  assert.equal(ltcChannel.confirmedLtc, true);
  assert.equal(ltcChannel.ltcTimecode, "01:00:00:00");
});

test("an LTC result without a channelIndex does not flag any channel", async () => {
  const records = await take("take04", { tracks: 4 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const choices = buildExportChoices(groups, {
    ltcResults: new Map([["take04_Tr4.wav", { ok: true, sourceRecord: records[3], startTimecode: "01:00:00:00" }]]),
  });
  assert.equal(choices.confirmedLtcKeys.size, 0);
});

test("LTC results accept Map, array and key/value iterable", async () => {
  const records = await take("take05", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const entry = ["take05_Tr2.wav", { ok: true, sourceRecord: records[1], channelIndex: 0 }];
  for (const source of [new Map([entry]), [entry], new Set([entry])]) {
    const choices = buildExportChoices(groups, { ltcResults: source });
    assert.deepEqual(Array.from(choices.confirmedLtcKeys), ["take05_Tr2.wav:0"]);
  }
});

test("resolve policy unchecks detected LTC by default; retain policy keeps it", async () => {
  const records = await take("take06", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take06_Tr2.wav", { ok: true, sourceRecord: records[1], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  const ltcChannel = choices.takes[0].channels.find(channel => channel.key === "take06_Tr2.wav:0");

  assert.equal(defaultCheckedForChannel(ltcChannel, "resolve"), false);
  assert.equal(defaultCheckedForChannel(ltcChannel, "sidus"), true);
  assert.equal(defaultCheckedForChannel(ltcChannel, "archive"), true);

  assert.deepEqual(Array.from(resolveCheckedKeys(choices, "resolve")).sort(), ["take06_Tr1.wav:0", "take06_Tr3.wav:0"]);
  assert.deepEqual(Array.from(resolveCheckedKeys(choices, "sidus")).sort(), ["take06_Tr1.wav:0", "take06_Tr2.wav:0", "take06_Tr3.wav:0"]);
});

test("explicit user choices win over profile defaults and survive a profile switch", async () => {
  const records = await take("take07", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take07_Tr2.wav", { ok: true, sourceRecord: records[1], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  const explicit = new Map([["take07_Tr2.wav:0", true]]);

  assert.ok(resolveCheckedKeys(choices, "resolve", explicit).has("take07_Tr2.wav:0"));
  assert.equal(effectiveKeptKeys(choices, "resolve", resolveCheckedKeys(choices, "resolve", explicit)).has("take07_Tr2.wav:0"), false);
  assert.ok(effectiveKeptKeys(choices, "sidus", resolveCheckedKeys(choices, "sidus", explicit)).has("take07_Tr2.wav:0"));
});

test("buildExportOptions returns the field names poly-combine-controller reads", async () => {
  const records = await take("take08", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const choices = buildExportChoices(groups);
  const options = buildExportOptions({ profileId: "archive", choices, checkedKeys: resolveCheckedKeys(choices, "archive"), groupCount: 1 });
  assert.deepEqual(Object.keys(options).sort(), ["profile", "selectedSourceChannels"]);
  assert.equal(options.profile, "archive");
  assert.ok(options.selectedSourceChannels instanceof Set);
  // 归档方案保留源编码，控制器会按 profile 决定编码，不需要界面传
  assert.equal(polyExportProfile(options.profile).encoding, "source");
});

test("buildExportOptions rejects an empty channel selection, unknown keys and unknown profiles", async () => {
  const records = await take("take09", { tracks: 2 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const choices = buildExportChoices(groups);
  assert.throws(() => buildExportOptions({ profileId: "resolve", choices, checkedKeys: new Set() }), /至少要保留一个输出通道/);
  assert.throws(() => buildExportOptions({ profileId: "resolve", choices, checkedKeys: new Set(["nope.wav:0"]) }), /输出通道不存在/);
  assert.throws(() => buildExportOptions({ profileId: "premiere", choices, checkedKeys: resolveCheckedKeys(choices) }), /未知 Poly 导出方案/);
  assert.throws(() => buildExportOptions({ profileId: "resolve" }), /通道清单还没准备好/);
});

test("unchecking every confirmed LTC channel is refused with an actionable message", async () => {
  const records = await take("take10", { tracks: 2 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take10_Tr1.wav", { ok: true, sourceRecord: records[0], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  assert.throws(
    () => buildExportOptions({ profileId: "resolve", choices, checkedKeys: new Set(), groupCount: 1 }),
    /至少要保留一个输出通道/,
  );
  // 勾上了，但方案会把唯一的 LTC 也删掉 —— 同样要报错而不是写出一个空的 Poly
  assert.throws(
    () => buildExportOptions({ profileId: "resolve", choices, checkedKeys: new Set(["take10_Tr1.wav:0"]), groupCount: 1 }),
    /没有可用的节目音频/,
  );
});

test("a channel excluded as LTC can never be chosen as SyncRef", async () => {
  const records = await take("take11", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take11_Tr2.wav", { ok: true, sourceRecord: records[1], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  const checked = resolveCheckedKeys(choices, "pluraleyes");

  const candidates = referenceChannelCandidates(choices, "pluraleyes", checked);
  assert.deepEqual(candidates.map(channel => channel.key), ["take11_Tr1.wav:0", "take11_Tr3.wav:0"]);
  assert.ok(!candidates.some(channel => channel.key === "take11_Tr2.wav:0"));

  // 用户强行把被 LTC 排除的通道塞进 referenceSourceChannel，必须报错
  assert.throws(
    () => buildExportOptions({ profileId: "pluraleyes", choices, checkedKeys: new Set(["take11_Tr1.wav:0", "take11_Tr2.wav:0", "take11_Tr3.wav:0"]), referenceSourceChannel: "take11_Tr2.wav:0", groupCount: 1 }),
    /SyncRef 必须从主 Poly 保留的通道里选/,
  );
  // 未勾选的通道同样不行
  assert.throws(
    () => buildExportOptions({ profileId: "syncaila", choices, checkedKeys: new Set(["take11_Tr1.wav:0"]), referenceSourceChannel: "take11_Tr3.wav:0", groupCount: 1 }),
    /SyncRef 必须从主 Poly 保留的通道里选/,
  );
});

test("an LTC channel can be SyncRef under a retain profile, because the main Poly keeps it", async () => {
  const records = await take("take12", { tracks: 2 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take12_Tr1.wav", { ok: true, sourceRecord: records[0], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });

  // 所有需要 SyncRef 的方案（pluraleyes / syncaila）ltcPolicy 都是 exclude，
  // 所以被确认的 LTC 通道在主 Poly 里根本不存在，任何方案下都当不了参考声。
  for (const profileId of ["pluraleyes", "syncaila"]) {
    assert.throws(
      () => buildExportOptions({
        profileId,
        choices,
        checkedKeys: new Set(["take12_Tr1.wav:0", "take12_Tr2.wav:0"]),
        referenceSourceChannel: "take12_Tr1.wav:0",
        groupCount: 1,
      }),
      /SyncRef 必须从主 Poly 保留的通道里选/,
      `${profileId} 不该允许把 LTC 通道选成 SyncRef`,
    );
  }
  // 同一通道在保留 LTC 的方案下确实能进主 Poly，但那个方案不需要 SyncRef，给了就报错
  assert.throws(
    () => buildExportOptions({ profileId: "sidus", choices, checkedKeys: resolveCheckedKeys(choices, "sidus"), referenceSourceChannel: "take12_Tr1.wav:0", groupCount: 1 }),
    /不需要 SyncRef 参考声道/,
  );
  // 节目通道则是合法的
  const options = buildExportOptions({
    profileId: "syncaila",
    choices,
    checkedKeys: resolveCheckedKeys(choices, "syncaila"),
    referenceSourceChannel: "take12_Tr2.wav:0",
    groupCount: 1,
  });
  assert.equal(options.referenceSourceChannel, "take12_Tr2.wav:0");
});

test("SyncRef is refused when more than one take is being exported at once", async () => {
  const records = [...(await take("take13", { tracks: 2 })), ...(await take("take14", { tracks: 2 }))];
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  assert.equal(groups.length, 2);
  const choices = buildExportChoices(groups);
  const checked = resolveCheckedKeys(choices, "pluraleyes");
  assert.throws(
    () => buildExportOptions({ profileId: "pluraleyes", choices, checkedKeys: checked, referenceSourceChannel: "take13_Tr1.wav:0", groupCount: 2 }),
    /SyncRef 需要逐 take 指定/,
  );
  // 不选参考声道时批量导出是合法的
  const options = buildExportOptions({ profileId: "pluraleyes", choices, checkedKeys: checked, groupCount: 2 });
  assert.equal(options.referenceSourceChannel, undefined);
});

test("a reference channel that survives validation is accepted by wave-combine", async () => {
  const records = await take("take15", { tracks: 3 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take15_Tr3.wav", { ok: true, sourceRecord: records[2], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  const checked = resolveCheckedKeys(choices, "pluraleyes");
  const options = buildExportOptions({ profileId: "pluraleyes", choices, checkedKeys: checked, referenceSourceChannel: "take15_Tr1.wav:0", groupCount: 1 });
  const plan = validateCombineGroup(groups[0][1], options);
  assert.deepEqual(plan.tracks.map(track => sourceTrackKey(track)).sort(), ["take15_Tr1.wav:0", "take15_Tr2.wav:0"]);
});

test("every profile has Chinese usage / LTC / encoding text for the picker", () => {
  const options = polyProfileOptions();
  assert.equal(options.length, 5);
  for (const option of options) {
    assert.ok(option.usage.length > 0, `${option.id} 缺少用途说明`);
    assert.ok(option.ltcText.length > 0, `${option.id} 缺少 LTC 策略说明`);
    assert.ok(option.encodingText.length > 0, `${option.id} 缺少编码说明`);
  }
  assert.deepEqual(options.filter(option => option.reference).map(option => option.id), ["pluraleyes", "syncaila"]);
  assert.deepEqual(options.filter(option => option.ltcPolicy === "retain").map(option => option.id), ["sidus", "archive"]);
});

test("selection summary reports kept tracks, unchecked channels and auto-removed LTC", async () => {
  const records = await take("take16", { tracks: 4 });
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const ltcResults = new Map([["take16_Tr4.wav", { ok: true, sourceRecord: records[3], channelIndex: 0 }]]);
  const choices = buildExportChoices(groups, { ltcResults });
  const explicit = new Map([["take16_Tr1.wav:0", false]]);
  const summary = summarizeExportSelection(choices, "resolve", resolveCheckedKeys(choices, "resolve", explicit));
  assert.match(summary, /主 Poly 保留 2 轨/);
  assert.match(summary, /未勾选 1 条/);
  assert.match(summary, /移除 1 条已确认 LTC/);
});

test("dropped takes are reported with the reason they were filtered out", async () => {
  const good = await take("take17", { tracks: 2 });
  // take18 的最后一条分轨被截断 —— 同组内时长不一致，正是 grouping.js 那一行静默过滤掉的情况
  const ragged = await take("take18", { tracks: 3, shortenLastTrack: true });
  const lonely = await audioRecord("take19.wav", [await silent(480)], { sampleRate: 48000, bits: 16 });
  const records = [
    ...good,
    ...ragged,
    { ...lonely, parentPath: "take19", relativePath: "take19.wav" },
  ];
  const takeGroupKeys = detectTakeGroupKeys(records);
  const eligibleGroups = combineEligibleGroupsFor(records, takeGroupKeys);
  assert.deepEqual(eligibleGroups.map(([key]) => key), ["take17/take17"]);

  const dropped = describeDroppedTakes({ recordsByGroup: recordsByGroupFor(records, takeGroupKeys), takeGroupKeys, eligibleGroups });
  assert.equal(dropped.count, 2);
  const byLabel = Object.fromEntries(dropped.items.map(item => [item.takeLabel, item.reason]));
  assert.equal(byLabel.take18, "duration-mismatch");
  assert.equal(byLabel["take19.wav"], "not-a-take");
  assert.deepEqual(dropped.byReason, { "duration-mismatch": 1, "not-a-take": 1 });
  assert.equal(dropped.items[0].reasonText, TAKE_EXCLUSION_REASONS["duration-mismatch"]);

  const notice = droppedTakesNoticeText(dropped);
  assert.match(notice, /有 2 个分组未纳入合并/);
  assert.match(notice, /时长不一致/);
  assert.match(droppedTakesSummaryText(dropped), /时长不一致，无法逐样本对齐 1 组/);
  assert.equal(droppedTakesNoticeText({ count: 0, items: [] }), "");
});

test("metadata-only and video-only groups are not counted as dropped takes", async () => {
  const good = await take("take20", { tracks: 2 });
  const ale = { name: "camera.ale", relativePath: "camera.ale", parentPath: "camera", _meta: true, channels: 0 };
  const mov = { name: "A001.MOV", relativePath: "A001.MOV", parentPath: "clips", _video: true, channels: 2 };
  const records = [...good, ale, mov];
  const takeGroupKeys = detectTakeGroupKeys(records);
  const eligibleGroups = combineEligibleGroupsFor(records, takeGroupKeys);
  const dropped = describeDroppedTakes({ recordsByGroup: recordsByGroupFor(records, takeGroupKeys), takeGroupKeys, eligibleGroups });
  assert.equal(dropped.count, 0);
});

test("a stray file next to a take is reported on its own, and the real take still merges", async () => {
  const tracks = await take("take21", { tracks: 2 });
  const stray = await audioRecord("take21_notes.wav", [await silent(480)], { sampleRate: 48000, bits: 16 });
  const records = [
    ...tracks,
    { ...stray, parentPath: "take21", relativePath: "take21_notes.wav" },
  ];
  const takeGroupKeys = detectTakeGroupKeys(records);
  const groups = combineEligibleGroupsFor(records, takeGroupKeys);
  assert.equal(groups.length, 1, "成对的分轨 take 不该被旁边的散文件拖累");
  const dropped = describeDroppedTakes({ recordsByGroup: recordsByGroupFor(records, takeGroupKeys), takeGroupKeys, eligibleGroups: groups });
  assert.equal(dropped.count, 1);
  assert.equal(dropped.items[0].reason, "not-a-take");
  assert.equal(dropped.items[0].takeLabel, "take21_notes.wav");
});

test("poly output names are stable and sidecars do not collide with the poly or the bak suffix", () => {
  assert.equal(polyOutputNameFor("AudioTCChange_2026-10-05/take01"), "take01_Poly.WAV");
  assert.equal(polyOutputNameFor("take 01 (raw)"), "take_01_raw_Poly.WAV");
  // 与改动前的 `result.name.replace(/\.wav$/i, "_SyncRef.WAV")` 保持一致，不在这里改命名
  assert.equal(polyReferenceOutputNameFor("take01_Poly.WAV"), "take01_Poly_SyncRef.WAV");
  assert.deepEqual(polySidecarNamesFor("take01_Poly.WAV"), ["take01_Poly_合板说明.txt", "take01_Poly_channels.json"]);
  for (const name of polySidecarNamesFor("take01_Poly.WAV")) {
    assert.ok(!name.toLowerCase().endsWith(".wav"), "边车文件不能以 .wav 结尾，否则会被当成素材重新导入");
    assert.ok(!name.toLowerCase().endsWith(".bak"));
  }
});

test("batch name collision detection is case-insensitive and covers in-batch duplicates", () => {
  assert.deepEqual(partitionCollidingNames(["a_Poly.WAV", "b_Poly.WAV"], []), { collisions: [], fresh: ["a_Poly.WAV", "b_Poly.WAV"] });
  // Windows 文件系统大小写不敏感，所以 TAKE02_POLY.wav 必须算 take02_Poly.WAV 的冲突
  assert.deepEqual(
    partitionCollidingNames(["take01_Poly.WAV", "take02_Poly.WAV"], ["TAKE02_POLY.wav"]),
    { collisions: ["take02_Poly.WAV"], fresh: ["take01_Poly.WAV"] },
  );
  // 同一批里出现两个同名输出也算冲突（上游另有一次整体校验，这里不重复报）
  assert.deepEqual(
    partitionCollidingNames(["take01_Poly.WAV", "take01_Poly.WAV"], []),
    { collisions: ["take01_Poly.WAV"], fresh: ["take01_Poly.WAV"] },
  );
});

test("existingOutputNames reports only names already present in the directory", async () => {
  const present = new Set(["take01_Poly.WAV", "take01_SyncRef.WAV"]);
  const directory = {
    async getFileHandle(name) {
      if (present.has(name)) return { name };
      const error = new Error("not found");
      error.name = "NotFoundError";
      throw error;
    },
  };
  const found = await existingOutputNames(directory, ["take01_Poly.WAV", "take02_Poly.WAV", "take01_SyncRef.WAV"]);
  assert.deepEqual(Array.from(found).sort(), ["take01_Poly.WAV", "take01_SyncRef.WAV"]);
  assert.deepEqual(Array.from(await existingOutputNames(null, ["x"])), []);
});

test("an unreadable directory surfaces as an error instead of a silent overwrite", async () => {
  const directory = {
    async getFileHandle() {
      const error = new Error("permission denied");
      error.name = "NotAllowedError";
      throw error;
    },
  };
  await assert.rejects(() => existingOutputNames(directory, ["take01_Poly.WAV"]), /permission denied/);
});

test("directory permission helper only prompts when the caller asks, and never throws", async () => {
  let prompts = 0;
  const granted = { queryPermission: async () => "granted", requestPermission: async () => { prompts++; return "granted"; } };
  assert.deepEqual(await directoryPermission(granted), { ok: true, state: "granted" });
  assert.equal(prompts, 0, "已授权时不该再调 requestPermission");

  const needsPrompt = { queryPermission: async () => "prompt", requestPermission: async () => { prompts++; return "granted"; } };
  assert.deepEqual(await directoryPermission(needsPrompt), { ok: false, state: "prompt" });
  assert.equal(prompts, 0, "没要求 prompt 时不能弹授权框（会脱离用户手势被浏览器拒绝）");
  assert.deepEqual(await directoryPermission(needsPrompt, { prompt: true }), { ok: true, state: "granted" });
  assert.equal(prompts, 1);

  const denied = { queryPermission: async () => "denied", requestPermission: async () => "denied" };
  assert.equal((await directoryPermission(denied, { prompt: true })).ok, false);

  const broken = { queryPermission: async () => { throw new Error("nope"); } };
  assert.equal((await directoryPermission(broken)).ok, false);
  assert.deepEqual(await directoryPermission(null), { ok: false, state: "none" });
  // 老实现没有 queryPermission 时按已授权处理（等于降级为每次询问）
  assert.deepEqual(await directoryPermission({}), { ok: true, state: "granted" });
});

test("without IndexedDB the directory store degrades to per-export prompts instead of failing", async () => {
  // Node 没有 indexedDB 全局，正好覆盖 file:// / Firefox / 隐私模式下的降级分支
  assert.equal(typeof indexedDB, "undefined");
  const store = createRememberedDirectoryStore();
  assert.equal(store.storageSupported(), false);
  assert.equal(await store.load(), null);
  assert.equal(await store.remembered(), null);
  const info = store.describe();
  assert.equal(info.remembered, false);
  assert.match(info.text, /每次导出会重新询问/);
  // 没有 showDirectoryPicker 的环境也只是报告状态，不会抛错
  const picked = await store.pick();
  assert.deepEqual(picked, { handle: null, cancelled: false, remembered: false });
  assert.match(store.describe().text, /每次导出都会询问保存位置|不支持选择文件夹/);
});