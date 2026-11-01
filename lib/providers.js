/**
 * 通道的读取实现。
 *
 * 硬约束（代码里写死，不靠自觉）：
 *  - 只允许 http/https 的公开 GET；不接受任何 POST；
 *  - 目标域名已在 classify.js 里限定，本文件不再扩展白名单；
 *  - 不读浏览器 cookie、不读注册表、不写系统目录；
 *  - 所有落盘文件都在 stateDir 的 cache 子目录里；
 *  - 子进程只用 argv 列表（无 shell），并带超时；
 *  - ASR 用本地 whisper-cli，音频不出机器。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { stateDir, loadState } from './state.js'

const run = promisify(execFile)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const BILI_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
}

/**
 * 登录态（可选）：用户自己把 SESSDATA 写进 <stateDir>/bilibili.cookie，
 * 插件只在 **B 站域名** 上带这个 Cookie，不记日志、不发别处。
 * 现在只有 4 个域名会被判定为 B 站；其他一律不加。
 */
const BILI_DOMAINS = ['bilibili.com', 'bili2233.cn', 'bilivideo.com', 'hdslb.com']
let sessionCookie = ''

export function cookiePath(config = {}) {
  return path.join(stateDir(config), 'bilibili.cookie')
}

export async function readSessionCookie(config = {}) {
  try {
    const raw = (await readFile(cookiePath(config), 'utf8')).trim()
    if (!raw) return ''
    let value = raw
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        value = String(parsed.SESSDATA || parsed.sessdata || '')
      } catch {
        return ''
      }
    } else if (/^SESSDATA\s*=/i.test(raw)) {
      value = raw.slice(raw.indexOf('=') + 1)
    }
    value = value.trim().replace(/^["']|["']$/g, '')
    if (value.length < 8 || value.length > 4096) return ''
    if (/[\r\n;]/.test(value)) return ''
    return value
  } catch {
    return ''
  }
}

function isBiliUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return BILI_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function headersFor(url, extra) {
  const headers = { ...BILI_HEADERS, ...(extra || {}) }
  if (sessionCookie && isBiliUrl(url)) headers.Cookie = `SESSDATA=${sessionCookie}`
  return headers
}

// ------------------------------------------------------------------ 基础工具

export function fmt(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function withTimeout(ms) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  return { signal: ac.signal, done: () => clearTimeout(timer) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson(url, timeoutMs = 20000) {
  const t = withTimeout(timeoutMs)
  try {
    const res = await fetch(url, { headers: headersFor(url), signal: t.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}（${new URL(url).host}）`)
    return await res.json()
  } finally {
    t.done()
  }
}

async function getBytes(url, timeoutMs = 60000, maxBytes = 40 * 1024 * 1024) {
  const t = withTimeout(timeoutMs)
  try {
    const res = await fetch(url, { headers: headersFor(url), signal: t.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}（${new URL(url).host}）`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes) throw new Error(`响应过大（${Math.round(len / 1e6)}MB > ${Math.round(maxBytes / 1e6)}MB 上限）`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error(`响应过大（${Math.round(buf.length / 1e6)}MB 超过上限）`)
    return buf
  } finally {
    t.done()
  }
}

async function hasCmd(cmd, args = ['-version']) {
  try {
    await run(cmd, args, { timeout: 8000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------- Python / 裁剪

let pythonCache
async function findPython(config) {
  if (pythonCache !== undefined) return pythonCache
  const cands = []
  if (typeof config.pythonPath === 'string' && config.pythonPath.trim()) cands.push(config.pythonPath.trim())
  cands.push(process.platform === 'win32' ? 'python' : 'python3')
  try {
    const base = path.join(homedir(), '.dsh', 'dsh-runtimes')
    for (const name of await readdir(base)) {
      const p = path.join(base, name, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
      if (existsSync(p)) cands.push(p)
    }
  } catch {
    /* 没有运行时目录就跳过 */
  }
  for (const cand of cands) {
    try {
      await run(cand, ['-c', 'import PIL'], { timeout: 10000, windowsHide: true })
      pythonCache = cand
      return cand
    } catch {
      /* 换下一个 */
    }
  }
  pythonCache = null
  return null
}

export async function cropSheet(config, sheetPath, outDir, grid, pairs) {
  const python = await findPython(config)
  if (!python) return { ok: false, error: '找不到带 Pillow 的 Python（无法裁剪分镜图）' }
  const script = path.join(config.pluginDir || '.', 'tools', 'crop.py')
  if (!existsSync(script)) return { ok: false, error: `裁剪脚本缺失：${script}` }
  const args = [script, sheetPath, outDir, String(grid.w), String(grid.h), String(grid.cols), String(grid.rows), ...pairs]
  try {
    const { stdout } = await run(python, args, { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    const parsed = JSON.parse(String(stdout).trim().split(/\r?\n/).pop() || '{}')
    return parsed
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

// ---------------------------------------------------------------- Bilibili

function bvidOf(url) {
  const m = /BV[0-9A-Za-z]{10}/.exec(url)
  if (m) return m[0]
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean)
    if (u.hostname === 'b23.tv' && seg.length) return `short:${seg[0]}`
  } catch {
    /* ignore */
  }
  return null
}

function defaultTimes(duration, count) {
  const d = Math.max(1, Number(duration) || 1)
  const n = Math.max(1, Math.min(count, 8))
  const out = []
  for (let i = 0; i < n; i += 1) out.push(Math.min(d - 1, Math.round((d * (i + 0.5)) / n)))
  return out
}

export async function readBilibili(config, url, opts = {}) {
  const lines = []
  let bvid = bvidOf(url)
  // 每次读取都重读登录态：用户刚放好/删掉 cookie 时立刻生效
  sessionCookie = await readSessionCookie(config)
  if (sessionCookie) lines.push('（已带登录态：只用在本机的 B 站请求上）')

  if (bvid && bvid.startsWith('short:')) {
    const code = bvid.slice(6)
    try {
      const res = await fetch(`https://b23.tv/${code}`, { headers: BILI_HEADERS, redirect: 'manual' })
      const loc = res.headers.get('location') || ''
      const m = /BV[0-9A-Za-z]{10}/.exec(loc)
      if (m) bvid = m[0]
    } catch {
      /* 落到下面的报错 */
    }
  }
  if (!bvid || bvid.startsWith('short:')) throw new Error('不是可识别的 B 站视频链接（需要包含 BV 号）')

  // 元信息是“尽力而为”：B 站的 view 接口有风控（HTTP 412），拿不到不该拖垮抽帧。
  let d = {}
  let metaNote = ''
  try {
    const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
    if (view.code === 0) d = view.data || {}
    else metaNote = `view ${view.code}：${view.message || ''}`
  } catch (err) {
    metaNote = String(err?.message || err)
  }

  let cid = d.cid || d.pages?.[0]?.cid
  if (!cid || !d.duration) {
    try {
      const pl = await getJson(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`)
      const first = pl?.data?.[0]
      if (!cid) cid = first?.cid
      // view 接口被风控（412）时，时长只能从这里补——没有时长就分不出帧
      if (!Number(d.duration) && Number(first?.duration)) d.duration = Number(first.duration)
    } catch {
      /* 下面统一报错 */
    }
  }
  if (!cid) throw new Error(`取不到 cid（元信息接口：${metaNote || '无响应'}）`)

  lines.push(`【${d.title || bvid}】`)
  if (d.duration) lines.push(`UP：${d.owner?.name || '未知'}｜时长：${fmt(d.duration)}｜BV：${bvid}｜cid：${cid}`)
  else lines.push(`BV：${bvid}｜cid：${cid}（元信息降级：${metaNote || '接口无响应'}）`)

  // 字幕轨（公开 CC 字幕 / 登录后的 AI 字幕）
  // 实测：B 站的 AI 字幕对象是按 aid 存的，但接口前几次可能把**别的视频**的对象递给你
  // （有时甚至没有 track）。等本视频的字幕生成/缓存好之后，同一个请求就稳定返回正确的那份。
  // 所以策略是：先看本地缓存 → 没有就重试 + 校验 → 成功后写缓存。
  const hasSession = Boolean(sessionCookie)
  const cacheFile = path.join(stateDir(config), 'cache', bvid, 'subtitle.json')
  let subtitleText = ''
  try {
    let accepted = null
    let lastReason = ''
    let sawLoginPrompt = false

    // ① 本地缓存（同一支视频读过一次就不再碰接口）
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
      const items = Array.isArray(cached?.items) ? cached.items : []
      if (items.length) {
        const lastAt = Number(items[items.length - 1]?.to) || Number(items[items.length - 1]?.from) || 0
        const verdict = subtitleMatches({
          title: d.title,
          owner: d.owner?.name,
          text: items.map((x) => x.content).join(' '),
          lastAt,
          duration: Number(d.duration) || 0,
        })
        if (verdict.ok) accepted = { items, label: cached.label || '中文', attempt: 0, cached: true }
      }
    } catch {
      /* 没有缓存 */
    }

    // ② 接口：重试 + 校验
    for (let attempt = 0; attempt < 8 && !accepted; attempt += 1) {
      if (attempt > 0) await sleep(400)
      const p = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`)
      if (attempt === 0 && p?.data?.need_login_subtitle === true) sawLoginPrompt = true
      const tracks = p?.data?.subtitle?.subtitles || []
      if (!tracks.length) break
      const rel = tracks[0].subtitle_url || ''
      const abs = rel.startsWith('//') ? `https:${rel}` : rel
      if (!abs) continue
      const body = await getJson(abs, 30000)
      const all = Array.isArray(body?.body) ? body.body : []
      const items = all.slice(0, 300)
      if (!items.length) {
        lastReason = '字幕是空的'
        continue
      }
      const duration = Number(d.duration) || 0
      const lastAt = Number(all[all.length - 1]?.to) || Number(all[all.length - 1]?.from) || 0
      const verdict = subtitleMatches({
        title: d.title,
        owner: d.owner?.name,
        text: items.map((x) => x.content).join(' '),
        lastAt,
        duration,
      })
      if (verdict.ok) {
        accepted = { items, label: tracks[0].lan_doc || tracks[0].lan || '有', attempt: attempt + 1 }
      } else {
        lastReason = verdict.reasons.join('；')
      }
    }

    if (accepted) {
      subtitleText = accepted.items.map((x) => `[${fmt(x.from)}] ${x.content}`).join('\n')
      const how = accepted.cached
        ? '本地缓存'
        : accepted.attempt > 1
          ? `第 ${accepted.attempt} 次才取到`
          : '一次取到'
      lines.push(`字幕轨：${accepted.label}，${accepted.items.length} 行（${how}，已内联在下方）`)
      if (!accepted.cached) {
        try {
          await mkdir(path.dirname(cacheFile), { recursive: true })
          await writeFile(
            cacheFile,
            JSON.stringify({ bvid, savedAt: new Date().toISOString(), label: accepted.label, items: accepted.items }),
            'utf8',
          )
        } catch {
          /* 缓存写失败不影响本次结果 */
        }
      }
      if (hasSession) {
        lines.push('（这次用到了本地保存的登录态。看完如果不需要了，说「退出 B 站登录」，我会删掉 bilibili.cookie）')
      }
    } else if (sawLoginPrompt && !hasSession) {
      lines.push('字幕轨：**需要登录**才能取（B 站 AI 字幕）。')
      lines.push('想拿到完整台词：跟我说「登录 B 站」，我会打开登录页并告诉你怎么把 SESSDATA 放到本地文件；')
      lines.push('放好之后我重新读一次，这次就会带上字幕。')
    } else if (lastReason) {
      lines.push(`字幕轨：没取到可用字幕（试了 8 次都不对：${lastReason}）。`)
      lines.push('B 站这个入口在字幕生成好之前会把**别的视频**的字幕递过来；为保证不给你错内容，这里宁可空着。')
      lines.push('等一会儿（或先在网页上放一下这条视频）再说「再读一次」；要准确台词也可以走本地 ASR。')
    } else {
      lines.push('字幕轨：无（这个视频确实没有字幕轨）。')
    }
  } catch (err) {
    lines.push(`字幕轨：读取失败（${String(err?.message || err)}）`)
  }

  // 分镜图：每 5 秒一格，不需要下载视频本体
  const images = []
  try {
    const sb = await getJson(`https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=1`, 30000)
    const data = sb?.data
    if (sb?.code === 0 && Array.isArray(data?.image) && data.image.length) {
      const grid = {
        cols: Number(data.img_x_len) || 10,
        rows: Number(data.img_y_len) || 10,
        w: Number(data.img_x_size) || 480,
        h: Number(data.img_y_size) || 270,
      }
      const perSheet = grid.cols * grid.rows
      const idx = Array.isArray(data.index) ? data.index : []
      const duration = Number(d.duration) || (idx.length ? idx[idx.length - 1] + 5 : 0)
      const total = idx.length || Math.max(1, Math.round(duration / 5) + 1)
      const count = Math.max(1, Math.min(opts.maxFrames || 6, 8))
      let times
      if (opts.at && opts.at.length) times = opts.at.slice(0, 8)
      else if (idx.length) {
        times = Array.from({ length: count }, (_, i) =>
          idx[Math.min(idx.length - 1, Math.round(((i + 0.5) * idx.length) / count))],
        )
      } else times = defaultTimes(duration, count)

      const cacheDir = path.join(stateDir(config), 'cache', bvid)
      await mkdir(cacheDir, { recursive: true })

      const bySheet = new Map()
      const seen = new Set()
      for (const t of times) {
        let tile
        if (idx.length) {
          let best = 0
          for (let i = 0; i < idx.length; i += 1) if (Math.abs(idx[i] - t) < Math.abs(idx[best] - t)) best = i
          tile = best
        } else {
          tile = Math.min(total - 1, Math.max(0, Math.round(t / 5) + 1))
        }
        const sheetNo = Math.floor(tile / perSheet)
        const local = tile % perSheet
        const col = local % grid.cols
        const row = Math.floor(local / grid.cols)
        const key = `${sheetNo}:${col}:${row}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!bySheet.has(sheetNo)) bySheet.set(sheetNo, [])
        bySheet.get(sheetNo).push({ t, col, row })
      }

      const cropped = []
      for (const [sheetNo, list] of bySheet) {
        const rel = data.image[sheetNo] || data.image[0]
        const sheetUrl = rel.startsWith('//') ? `https:${rel}` : rel
        const sheetPath = path.join(cacheDir, `sheet-${sheetNo}.jpg`)
        if (!existsSync(sheetPath)) {
          const bytes = await getBytes(sheetUrl, 60000, 30 * 1024 * 1024)
          await writeFile(sheetPath, bytes)
        }
        const pairs = list.map((x) => `${x.col},${x.row}`)
        const outDir = path.join(cacheDir, `frames-${sheetNo}-${Date.now()}`)
        const res = await cropSheet(config, sheetPath, outDir, grid, pairs)
        if (!res?.ok) {
          lines.push(`分镜图：已下载但裁剪失败（${res?.error || '未知原因'}）`)
          continue
        }
        (res.files || []).forEach((file, i) => {
          const at = list[i]?.t ?? 0
          cropped.push({ path: file, name: `bili-${bvid}-${Math.round(at)}s.png`, at })
        })
      }
      cropped.sort((a, b) => a.at - b.at)
      images.push(...cropped)
      lines.push(`分镜帧：${images.length} 张（每格 5 秒，烧录字幕可直接读）`)
    } else {
      lines.push('分镜图：该视频没有（可能太新或太短）')
    }
  } catch (err) {
    lines.push(`分镜图：读取失败（${String(err?.message || err)}）`)
  }

  if (subtitleText) lines.push('', '—— 字幕 ——', subtitleText.slice(0, 6000))

  if (opts.transcribe && !subtitleText) {
    try {
      const audioUrl = await bilibiliAudioUrl(bvid, cid)
      const audioFile = await downloadAudio(config, audioUrl, bvid)
      const asr = await transcribeMedia(config, audioFile, { maxSeconds: opts.maxAsrSeconds, timeoutMs: opts.asrTimeoutMs })
      lines.push('', '—— 本地 ASR ——', asr.text)
    } catch (err) {
      lines.push('', `本地 ASR 没跑起来：${String(err?.message || err)}`)
    }
  } else if (!images.length && !subtitleText) {
    lines.push('', '这个视频没有公开字幕，也没取到分镜图；需要台词时用 transcribe=true 走本地 ASR。')
  }

  return { text: lines.join('\n'), images }
}

// ------------------------------------------------------------------- 本地

async function effectiveRoots(config) {
  const state = await loadState(config)
  const fromState = Array.isArray(state.localRoots) ? state.localRoots : []
  const fromConfig = Array.isArray(config.localRoots) ? config.localRoots.filter((x) => typeof x === 'string' && x.trim()) : []
  const all = [...new Set([...fromConfig, ...fromState].map((r) => path.resolve(r)))]
  if (all.length) return all
  return [process.cwd(), path.join(homedir(), 'Videos')]
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 找 ffmpeg：config.ffmpegPath → 环境变量 → 插件旁的 tools/ffmpeg/ffmpeg.exe → PATH。
 * 只用绝对路径调用，不依赖用户改 PATH。
 */
let ffmpegCache
export async function resolveFfmpeg(config = {}) {
  if (ffmpegCache) return ffmpegCache
  const cands = []
  if (typeof config.ffmpegPath === 'string' && config.ffmpegPath.trim()) cands.push(config.ffmpegPath.trim())
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH)
  if (config.pluginDir) {
    cands.push(path.join(config.pluginDir, '..', 'tools', 'ffmpeg', 'ffmpeg.exe'))
    cands.push(path.join(config.pluginDir, '..', '..', 'tools', 'ffmpeg', 'ffmpeg.exe'))
  }
  cands.push('ffmpeg')
  for (const cand of cands) {
    try {
      await run(cand, ['-version'], { timeout: 10000, windowsHide: true })
      ffmpegCache = cand
      return cand
    } catch {
      /* 换下一个 */
    }
  }
  ffmpegCache = null
  return null
}

/**
 * 判断一条字幕是不是真的属于这个视频。
 * 两道独立检查，任一不过就不认：
 *  1) 时长：字幕最后一句不能明显超出视频时长；
 *  2) 内容：标题/UP 名里的词，至少要在字幕里出现一次（中文按二字滑窗切）。
 * B 站这个 AI 字幕入口实测会返回「别的视频」的字幕，所以必须验证，不能拿来就用。
 */
function subtitleMatches({ title, owner, text, lastAt, duration }) {
  const reasons = []
  if (duration > 0) {
    // 字幕必须覆盖到大半段视频：太短的多半是别的视频里的一个小片段
    if (lastAt > duration + 15) reasons.push(`字幕到 ${fmt(lastAt)}，视频只有 ${fmt(duration)}`)
    else if (lastAt < duration * 0.6) reasons.push(`字幕只覆盖到 ${fmt(lastAt)}，视频有 ${fmt(duration)}`)
  }
  const tokens = new Set()
  for (const source of [title, owner]) {
    for (const chunk of String(source || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (chunk.length < 2) continue
      if (/^[\x00-\x7f]+$/.test(chunk)) {
        tokens.add(chunk)
      } else {
        for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2))
      }
    }
  }
  const haystack = String(text || '').toLowerCase()
  let hits = 0
  for (const token of tokens) if (token.length >= 2 && haystack.includes(token)) hits += 1
  if (tokens.size > 0 && hits === 0) reasons.push('标题/UP 名里的词一个都没出现在字幕里')
  return { ok: reasons.length === 0, reasons, hits, tokens: tokens.size }
}
async function probeDuration(ffmpeg, abs) {
  if (await hasCmd('ffprobe', ['-version'])) {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs], {
        timeout: 20000,
        windowsHide: true,
      })
      const value = Number(String(stdout).trim())
      if (value > 0) return value
    } catch {
      /* 落到 ffmpeg 解析 */
    }
  }
  const parse = (text) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
  }
  try {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', abs], { timeout: 20000, windowsHide: true })
    return parse(stderr)
  } catch (err) {
    return parse(err?.stderr)
  }
}

export async function readLocal(config, filePath, opts = {}) {
  const abs = path.resolve(filePath)
  const info = await stat(abs).catch(() => null)
  if (!info || !info.isFile()) throw new Error(`本地文件不存在：${abs}`)

  const roots = await effectiveRoots(config)
  if (!roots.some((r) => isInside(r, abs))) {
    throw new Error(
      `路径不在允许的本地根目录内：${abs}\n允许的根：${roots.join('；')}\n（在 state.json 的 localRoots 里加目录后重试）`,
    )
  }
  if (info.size > 8 * 1024 * 1024 * 1024) throw new Error(`文件过大：${(info.size / 1e9).toFixed(1)}GB`)

  const lines = [`本地文件：${abs}（${(info.size / 1e6).toFixed(1)}MB）`]
  const ffmpeg = await resolveFfmpeg(config)
  if (!ffmpeg) {
    lines.push('', '⛔ 本地通道已开，但找不到 ffmpeg，无法抽帧。')
    lines.push('把 ffmpeg 放到 <插件目录>/../tools/ffmpeg/ffmpeg.exe，或在 state.json 里写 ffmpegPath。')
    return { text: lines.join('\n'), images: [] }
  }
  lines.push(`ffmpeg：${ffmpeg}`)

  const duration = await probeDuration(ffmpeg, abs)
  if (duration) lines.push(`时长：${fmt(duration)}`)

  const times = (opts.at && opts.at.length ? opts.at : duration ? defaultTimes(duration, opts.maxFrames || 6) : [0]).slice(0, 8)
  const outDir = path.join(stateDir(config), 'cache', 'local', String(Date.now()))
  await mkdir(outDir, { recursive: true })
  const images = []
  for (const [i, t] of times.entries()) {
    const out = path.join(outDir, `f${String(i).padStart(3, '0')}.png`)
    try {
      await run(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-vf', 'scale=-2:720', '-y', out],
        { timeout: 60000, windowsHide: true },
      )
      if (existsSync(out)) images.push({ path: out, name: `local-${Math.round(t)}s.png`, at: t })
    } catch {
      /* 单帧失败不影响其他帧 */
    }
  }
  lines.push(`抽帧：${images.length} 张`)
  return { text: lines.join('\n'), images }
}

// ------------------------------------------------------------------ 本地 ASR

let whisperCache

/** 找 whisper-cli + ggml 模型；缺一个就返回 null，不报错。 */
export async function resolveWhisper(config = {}) {
  if (whisperCache) return whisperCache
  const root = config.pluginDir ? path.join(config.pluginDir, '..', 'tools', 'whisper') : null
  const clis = []
  if (typeof config.whisperCli === 'string' && config.whisperCli.trim()) clis.push(config.whisperCli.trim())
  if (process.env.WHISPER_CLI) clis.push(process.env.WHISPER_CLI)
  if (root) clis.push(path.join(root, 'whisper-cli.exe'))
  const models = []
  if (typeof config.whisperModel === 'string' && config.whisperModel.trim()) models.push(config.whisperModel.trim())
  if (process.env.WHISPER_MODEL) models.push(process.env.WHISPER_MODEL)
  if (root) {
    models.push(path.join(root, 'models', 'ggml-medium.bin'))
    models.push(path.join(root, 'models', 'ggml-small.bin'))
  }
  const cli = clis.find((p) => existsSync(p))
  const model = models.find((p) => existsSync(p))
  if (!cli || !model) return null
  whisperCache = { cli, model }
  return whisperCache
}

function parseSrt(text) {
  const out = []
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean)
    if (lines.length < 3) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->/.exec(lines[1] || '')
    if (!m) continue
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    const body = lines.slice(2).join(' ').trim()
    if (body) out.push({ at: seconds, text: body })
  }
  return out
}

/**
 * 用本地 whisper.cpp 转写一段媒体文件。
 * 音频先在本地被 ffmpeg 重编码成 16k 单声道 wav（顺带消掉异常封装），再喂给 whisper-cli。
 */
export async function transcribeMedia(config, mediaPath, opts = {}) {
  const ffmpeg = await resolveFfmpeg(config)
  const whisper = await resolveWhisper(config)
  if (!ffmpeg) throw new Error('ASR 需要 ffmpeg（先把音频转成 16kHz wav）')
  if (!whisper) throw new Error('没找到 whisper-cli 或 ggml 模型（放在 tools/whisper/ 下）')

  const maxSeconds = Math.max(30, Number(opts.maxSeconds) || 900)
  const cacheDir = path.join(stateDir(config), 'cache', 'asr', String(Date.now()))
  await mkdir(cacheDir, { recursive: true })
  const wav = path.join(cacheDir, 'audio.wav')

  try {
    await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav],
      { timeout: 300000, windowsHide: true },
    )
    const prefix = path.join(cacheDir, 'out')
    await run(
      whisper.cli,
      ['-m', whisper.model, '-f', wav, '-l', opts.lang || 'zh', '-t', String(Math.min(8, Math.max(2, opts.threads || 4))), '-osrt', '-of', prefix],
      { timeout: Number(opts.timeoutMs) || 900000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    )
    const srt = await readFile(`${prefix}.srt`, 'utf8')
    const segments = parseSrt(srt)
    if (!segments.length) return { text: '（ASR 没有识别出内容）', segments: [] }
    const lines = segments.slice(0, 400).map((s) => `[${fmt(s.at)}] ${s.text}`)
    const head = `本地 ASR（whisper.cpp，模型 ${path.basename(whisper.model)}，最多处理 ${Math.round(maxSeconds / 60)} 分钟）`
    return { text: [head, '', ...lines].join('\n'), segments }
  } finally {
    unlink(wav).catch(() => {})
  }
}

/** B 站：取音频流地址（匿名 64k/132k；失败就如实报错）。 */
export async function bilibiliAudioUrl(bvid, cid) {
  const d = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=0&platform=html5`, 30000)
  if (d?.code !== 0) throw new Error(`playurl ${d?.code}：${d?.message || ''}`)
  const audio = d?.data?.dash?.audio?.[0]
  if (!audio) throw new Error('没有音频流（可能需要登录，或该视频是番剧/付费内容）')
  return audio.baseUrl || audio.base_url || audio.backupUrl?.[0] || audio.backup_url?.[0]
}

/** 把远程音频抓下来（只走 GET，带 B 站 Referer）。 */
export async function downloadAudio(config, url, bvid) {
  const dir = path.join(stateDir(config), 'cache', 'audio', bvid)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'audio.m4s')
  if (!existsSync(file)) {
    const bytes = await getBytes(url, 120000, 200 * 1024 * 1024)
    await writeFile(file, bytes)
  }
  return file
}
