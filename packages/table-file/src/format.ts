import { fileError, type GridError } from './grid.js'

export type FileFormat = 'csv' | 'xlsx' | 'html'

const startsWith = (bytes: Uint8Array, sig: number[]): boolean => sig.every((b, i) => bytes[i] === b)

/**
 * 按文件头识别格式（扩展名只作参考，不靠它判断）。
 * 二进制 .xls（OLE）、SpreadsheetML 2003、PDF 等明确报“暂不支持”，不猜。
 */
export function detectFileFormat(bytes: Uint8Array, name: string, declared: 'auto' | FileFormat = 'auto'): { ok: true; format: FileFormat } | GridError {
  const isZip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  const isOle = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  if (isOle) {
    return fileError('TABLE_FILE_XLS_UNSUPPORTED', `「${name}」是旧版二进制 Excel（.xls），暂不支持；请让系统导出 .xlsx 或 .csv`)
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return fileError('TABLE_FILE_FORMAT_UNSUPPORTED', `「${name}」是 PDF，不能当表格数据读取`)
  if (declared === 'xlsx' || (declared === 'auto' && isZip)) {
    if (!isZip) return fileError('TABLE_FILE_FORMAT_MISMATCH', `「${name}」不是 xlsx 文件（文件头不是压缩包）`)
    return { ok: true, format: 'xlsx' }
  }
  if (isZip) return fileError('TABLE_FILE_FORMAT_MISMATCH', `「${name}」是压缩包（可能是 xlsx），与指定的格式不符`)
  // 文本类：看前 64 KB
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024))
  const nulCount = Array.from(bytes.subarray(0, 4096)).filter((b) => b === 0).length
  const lower = head.replace(/^﻿/, '').trimStart().toLowerCase()
  if (lower.includes('urn:schemas-microsoft-com:office:spreadsheet') && lower.startsWith('<?xml')) {
    return fileError('TABLE_FILE_FORMAT_UNSUPPORTED', `「${name}」是 Excel 2003 XML 表格，暂不支持；请让系统导出 .xlsx 或 .csv`)
  }
  const looksHtml = lower.startsWith('<') && /<table[\s>]/.test(lower)
  if (declared === 'html' || (declared === 'auto' && looksHtml)) {
    if (!looksHtml) return fileError('TABLE_FILE_FORMAT_MISMATCH', `「${name}」里没有 HTML 表格`)
    return { ok: true, format: 'html' }
  }
  // UTF-16 的文本会有大量 0 字节，交给编码判定；其余出现 0 字节的当作二进制
  const utf16 = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])
  if (nulCount > 8 && !utf16) return fileError('TABLE_FILE_FORMAT_UNSUPPORTED', `「${name}」不是可识别的表格文件（CSV / XLSX / HTML）`)
  return { ok: true, format: 'csv' }
}

/**
 * 文本编码：BOM → 严格 UTF-8 → GB18030（国内老系统导出的 CSV 常见）。可手工指定。
 * Node 自带完整 ICU，GB18030 无需额外编码库。
 */
export function decodeText(bytes: Uint8Array, encoding: 'auto' | 'utf-8' | 'gb18030'): { text: string; encoding: string } {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' }
  if (startsWith(bytes, [0xff, 0xfe])) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  if (startsWith(bytes, [0xfe, 0xff])) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  if (encoding === 'gb18030') return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030' }
  if (encoding === 'utf-8') return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030' }
  }
}
