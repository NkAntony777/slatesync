# 不依赖前端的 Poly 交付命令

前端 agent 尚未接入软件/音轨选择控件时，也可以直接使用数据层 CLI：

```powershell
node scripts/export-sync-package.mjs --help

# 真实参数举例：每次只处理一个 take，输出目录必须独立于输入目录。
node scripts/export-sync-package.mjs --input demo/FOLDER01 --output test/artifacts/cli --take ZOOM0004 --profile resolve --auto-ltc --channels ZOOM0004_Tr1.WAV:1 --reference ZOOM0004_Tr1.WAV:1
```

- `--profile`：resolve / sidus / pluraleyes / syncaila / archive。
- `--channels`：显式指定节目通道，格式 `文件名.WAV:1`，这里是 **1-based**，与前端内部 key 的 0-based 不同。
- `--reference`：另存一个 mono SyncRef，不是额外制作轨；必须来自保留的节目通道。
- `--auto-ltc`：成功识别后将起始时码及帧率写入**新输出**，源文件不变。
- 自动扫描默认前 60 秒，LTC 很晚才接入时用 `--scan-seconds` 调大；最大 3600 秒，大文件要注意内存。
- 自动 LTC 失败时默认拒绝输出，不会猜测。波形流程需要保留未确认时码时可显式加 `--allow-no-ltc`。
- 原始 metadata 时间码未经同步确认时，在交付说明里明确标注。
- 默认不覆盖已有输出；需要时显式 `--overwrite`。输出目录不能在源文件目录内。
- 使用 `.partial` 临时文件流式写 WAV，写失败 abort，成功后 rename。
- 输出主 Poly、可选 SyncRef、`_合板说明.txt`、`_channels.json`。
- 此 CLI 只读取输入文件夹第一层 WAV；有多个 take 时必须指定 `--take`。
- 未做自动 LTC 检测时，可用 `--ltc-channel` 标记你已经确认的 LTC 通道；不会凭 Tr6 名称猜测。

已实测 demo 的 ZOOM0004 低电平 LTC，生成了一个仅节目通道的 Resolve 输出和独立 SyncRef。
