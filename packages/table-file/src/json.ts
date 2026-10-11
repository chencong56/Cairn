import type { TableColumnSpec, TableNetworkPlan } from '@cairn/shared'
import { makeValueParsers, type ValueField } from './values.js'

/**
 * 接口来源：把页面自己发出的 JSON 接口响应读成记录集。
 *
 * 纯函数、不碰网络：Worker 运行时读取与编写期“选择接口”对话框的结构概览、建议与预览共用同一份。
 * 路径是用点分隔的字段名或数组序号（data.list、series.0.data）。
 */

const values = makeValueParsers()

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function splitJsonPath(path: string): string[] {
  return path.split('.')
}

/** 按路径取值；路径不存在返回 undefined（与 JSON 的 null 区分开）。 */
export function resolveJsonPath(root: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') return root
  let cur: unknown = root
  for (const seg of splitJsonPath(path)) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
      cur = (cur as Record<string, unknown>)[seg]
    } else return undefined
    if (cur === undefined) return undefined
  }
  return cur
}

const isPrimitive = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const join = (base: string, seg: string) => (base ? `${base}.${seg}` : seg)

// ---------------------------------------------------------------------------
// 结构概览（编写期“选择接口”对话框右侧的 JSON 树）
// ---------------------------------------------------------------------------

export type JsonOutlineNode = {
  path: string
  key: string
  depth: number
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  /** 数组的项数。 */
  length?: number
  /** 叶子值的预览（≤ 200 字）。 */
  preview?: string
  /** 对象数组：可“用作数据行”。 */
  rows?: boolean
  /** 基本值数组（≥ 2 项）：可“按下标拼成行”（图表的列式数据）。 */
  series?: boolean
  /** 数字（或像数字的文字）：可“设为总条数”。 */
  numeric?: boolean
}

const PREVIEW_CHARS = 200

function previewOf(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

function typeOf(v: unknown): JsonOutlineNode['type'] {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v === 'object' ? 'object' : (typeof v as 'string' | 'number' | 'boolean')
}

/** JSON 树概览：对象展开全部字段，数组一般只展开第 0 项作样例（图表的 series 列表全部展开）；超过节点上限截断。 */
export function outlineJson(root: unknown, options: { maxNodes?: number; maxDepth?: number } = {}): { nodes: JsonOutlineNode[]; truncated: boolean } {
  const maxNodes = options.maxNodes ?? 400
  const maxDepth = options.maxDepth ?? 8
  const nodes: JsonOutlineNode[] = []
  let truncated = false
  const visit = (v: unknown, path: string, key: string, depth: number) => {
    if (nodes.length >= maxNodes) {
      truncated = true
      return
    }
    const type = typeOf(v)
    const node: JsonOutlineNode = { path, key, depth, type }
    if (Array.isArray(v)) {
      node.length = v.length
      if (v.length > 0 && v.slice(0, 20).every(isPlainObject)) node.rows = true
      if (v.length >= 2 && v.slice(0, 50).every(isPrimitive)) node.series = true
    } else if (!isPlainObject(v)) {
      node.preview = previewOf(v)
      if (typeof v === 'number' || (typeof v === 'string' && values.parseNumber(v, false).ok)) node.numeric = true
    }
    nodes.push(node)
    if (depth >= maxDepth) return
    if (Array.isArray(v)) {
      // 一般只展开第 0 项作样例；元素里还有数组的短数组（图表的 series 列表）全部展开，每条序列都能单独选
      const seriesList = v.length <= 10 && v.some((item) => isPlainObject(item) && Object.values(item).some(Array.isArray))
      const items = node.series ? [] : seriesList ? v : v.slice(0, 1)
      items.forEach((item, i) => visit(item, join(path, String(i)), String(i), depth + 1))
    } else if (isPlainObject(v)) {
      for (const [k, child] of Object.entries(v)) visit(child, join(path, k), k, depth + 1)
    }
  }
  visit(root, '', '', 0)
  return { nodes, truncated }
}

// ---------------------------------------------------------------------------
// 建议：哪个数组最像数据源、列是哪些
// ---------------------------------------------------------------------------

export type JsonTableSuggestion = {
  layout: 'rows' | 'columns'
  rowsPath?: string
  totalPath?: string
  rowCount: number
  columns: Array<Pick<TableColumnSpec, 'key' | 'name' | 'path' | 'valueType' | 'numericKind'>>
  score: number
}

const ROW_ARRAY_NAMES = /^(list|rows|records|items|data|result|results|content|dataList|resultList|recordList)$/i
const TOTAL_NAMES = /^(total|totalCount|total_count|totalRows|totalRecords|totalElements|recordsTotal|count|totalNum|rowCount)$/i

/** 列 key：路径能当标识符就用它（点换成下划线），否则按列序号。 */
function columnKeyOf(path: string, index: number, used: Set<string>): string {
  const base = path.replace(/\./g, '_')
  let key = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(base) ? base : `col_${index + 1}`
  while (used.has(key)) key = `${key}_${index + 1}`.slice(0, 64)
  used.add(key)
  return key
}

/** 按样本值推断列类型：JSON 数字直接算数字；文字走与页面 / 文件相同的推断。 */
function inferJsonType(samples: unknown[]): Pick<TableColumnSpec, 'valueType' | 'numericKind'> {
  const present = samples.filter((v) => v !== null && v !== undefined && v !== '')
  if (present.length === 0) return { valueType: 'text' }
  if (present.every((v) => typeof v === 'number')) {
    return { valueType: 'number', numericKind: present.every((v) => Number.isInteger(v)) ? 'integer' : 'decimal' }
  }
  if (present.every((v) => typeof v === 'boolean')) return { valueType: 'boolean' }
  if (present.every((v) => typeof v === 'string')) {
    const inferred = values.inferType(present as string[])
    return { valueType: inferred.valueType, ...(inferred.numericKind ? { numericKind: inferred.numericKind } : {}) }
  }
  return { valueType: 'text' }
}

/** 对象数组每一项里的基本值字段（含一层嵌套对象，如 region.name），按出现顺序。 */
function leafFieldsOf(items: unknown[]): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p)
      order.push(p)
    }
  }
  for (const item of items.slice(0, 20)) {
    if (!isPlainObject(item)) continue
    for (const [k, v] of Object.entries(item)) {
      if (isPrimitive(v)) add(k)
      else if (isPlainObject(v)) for (const [k2, v2] of Object.entries(v)) if (isPrimitive(v2)) add(`${k}.${k2}`)
    }
  }
  return order.slice(0, 40)
}

function findTotalPath(root: unknown, rowsPath: string, rowCount: number): string | undefined {
  const segs = splitJsonPath(rowsPath)
  for (let n = segs.length - 1; n >= 0; n--) {
    const parentPath = segs.slice(0, n).join('.')
    const parent = resolveJsonPath(root, parentPath || undefined)
    if (!isPlainObject(parent)) continue
    for (const [k, v] of Object.entries(parent)) {
      if (TOTAL_NAMES.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= rowCount) return join(parentPath, k)
    }
  }
  return undefined
}

/** 给出至多 5 个建议，最像数据源的排前面。 */
export function suggestJsonTables(root: unknown): JsonTableSuggestion[] {
  const out: JsonTableSuggestion[] = []
  const primitiveArrays: Array<{ path: string; length: number; name: string; values: unknown[] }> = []
  const visit = (v: unknown, path: string, parent: unknown, depth: number) => {
    if (depth > 8) return
    if (Array.isArray(v)) {
      if (v.length > 0 && v.slice(0, 20).every(isPlainObject)) {
        const fields = leafFieldsOf(v)
        if (fields.length > 0) {
          const used = new Set<string>()
          const columns = fields.map((f, i) => ({
            key: columnKeyOf(f, i, used),
            name: f.slice(0, 64),
            path: f,
            ...inferJsonType(v.slice(0, 50).map((item) => resolveJsonPath(item, f))),
          }))
          const last = splitJsonPath(path).at(-1) ?? ''
          const totalPath = path ? findTotalPath(root, path, v.length) : undefined
          out.push({
            layout: 'rows',
            ...(path ? { rowsPath: path } : {}),
            ...(totalPath ? { totalPath } : {}),
            rowCount: v.length,
            columns,
            score: v.length * Math.min(fields.length, 10) + (ROW_ARRAY_NAMES.test(last) ? 50 : 0) + (totalPath ? 20 : 0),
          })
        }
      } else if (v.length >= 2 && v.slice(0, 50).every(isPrimitive)) {
        // 图表列式数据：series[i].data 的列名取同级的 name
        const segs = splitJsonPath(path)
        const siblingName = isPlainObject(parent) && typeof parent.name === 'string' ? parent.name : undefined
        const name = siblingName ?? [...segs].reverse().find((s) => !/^\d+$/.test(s)) ?? path
        primitiveArrays.push({ path, length: v.length, name: name.slice(0, 64), values: v })
      }
      // rowsPath 必须是“数组本身”，只往对象数组里继续找嵌套数组
      if (v.length > 0 && isPlainObject(v[0])) v.slice(0, 5).forEach((item, i) => visit(item, join(path, String(i)), v, depth + 1))
      return
    }
    if (isPlainObject(v)) for (const [k, child] of Object.entries(v)) visit(child, join(path, k), v, depth + 1)
  }
  visit(root, '', undefined, 0)

  // 等长的基本值数组（≥ 2 个）拼成一张列式表，长度相同的分为一组
  const byLength = new Map<number, typeof primitiveArrays>()
  for (const a of primitiveArrays) byLength.set(a.length, [...(byLength.get(a.length) ?? []), a])
  for (const [length, group] of byLength) {
    if (group.length < 2) continue
    const used = new Set<string>()
    const names = new Set<string>()
    const columns = group.slice(0, 20).map((a, i) => {
      let name = a.name
      if (names.has(name)) name = `${name}（${i + 1}）`.slice(0, 64)
      names.add(name)
      return { key: columnKeyOf(a.path, i, used), name, path: a.path, ...inferJsonType(a.values.slice(0, 50)) }
    })
    out.push({ layout: 'columns', rowCount: length, columns, score: length * columns.length + 10 })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5)
}

// ---------------------------------------------------------------------------
// 按计划读取
// ---------------------------------------------------------------------------

export type JsonTableError = { ok: false; code: string; message: string }
export type JsonTableBody = {
  columns: TableColumnSpec[]
  rows: Array<Record<string, ValueField>>
  rowCount: number
  coverage: {
    requestedScope: 'current_page'
    observedScope: 'current_page'
    status: 'complete' | 'partial'
    reasonCode?: string
    reasonMessage?: string
  }
  pageInfo?: { totalRows: number; rawText: string }
}

function numberText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
}

/** 一个 JSON 值 → 字段（与页面 / 文件的字段口径一致；不写 undefined 属性，结果直接持久化）。 */
export function fieldFromJson(spec: TableColumnSpec, v: unknown): ValueField {
  if (spec.sensitive) return { value: null, status: 'masked' }
  if (v === undefined || v === null) return { value: null, status: 'missing' }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { value: null, rawText: String(v), status: 'error' }
    if (spec.valueType === 'number') return { value: v, decimalValue: numberText(v), status: 'ok' }
    if (spec.valueType === 'text') return { value: numberText(v), status: 'ok' }
    return values.fieldFromText(spec, numberText(v)).field
  }
  if (typeof v === 'boolean') {
    if (spec.valueType === 'boolean') return { value: v, status: 'ok' }
    if (spec.valueType === 'text') return { value: String(v), status: 'ok' }
    return { value: null, rawText: String(v), status: 'error' }
  }
  if (typeof v === 'string') return values.fieldFromText(spec, v.trim()).field
  const raw = JSON.stringify(v)
  return { value: null, rawText: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw, status: 'error' }
}

export function readJsonTable(root: unknown, plan: TableNetworkPlan): { ok: true; body: JsonTableBody } | JsonTableError {
  const max = plan.limits.maxRows
  let rows: Array<Record<string, ValueField>>
  let total: number
  if (plan.layout === 'columns') {
    const arrays = plan.columns.map((col) => ({ col, value: resolveJsonPath(root, col.path) }))
    const missing = arrays.find((a) => a.value === undefined)
    if (missing) return { ok: false, code: 'TABLE_NETWORK_PATH_NOT_FOUND', message: `接口返回里没有「${missing.col.path}」，无法读取列「${missing.col.name}」` }
    const notArray = arrays.find((a) => !Array.isArray(a.value))
    if (notArray) return { ok: false, code: 'TABLE_NETWORK_PATH_NOT_ARRAY', message: `「${notArray.col.path}」不是数组，按列读取时每列都要指向一个数组` }
    const lengths = new Set(arrays.map((a) => (a.value as unknown[]).length))
    if (lengths.size > 1) {
      return { ok: false, code: 'TABLE_NETWORK_COLUMNS_LENGTH_MISMATCH', message: `按列读取的几个数组长度不一致（${arrays.map((a) => `${a.col.name} ${(a.value as unknown[]).length}`).join('、')}），无法按下标拼成行` }
    }
    total = arrays.length > 0 ? (arrays[0]!.value as unknown[]).length : 0
    rows = []
    for (let i = 0; i < Math.min(total, max); i++) {
      const row: Record<string, ValueField> = {}
      for (const { col, value } of arrays) row[col.key] = fieldFromJson(col, (value as unknown[])[i])
      rows.push(row)
    }
  } else {
    const list = resolveJsonPath(root, plan.rowsPath)
    if (list === undefined) return { ok: false, code: 'TABLE_NETWORK_PATH_NOT_FOUND', message: `接口返回里没有「${plan.rowsPath}」` }
    if (!Array.isArray(list)) return { ok: false, code: 'TABLE_NETWORK_PATH_NOT_ARRAY', message: `「${plan.rowsPath}」不是数组，不能作为数据行` }
    total = list.length
    rows = list.slice(0, max).map((item) => {
      const row: Record<string, ValueField> = {}
      for (const col of plan.columns) row[col.key] = fieldFromJson(col, resolveJsonPath(item, col.path))
      return row
    })
  }
  let pageInfo: JsonTableBody['pageInfo']
  if (plan.totalPath) {
    const t = resolveJsonPath(root, plan.totalPath)
    const n = typeof t === 'number' ? t : typeof t === 'string' && /^\d+$/.test(t.trim()) ? Number(t.trim()) : NaN
    if (t === undefined) return { ok: false, code: 'TABLE_NETWORK_PATH_NOT_FOUND', message: `接口返回里没有总条数字段「${plan.totalPath}」` }
    if (!Number.isInteger(n) || n < 0) return { ok: false, code: 'TABLE_NETWORK_TOTAL_INVALID', message: `总条数字段「${plan.totalPath}」不是非负整数（${previewOf(t)}）` }
    pageInfo = { totalRows: n, rawText: `接口 ${plan.totalPath} = ${n}`.slice(0, 240) }
  }
  const truncated = total > max
  return {
    ok: true,
    body: {
      columns: plan.columns,
      rows,
      rowCount: rows.length,
      coverage: {
        requestedScope: 'current_page',
        observedScope: 'current_page',
        status: truncated ? 'partial' : 'complete',
        ...(truncated ? { reasonCode: 'TABLE_ROW_LIMIT_TRUNCATED', reasonMessage: `接口返回 ${total} 行，超过读取上限 ${max} 行，只读取了前 ${max} 行` } : {}),
      },
      ...(pageInfo ? { pageInfo } : {}),
    },
  }
}
