import type { PageHealthSlowRule } from '@cairn/shared'

/** 一行一条：`[方法] 地址 阈值毫秒`，例如 `POST /api/v1/checkout 800`。 */
export function formatSlowRules(rules: readonly PageHealthSlowRule[]): string {
  return rules.map((rule) => `${rule.method ? `${rule.method} ` : ''}${rule.match} ${rule.maxMs}`).join('\n')
}

export function parseSlowRules(text: string): PageHealthSlowRule[] {
  const rules: PageHealthSlowRule[] = []
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) continue
    const maxMs = Number(parts[parts.length - 1])
    if (!Number.isInteger(maxMs) || maxMs < 1 || maxMs > 600_000) continue
    const head = parts.slice(0, -1)
    const method = head.length > 1 && /^[A-Za-z]{1,10}$/.test(head[0]!) ? head[0]!.toUpperCase() : undefined
    const match = (method ? head.slice(1) : head).join(' ')
    if (!match) continue
    rules.push({ match: match.slice(0, 256), ...(method ? { method } : {}), maxMs })
  }
  return rules.slice(0, 20)
}
