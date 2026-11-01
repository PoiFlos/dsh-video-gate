/**
 * 来源分类：只认五个通道，其余一律拒绝（fail-closed）。
 * 这一层是“阀门”的第一道闸：任何 URL 都必须先落到某个通道上才可能被读取。
 */

import { fileURLToPath } from 'node:url'

const HOSTS = [
  { channel: 'bilibili', match: (h) => h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h === 'bili2233.cn' },
]

function isPrivate(host) {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '0.0.0.0' || h === '[::1]' || h === '::1') return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(h)) return true
  return false
}

/**
 * @returns {{channel: string, url?: string, path?: string} | {error: string}}
 */
export function classify(source) {
  const s = String(source ?? '').trim()
  if (!s) return { error: 'source 为空' }

  if (/^file:\/\//i.test(s)) {
    try {
      return { channel: 'local', path: fileURLToPath(s) }
    } catch {
      return { error: `file:// 路径解析失败：${s}` }
    }
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u
    try {
      u = new URL(s)
    } catch {
      return { error: `URL 解析失败：${s}` }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: `只允许 http/https，收到 ${u.protocol}` }
    }
    const host = u.hostname.toLowerCase()
    if (isPrivate(host)) return { error: `拒绝访问内网或回环地址：${host}` }
    const hit = HOSTS.find((x) => x.match(host))
    if (!hit) return { error: `不属于已支持的通道：${host}（只支持 Bilibili 链接和本地文件）` }
    return { channel: hit.channel, url: s }
  }

  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/') || s.startsWith('./') || s.startsWith('.\\')) {
    return { channel: 'local', path: s }
  }
  return { channel: 'local', path: s }
}
