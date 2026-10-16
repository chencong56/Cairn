import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 老系统保存页面（mhtml）快照：运行时从目录读取，拆成「主页面 / iframe / 样式 / 图片 / 字体」，
 * 全部改写成 /legacy/<序号>/ 下的本地地址，并去掉脚本（保存下来的就是渲染后的静态 DOM，不再回连原系统）。
 * 页面里可能有真实业务数据与登录令牌：目录默认指向被忽略的 tmp/，内容不进仓库，也只在登录门户后可访问。
 * 目录不存在时整块功能关闭。
 */
const here = dirname(fileURLToPath(import.meta.url))
export const LEGACY_DIR = resolve(process.env.PORTAL_LEGACY_DIR ?? join(here, '..', '..', 'tmp', '铁塔页面20261007'))

function decodeBody(headers, raw) {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (enc === 'base64') return Buffer.from(raw.replace(/\s+/g, ''), 'base64')
  if (enc === 'quoted-printable') {
    const bytes = []
    const text = raw.replace(/=\r?\n/g, '')
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
        i += 2
      } else bytes.push(...Buffer.from(text[i], 'latin1'))
    }
    return Buffer.from(bytes)
  }
  return Buffer.from(raw, 'latin1')
}

function parseHeaders(block) {
  const headers = {}
  let last = ''
  for (const line of block.split(/\r?\n/)) {
    if (/^\s/.test(line) && last) headers[last] += ` ${line.trim()}`
    else {
      const i = line.indexOf(':')
      if (i > 0) {
        last = line.slice(0, i).trim().toLowerCase()
        headers[last] = line.slice(i + 1).trim()
      }
    }
  }
  return headers
}

/** 解析 mhtml：返回各部分 { type, charset, location, cid, body }。 */
export function parseMhtml(buffer) {
  const text = buffer.toString('latin1')
  const headEnd = text.search(/\r?\n\r?\n/)
  const top = parseHeaders(text.slice(0, headEnd))
  const boundary = /boundary="?([^";\s]+)"?/i.exec(top['content-type'] ?? '')?.[1]
  if (!boundary) return []
  const parts = []
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break
    const cut = chunk.search(/\r?\n\r?\n/)
    if (cut < 0) continue
    const headers = parseHeaders(chunk.slice(0, cut).replace(/^\r?\n/, ''))
    const ct = headers['content-type'] ?? 'application/octet-stream'
    parts.push({
      type: ct.split(';')[0].trim().toLowerCase(),
      charset: /charset="?([^";\s]+)"?/i.exec(ct)?.[1] ?? 'utf-8',
      location: headers['content-location'] ?? '',
      cid: (headers['content-id'] ?? '').replace(/^<|>$/g, ''),
      body: decodeBody(headers, chunk.slice(cut).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '')),
    })
  }
  return parts
}

const textOf = (part) => new TextDecoder(part.charset).decode(part.body)

/** 把文本里能对上本快照资源的地址（绝对 / 相对 / cid:）换成本地路径；其余原样保留。 */
function rewrite(text, base, lookup) {
  const local = (value) => {
    const raw = value.replace(/&amp;/g, '&').trim()
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('javascript:')) return null
    if (raw.startsWith('cid:')) return lookup.get(raw.slice(4)) ?? lookup.get(raw) ?? null
    try {
      const url = new URL(raw, base || 'http://snapshot.invalid/').href
      return lookup.get(url) ?? lookup.get(url.split('#')[0]) ?? null
    } catch {
      return null
    }
  }
  return text
    .replace(/\b(src|href|poster|data-src)=("([^"]*)"|'([^']*)')/gi, (all, attr, q, a, b) => {
      const hit = local(a ?? b ?? '')
      return hit ? `${attr}="${hit}"` : all
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, v) => {
      const hit = local(v)
      return hit ? `url("${hit}")` : all
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (all, q, v) => {
      const hit = local(v)
      return hit ? `@import "${hit}"` : all
    })
}

const stripScripts = (html) =>
  html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, '')
    .replace(/<link[^>]+rel=["']?(?:preload|prefetch|dns-prefetch|modulepreload)[^>]*>/gi, '')

/** 读目录里的全部快照。返回 [{ id, name, parts, main, lookup }]。 */
export function loadSnapshots(dir = LEGACY_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mhtml'))
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((file, index) => {
      const parts = parseMhtml(readFileSync(join(dir, file)))
      const id = String(index)
      const lookup = new Map()
      parts.forEach((p, i) => {
        const path = `/legacy/${id}/r/${i}`
        if (p.location) {
          lookup.set(p.location, path)
          lookup.set(p.location.split('#')[0], path)
        }
        if (p.cid) {
          lookup.set(p.cid, path)
          lookup.set(`cid:${p.cid}`, path)
        }
      })
      const mainIndex = parts.findIndex((p) => p.type === 'text/html')
      return { id, name: file.replace(/\.mhtml$/i, ''), parts, mainIndex, lookup }
    })
    .filter((s) => s.mainIndex >= 0)
}

export function serveLegacy(snapshots, pathname) {
  if (snapshots.length === 0) {
    return { status: 404, type: 'text/html; charset=utf-8', body: '<p>没有找到老系统页面快照目录（PORTAL_LEGACY_DIR）。</p>' }
  }
  if (pathname === '/legacy' || pathname === '/legacy/') {
    const items = snapshots.map((s) => `<li><a class="legacy-link" href="/legacy/${s.id}/">${s.name}</a></li>`).join('')
    return { status: 200, type: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>老系统页面快照</title><h1>老系统页面快照</h1><p>来自保存的页面，已去掉脚本，仅用于读取与断言联调。</p><ul id="legacy-list">${items}</ul><p><a href="/eip/index">返回首页</a></p>` }
  }
  const m = /^\/legacy\/(\d+)\/(?:r\/(\d+))?$/.exec(pathname)
  const snap = m && snapshots.find((s) => s.id === m[1])
  if (!snap) return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' }
  const index = m[2] === undefined ? snap.mainIndex : Number(m[2])
  const part = snap.parts[index]
  if (!part) return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' }
  if (part.type === 'text/html') {
    return { status: 200, type: 'text/html; charset=utf-8', body: Buffer.from(rewrite(stripScripts(textOf(part)), part.location, snap.lookup)) }
  }
  if (part.type === 'text/css') {
    return { status: 200, type: 'text/css; charset=utf-8', body: Buffer.from(rewrite(textOf(part), part.location, snap.lookup)) }
  }
  if (part.type.includes('javascript')) return { status: 200, type: 'text/plain; charset=utf-8', body: '' }
  return { status: 200, type: part.type, body: part.body }
}
