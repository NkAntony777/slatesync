// FCPXML 1.9 sidecar（src/fcpxml.js）
//
// 这是"交给剪辑软件的最小通路"：resources 里声明帧率格式与 Poly 素材，
// 时间线上放一个 asset-clip。验的是结构与时间有理数算得对不对。

import test from "node:test";
import assert from "node:assert/strict";

import { fcpxmlTextForPoly, rationalFrameRate } from "../src/fcpxml.js";

const result = {
  name: "TAKE01_Poly.WAV",
  durationSamples: 25000n,   // 48000 Hz 下 0.52 秒
  sampleRate: 48000,
  channels: 4,
  tracks: [],
};

test("F1 帧率换算：整数与分数帧率的有理数形式", () => {
  assert.deepEqual(rationalFrameRate("25"), { num: 25, den: 1, name: "FFVideoFormatRate25", drop: false });
  assert.deepEqual(rationalFrameRate("23.976"), { num: 24000, den: 1001, name: "FFVideoFormatRate2398", drop: false });
  assert.deepEqual(rationalFrameRate("29.97").drop, true, "29.97 是丢帧");
  assert.deepEqual(rationalFrameRate("29.97").num, 30000);
  // 认不出来的帧率退回 25，不猜。
  assert.deepEqual(rationalFrameRate("").num, 25);
  assert.deepEqual(rationalFrameRate(undefined).num, 25);
});

test("F2 结构：fcpxml / resources / library / sequence / asset-clip", () => {
  const text = fcpxmlTextForPoly(result, { fpsValue: "25", sourceName: "TAKE01_Poly.WAV" });
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(text, /<!DOCTYPE fcpxml>/);
  assert.match(text, /<fcpxml version="1\.9">/);
  assert.match(text, /<format id="r1" name="FFVideoFormatRate25" frameDuration="1\/25s"/);
  assert.match(text, /<asset id="r2" name="TAKE01_Poly\.WAV"[^>]*hasAudio="1"[^>]*audioSources="1" audioChannels="4">/);
  assert.match(text, /<media-rep kind="original-media" src="TAKE01_Poly\.WAV"\/>/);
  assert.match(text, /<sequence format="r1"[^>]*tcFormat="NDF"[^>]*audioLayout="surround" audioRate="48k">/);
  assert.match(text, /<asset-clip ref="r2" offset="0s" name="TAKE01_Poly\.WAV"/);
});

test("F3 时长用有理数：25 fps 下 13 帧 = 13/25 秒", () => {
  const text = fcpxmlTextForPoly(result, { fpsValue: "25" });
  // 25000 采样 @ 48 kHz = 0.520833 秒 → 25 fps 下 13 帧 → 13/25s
  assert.match(text, /duration="13\/25s"/);
});

test("F4 23.976 fps 用 1001/24000 的时基", () => {
  const text = fcpxmlTextForPoly(result, { fpsValue: "23.976" });
  assert.match(text, /frameDuration="1001\/24000s"/);
  assert.match(text, /name="FFVideoFormatRate2398"/);
  // 0.520833 秒在 23.976 fps 下是 12 帧 → 12 × 1001 / 24000 = 12012/24000 秒
  assert.match(text, /duration="12012\/24000s"/);
});

test("F5 通道数决定 audioLayout 与 audioRate", () => {
  assert.match(fcpxmlTextForPoly({ ...result, channels: 1 }, { fpsValue: "25" }), /audioLayout="mono"/);
  assert.match(fcpxmlTextForPoly({ ...result, channels: 2 }, { fpsValue: "25" }), /audioLayout="stereo"/);
  assert.match(fcpxmlTextForPoly({ ...result, sampleRate: 44100 }, { fpsValue: "25" }), /audioRate="44\.1k"/);
  assert.match(fcpxmlTextForPoly({ ...result, sampleRate: 96000 }, { fpsValue: "25" }), /audioRate="96k"/);
});

test("F6 uid 是确定的：同一份素材两次导出得到同一个 uid", () => {
  const first = fcpxmlTextForPoly(result, { fpsValue: "25" });
  const second = fcpxmlTextForPoly(result, { fpsValue: "25" });
  assert.equal(first, second);
  const other = fcpxmlTextForPoly({ ...result, name: "TAKE02_Poly.WAV" }, { fpsValue: "25" });
  assert.notEqual(first, other);
  // uid 要长得像 uuid：8-4-4-4-12。
  const uid = /uid="([0-9A-F-]+)"/.exec(first)[1];
  assert.match(uid, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/);
});

test("F7 文件名里的特殊字符要转义", () => {
  const text = fcpxmlTextForPoly({ ...result, name: "A&B<C>.WAV" }, { fpsValue: "25", sourceName: "A&B<C>.WAV" });
  assert.match(text, /name="A&amp;B&lt;C&gt;\.WAV"/);
});
