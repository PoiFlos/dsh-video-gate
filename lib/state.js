/**
 * 通道状态：默认只开本地，Bilibili 站点通道默认关闭。
 * 状态存在 <home>/.dsh/video-gate/state.json，用户随时可以打开看、改、删。
 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const CHANNELS = ['local', 'bilibili']

export const LABELS = {
  local: '本地文件',
  bilibili: 'Bilibili',
}

const DEFAULTS = {
  version: 1,
  channels: { local: true, bilibili: false },
  localRoots: [],
  auditLog: true,
}

export function stateDir(config = {}) {
  const custom = typeof config.stateDir === 'string' ? config.stateDir.trim() : ''
  return custom || path.join(homedir(), '.dsh', 'video-gate')
}

export function stateFile(config = {}) {
  return path.join(stateDir(config), 'state.json')
}

function normalize(raw) {
  const out = {
    version: 1,
    channels: { ...DEFAULTS.channels },
    localRoots: [],
    auditLog: true,
  }
  if (raw && typeof raw === 'object') {
    const ch = raw.channels
    if (ch && typeof ch === 'object') {
      for (const name of CHANNELS) {
        if (typeof ch[name] === 'boolean') out.channels[name] = ch[name]
      }
    }
    if (Array.isArray(raw.localRoots)) {
      out.localRoots = raw.localRoots.filter((r) => typeof r === 'string' && r.trim()).map((r) => path.resolve(r.trim()))
    }
    if (typeof raw.auditLog === 'boolean') out.auditLog = raw.auditLog
  }
  // local 是唯一允许默认开启的通道；其余通道任何情况下都不从文件里“意外”变成开
  return out
}

export async function loadState(config = {}) {
  try {
    const text = await readFile(stateFile(config), 'utf8')
    return normalize(JSON.parse(text))
  } catch {
    return normalize(null)
  }
}

export async function saveState(config = {}, state) {
  const dir = stateDir(config)
  await mkdir(dir, { recursive: true })
  const clean = normalize(state)
  await writeFile(stateFile(config), JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}

/** 审计日志：每次联网/读取一行 JSON，用户可以直接 grep。 */
export async function appendAudit(config = {}, record) {
  try {
    const dir = stateDir(config)
    await mkdir(dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'
    await appendFile(path.join(dir, 'audit.jsonl'), line, 'utf8')
  } catch {
    /* 审计写失败不阻断功能，但也不会静默改状态 */
  }
}
