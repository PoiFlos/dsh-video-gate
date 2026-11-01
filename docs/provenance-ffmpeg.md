# ffmpeg 的来历（可核对）

这里只有一个文件：`ffmpeg.exe`。没有安装器、没有写注册表、没有改 PATH、没有后台服务。

## 为什么是这个来源

原计划是从 gyan.dev 或 GitHub Releases 下 BtbN 的官方包，但**直连 github.com 与 gyan.dev 经常超时**，
而 PyPI 可达。于是改用 PyPI 上 `imageio-ffmpeg` 0.7.0 的 Windows wheel：
它把 **gyan.dev 的 essentials build** 原样打进了包里，因此仍能拿到同一份二进制，并且**下载有官方 sha256 可对**。

二进制自己报告的版本：

```
ffmpeg version 7.1-essentials_build-www.gyan.dev
configuration: --enable-gpl --enable-version3 --enable-static ... --enable-libx264 --enable-libx265 ...
```

## 校验链

| 对象 | 值 |
|---|---|
| wheel | `imageio_ffmpeg-0.7.0-py3-none-win_amd64.whl`（31,247,004 字节） |
| wheel sha256（PyPI 官方 digest） | `7a22b45f60321d4172bdf2bc61f716bce4c81b85727bd59c7c7e371055a6a440` |
| 下载镜像 | `https://mirrors.aliyun.com/pypi/`（官方源直连很慢，镜像快一个量级） |
| 安装后 `ffmpeg.exe` sha256 | `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3` |
| 大小 | 87,638,016 字节 |

复核方式：

```powershell
(Get-FileHash <工作区>\tools\ffmpeg\ffmpeg.exe -Algorithm SHA256).Hash
<工作区>\tools\ffmpeg\ffmpeg.exe -version
```

## 许可

FFmpeg 本体是 LGPL/GPL（这个 build 开了 `--enable-gpl`，所以是 **GPL**），`imageio-ffmpeg` 是 BSD-2-Clause。
本地自用不涉及分发；如果把整个 `tools/` 目录打包给别人，需要一并遵守 GPL 的源码提供要求。

## 怎么被调用

插件按这个顺序找二进制，**只用绝对路径**，不依赖 PATH：

1. `state.json` 里的 `ffmpegPath`
2. 环境变量 `FFMPEG_PATH`
3. `<工作区>\tools\ffmpeg\ffmpeg.exe`（本文件所在位置）
4. PATH 上的 `ffmpeg`

调用参数固定为 `-hide_banner -loglevel error -ss <秒> -i <文件> -frames:v 1 -vf scale=-2:720 -y <输出>`，
带 60 秒超时，单帧失败不影响其他帧；文件大小超过 8GB 直接拒绝。

## 没有 ffprobe

`imageio-ffmpeg` 只打包了 `ffmpeg.exe`，没有 `ffprobe.exe`。插件因此改成从
`ffmpeg -i` 的 stderr 里解析 `Duration:`，少一个二进制就少一份攻击面。
