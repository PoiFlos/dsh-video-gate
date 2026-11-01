# whisper.cpp 的来历（可核对）

这里有两样东西：`whisper-cli.exe` + 几个 DLL（运行时），和 `models\ggml-small.bin`（模型）。
没有安装器、没有写注册表、没有改 PATH、没有后台服务、**运行时不需要网络**。

## 二进制

| 项 | 值 |
|---|---|
| 来源 | GitHub `ggml-org/whisper.cpp` 的 nightly 资产 `whisper-bin-x64.zip`，tag `b5454`（2026-10-06） |
| 下载通道 | `api.github.com/repos/.../releases/assets/616096933`（带 `Accept: application/octet-stream`）——**直连 github.com 在经常超时，只能走 API 端点的 302** |
| 大小 / sha256 | 8,928,640 字节 / `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb` |
| 保留的文件 | `whisper-cli.exe`、`whisper.dll`、`ggml.dll`、`ggml-base.dll`、`ggml-cpu-*.dll`（共 13 个，11.1MB） |
| 丢弃的 | `whisper-server.exe`、`stream.exe`、`bench.exe`、各种 `test-*.exe`、`SDL2.dll`、`llama.dll`、`parakeet-*`、`wchess.exe` |

只留 CLI 和它真正要加载的 DLL：**留着一个本地 HTTP server 是可避免的攻击面**。

## 模型

| 项 | 值 |
|---|---|
| 文件 | `models/ggml-small.bin` |
| 来源 | `hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin`（huggingface.co 直连超时） |
| 大小 | 487,601,967 字节（465MB） |
| sha256 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| 哈希出处 | HF 仓库里该文件的 **LFS 指针**（`.../raw/main/ggml-small.bin` 的前三行），不是我自己算的 |

更大的 `ggml-medium.bin` 哈希也记在这里，将来要换直接核对：
`6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208`（1,533,763,059 字节）。

## 复核命令

```powershell
(Get-FileHash <工作区>\tools\whisper\models\ggml-small.bin -Algorithm SHA256).Hash
<工作区>\tools\whisper\whisper-cli.exe --version
```

## 运行时行为

- 输入：`ffmpeg` 先转出的 16kHz 单声道 wav（**重编码一次**，消掉异常封装）
- 调用：`whisper-cli.exe -m <模型> -f <wav> -l zh -t 4 -osrt -of <前缀>`
- 输出：`<前缀>.srt`（带时间码），读完即删 wav
- 超时：转换 5 分钟、转写 15 分钟；单次最多处理前 15 分钟音频
- 不联网：没有任何 API key、上传或回调；`whisper-server` 已从包里剔除

## 实测（2026-11-01）

用 Windows SAPI 的中文语音（Microsoft Huihui）合成一句：

> 这是一段测试音频，用来验证本地语音识别是否正常工作。

whisper small 的输出（逐字一致）：

> 这是一段测试音频,用来验证本地语音识别是否正常工作。

6 秒音频耗时约 10 秒（其中大半是 30 秒窗口的固定开销）；普通桌面 CPU 上 7 分半的视频估计 2–3 分钟。
