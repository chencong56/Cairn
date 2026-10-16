import { createRequire } from 'node:module'
import { siteRows, siteTotal, SITE_COLUMNS } from './data.mjs'

/**
 * /grids/export：把同一份站点数据导出成各种“老系统导出”的文件，供文件来源的读取与断言验证。
 * format：csv | csv-bom | csv-gbk | tsv | xlsx | html-xls | html-xls-gbk | xls-binary（反例）
 * 选项：title=1（表头上方有标题行与空行）、merged=1（两级合并表头 + 区域列纵向合并，数据按区域排序）、
 * summary=1 / bad=1（末尾合计行，bad 时数量合计多 1）、formula=1（xlsx 金额与合计用公式，带缓存值）、
 * sheets=2（xlsx 另有一个“汇总”工作表）、corrupt=1（文件截断一半）。
 */
const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const iconv = require('iconv-lite')

export function exportOptions(q) {
  return {
    format: q.get('format') ?? 'csv',
    title: q.get('title') === '1',
    merged: q.get('merged') === '1',
    formula: q.get('formula') === '1',
    sheets: Number(q.get('sheets') ?? 1),
    corrupt: q.get('corrupt') === '1',
  }
}

/** 导出顺序的明细：merged 时按区域分组排序（同区域内按编号）。 */
export function exportRows(p, o) {
  const rows = siteRows(p)
  if (!o.merged) return rows
  const order = ['华南', '华东', '华北', '西南']
  return [...rows].sort((a, b) => order.indexOf(a.region) - order.indexOf(b.region) || a.id - b.id)
}

const fmt2 = (n) => n.toFixed(2)
const GROUPS = [
  { title: '基础信息', keys: ['id', 'name', 'region'] },
  { title: '业务数据', keys: ['qty', 'amount'] },
]

/** 表格的文字矩阵（CSV / HTML 共用）：标题行、表头（一或两级）、明细、合计行。 */
function textMatrix(p, o) {
  const rows = exportRows(p, o)
  const out = []
  if (o.title) out.push(['站点清单导出'], [`导出时间：2026-10-09 10:00:00`], [])
  if (o.merged) {
    out.push(['基础信息', '', '', '业务数据', '', '状态', '日期'])
  }
  out.push(SITE_COLUMNS.map((c) => c.title))
  for (const r of rows) out.push([String(r.id), r.name, r.region, String(r.qty), fmt2(r.amount), r.status, r.date])
  if (p.summary) {
    const t = siteTotal(p, rows)
    out.push(['合计', '', '', String(t.qty), fmt2(t.amount), '', ''])
  }
  return out
}

const csvCell = (v) => (/[",\n\r\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function toCsv(p, o, sep) {
  return textMatrix(p, o).map((r) => r.map(csvCell).join(sep)).join('\r\n') + '\r\n'
}

function toHtml(p, o, charset) {
  const m = textMatrix(p, o)
  const rows = exportRows(p, o)
  const lines = []
  let i = 0
  if (o.title) {
    lines.push(`<tr><td colspan="7" style="font-size:18px">${m[0][0]}</td></tr>`, `<tr><td colspan="7">${m[1][0]}</td></tr>`)
    i = 3
  }
  if (o.merged) {
    lines.push('<tr><th colspan="3">基础信息</th><th colspan="2">业务数据</th><th rowspan="2">状态</th><th rowspan="2">日期</th></tr>')
    lines.push(`<tr>${['编号', '站点名称', '区域', '数量', '金额（元）'].map((t) => `<th>${t}</th>`).join('')}</tr>`)
    // 区域列纵向合并
    let r = 0
    while (r < rows.length) {
      let n = 1
      while (r + n < rows.length && rows[r + n].region === rows[r].region) n++
      for (let k = 0; k < n; k++) {
        const x = rows[r + k]
        const region = k === 0 ? `<td rowspan="${n}">${x.region}</td>` : ''
        lines.push(`<tr><td>${x.id}</td><td>${x.name}</td>${region}<td>${x.qty}</td><td>${fmt2(x.amount)}</td><td>${x.status}</td><td>${x.date}</td></tr>`)
      }
      r += n
    }
    if (p.summary) {
      const t = siteTotal(p, rows)
      lines.push(`<tr><td>合计</td><td></td><td></td><td>${t.qty}</td><td>${fmt2(t.amount)}</td><td></td><td></td></tr>`)
    }
  } else {
    for (; i < m.length; i++) lines.push(`<tr>${m[i].map((v) => `<td>${v}</td>`).join('')}</tr>`)
  }
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=${charset}"></head><body><table border="1">${lines.join('\n')}</table></body></html>`
}

async function toXlsx(p, o) {
  const wb = new ExcelJS.Workbook()
  const rows = exportRows(p, o)
  const ws = wb.addWorksheet('站点明细')
  let r = 1
  if (o.title) {
    ws.getCell(r, 1).value = '站点清单导出'
    ws.mergeCells(r, 1, r, 7)
    r++
    ws.getCell(r, 1).value = '导出时间：2026-10-09 10:00:00'
    r += 2
  }
  if (o.merged) {
    ws.getCell(r, 1).value = '基础信息'
    ws.mergeCells(r, 1, r, 3)
    ws.getCell(r, 4).value = '业务数据'
    ws.mergeCells(r, 4, r, 5)
    ws.getCell(r, 6).value = '状态'
    ws.mergeCells(r, 6, r + 1, 6)
    ws.getCell(r, 7).value = '日期'
    ws.mergeCells(r, 7, r + 1, 7)
    r++
    ;['编号', '站点名称', '区域', '数量', '金额（元）'].forEach((t, c) => (ws.getCell(r, c + 1).value = t))
  } else {
    SITE_COLUMNS.forEach((c, i) => (ws.getCell(r, i + 1).value = c.title))
  }
  r++
  const firstData = r
  let groupStart = r
  rows.forEach((x, i) => {
    ws.getCell(r, 1).value = x.id
    ws.getCell(r, 2).value = x.name
    ws.getCell(r, 3).value = x.region
    ws.getCell(r, 4).value = x.qty
    ws.getCell(r, 5).value = o.formula ? { formula: `ROUND(${x.amount}*1,2)`, result: x.amount } : x.amount
    ws.getCell(r, 5).numFmt = '#,##0.00'
    ws.getCell(r, 6).value = x.status
    const [yy, mm, dd] = x.date.split('-').map(Number)
    ws.getCell(r, 7).value = new Date(Date.UTC(yy, mm - 1, dd))
    ws.getCell(r, 7).numFmt = 'yyyy-mm-dd'
    // 区域列纵向合并（merged 时）
    const next = rows[i + 1]
    if (o.merged && (!next || next.region !== x.region)) {
      if (r > groupStart) ws.mergeCells(groupStart, 3, r, 3)
      groupStart = r + 1
    }
    r++
  })
  if (p.summary) {
    const t = siteTotal(p, rows)
    ws.getCell(r, 1).value = '合计'
    ws.getCell(r, 4).value = o.formula ? { formula: `SUM(D${firstData}:D${r - 1})${p.bad ? '+1' : ''}`, result: t.qty } : t.qty
    ws.getCell(r, 5).value = o.formula ? { formula: `SUM(E${firstData}:E${r - 1})`, result: t.amount } : t.amount
    ws.getCell(r, 5).numFmt = '#,##0.00'
  }
  if (o.sheets >= 2) {
    const s2 = wb.addWorksheet('汇总')
    s2.getCell(1, 1).value = '区域'
    s2.getCell(1, 2).value = '站点数'
    ;['华南', '华东', '华北', '西南'].forEach((g, i) => {
      s2.getCell(i + 2, 1).value = g
      s2.getCell(i + 2, 2).value = rows.filter((x) => x.region === g).length
    })
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const NAME = '站点清单'

/** 返回 { body, type, filename }。 */
export async function exportFile(p, o) {
  let out
  if (o.format === 'xlsx') {
    out = { body: await toXlsx(p, o), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${NAME}.xlsx` }
  } else if (o.format === 'csv' || o.format === 'csv-bom' || o.format === 'tsv') {
    const text = toCsv(p, o, o.format === 'tsv' ? '\t' : ',')
    out = { body: Buffer.from((o.format === 'csv-bom' ? '﻿' : '') + text, 'utf8'), type: 'text/csv; charset=utf-8', filename: `${NAME}.${o.format === 'tsv' ? 'txt' : 'csv'}` }
  } else if (o.format === 'csv-gbk') {
    out = { body: iconv.encode(toCsv(p, o, ','), 'gbk'), type: 'text/csv; charset=gbk', filename: `${NAME}.csv` }
  } else if (o.format === 'html-xls') {
    out = { body: Buffer.from(toHtml(p, o, 'utf-8'), 'utf8'), type: 'application/vnd.ms-excel', filename: `${NAME}.xls` }
  } else if (o.format === 'html-xls-gbk') {
    out = { body: iconv.encode(toHtml(p, o, 'gb2312'), 'gbk'), type: 'application/vnd.ms-excel', filename: `${NAME}.xls` }
  } else if (o.format === 'xls-binary') {
    // 反例：旧版二进制 xls 的文件头（OLE），内容无意义
    out = { body: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512, 0)]), type: 'application/vnd.ms-excel', filename: `${NAME}.xls` }
  } else {
    return null
  }
  if (o.corrupt) out.body = out.body.subarray(0, Math.floor(out.body.length / 2))
  return out
}

/** 标准答案：导出文件里应读到的明细（导出顺序）与合计。 */
export function exportTruth(p, o) {
  const rows = exportRows(p, o)
  return { view: 'export', rowCount: rows.length, total: rows.length, rows, ...(p.summary ? { summary: siteTotal(p, rows) } : {}) }
}
