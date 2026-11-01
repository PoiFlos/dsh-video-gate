# 给 AI Agent 的安装说明（AGENTS.md）

**平台：Windows 10/11。** 只用 PowerShell；`install-deps.ps1` 与阀门窗口都是 Windows 专用。
macOS / Linux 目前没有适配（B 站读取那段是纯 JS，理论上能跑，但没有验证过）。

你是被要求「把这个仓库装到本机 DeepSeek Harness 上」的 AI Agent。照这份文件做，**每一步都能验证**。
遇到需要用户决定的地方，**停下来问一次**，别猜。

> ⚠️ **有一件事你做不到**：你运行在 DSH 进程里，**不能重启它**（重启会杀掉你自己）。
> 第 4 步必须由用户手动做。别假装能重启，也别跳过——不重启插件不会加载。

> 给用户的一句话交接（他们可以直接复制给你）：
> 「克隆 https://github.com/PoiFlos/dsh-video-gate 到本机，按仓库里的 AGENTS.md 装好。装之前先把要做什么、要下载多少东西告诉我，我同意后再动手。」

---

## 0. 先确认环境（不要跳过）

```powershell
$PSVersionTable.PSVersion      # Windows PowerShell 5.1 或 PowerShell 7 都行
node --version                 # 需要 ≥ 20
git --version                  # 没有 git 就下载 zip 解压
```

再确认 DSH 在跑：宿主里应该能调用 `plugin_manager`。**如果拿不到这个工具，就说明当前会话不在 DSH 里**，
直接告诉用户「这一步要在 DeepSeek Harness 里做」，不要瞎装。

---

## 1. 拿代码

```powershell
git clone https://github.com/PoiFlos/dsh-video-gate.git
```

没有 git：下载仓库的 **Code → Download ZIP**，解压到任意目录。记下这个路径，后面叫 `<仓库目录>`。

---

## 2. 装依赖（可选，但要先问用户）

**只有需要读本地视频（抽帧）或本地转写（ASR）时才需要。** 只读 B 站的话可以跳过。

| 依赖 | 体积 | 用途 |
|---|---|---|
| ffmpeg | ~84MB | 抽帧、转 16k 音频 |
| whisper.cpp | ~11MB | 本地语音识别 |
| ggml-small 模型 | ~465MB | 同上（可换 medium，1.46GB） |

**先跑 Plan 给用户看来源和哈希，再问要不要装**：

```powershell
powershell -ExecutionPolicy Bypass -File <仓库目录>\install-deps.ps1 -Plan
```

用户同意后再实跑（**不要**跳过 `-Plan` 直接下 550MB）：

```powershell
powershell -ExecutionPolicy Bypass -File <仓库目录>\install-deps.ps1
```

脚本行为：下载 → 校验 sha256 → 解压到 `<仓库目录>\..\tools\`。**不装服务、不写注册表、不改 PATH、不需要管理员权限**。
已存在且哈希正确的文件会跳过，所以重复跑是安全的。

装完验证：

```powershell
& <仓库目录>\..\tools\ffmpeg\ffmpeg.exe -version
& <仓库目录>\..\tools\whisper\whisper-cli.exe --help
```

---

## 3. 装插件

```
plugin_manager action=install_bundle target=<仓库目录>
```

或者命令行：

```powershell
dsh plugin --profile desktop add <仓库目录>
```

成功标志是返回里 `application: "applied"`。**不要**手工改 profile 的 `package.json` 或 `cordis.patch.yml`。

---

## 4. 重启（必须）

Host 插件在进程启动时加载，**不重启不生效**。告诉用户：「请完全退出 DSH 再打开」。
重启后可以让用户问一句「看一下视频通道状态」，正常会返回：

```
视频通道阀门（只读）

- 本地文件：开
- Bilibili：关

本会话：未启用
登录态：未保存
```

---

## 5. 首次配置（要问用户）

插件只允许读 `localRoots` 列出的目录。**问用户视频放在哪**，然后写
`%USERPROFILE%\.dsh\video-gate\state.json`：

```json
{
  "version": 1,
  "channels": { "local": true, "bilibili": false },
  "localRoots": ["D:\\素材", "C:\\Users\\<用户名>\\Videos"],
  "auditLog": true
}
```

不配的话，本地文件一律被拒（这是安全边界，不是 bug）。

---

## 6. 验收（别只报"装好了"）

1. **状态**：让用户问「看一下视频通道状态」→ 确认两个通道 + 本会话/登录态都在
2. **本地**：`video_read` 读一个 10 秒以内的本地视频，确认返回「抽帧：N 张」和图片
3. **B 站**：让用户发一条 B 站链接 → 应弹出阀门选择框；选「只放行这一次」后应返回标题/时长/分镜帧
4. **唤醒**：新会话里直接 `video_read` 应被拒（提示先说「启用读取视频插件」），说一句后再读应成功

四项里有一项不过，就不要说装好了。

---

## 7. 需要用户拍板的点（逐条问，别合并成一句）

| 时机 | 问什么 |
|---|---|
| 装依赖前 | 要不要装 ffmpeg（84MB）+ whisper（11MB）+ 模型（465MB）？只读 B 站可以跳过 |
| 选模型时 | small（465MB，够用）还是 medium（1.46GB，更准更慢）？ |
| 写配置前 | 视频放在哪个目录？（要写进 `localRoots`） |
| 重启前 | 现在可以重启 DSH 吗？ |
| B 站通道 | 保持默认「每次弹窗确认」，还是长期打开？**默认后者不做** |

---

## 8. 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `plugin_manager` 不可用 | 不在 DSH 会话里 | 让用户在 DSH 里说这句话 |
| 工具列表里没有 `video_read` | 没重启 | 完全退出 DSH 再开 |
| 下载超时 / 直连 github.com 失败 | 网络对 GitHub 不稳 | 脚本已优先走 `api.github.com` 资产端点；PyPI 失败会自动切阿里云镜像 |
| `pythonw` / tkinter 缺失 | 阀门窗口需要 Python 3.10+ | 窗口是可选功能；没有也不影响插件本体 |
| 「路径不在允许的本地根目录内」 | `localRoots` 没配 | 回到第 5 步 |
| 「找不到 ffmpeg」 | 依赖没装或放错位置 | 重跑 `install-deps.ps1`，或写 `state.json` 的 `ffmpegPath` |

---

## 9. 不要做的事

- ❌ 不要读浏览器 cookie、不要 `pip install` 任何东西、不要改 PATH / 注册表 / 装服务
- ❌ 不要把 `tools/`（ffmpeg、模型）提交进仓库——GitHub 单文件上限 100MB，模型有 465MB
- ❌ 不要在用户没同意时下载 550MB
- ❌ 不要绕过阀门：用户拒绝放行就是拒绝，不要改用 `web_fetch` 去抓同一支视频

---

## 10. 装完告诉用户什么

一段话，包含：装在哪、依赖装了哪些多大、怎么唤醒、怎么读、已知限制（B 站 AI 字幕按需生成、
分镜只有 480×270、本地 ASR 最多 15 分钟）、以及怎么卸载：

```
plugin_manager action=remove_bundle target=dsh-video-gate
```
