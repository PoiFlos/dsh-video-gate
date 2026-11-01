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
| Bilibili | 关 | 标题/时长/公开字幕/分镜帧；登录后可取 AI 字幕（可选，见下） |

## 本地通道的位置

- ffmpeg：`<工作区>\tools\ffmpeg\ffmpeg.exe`（来源与哈希见 [docs/provenance-ffmpeg.md](docs/provenance-ffmpeg.md)）
- whisper：`<工作区>\tools\whisper\whisper-cli.exe` + `models\ggml-small.bin`（见 [docs/provenance-whisper.md](docs/provenance-whisper.md)）
- 允许的根目录：写在 `%USERPROFILE%\.dsh\video-gate\state.json` 的 `localRoots` 里，默认
  `<工作区>` + `%USERPROFILE%\Videos`
- 没有 `ffprobe`：时长从 `ffmpeg -i` 的 stderr 解析

## 实测

真机跑过的，不是"设计如此"：

| 场景 | 结果 |
|---|---|
| 会话唤醒 | 发「启用读取视频插件」→ 插件的 `session/event` 监听器先醒，工具回「之前就已经是启用状态」 |
| 未启用时 | `video_read` 直接返回「视频插件还没启用」，不读 |
| 阀门弹窗 | 审计里 2 条 `grant-once`，均为用户在弹窗里点「只放行这一次」；不点则超时拒绝 |
| B 站读取 | 标题/时长/分镜帧正常；一条 7:35 的教程视频取到 5 帧 |
| B 站 AI 字幕 | 登录后取到 **198 行**，内容与视频一致 |
| 错字幕拦截 | 实测拦下 3 次「别的视频」的字幕（美食视频、番剧片段），宁可不给 |
| 本地抽帧 | 6 秒测试片 → 1s/3s/5s 三帧，画面时间码与文件名一致 |
| 本地 ASR | SAPI 合成中文 → whisper 输出逐字一致 |
| 阀门窗口 | 进程/标题正常；勾选实时写 `state.json`；托盘模块加载成功（`HAVE_TRAY=True`） |

### 一个必须知道的坑：B 站 AI 字幕在生成好之前会给你**别人的**

同一个请求（`?bvid=...&cid=...` 固定不变）连发 10 次，返回的是：

| 次 | 内容 | 判定 |
|---|---|---|
| 1–8 | 全是**别的视频**的字幕（有的根本没 track） | ✗ |
| 9–10 | 同一条 URL（`.../prod/113381163996591…`，这串就是本视频的 **aid**）、198 行、末句 453s | ✓ |

前 8 次返回的 URL 里嵌的是**别的 aid**。等本视频的字幕生成/缓存好之后，同一请求就稳定返回正确的那份了
——**同一个 URL 连续两次生效**，说明这是「按需生成 + 缓存」，不是随机抽奖。

所以代码里的三段式：

1. **本地缓存**：读过一次就写 `cache/<bvid>/subtitle.json`，之后不再碰接口；
2. **重试**：没有缓存就最多试 8 次（间隔 400ms），每次重新请求拿新地址；
3. **双校验**：必须覆盖到大半段视频（太短的多半是别人的片段），且标题/UP 名里的词**至少命中 2 个**
   （拉丁词只认整词且 ≥4 字母，否则 `in`、`si` 这种会命中一切英文；中文按二字滑窗）。

过不了就明确说「没取到」并告诉你等一会儿再读，**绝不把别人的台词当你的**。

> 这也解释了为什么"我给了具体链接还会错"：链接定位的是**视频**（标题/时长/分镜帧始终正确），
> 而字幕是另一个独立文件，由字幕服务按「当前完成的生成任务」发放。

### 没验证到的

- 窗口的实际观感（只验了进程、标题、逻辑；渲染结果得人眼看）
- 托盘图标的点击行为（pystray 已装进 `gui/_vendor`，但没人工点过）
- 换机器后的行为（目录约定、Python 版本差异）未验证

## 关于 ASR 和登录态

- 只用本地 whisper.cpp，**音频不出机器**，没有 API key、没有上传
- 单次最多处理前 15 分钟；普通桌面 CPU 上 7 分半视频约 2–3 分钟
- **Bilibili 匿名拿不到音频流**（`playurl` 返回 0 条 audio），所以 B 站视频的台词只能靠平台字幕；
  真要 ASR 就把视频下载到本地，走本地通道
- 登录态是可选的：说「登录 B 站」后，把 `SESSDATA` 写进 `%USERPROFILE%\.dsh\video-gate\bilibili.cookie`。
  **插件不读浏览器 cookie**，只读这个文件，且只对 `bilibili.com` / `bili2233.cn` / `bilivideo.com` / `hdslb.com` 生效

## 阀门怎么工作

1. 模型调用 `video_read`，插件先按域名把来源分类到某个通道。
2. 通道关着 → 弹出选择框，四个选项：
   - 只放行这一次（读完即失效）
   - 本会话放行（不写盘）
   - 长期打开这个通道（写 `state.json`）
   - 保持关闭
3. 用户拒绝就是拒绝：工具返回错误，模型不得换路子绕过（系统提示里写死了）。
4. 宿主没有 `userQuestions` 服务时按**关闭**处理（fail-closed）。

`/video` 命令只显示当前状态；改阀门走弹窗，或下面那个独立窗口。

## 阀门窗口（独立小程序）

双击 **`启动阀门.cmd`**（或桌面快捷方式）打开一个小窗口，勾选通道即时生效——它直接写 `state.json`，
插件每次读取前都会重读，**不用重启 DSH**。

- 关窗口 = 收起：装了托盘支持就缩到右下角，没装就最小化到任务栏
- 托盘支持可选：跑一次 **`安装托盘支持.cmd`**（pystray + Pillow 装进 `gui/_vendor`，不动系统 Python）
- 窗口里能看到「登录态：已保存/未保存」，带 **粘贴登录态** 和 **退出登录** 两个按钮

> 它和「启用读取视频插件」不是同一层：窗口管**通道**（持久），唤醒管**本会话是否允许读视频**（内存）。
> 两层都过才读——所以顺序是：先唤醒，再用窗口决定放不放 B 站。

## 状态与审计

- 状态：`%USERPROFILE%\.dsh\video-gate\state.json`
- 审计：`%USERPROFILE%\.dsh\video-gate\audit.jsonl`（每次放行/拒绝/读取一行 JSON）
- 缓存：`%USERPROFILE%\.dsh\video-gate\cache\`

## 硬约束（代码里写死）

- 只允许 http/https 的公开 GET，**没有任何 POST**；
- 目标域名限定在 B 站 + 本地文件，其他域名直接拒绝；
- 拒绝内网/回环地址（SSRF）；
- 不读浏览器 cookie、不读注册表、不装 Python 包（登录态只来自你自己放的那个文件）；
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
