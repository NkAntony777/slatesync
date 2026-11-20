# conform_check.v1：合板校验层契约

> 这份文档定义 SlateSync 的**校验层**：它不连片段、不修时码、不写文件，只回答一个问题——
> **时间线上这条 clip，真的连到了它声称的那条 take 吗？**
>
> 版本：`conform_check.v1`（输出 JSON 的 `contract` 字段）
> 实现：`src/conform-check.js`（纯判定逻辑）+ `scripts/conform-check.mjs`（CLI/媒体扫描）
> 状态：判定层 `conform_check.v1` 不变；输入支持本项目自定义剪辑清单 `clip_list.v1`
> **与 CMX3600 EDL（`--edl`，见 §9）**。AAF / OTIO / FCPXML 仍未接。

## 0. 为什么需要这一层

合板（conform）分三层，前两层市面上的 NLE 已经做得很全：

| 层 | 做什么 | 谁在做 | 失败时会不会报错 |
|---|---|---|---|
| 1 时间码层 | 读 LTC / BWF 起始时码 | Resolve、Pro Tools、Syncaila… | 会 |
| 2 时间线层 | 把 clip 连回媒体文件（relink、卷号、模糊匹配） | 同上 | **常常不会** |
| 3 校验层 | 用**独立见证**证明「连对了 take」 | **基本没有** | —— |

第 2 层的失败模式最危险：调研里 Resolve 在真实 turnover 上把 878/882 个片段都连上了，
其中 **734 个（84%）连错 take**，而界面 **no error / no warning**。连得顺 ≠ 连得对。

所以这一层的产出不是「成功/失败」，而是**每条 clip 一条证据链 + 三态结论**。
它的价值有一半来自「敢说自己不知道」：`unverified` 是一个诚实的结论，不是一个缺陷。

### 边界（明写，避免被当成承诺）

- **不做**商业软件的逆向工程：不解析 Resolve 的 `Project.db`，不读任何闭源工程格式。
  本层只依据公开标准（EBU Tech 3285 bext、iXML 字段约定、SMPTE ST 12-1 timecode/LTC）
  和文件自身的字节。
- **只读一种外部格式**：CMX3600 EDL（`src/edl-cmx3600.js` + `--edl`，见 §9）。
  AAF / OTIO / FCPXML / 任何闭源工程文件都不读。EDL 只按公开的 CMX3600 约定解析，
  不逆向任何商业软件。
- **不改**任何源素材：CLI 全程只读。
- 零运行时依赖：只用 `node:*` 与仓库内已有模块。

## 1. 输入：剪辑清单 `clip_list.v1`

JSON only（CSV 留给格式层）。最小形态：

```json
{
  "schema": "clip_list.v1",
  "fps": "25",
  "clips": [
    {
      "id": "clip-001",
      "name": "A001_T001.WAV",
      "reel": "A001",
      "sourceIn": "10:00:01:00",
      "sourceOut": "10:00:05:00",
      "timelineIn": "01:00:00:00",
      "timelineOut": "01:00:04:00",
      "fps": "25",
      "note": "可选备注"
    }
  ]
}
```

| 字段 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `schema` | 是 | string | 固定 `"clip_list.v1"`，不符即退出码 2 |
| `fps` | 否 | string | 顶层默认帧率，默认 `"25"`；支持 `23.976 / 24 / 25 / 29.97 / 29.97df / 30 / 48 / 50 / 59.94 / 59.94df / 60 …` |
| `clips[]` | 是 | array | 非空 |
| `clips[].id` | 是 | string | 清单内唯一 |
| `clips[].name` | 是 | string | 媒体目录里的文件名（大小写不敏感精确匹配） |
| `clips[].reel` | 否 | string | 卷号/磁带号，只做弱匹配（见 §3.1） |
| `clips[].sourceIn` | 是 | string | 该 clip **声称的取用段入点**（不是 take 首帧） |
| `clips[].sourceOut` | 是 | string | 声称的取用段出点，必须晚于 sourceIn |
| `clips[].timelineIn/Out` | 否 | string | 时间线入出，成对出现；用于查「清单自身是否自相矛盾」 |
| `clips[].fps` | 否 | string | 覆盖顶层帧率（同一份清单可混帧率） |
| `clips[].note` | 否 | string | 自由文本，不参与判定 |

**严格拒绝未知字段**（顶层与 clip 内都一样）。理由：清单里把 `sourceIn` 拼错成
`sourceTC` 会让校验静默少验一项，而「少验一项」在报告里看起来和「验过且通过」一样。
宁可退出码 2 让人改，也不要出一个看着完整的空壳报告。

**格式层接口**：外部格式由适配器投影成本 schema，判定层不变。
CMX3600 EDL 的适配器已实现（`src/edl-cmx3600.js`，见 §9）；AAF / OTIO / FCPXML 仍未实现。

## 2. 输出：报告与证据链

```jsonc
{
  "contract": "conform_check.v1",
  "clipListSchema": "clip_list.v1",
  "mediaRoot": "media",                     // 相对 cwd 的路径；不做绝对路径外泄
  "options": { "frameToleranceFrames": 1, "durationToleranceFrames": 1,
               "maxUnverifiedRatio": 0, "ltcPolicy": "auto", "ltcScanSeconds": 60 },
  "syntheticStubMedia": false,              // 文件名含 _stub 时为 true
  "media": { "filesSeen": 6, "waveFilesReadable": 6, "waveFilesUnreadable": 0,
             "withEmbeddedStart": 4, "ltcScanned": 4, "ltcDecoded": 2 },
  "summary": { "clips": 6, "supported": 2, "unverified": 2, "conflict": 2,
               "unverifiedRatio": 0.33 },
  "exitCode": 1,
  "exitMeaning": "存在证据矛盾（conflict），或不可判定比例超过阈值",
  "ltcRequests": [{ "clipId": "ok-ltc-02", "probePath": "B001_T001_ltc_stub.WAV",
                    "reason": "no-embedded-stamp" }],
  "clips": [ /* 见下 */ ]
}
```

单条 clip：

```jsonc
{
  "id": "wrong-take-01",
  "verdict": "conflict",
  "reasons": ["embedded-range-mismatch", "embedded-span-mismatch"],
  "claim": { "name": "A002_T001_stub.WAV", "fps": "25", "dropFrame": false,
             "sourceIn": "10:00:00:00", "sourceInFrames": "900000",
             "sourceOut": "10:00:04:00", "sourceOutFrames": "900600",
             "spanFrames": "600", "timelineIn": null, "timelineOut": null },
  "evidence": [
    {
      "kind": "content.embedded-range",
      "strength": "strong",
      "status": "fail",
      "expected": { "timecode": "10:00:00:00", "frames": "900000", "seconds": "36000.000000000" },
      "measured": { "claimTimecode": "10:00:00:00", "fileStart": "10:00:20:00",
                    "fileEnd": "10:00:26:00", "fileStartSamples": "1728960000",
                    "source": "content.bext-time-reference", "sampleRate": 48000 },
      "deltaSeconds": "20.000000000",
      "deltaFrames": "500.000000000",
      "toleranceFrames": 1,
      "coverage": "before-file",
      "detail": "文件自身记录的起点晚于清单声称的源入：这个文件里没有这段素材",
      "readBy": "src/wave.js scanWave 读 bext.TimeReference …"
    }
  ],
  "candidates": [{ "path": "A002_T001_stub.WAV", "hasBext": true, "durationSamples": "288000" }],
  "alternates": [{ "path": "A002_T002_stub.WAV", "startTimecode": "10:00:00:00",
                   "endTimecode": "10:00:06:00", "startDeltaFrames": "0.000000000" }],
  "suggestions": ["媒体目录里 A002_T002_stub.WAV 覆盖清单声称的源区间…"],
  "ltcRequest": null
}
```

### 2.1 证据行字段（每条 clip 是一串比较，不是一个布尔）

| 字段 | 含义 |
|---|---|
| `kind` | 证据种类（§3 表格） |
| `strength` | `identifier` / `weak` / `strong`（决定它能不能单独支撑支持结论） |
| `status` | `pass` / `fail` / `missing` / `na`。**`missing` 不是 fail** |
| `expected` | 清单声称的值（时码、帧号、秒数、span） |
| `measured` | 实测值 + 读取来源（`source`、`sampleRate`、`samples`、`confidence`…） |
| `deltaSeconds` / `deltaFrames` | 实测 − 期望（有符号），精确有理数展开成 9 位小数 |
| `toleranceFrames` | 该项比较用的容差（帧） |
| `coverage` | 区间类证据的定位：`exact` / `inside` / `before-file` / `after-file` / `unknown` |
| `detail` | 中文一句话结论 |
| `readBy` | **复算路径**：读哪个字节、走哪个模块、和什么比 |

`deltaFrames` 与 `deltaSeconds` 同时给，是因为跨帧率时只有秒是可比的；
而人看帧数更快。两者都是精确有理数（BigInt 分数）展开，不是浮点。

## 3. 证据源（全部复用既有模块）

| kind | strength | 读什么 | 复用模块 | 什么时候拿不到 |
|---|---|---|---|---|
| `identifier.filename` | identifier | 媒体目录里的文件名（小写精确匹配） | CLI 扫描 | 文件不存在（`missing`）/ 同名多份（`fail`，判 conflict） |
| `identifier.reel` | identifier | 候选路径里是否出现卷号子串 | —— | 命名不含卷号时只记 `missing`，**永不判 fail** |
| `identifier.timeline-span` | identifier | 清单自身的 source span 与 timeline span | `src/timecode.js` | 未给 timelineIn/Out 时不出现 |
| `content.embedded-range` | strong | bext.TimeReference / iXML 时间戳 → 文件起点；+ data 时长 → 文件终点 | `src/wave.js` `src/timecode.js` | 文件没有 bext 也没有 iXML（`missing`），或文件头解析失败 |
| `content.embedded-span` | strong | 同上，判声称出点是否被文件终点覆盖 | 同上 | 同上 |
| `content.duration` | weak | data chunk 采样数 / 采样率 | `src/wave.js` | 文件无法解析 |
| `content.ltc-range` | strong | 解码 LTC 首帧时码 + 文件时长 | `src/ltc-decoder.js`（`detectAuto`） | 静音、无 LTC、置信度 < `LTC_MIN_CONFIDENCE`（0.6）→ `missing` |
| `content.cross-evidence-agreement` | strong | bext/iXML 起点 vs LTC 起点 | 同上 | 缺任一侧时不出现 |

**LTC 何时扫**（`--ltc`）：

- `auto`（默认）：只对「没有内嵌时码」或「已经 conflict」的候选扫 LTC。
  大目录上不会为每条 clip 把所有文件都解一遍。
- `on`：所有命中候选都扫。
- `off`：完全不扫（只看文件头）。此时 `content.ltc-range` 记 `missing`。

## 4. 三态语义

| 判定 | 含义 | 触发条件 |
|---|---|---|
| `supported` | **有独立证据支撑**：文件内容与声称相容 | ≥1 条 `strong` 证据 `pass`，且 0 条 `fail` |
| `unverified` | **找不到可用证据 ≠ 错** | 无 `fail`，且无 `strong` `pass`（只有 identifier / weak 通过，或什么都没读到） |
| `conflict` | **证据互相矛盾** | 任意一条证据 `fail` |

要点，逐条写明：

1. **只有文件名对上，不算 supported。** 文件名是操作者自己的声明，不是独立见证。
   命中文件名只会让 `identifier.filename` 记 pass，结论仍是 `unverified`
   （原因 `no-independent-witness`）。
2. **时长对上，不算 supported。** 6 秒的 take 很多，时长一致可以巧合。
   `content.duration` 刻意标成 `weak`。
3. **判的是相容性，不是相等。** `sourceIn` 通常不是 take 首帧（现场留 pre-roll、
   成片只取 take 中一段都是常态）。所以查的是「声称区间是否落在文件自己记录的区间内」，
   而不是「文件起点是否等于 sourceIn」。`coverage` 字段会区分
   `exact`（起点正好等于声称入点）与 `inside`（落在区间内）。
4. **优先冲突。** 只要有一条 fail，即使别的证据都 pass，结论也是 conflict。
   一条证据说「不是它」就足以否掉。
5. **文件不在 ≠ 冲突。** 媒体目录里没有这个文件时记 `unverified`
   （原因 `media-not-found`）：这是证据缺席，不是证据反对。但默认阈值下它照样让
   退出码变 1，见 §5。
6. **文件内部两条见证打架 = 冲突。** bext 说 09:00、LTC 说 09:30 的文件，
   两条 strong 证据都不能单独当见证，判 conflict（`internal-evidence-disagreement`）。

## 5. 退出码

| 码 | 条件 | 含义 |
|---|---|---|
| `0` | 全部 clip `supported`，或 `unverified` 比例 ≤ `--max-unverified-ratio` | 可以放行 |
| `1` | 存在任意 `conflict`，**或** `unverified` 比例 > 阈值 | 不能放行 |
| `2` | 剪辑清单读不到 / JSON 非法 / schema 不符 / 未知字段 / 用法错 / 媒体目录不存在 | 输入问题，不是判定结果 |

`--max-unverified-ratio` 默认 **0**。理由：作为 CI 门禁，「我不知道」不该悄悄变绿。
确实有拿不到内嵌时码也不接 LTC 的素材时，显式给一个比例（例如 `0.2`），
把「这部分我认了」写进命令历史，而不是把默认值放宽。

## 6. 容差常量

全部是 `src/conform-check.js` 里的具名常量，可被 CLI 逐项覆盖。

| 常量 | 默认 | 单位 | 理由 |
|---|---|---|---|
| `DEFAULT_FRAME_TOLERANCE_FRAMES` | 1 | 帧 | bext 是采样级精确，清单是帧量化；23.976/29.97/59.94 下一帧不是整数个采样（48000/29.97=1601.6），采样边界换算成帧可能偏出半帧；现场也常在 take 头留不足一帧的 pre-roll。连错 take 的偏差是**秒级**，1 帧掩不住 |
| `DEFAULT_DURATION_TOLERANCE_FRAMES` | 1 | 帧 | data chunk 精确到采样，但 `sourceOut` 是「最后一帧」还是「之后」没有统一约定，两种写法差 1 帧 |
| `DEFAULT_MAX_UNVERIFIED_RATIO` | 0 | 比例 | 见 §5 |
| `LTC_MIN_CONFIDENCE` | 0.6 | 0..1 | 低于此值的 LTC 锁不当证据（宁可 missing，不拿错锁当见证）；与 `scripts/export-sync-package.mjs` 的自动 LTC 门槛一致 |
| `DEFAULT_LTC_SCAN_SECONDS` | 60 | 秒 | LTC 一般在前几秒就出现；封顶让大目录可跑。可用 `--ltc-scan-seconds` 放宽 |

**跨帧率与 drop-frame 归一**：所有比较先把两边化成「一天里的精确有理秒数」
（`timecodeToFrames(tc, fps) / fpsRate(fps)`，DF 的跳帧由 `timecodeToFrames` 处理），
再把容差从帧换算成秒（`frames / fpsRate(fps)`）后相减。
因此 25 / 29.97DF / 23.976 混在一份清单里也成立，调用点没有任何裸帧率换算。

## 7. 用法

```bash
# 生成合成素材（全部 _stub，反例可复现）
node scripts/make-conform-fixtures.mjs --out test/artifacts/conform-stub

# 混合清单：三种态一次看全（退出码 1）
node scripts/conform-check.mjs test/artifacts/conform-stub/clip-list.mixed.json \
  --media test/artifacts/conform-stub/media

# 负对照 1：连错 take → conflict / 退出码 1
node scripts/conform-check.mjs test/artifacts/conform-stub/clip-list.wrong-take.json \
  --media test/artifacts/conform-stub/media

# 负对照 2：证据缺失 → unverified / 默认退出码 1
node scripts/conform-check.mjs test/artifacts/conform-stub/clip-list.missing-evidence.json \
  --media test/artifacts/conform-stub/media
# 显式放宽阈值后退出码 0，但结论仍是 unverified
node scripts/conform-check.mjs test/artifacts/conform-stub/clip-list.missing-evidence.json \
  --media test/artifacts/conform-stub/media --max-unverified-ratio 1

# 正例：退出码 0
node scripts/conform-check.mjs test/artifacts/conform-stub/clip-list.all-supported.json \
  --media test/artifacts/conform-stub/media

# CI：机器可读报告
node scripts/conform-check.mjs clips.json --media ./media --json --report conform.json
```

## 8. 已知局限（这个工具在哪些情况下给不出判定）

这一节是契约的一部分：**不装作知道**。

1. **错拿的 take 恰好覆盖声称区间时，本层判 supported 而不是 conflict。**
   内嵌时码只能证明「这个文件里确实有这一段」，证明不了「这一段就是剪辑师想要的那条」。
   两条 take 时码区间重叠（多机位、连续录制）时，只有 LTC 内容、文件名/卷号、
   或人工确认能进一步区分。→ 报告里 `coverage` 会显示 `exact`/`inside`，
   `inside` 的支撑弱于 `exact`，人应据此决定要不要看第二眼。
2. **两个文件同名**时无法判定该验哪个，判 conflict（`ambiguous-filename`）。
   工具不会替你选。
3. **没有 bext、没有 iXML、也没有 LTC** 的文件永远只能是 unverified。
   数字静音无法通过增益恢复，工具不许猜。
4. **LTC 扫描只读文件头部**（默认 60 秒）。时码在更晚处才出现的素材，
   需要 `--ltc-scan-seconds` 放宽，否则会记 missing（不是 fail）。
5. **不校验画面。** 纯音频证据层：镜头是否对、画面是否同期，本层不管。
6. **不校验时间线顺序与重叠。** 本层逐条查身份，不查「第 3 条是不是该在第 2 条后面」。
7. **不解析商业工程文件。** 清单必须由外部工具/人投影成 `clip_list.v1`。
8. **卷号匹配是子串匹配**，只作 identifier 级提示，不参与 supported/conflict 判定。
9. **合成素材未覆盖真实拍摄素材的长尾**：现场噪声、时钟漂移、变速、多声道
   LTC 混音等场景需要真实素材回归（当前 fixtures 全部 `_stub`）。

## 9. 格式层：CMX3600 EDL（`--edl`）

### 9.1 这一层解决什么

剪辑室不会给 JSON。他们给的是 `.edl`。判定层已经能回答「这条 clip 连对了没有」，
但它之前只吃自定义清单，所以真实项目里要先有人手抄一遍——手抄就没人跑，
跑不起来的校验等于没有校验。这一节把第一块格式层补上：**直接吃 CMX3600 EDL**。

解析器在 `src/edl-cmx3600.js`，纯函数、零依赖（只 import `./timecode.js`；有测试守着这条）。
它只读文本，不读盘、不逆向任何商业软件；CMX3600 的行为按公开约定实现（事件行八/九字段、
`TITLE`/`FCM` 头部、`*` 注释、`D` 带帧数、丢帧时码用分号）。

### 9.2 支持的子集（明写到这里，避免被当成「支持 EDL」）

| 元素 | 形态 | 说明 |
|---|---|---|
| `TITLE` | `TITLE:   NAME` | 只记录，进 `run.source.title`；不参与判定 |
| `FCM` | `FCM: DROP FRAME` / `FCM: NON-DROP FRAME`（也认 `NDF` / `DF`） | 只声明丢帧与否；速率不在这行（见 §9.4） |
| 事件行（cut） | `NNN  REEL  TRACK  C  srcIn srcOut recIn recOut` | 8 个字段 |
| 事件行（dissolve） | `NNN  REEL  TRACK  D  NNN  srcIn srcOut recIn recOut` | 9 个字段，`NNN` 为转场帧数（> 0） |
| 轨道记号 | `V` / `A` / `AA` / `AB` / `A1`..`A9`，可 `/` 组合（如 `A2/V`） | 含 `A` 即视为有音频；纯 `V` 见 §9.4 |
| 时码（非丢帧） | `HH:MM:SS:FF` | 合法性（帧数 < 额定帧率）由 `src/timecode.js` 判 |
| 时码（丢帧） | `HH:MM:SS;FF` | 分号即丢帧；不存在的时间码（非 10 分钟整点跳帧位）会被拒 |
| 注释行 | `* ...` | **全部保留**，挂在它前面的事件上（无前序事件则挂文件头） |
| 空行 | —— | 结构性分隔，跳过不算「丢数据」 |

注释里能被当成**真实文件名**的键（只认这些，其余一律不用）：
`FROM CLIP NAME` > `CLIP NAME` > `TO CLIP NAME` > `SOURCE FILE` / `FROM FILE`。
值里若是路径，只取 basename。**解析不到就留空，不猜。**

### 9.3 明确不支持（遇到就报错 + 退出码 2，不静默跳过）

| 元素 | 为什么不支持 |
|---|---|
| `W` / `K` / `KB` / `KO` / `KI` / `X` 转场 | 只实现 cut 与 dissolve；把 wipe 当硬切会让源跨度看起来对、实际错 |
| `M2` / `M1` 变速备忘 | 没实现速度换算；忽略它会把变速段的源跨度算错 |
| 其他任何非空、非注释、非头部、非事件的行 | 例如 `EFFECTS NAME IS ...`：不认识就说，不猜 |
| 只有视频轨（没有任何 `A*` 事件）的 EDL | 本层只验音频身份；拿这种表跑只会得到一片 unverified，属于用错工具，直接报 unsupported |
| AAF / OTIO / FCPXML / XML | 未实现（本层不做） |

### 9.4 映射规则（EDL 事件 → `clip_list.v1`）

| EDL | clip_list.v1 | 规则 |
|---|---|---|
| `reel` | `reel` | 原样；只作 identifier 级弱匹配 |
| 事件号 `NNN` | `id` | 原样（保留前导零）。**重复事件号加 `#2`/`#3` 后缀**，因为 `clip_list.v1` 要求 id 唯一（dissolve 常把同一事件号写两行）。`note` 里留 `dupOf=` |
| `srcIn` / `srcOut` | `sourceIn` / `sourceOut` | 写成**该帧率下的规范形态**（`framesToTimecode` 回显）：丢帧仍带分号，非丢帧带冒号 |
| `recIn` / `recOut` | `timelineIn` / `timelineOut` | 让判定层能查「清单自身是否自相矛盾」（`identifier.timeline-span`） |
| 注释里的文件名 | `name` | 解析不到 → `name: ""` + `note` 里 `nameUnresolved`，判定层记 `no-filename-in-edl` 判 **unverified**（不是 supported） |
| 转场与帧数 | `note` | `note: "edl:evt=004;track=A;trans=D;dissolveFrames=24;nameFrom=FROM_CLIP_NAME"`。**不往 clip 上加字段**，schema 不变 |
| 纯 `V` 事件 | 不进 `clips` | **明确排除并计数**：`run.source.videoOnlyEventsExcluded` / `videoOnlyEventIds`。不静默丢：数量与事件号都在报告里 |

**dissolve 怎么处理（重要）**：每个事件行各成一条 clip，**不合并**前后两行，也不重算转场几何。
理由：判定层只关心「这条 clip 声称的源区间是什么」，转场几何属于时间线结构，不是身份证据。
唯一做的是自检：`dissolveFrames` 必须 > 0，且不超过该事件的源跨度/录制跨度，否则报错——
这类输入多半是列表被截断或列错位，放过去就会用错的跨度去比对。

**帧率怎么定（`fpsSource` 会写进报告，不藏假设）**：

1. 给了 `--edl-fps` → 用它（`fpsSource: cli`）。若时码里有分号而它非丢帧 → 报错并提示改传 `29.97df`；
   25 / 24 这类速率根本没有丢帧变体，也会明确说不支持。
2. 没给参数、时码里有分号 → `29.97df`（`fpsSource: default-dropframe`）。
3. 其余 → `25`（`fpsSource: default`，与 `clip_list.v1` 默认一致）。

`FCM` 只说丢帧/非丢帧、不说速率，所以这三条是**确定规则**而不是猜：选择会打印在人类摘要里，
也写在 `run.source.fps` / `run.source.fpsSource`。以下两种矛盾一律报错，不替你挑一种解释：

- `FCM: NON-DROP FRAME` 但时码里有分号；
- `FCM: DROP FRAME` 但**没有任何**时码用分号（若确认是非丢帧，用 `--edl-fps 29.97` 显式声明）；
- 同一份表里混用 `;` 与 `:`。

### 9.5 严格性：这些情况一律退出码 2

| 情况 | 报什么 |
|---|---|
| 字段数不对 | `行 4：字段数不对：cut 事件需要 8 个字段，实际 7 个` |
| 时码非法 | `行 4：时码非法："10:00:00:99"（帧数必须小于 25；当前帧率 25）` |
| 不认识的记录类型 | `行 4：无法识别的记录类型：首字段 "EFFECTS" 不是事件号` |
| 不认识的轨道/转场 | `行 4：不认识的轨道记号："X"` / `行 4：不支持的转场类型 W（wipe（划像））` |
| `M2` 变速备忘 | `行 4：不支持变速/冻结备忘行（M2）：…` |
| 倒置入出 | `行 4：源出必须晚于源入（… -> …）` |
| dissolve 帧数超跨度 | `行 4：dissolve 帧数 100 超过该事件的源跨度 25 帧` |
| 没有音频轨事件 | `这份 EDL 只有视频轨事件（V），没有任何音频轨事件` |

一次解析会**收集全部问题**再退出，每条都带行号与原文，所以坏表不用一条一条试。
错误走 stderr，stdout 不产生半份报告——半份报告比没有报告更危险。

### 9.6 报告里的 EDL 溯源（`run.source`）

只在 `--edl` 输入时出现（`clip_list` 输入的输出与本文首版逐字节一致）：

```jsonc
"run": {
  "ignoredNonWaveFiles": 1,
  "takesDetected": 4,
  "source": {
    "kind": "edl-cmx3600", "parser": "cmx3600.v1", "file": "turnover_25fps.edl",
    "title": "SLATESYNC TURNOVER TEST", "fcm": "NON-DROP FRAME",
    "fps": "25", "fpsSource": "default",
    "events": 5, "audioEvents": 4,
    "videoOnlyEventsExcluded": 1, "videoOnlyEventIds": ["001"],
    "dissolves": 1, "dissolveEvents": [{ "id": "004", "line": 15, "frames": 24, "reel": "A002" }],
    "comments": 8, "namesResolved": 4, "namesUnresolved": 0, "duplicateEventNumbers": 0,
    "eventLines": [{ "id": "002", "line": 8, "track": "A", "transition": "C",
                     "dissolveFrames": null, "reel": "A001", "name": "A001_T001_stub.WAV",
                     "nameSource": "FROM CLIP NAME" }]
  }
}
```

`run` 是 CLI 的溯源块，**不属于三态判定契约**：`contract` / `summary` / `clips[].verdict` /
`exitCode` 的语义与取值规则完全没动。`eventLines` 给出每个事件的行号，报告里的每条 clip
都能回到 EDL 的某一行。

### 9.7 用法

```bash
# 生成合成素材（全部 _stub）
node scripts/make-conform-fixtures.mjs --out test/artifacts/conform-stub

# 1) EDL 直接判定（按扩展名识别；等价于 --edl）
node scripts/conform-check.mjs test/fixtures/edl/turnover_25fps.edl \
  --media test/artifacts/conform-stub/media

# 2) 显式 --edl + 显式帧率 + 机器可读报告
node scripts/conform-check.mjs --edl test/fixtures/edl/turnover_25fps.edl \
  --media test/artifacts/conform-stub/media --edl-fps 25 --json --report conform.json

# 3) 完整链路：EDL → clip_list.v1（落盘）→ 再跑该清单
node scripts/conform-check.mjs --edl test/fixtures/edl/turnover_25fps.edl \
  --media test/artifacts/conform-stub/media --emit-clip-list out/from-edl.json --quiet
node scripts/conform-check.mjs out/from-edl.json \
  --media test/artifacts/conform-stub/media --json

# 4) 丢帧表
node scripts/conform-check.mjs test/fixtures/edl/dropframe_2997df.edl \
  --media test/artifacts/conform-stub/media
```

`--emit-clip-list` 写出的清单里，`name` 为空串的条目需要人工补文件名；
**直接读 `clip_list` 文件时空 name 仍然退出码 2**（schema 没有被 EDL 路径顺手放宽）。

### 9.8 已知局限：什么样的真实 EDL 会解析失败

这一节同样是契约的一部分。下面每一条都是**故意**的失败，不是 bug：

1. **含 wipe / key 的表**：`W` / `K` 一律退出码 2。真实成片表里转场很常见，
   所以本层现在只能吃「cut + dissolve」的表。需要 wipe 的话，先在 NLE 里把转场渲染掉再导出。
2. **含变速（`M2`）的表**：退出码 2。速度换算没实现，忽略它会把源跨度算错。
3. **`FCM` 与分号不一致的表**：退出码 2。这类表要么是导出器 bug，要么是人工改过；
   猜错丢帧会让整条时间线差几分钟。用 `--edl-fps` 显式声明可以绕过 FCM 的裁决。
4. **没有 `* FROM CLIP NAME` 的表**：能解析，但每条 clip 都判 `unverified`
   （`no-filename-in-edl`）。EDL 的卷号不是文件名，拿卷号当文件名会去验错文件。
5. **正是视频轨的表**（只交付画面 EDL）：退出码 2。本层验的是音频素材身份。
6. **事件号重复但没有 dissolve 语义的表**：会被加上 `#2` 后缀。序号本身不参与判定，
   但报告里的 id 与原始事件号不完全一致，`run.source.eventLines[].line` 可用于回查。
7. **列宽靠空格对齐、字段里有空格**的表：按空白切分，所以卷号/轨道里不能有空格。
   真实 EDL 不会这样，但手工编辑过的会。
8. **24 小时以上的时码、绝对帧号写法、AAF 风格的时间线**：不支持，会报时码非法。
9. **CMX3600 的其他方言**（File32/File128 的额外头、GVC 的扩展备忘）：未覆盖；
   不认识的行一律报错而不是忽略，所以会失败得很明确。

> 参考的公开说明：CMX3600 事件行/转场/`FCM`/分号丢帧的公开描述
> （如 [postmicrotools EDL inspector](https://www.postmicrotools.com/edl) 的说明页），
> 以及 SMPTE ST 12-1 的时码定义。**未参考任何闭源软件的实现，也未复制任何代码。**

## 10. 变更规则

- 加字段 / 改语义 / 改退出码 = 升版到 `conform_check.v2`。
- 加一种证据 kind、放宽容差默认值，都必须在这份文档里写清理由与影响面。
- 任何让 `unverified` 变成 `supported` 的改动都算语义变更（它把「不知道」变成了「通过」）。
