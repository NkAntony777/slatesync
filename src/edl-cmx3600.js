// CMX3600 EDL 解析器：把剪辑室给的 .edl 投影成 clip_list.v1。
//
// 为什么这一层必须存在：校验层（src/conform-check.js）能判「这条 clip 连对了没有」，
// 但它只吃自定义 JSON。真实剪辑室给的是 EDL，中间没有人愿意手抄。没有这一层，
// 校验层在真实项目里就跑不起来——而「跑不起来的校验」等于没有校验。
//
// 边界（明写）：
//   - 只按公开的 CMX3600 约定解析（事件行 NNN REEL TRACK TRANS srcIn srcOut recIn recOut、
//     TITLE / FCM 头部、* 注释行、D 转场带帧数、丢帧时码用分号）。
//     不逆向任何商业软件，不读任何闭源工程文件。
//   - 纯函数：不读盘、不 import node:fs。时码数学全部复用 src/timecode.js，
//     本模块不写一条裸帧率换算。这样同一份解析既能跑在 Node CLI，也能跑在浏览器。
//   - 严格优先：不认识的记录类型、字段数不对、时码非法、轨道记号不认识，一律
//     收集成带行号的 issue 并抛 EdlParseError，由 CLI 以退出码 2 结束。
//     这里绝不静默跳过一行——静默跳过会让校验「少验几条却报成功」，
//     正是本项目要防的那类错误。
//   - 已知但本层不支持的东西（wipe / key / M2 变速备忘）也一律报错，不忽略：
//     忽略 wipe 会把转场当硬切，忽略 M2 会把变速段的源跨度算错，两种都是
//     「看起来成功的错答案」。
//
// 不做：AAF / OTIO / FCPXML / XML；不解析特效、调色、音频电平；
// 不合并 dissolve 的前后两行（每个事件行各成一条 clip，见 docs §9）。

import {
  framesToTimecode,
  parseFps,
  timecodeToFrames,
} from "./timecode.js";

/** 解析器版本。写进报告，便于以后区分行为差异。 */
export const CMX3600_PARSER = "cmx3600.v1";

/** 支持的转场：C=cut、D=dissolve（带帧数）。 */
export const SUPPORTED_TRANSITIONS = Object.freeze({ CUT: "C", DISSOLVE: "D" });

/**
 * 已知但明确不支持的转场。给它们单独的错误文案，比一句「不认识」有用：
 * 用户看到「wipe 不支持」会去换一种导出方式，看到「不认识 W」只会以为解析器有 bug。
 */
export const UNSUPPORTED_TRANSITIONS = Object.freeze({
  W: "wipe（划像）",
  K: "key（键控）",
  KB: "background key",
  KO: "key out",
  KI: "key in",
  X: "split edit",
});

/** 轨道记号：V、A、AA、AB、A1..A9（可用 / 组合，如 A2/V）。 */
const TRACK_PART_RE = /^(?:V|A|AA|AB|A[1-9](?:A[1-9])?)$/;
/** 事件号：CMX3600 约定 3 位，真实表里常见 1..4 位。 */
const EVENT_NUMBER_RE = /^\d{1,4}$/;
/** 变速备忘行（M1 = 冻结帧，M2 = 变速）。本层不支持。 */
const MOTION_MEMO_RE = /^M[12]\b/i;
const TITLE_RE = /^TITLE\s*:\s*(.*)$/i;
const FCM_RE = /^FCM\s*:\s*(.*)$/i;
/** 丢帧时码：分号在帧之前。 */
const DROP_TIMECODE_RE = /^\d{2,4}:\d{2}:\d{2};\d{1,3}$/;
/** 非丢帧时码（只用于统计风格，真正的合法性由 timecodeToFrames 判）。 */
const NDF_TIMECODE_RE = /^\d{2,4}:\d{2}:\d{2}:\d{1,3}$/;

/**
 * 注释行里可以当作「真实文件名」的键。只认这些显式键，绝不做「猜一个像文件名的词」：
 * 猜错文件名会让校验层去验错文件，比留空危险得多。
 *
 * 用一条正则同时吃掉 FROM/TO 前缀，而不是按子串逐条试：
 * 「CLIP NAME」是「TO CLIP NAME」的子串，按子串试会把 TO 误判成普通 CLIP NAME，
 * 让报告里的溯源键写错（名字本身没错，但「这条名字是从哪个键来的」会骗人）。
 */
const CLIP_NAME_RE = /(?:(FROM|TO)\s+)?CLIP NAME\s*[:=]\s*(.+)$/i;
const FILE_NAME_RE = /(SOURCE|FROM)\s+FILE\s*[:=]\s*(.+)$/i;

export class EdlParseError extends Error {
  /** @param {string} message @param {Array<object>} issues 每条都带 line / text / message */
  constructor(message, issues = []) {
    super(message);
    this.name = "EdlParseError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 只取文件名：EDL 里常写绝对路径或 /vol/... 挂载路径，报告不该带出本机目录结构。 */
export function baseNameOf(value) {
  const text = String(value || "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (!text) return "";
  const parts = text.split(/[\\/]/);
  const last = parts[parts.length - 1].trim();
  return last.replace(/^["']+|["']+$/g, "");
}

function classifyTrack(token) {
  const upper = String(token || "").toUpperCase();
  const parts = upper.split("/");
  if (!parts.length || !parts.every((part) => TRACK_PART_RE.test(part))) return null;
  const hasAudio = parts.some((part) => part.includes("A"));
  const hasVideo = parts.some((part) => part === "V");
  return { track: upper, hasAudio, hasVideo, videoOnly: hasVideo && !hasAudio };
}

/**
 * 在注释文本里找显式文件名。优先级：FROM CLIP NAME > CLIP NAME > TO CLIP NAME >
 * SOURCE FILE / FROM FILE。只认这些键，其余一律返回 null（留空，不猜）。
 */
export function extractClipName(commentText) {
  const text = String(commentText || "");
  const clipName = text.match(CLIP_NAME_RE);
  if (clipName) {
    const prefix = clipName[1] ? clipName[1].toUpperCase() : "";
    const name = baseNameOf(clipName[2]);
    if (name) {
      return {
        name,
        key: prefix ? prefix + " CLIP NAME" : "CLIP NAME",
        role: prefix === "FROM" ? "from" : prefix === "TO" ? "to" : "clip",
      };
    }
  }
  const fileName = text.match(FILE_NAME_RE);
  if (fileName) {
    const isSource = fileName[1].toUpperCase() === "SOURCE";
    const name = baseNameOf(fileName[2]);
    if (name) {
      return {
        name,
        key: isSource ? "SOURCE FILE" : "FROM FILE",
        role: isSource ? "source" : "from-file",
      };
    }
  }
  return null;
}
/**
 * 把帧率升成丢帧变体。丢帧只存在于 30000/1001、60000/1001、120000/1001 三种速率上
 * （与 src/timecode.js 的 dropFramesFor 一致）。
 */
function withDropFrame(fps) {
  if (fps.drop) return fps;
  const rate = fps.rate || fps;
  const ratio = Number(rate.n) / Number(rate.d);
  if (Math.abs(ratio - 30000 / 1001) < 0.0002) return { ...fps, drop: true, value: "29.97df" };
  if (Math.abs(ratio - 60000 / 1001) < 0.0002) return { ...fps, drop: true, value: "59.94df" };
  if (Math.abs(ratio - 120000 / 1001) < 0.0002) return { ...fps, drop: true, value: "119.88df" };
  return null;
}

// ---------------------------------------------------------------------------
// 帧率裁决
// ---------------------------------------------------------------------------

/**
 * 决定用哪个帧率解析时码。
 *
 * 为什么需要裁决：CMX3600 的 FCM 行只声明丢帧/非丢帧，不声明速率；
 * 速率在真实工作里来自「这份表是按 25 还是 29.97 出的」这个上下文。
 * 所以规则必须是确定的、可复述的，并且把选择写进报告（fpsSource），
 * 让人能看见工具假设了什么：
 *
 *   1. 给了 --edl-fps → 用它（人显式声明优先）。但时码里出现分号而它是非丢帧，
 *      仍然报错：那是文件自身矛盾，不是参数问题。
 *   2. 没给参数，但时码里有分号 → 29.97df（丢帧最常见的速率），fpsSource=default-dropframe。
 *   3. 其余 → 25（与 clip_list.v1 默认帧率一致），fpsSource=default。
 *
 * 分号与 FCM 打架、FCM 说丢帧但没有任何分号，都判错而不是挑一个信：
 * 丢帧与否会让同一个时码标签差出几分钟的墙钟时间，二选一猜错就是静默的错误答案。
 */
function resolveFps(input) {
  const issues = [];
  const sawSemicolon = input.semicolonTimecodes > 0;

  if (input.semicolonTimecodes > 0 && input.colonTimecodes > 0) {
    issues.push({
      line: 0,
      text: "",
      message:
        "同一份 EDL 里混用了丢帧（HH:MM:SS;FF）与非丢帧（HH:MM:SS:FF）时码，"
        + "无法判定该按哪种解释：丢帧与非丢帧的同一个标签差几分钟",
    });
  }

  const requested = input.requested === undefined || input.requested === null
    ? ""
    : String(input.requested).trim();

  if (requested) {
    let fps;
    try {
      fps = parseFps(requested);
    } catch (error) {
      issues.push({ line: 0, text: "", message: "--edl-fps 无法解析：" + error.message });
      return { issues, fps: null };
    }
    if (sawSemicolon && !fps.drop) {
      const upgraded = withDropFrame(fps);
      issues.push({
        line: 0,
        text: "",
        message: upgraded
          ? "时码使用丢帧分号，但 --edl-fps " + requested + " 是非丢帧：请改传 " + upgraded.value
          : "时码使用丢帧分号，但 --edl-fps " + requested + " 对应的速率不支持丢帧（只有 29.97 / 59.94 / 119.88 有丢帧）",
      });
      return { issues, fps: null };
    }
    return { issues, fps: { ...fps, fpsSource: "cli" } };
  }

  if (sawSemicolon && input.fcmNonDrop) {
    issues.push({
      line: 0,
      text: "",
      message: "FCM 声明 NON-DROP FRAME，但事件时码里有丢帧分号（HH:MM:SS;FF）：文件自身矛盾",
    });
    return { issues, fps: null };
  }

  if (input.fcmDrop && !sawSemicolon) {
    issues.push({
      line: 0,
      text: "",
      message:
        "FCM 声明 DROP FRAME，但没有任何时码使用分号（HH:MM:SS;FF）。若这份表确实是非丢帧，"
        + "用 --edl-fps 29.97 显式声明；本工具不替你挑一种解释",
    });
    return { issues, fps: null };
  }

  if (sawSemicolon) {
    return { issues, fps: { ...parseFps("29.97df"), fpsSource: "default-dropframe" } };
  }
  return { issues, fps: { ...parseFps("25"), fpsSource: "default" } };
}

// ---------------------------------------------------------------------------
// 主解析
// ---------------------------------------------------------------------------

/**
 * 解析 CMX3600 EDL 文本。
 *
 * @param {string} text
 * @param {object} options { fps, fileName }
 * @returns {object} 解析结果（含 events / counts；有问题时抛 EdlParseError）
 * @throws {EdlParseError}
 */
export function parseCmx3600Edl(text, options = {}) {
  const source = String(text === undefined || text === null ? "" : text).replace(/^\uFEFF/, "");
  const lines = source.split(/\r\n|\n|\r/);
  const issues = [];

  // ---- 第一趟：头部与「全文件范围」的时码风格 -----------------------------
  let title = null;
  let fcmRaw = null;
  let fcmDrop = false;
  let fcmNonDrop = false;
  let semicolonTimecodes = 0;
  let colonTimecodes = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const titleMatch = line.match(TITLE_RE);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }
    const fcmMatch = line.match(FCM_RE);
    if (fcmMatch) {
      const value = fcmMatch[1].trim().toUpperCase().replace(/\s+/g, " ");
      if (fcmRaw && fcmRaw !== value) {
        issues.push({
          line: 0,
          text: rawLine.trim(),
          message: "FCM 行重复且互相矛盾：" + fcmRaw + " / " + value,
        });
      }
      fcmRaw = value;
      if (/^NON[-\s]?DROP/.test(value) || value === "NDF") fcmNonDrop = true;
      else if (/^DROP/.test(value) || value === "DF") fcmDrop = true;
      else issues.push({ line: 0, text: rawLine.trim(), message: "无法识别的 FCM 值：" + value });
      continue;
    }
    if (line.startsWith("*")) continue;
    // 事件行只数时码风格，不做字段校验（第二趟负责，带行号）。
    for (const token of line.split(/\s+/)) {
      if (DROP_TIMECODE_RE.test(token)) semicolonTimecodes += 1;
      else if (NDF_TIMECODE_RE.test(token)) colonTimecodes += 1;
    }
  }

  const resolved = resolveFps({
    requested: options.fps,
    fcmDrop,
    fcmNonDrop,
    semicolonTimecodes,
    colonTimecodes,
  });
  issues.push(...resolved.issues);
  if (!resolved.fps) throw new EdlParseError("EDL 帧率无法裁决（" + issues.length + " 处问题）", issues);

  const fps = resolved.fps;
  const fpsValue = String(fps.value === undefined ? "" : fps.value);

  // ---- 第二趟：逐行解析事件 ---------------------------------------------
  const events = [];
  const headerComments = [];
  const seenEventNumbers = new Map();
  let lastEvent = null;
  let lineNumber = 0;

  const pushIssue = (rawLine, message) => issues.push({ line: lineNumber, text: rawLine.trim(), message });

  for (const rawLine of lines) {
    lineNumber += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("*")) {
      const comment = { line: lineNumber, text: trimmed };
      if (lastEvent) lastEvent.comments.push(comment);
      else headerComments.push(comment);
      continue;
    }
    if (TITLE_RE.test(trimmed) || FCM_RE.test(trimmed)) continue;

    if (MOTION_MEMO_RE.test(trimmed)) {
      pushIssue(
        rawLine,
        "不支持变速/冻结备忘行（" + trimmed.slice(0, 2).toUpperCase() + "）：本层没有实现速度换算，"
          + "忽略它会把源跨度算错，所以显式报错。请在导出 EDL 时去掉变速，或先把该段渲染成新素材",
      );
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    if (!EVENT_NUMBER_RE.test(tokens[0])) {
      pushIssue(rawLine, "无法识别的记录类型：首字段 " + JSON.stringify(tokens[0]) + " 不是事件号（应为 1..4 位数字）");
      continue;
    }
    if (tokens.length < 4) {
      pushIssue(rawLine, "字段数不对：事件行至少需要 4 个字段（事件号/卷号/轨道/转场），实际 " + tokens.length + " 个");
      continue;
    }

    const reel = tokens[1];
    if (/[:;]/.test(reel)) {
      pushIssue(rawLine, "卷号字段非法：" + JSON.stringify(reel) + "（不能含冒号/分号）");
      continue;
    }
    if (reel.length > 32) {
      pushIssue(rawLine, "卷号字段过长（" + reel.length + " 字符，上限 32）：CMX3600 约定 8 字符，这里放宽到 32 但不接受无界长度");
      continue;
    }

    const trackInfo = classifyTrack(tokens[2]);
    if (!trackInfo) {
      pushIssue(rawLine, "不认识的轨道记号：" + JSON.stringify(tokens[2]) + "（支持 V / A / AA / AB / A1..A9，可用 / 组合如 A2/V）");
      continue;
    }

    const transition = tokens[3].toUpperCase();
    let dissolveFrames = null;
    let timecodeStart = 4;

    if (transition === SUPPORTED_TRANSITIONS.DISSOLVE) {
      if (tokens.length !== 9) {
        pushIssue(rawLine, "字段数不对：dissolve 事件需要 9 个字段（转场后紧跟帧数），实际 " + tokens.length + " 个");
        continue;
      }
      if (!/^\d{1,4}$/.test(tokens[4])) {
        pushIssue(rawLine, "dissolve 的转场帧数非法：" + JSON.stringify(tokens[4]) + "（应为 1..4 位数字）");
        continue;
      }
      dissolveFrames = Number(tokens[4]);
      if (!(dissolveFrames > 0)) {
        pushIssue(rawLine, "dissolve 帧数必须大于 0，实际 " + dissolveFrames);
        continue;
      }
      timecodeStart = 5;
    } else if (transition === SUPPORTED_TRANSITIONS.CUT) {
      if (tokens.length !== 8) {
        pushIssue(rawLine, "字段数不对：cut 事件需要 8 个字段，实际 " + tokens.length + " 个");
        continue;
      }
    } else if (UNSUPPORTED_TRANSITIONS[transition]) {
      pushIssue(
        rawLine,
        "不支持的转场类型 " + transition + "（" + UNSUPPORTED_TRANSITIONS[transition] + "）：只有 C（cut）与 D（dissolve）被支持",
      );
      continue;
    } else {
      pushIssue(rawLine, "不认识的转场类型 " + JSON.stringify(tokens[3]) + "（只有 C 与 D 被支持）");
      continue;
    }

    const tcs = tokens.slice(timecodeStart, timecodeStart + 4);
    const parsedTcs = [];
    let timecodeFailed = false;
    for (const tc of tcs) {
      try {
        const frames = timecodeToFrames(tc, fps);
        parsedTcs.push({ raw: tc, frames, normalized: framesToTimecode(frames, fps) });
      } catch (error) {
        pushIssue(rawLine, "时码非法：" + JSON.stringify(tc) + "（" + error.message + "；当前帧率 " + fpsValue + "）");
        timecodeFailed = true;
        break;
      }
    }
    if (timecodeFailed) continue;

    const srcIn = parsedTcs[0];
    const srcOut = parsedTcs[1];
    const recIn = parsedTcs[2];
    const recOut = parsedTcs[3];
    if (srcOut.frames <= srcIn.frames) {
      pushIssue(rawLine, "源出必须晚于源入（" + srcIn.normalized + " -> " + srcOut.normalized + "）");
      continue;
    }
    if (recOut.frames <= recIn.frames) {
      pushIssue(rawLine, "录制出必须晚于录制入（" + recIn.normalized + " -> " + recOut.normalized + "）");
      continue;
    }
    const sourceSpan = srcOut.frames - srcIn.frames;
    const recordSpan = recOut.frames - recIn.frames;
    if (dissolveFrames !== null && BigInt(dissolveFrames) > sourceSpan) {
      pushIssue(rawLine, "dissolve 帧数 " + dissolveFrames + " 超过该事件的源跨度 " + sourceSpan + " 帧：转场不可能比事件本身更长");
      continue;
    }
    if (dissolveFrames !== null && BigInt(dissolveFrames) > recordSpan) {
      pushIssue(rawLine, "dissolve 帧数 " + dissolveFrames + " 超过该事件的录制跨度 " + recordSpan + " 帧");
      continue;
    }

    const number = tokens[0];
    const dupCount = (seenEventNumbers.get(number) || 0) + 1;
    seenEventNumbers.set(number, dupCount);
    const event = {
      line: lineNumber,
      raw: trimmed,
      number,
      id: dupCount === 1 ? number : number + "#" + dupCount,
      duplicateOf: dupCount === 1 ? null : number,
      reel,
      track: trackInfo.track,
      hasAudio: trackInfo.hasAudio,
      videoOnly: trackInfo.videoOnly,
      transition,
      dissolveFrames,
      sourceIn: srcIn,
      sourceOut: srcOut,
      recordIn: recIn,
      recordOut: recOut,
      comments: [],
    };
    events.push(event);
    lastEvent = event;
  }

  // ---- 收敛：结构性失败一律抛错（CLI 退出码 2） --------------------------
  if (events.length === 0) {
    if (!issues.length) {
      issues.push({ line: 0, text: "", message: "没有解析到任何事件行（事件行形如：001  AX  V  C  00:00:00:00 00:00:05:00 01:00:00:00 01:00:05:00）" });
    }
    throw new EdlParseError("EDL 解析失败（" + issues.length + " 处问题）", issues);
  }
  if (issues.length) throw new EdlParseError("EDL 解析失败（" + issues.length + " 处问题）", issues);

  // ---- 注释 → 文件名 -----------------------------------------------------
  let namesResolved = 0;
  let namesUnresolved = 0;
  for (const event of events) {
    const hits = [];
    for (const comment of event.comments) {
      const extracted = extractClipName(comment.text.replace(/^\*/, ""));
      if (extracted) hits.push({ ...extracted, line: comment.line });
    }
    // 同一事件可能出现 * FROM CLIP NAME 与 * TO CLIP NAME（dissolve 前后两条素材）。
    // 取优先级最高的一条当本事件的素材名，其余保留在报告里，不丢。
    const primary = hits.length ? hits[0] : null;
    event.nameHits = hits;
    event.name = primary ? primary.name : "";
    event.nameSource = primary ? primary.key : null;
    // 只统计「会变成 clip 的音频事件」：视频轨事件已被排除，把它们算进
    // 「文件名已解析 N 条」会让人以为有 N 条 clip 拿到了名字。
    if (!event.hasAudio) continue;
    if (primary) namesResolved += 1;
    else namesUnresolved += 1;
  }

  // ---- 视频轨事件：明确排除并计数，绝不静默丢 ---------------------------
  const audioEvents = events.filter((event) => event.hasAudio);
  const videoOnlyEvents = events.filter((event) => event.videoOnly);
  if (audioEvents.length === 0) {
    issues.push({
      line: 0,
      text: "",
      message:
        "这份 EDL 只有视频轨事件（V），没有任何音频轨事件（A/AA/A1..）。"
        + "本校验层只验音频素材的身份：对拿不出结论的输入不出绿灯",
    });
    throw new EdlParseError("EDL 没有音频轨事件，本校验层不支持", issues);
  }

  const dissolves = events
    .filter((event) => event.dissolveFrames !== null)
    .map((event) => ({ id: event.id, line: event.line, frames: event.dissolveFrames, reel: event.reel }));

  const commentsOfEvents = events.reduce((sum, event) => sum + event.comments.length, 0);

  return {
    parser: CMX3600_PARSER,
    fileName: options.fileName ? baseNameOf(options.fileName) : "",
    title,
    fcm: fcmRaw,
    dropFrame: Boolean(fps.drop),
    fpsValue,
    fpsSource: fps.fpsSource,
    lineCount: lines.length,
    events,
    audioEvents,
    videoOnlyEvents,
    headerComments,
    dissolves,
    counts: {
      lines: lines.length,
      events: events.length,
      audioEvents: audioEvents.length,
      videoOnlyEventsExcluded: videoOnlyEvents.length,
      videoOnlyEventIds: videoOnlyEvents.map((event) => event.id),
      dissolves: dissolves.length,
      comments: commentsOfEvents + headerComments.length,
      namesResolved,
      namesUnresolved,
      duplicateEventNumbers: events.filter((event) => event.duplicateOf).length,
    },
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// 投影成 clip_list.v1
// ---------------------------------------------------------------------------

/**
 * 把解析结果投影成 clip_list.v1（既有 schema，不改语义）。
 *
 * 映射规则（docs §9 有同一张表）：
 *   reel          -> reel
 *   事件号        -> id（重复事件号加 #2/#3 后缀，因为 clip_list.v1 要求 id 唯一）
 *   源入/源出     -> sourceIn / sourceOut（写成该帧率下的规范形态，丢帧带分号）
 *   录制入/出     -> timelineIn / timelineOut（让校验层能查「清单自身是否自相矛盾」）
 *   注释里的文件名 -> name；解析不到就留空字符串 + note，绝不猜
 *
 * 视频轨事件不进 clips：本校验层只验音频身份，把它们混进判定会让每份真实
 * 双系统 EDL 都无端多出一堆 unverified。排除数量与事件号写在报告 run.source 里。
 */
export function edlToClipList(parsed) {
  const clips = parsed.audioEvents.map((event) => {
    const noteParts = [
      "edl:evt=" + event.id,
      "track=" + event.track,
      "trans=" + event.transition,
    ];
    if (event.dissolveFrames !== null) noteParts.push("dissolveFrames=" + event.dissolveFrames);
    if (event.nameSource) noteParts.push("nameFrom=" + event.nameSource.replace(/\s+/g, "_"));
    if (event.duplicateOf) noteParts.push("dupOf=" + event.duplicateOf);
    if (!event.name) noteParts.push("nameUnresolved");
    return {
      id: event.id,
      name: event.name,
      reel: event.reel,
      sourceIn: event.sourceIn.normalized,
      sourceOut: event.sourceOut.normalized,
      timelineIn: event.recordIn.normalized,
      timelineOut: event.recordOut.normalized,
      note: noteParts.join(";"),
    };
  });
  return {
    schema: "clip_list.v1",
    fps: parsed.fpsValue,
    note: "由 CMX3600 EDL 派生（" + CMX3600_PARSER + "）；name 为空串表示 EDL 注释里没有文件名，需要人工补",
    clips,
  };
}

/** 解析 + 投影一步到位。CLI 与测试共用，避免两处口径漂移。 */
export function parseEdlToClipList(text, options = {}) {
  const parsed = parseCmx3600Edl(text, options);
  return { parsed, clipList: edlToClipList(parsed) };
}
