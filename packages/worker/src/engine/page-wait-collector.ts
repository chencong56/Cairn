import { AsyncLocalStorage } from 'node:async_hooks'
import { recordPageWait, type DbHandle } from '@cairn/db'
import type { PageWaitReason } from '@cairn/shared'

export type PageWaitScope = {
  db: DbHandle
  runId: string
  stepRunId: string
  attemptId: string
}

export type PageWaitSink = {
  markReady(): Promise<void>
  record(
    reason: Exclude<PageWaitReason, 'collector_ready'>,
    startedAt: Date,
    endedAt: Date,
    url?: string | null,
  ): Promise<void>
}

const store = new AsyncLocalStorage<PageWaitSink>()

export class PageWaitCollector implements PageWaitSink {
  private ready = false

  constructor(private readonly scope: PageWaitScope) {}

  async markReady(): Promise<void> {
    if (this.ready) return
    this.ready = true
    const now = new Date()
    // try/catch 而非 .catch：recordPageWait 可能在求值阶段同步抛（测试 mock 缺导出、
    // 句柄守卫 throw），.catch 挂不上，遥测写入失败不能击穿执行路径。
    try {
      await recordPageWait(this.scope.db, {
        ...this.scope,
        reason: 'collector_ready',
        startedAt: now,
        endedAt: now,
      })
    } catch (error) {
      console.error('[page-wait] collector_ready 写入失败', error instanceof Error ? error.message : error)
    }
  }

  async record(reason: Exclude<PageWaitReason, 'collector_ready'>, startedAt: Date, endedAt: Date, url?: string | null): Promise<void> {
    await this.markReady()
    try {
      await recordPageWait(this.scope.db, {
        ...this.scope,
        reason,
        startedAt,
        endedAt,
        url,
      })
    } catch (error) {
      console.error('[page-wait] 区间写入失败', error instanceof Error ? error.message : error)
    }
  }
}

export function runWithPageWaitCollector<T>(collector: PageWaitSink, fn: () => Promise<T> | T): Promise<T> | T {
  return store.run(collector, fn)
}

export function currentPageWaitCollector(): PageWaitSink | undefined {
  return store.getStore()
}

export async function timePageWait<T>(
  reason: Exclude<PageWaitReason, 'collector_ready'>,
  work: () => Promise<T>,
  url?: () => string | null | undefined,
): Promise<T> {
  const collector = currentPageWaitCollector()
  const startedAt = new Date()
  try {
    return await work()
  } finally {
    if (collector) {
      await collector.record(reason, startedAt, new Date(), url?.() ?? null)
    }
  }
}
