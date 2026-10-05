# 数据层回归测试

不需要安装 npm 依赖；使用支持 File/ES Modules 的 Node.js（本机 v24.12.0）。

```powershell
node --test test/ltc-low-level.test.mjs test/poly-compatibility.test.mjs
node test/run-tests.mjs
```

新增 26 个测试覆盖：

- PCM16 多个低电平（峰值到约 -90.5 dBFS）的合成 LTC；
- 24/23.976/29.97 DF，延迟接入，原始电平保留；
- Float32 低电平、DC 偏移、小噪声；
- 静音、类语音、随机噪声、纯音及量化后归零信号不误判，含 enhanced 模式；
- 主线程与 Worker 的起始 sample count 一致；
- PCM8/16/24/32/Float 转 PCM24，削波/非有限值统计；
- LTC 物理排除、显式节目轨选择、source 不被修改；
- WAVEFORMATEXTENSIBLE 离散布局、连续 iXML、BWF 起始时码；
- Archive Float + fact chunk；
- 失败写入 abort 而不是提交不完整文件；
- 中文合板说明和通道 manifest。

合成信号可恢复到某一电平，不代表同电平的现场噪声也能恢复。原始采样量化/信噪比不足时，工具必须返回明确失败，不猜测时码。

目标软件端：`scripts/resolve/`，报告在 `test/artifacts/resolve/resolve-report.json`。
