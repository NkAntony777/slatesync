# conform_check.v1：合板校验层契约

> 这份文档定义 SlateSync 的**校验层**：它不连片段、不修时码、不写文件，只回答一个问题——
> **时间线上这条 clip，真的连到了它声称的那条 take 吗？**
>
> 版本：`conform_check.v1`（输出 JSON 的 `contract` 字段）
> 实现：`src/conform-check.js`（纯判定逻辑）+ `scripts/conform-check.mjs`（CLI/媒体扫描）
> 状态：v1 只消费本项目自定义的最小剪辑清单，**格式层（EDL / AAF / OTIO / FCPXML）待接**。

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
- **不做**格式解析：v1 不读 EDL / AAF / OTIO / FCPXML。剪辑清单是自定义 JSON。
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

**格式层待接口**：将来接 EDL/AAF/OTIO 时，由适配器把外部格式投影成本 schema，
判定层不变。v1 不实现任何解析器。

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

## 9. 变更规则

- 加字段 / 改语义 / 改退出码 = 升版到 `conform_check.v2`。
- 加一种证据 kind、放宽容差默认值，都必须在这份文档里写清理由与影响面。
- 任何让 `unverified` 变成 `supported` 的改动都算语义变更（它把「不知道」变成了「通过」）。
