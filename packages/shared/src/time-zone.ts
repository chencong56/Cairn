import { z } from 'zod'

/** 平台统计时区的出厂值。按天统计（耗时分析汇总、周期报告）以平台配置里的统计时区为准，这里只是它的缺省。 */
export const DEFAULT_STATISTICS_TIME_ZONE = 'Asia/Shanghai'

function knownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** IANA 时区名，如 Asia/Shanghai、UTC。 */
export const timeZoneSchema = z.string().trim().min(1).max(64).refine(knownTimeZone, '请输入有效的时区')

/** 常用时区（下拉候选）；其它 IANA 时区也可以直接填写。 */
export const COMMON_TIME_ZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Asia/Shanghai', label: '北京时间（Asia/Shanghai）' },
  { value: 'UTC', label: '世界标准时间（UTC）' },
  { value: 'Asia/Hong_Kong', label: '香港（Asia/Hong_Kong）' },
  { value: 'Asia/Singapore', label: '新加坡（Asia/Singapore）' },
  { value: 'Asia/Tokyo', label: '东京（Asia/Tokyo）' },
  { value: 'Europe/London', label: '伦敦（Europe/London）' },
  { value: 'America/New_York', label: '纽约（America/New_York）' },
]
