# dsh-video-gate

视频通道**阀门**插件：默认只读本地文件；Bilibili 站点通道默认关闭，读取前必须由你在弹窗里放行。YouTube、小红书、Netflix 都不在列表里（前两个要额外程序和 cookie，第三个是 DRM）。

> **第一次用？** 看 [docs/安装与使用.md](docs/安装与使用.md)：从下载、装依赖、配 `localRoots`，
> 到日常问法、卸载和故障排查，都在那一份里。
>
> 每个会话先发一句 **「启用读取视频插件」**，之后发链接或路径即可（「关闭读取视频插件」停用）。
>
> 想随时开关通道：双击 **`启动阀门.cmd`**（或桌面快捷方式）打开独立小窗口，勾选立即生效，不用重启。

## 通道与实现状态

| 通道 | 默认 | 现在能做什么 |
|---|---|---|
| 本地文件 | **开** | ffmpeg 抽帧（720p PNG）+ 可选本地 whisper 转写（`transcribe: true`） |
| Bilibili | 关 | 标题/时长/公开字幕/分镜帧（不需要 ffmpeg，也不需要 cookie） |

## 本地通道的位置

- ffmpeg：`<工作区>\tools\ffmpeg\ffmpeg.exe`（来源与哈希见 [docs/provenance-ffmpeg.md](docs/provenance-ffmpeg.md)）
- whisper：`<工作区>\tools\whisper\whisper-cli.exe` + `models\ggml-small.bin`（见 [docs/provenance-whisper.md](docs/provenance-whisper.md)）
- 允许的根目录：写在 `%USERPROFILE%\.dsh\video-gate\state.json` 的 `localRoots` 里，默认
  `<工作区>` + `%USERPROFILE%\Videos`
- 没有 `ffprobe`：时长从 `ffmpeg -i` 的 stderr 解析

实测（2026-11-01）：

- `probe-clip.mp4`（6 秒）→ 时长 0:06，抽出 1s/3s/5s 三帧，画面时间码与文件名一致
- `speech-clip.mp4`（6 秒，带人声）→ 2 帧 + `[0:00] 这是一段测试音频,用来验证本地语音识别是否正常工作。`

## 关于 ASR 的边界

- 只用本地 whisper.cpp，**音频不出机器**，没有 API key、没有上传
- 单次最多处理前 15 分钟；普通桌面 CPU 上 7 分半视频约 2–3 分钟
- **Bilibili 的视频拿不到音频流**（匿名 `playurl` 返回 0 条 audio，需要登录态）——所以 B 站
  无字幕视频的台词只能靠"下载到本地后走本地通道"，不会去读你的 cookie

## 阀门怎么工作

1. 模型调用 `video_read`，插件先按域名把来源分类到某个通道。
2. 通道关着 → 弹出选择框，四个选项：
   - 只放行这一次（读完即失效）
   - 本会话放行（不写盘）
   - 长期打开这个通道（写 `state.json`）
   - 保持关闭
3. 用户拒绝就是拒绝：工具返回错误，模型不得换路子绕过（系统提示里写死了）。
4. 宿主没有 `userQuestions` 服务时按**关闭**处理（fail-closed）。

随时可以用 `/video` 命令打开同一个选择框，多选勾出想要的通道。

## 状态与审计

- 状态：`%USERPROFILE%\.dsh\video-gate\state.json`
- 审计：`%USERPROFILE%\.dsh\video-gate\audit.jsonl`（每次放行/拒绝/读取一行 JSON）
- 缓存：`%USERPROFILE%\.dsh\video-gate\cache\`

## 硬约束（代码里写死）

- 只允许 http/https 的公开 GET，**没有任何 POST**；
- 目标域名限定在 4 个平台 + 本地文件，其他域名直接拒绝；
- 拒绝内网/回环地址（SSRF）；
- 不读浏览器 cookie、不读注册表、不装 Python 包；
- 子进程只用 argv 列表（无 shell），全部带超时；
- 落盘只在 `cache/` 子目录。

## 安装

```powershell
git clone https://github.com/<你的账号>/dsh-video-gate.git
plugin_manager action=install_bundle target=<克隆路径>
```

依赖不随仓库分发（ffmpeg 87MB、模型 465MB 都超过 GitHub 的文件限制），
下载地址与 sha256 见 `tools/*/PROVENANCE.md` 的写法。

## 卸载

```powershell
plugin_manager action=remove_bundle target=dsh-video-gate
```

## 许可

MIT。`tools/` 里的第三方二进制各自遵守其许可（ffmpeg 为 GPL，whisper.cpp 为 MIT）。
