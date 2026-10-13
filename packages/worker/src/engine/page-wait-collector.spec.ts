import { describe, expect, it } from 'vitest'
import {
  runWithPageWaitCollector,
  timePageWait,
  type PageWaitSink,
} from './page-wait-collector.js'

function recordingSink() {
  const events: Array<{ reason: string; durationMs: number }> = []
  const sink: PageWaitSink = {
    async markReady() {
      events.push({ reason: 'collector_ready', durationMs: 0 })
    },
    async record(reason, startedAt, endedAt) {
      events.push({ reason, durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()) })
    },
  }
  return { events, sink }
}

describe('PageWaitCollector ALS', () => {
  it('没有采集器时 timePageWait 只执行工作、不写区间', async () => {
    let ran = false
    await timePageWait('navigate', async () => {
      ran = true
      return 1
    })
    expect(ran).toBe(true)
  })

  it('有采集器时包一层等待并记下 reason 与时长', async () => {
    const { events, sink } = recordingSink()
    await runWithPageWaitCollector(sink, async () => {
      await timePageWait('navigate', async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.reason).toBe('navigate')
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(20)
  })
})
