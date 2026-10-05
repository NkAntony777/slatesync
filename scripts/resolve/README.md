# DaVinci Resolve 本地验证

本项目的浏览器应用不能直接控制 Resolve。若要做软件端验证，需要先启动 Resolve，再使用 Resolve 的 Python API 或手工导入。

本机已发现：

- Resolve：`D:\game\dfq20 Win\Resolve.exe`
- 版本：`20.3.3.10`
- Scripting Modules：`C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules`

建议一次只验证一个 take：

1. 导入 `_Poly.WAV` 和对应视频；
2. 查看 Media Pool 的 `Clip Attributes > Audio` 通道映射；
3. 以 Timecode 做 Auto Sync；
4. 关闭/打开 `Retain embedded audio` 各验证一次，确认额外摄影机音轨是否来自 Resolve 选项而不是 Poly 文件；
5. 再以 Waveform 及指定 comparison channel 验证 SyncRef；
6. 保存截图和 Resolve 项目日志，不要直接覆盖原始素材。

项目不把 Resolve API 自动化当作浏览器功能，以避免在未运行 Resolve 或未授权脚本访问时误报“兼容”。

## 可复现验证

```powershell
node scripts/resolve/generate-fixtures.mjs
# 用已有 FFmpeg 为 camera_audio.wav 创建 camera.mov（25fps，TC 01:00:00:00）。
# 启动 Resolve 后：
python scripts/resolve/verify-resolve.py
```

`verify-resolve.py` 仅创建一个带时间戳的 `AudioTC_Compatibility_*` 测试工程，读取合成素材并保存测试结果。**不写入任何已有用户工程**；测试工程默认保留在项目库，便于复查，可手工删除。

报告在 `test/artifacts/resolve/resolve-report.json`。它既检查 `AutoSyncAudio` 返回值，也检查每条媒体的通道映射、BWF 起始时码、同步后来源与样本偏移。

2026-10-05 实测：4/2/5/1 通道导入，时码替换/保留摄影机声、主 Poly 波形同步、Mono SyncRef 波形同步及 20 项结果检查全部通过。只证明这些合成素材的工作流，不代表所有真实素材或其他软件经过验证。

公开仓库提供脱敏验证摘要：[`docs/validation/resolve-20.3.3.json`](../../docs/validation/resolve-20.3.3.json)。原始报告位于被 Git 忽略的 `test/artifacts/`，运行验证脚本后在本地生成。
