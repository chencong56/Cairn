import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getRunSessionOwner: vi.fn(),
  reserveObjectEvidence: vi.fn(),
  markEvidenceMissing: vi.fn(),
}))
vi.mock('@cairn/db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }))

import {
  finalizeSealedVideo,
  settleStoppedVideo,
  sweepStaleVideoDirs,
  writeCapturedFrame,
  type RunVideoRecorder,
} from './run-video.js'
import { VIDEO_MAX_DURATION_MS, VIDEO_MAX_FRAMES } from './video-timeline.js'
import type { CapturedFrame } from './captured-frame.js'

async function makeRecorder(overrides: Partial<RunVideoRecorder> = {}): Promise<RunVideoRecorder> {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-video-stop-'))
  return {
    runId: 'run-1',
    leaseId: 'lease-1',
    sessionId: 'session',
    pageId: 'page',
    captureEpoch: 1,
    dir,
    frameIndex: 0,
    jpegBytes: 0,
    jpegBudget: 1024 * 1024 * 1024,
    lastWriteAt: 0,
    lastAcceptedMonoMs: Number.NEGATIVE_INFINITY,
    lastTMs: 0,
    startedMonoMs: performance.now(),
    startedAt: new Date(),
    passwordMask: 'applied',
    truncated: false,
    accepting: true,
    sealed: false,
    writeChain: Promise.resolve(),
    retargetChain: Promise.resolve(),
    frames: [],
    framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
    finalFrame: 'page_closed',
    localSeq: 0,
    sensitiveSelectors: [],
    ...overrides,
  }
}

function heartbeatFrame(seq: number): CapturedFrame {
  return {
    pageId: 'page',
    captureEpoch: 1,
    sourceSeq: seq,
    origin: 'heartbeat',
    receivedMonoMs: seq * 10,
    jpeg: Buffer.from([0xff, 0xd8, seq & 0xff, 0xff, 0xd9]),
    width: 16,
    height: 12,
  }
}

function managerWith(recorder: RunVideoRecorder) {
  return {
    videoRecorders: new Map([[recorder.leaseId, recorder]]),
    lives: new Map(),
    dbHandle: {},
    logger: { warn: vi.fn(), log: vi.fn() },
    objects: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.reserveObjectEvidence.mockResolvedValue({ status: 'pending', id: 'ev-1' })
  db.markEvidenceMissing.mockResolvedValue(undefined)
})

describe('录屏采集上限', () => {
  it('帧数达到上限后停止采集、标记截断并通知收尾，不再写盘', async () => {
    const stopped = vi.fn()
    const item = await makeRecorder({ frameIndex: VIDEO_MAX_FRAMES, onCaptureStopped: stopped })
    await writeCapturedFrame(item, heartbeatFrame(1), [])
    expect(item.accepting).toBe(false)
    expect(item.truncated).toBe(true)
    expect(item.frames).toHaveLength(0)
    expect(stopped).toHaveBeenCalledTimes(1)
    await writeCapturedFrame(item, heartbeatFrame(2), [])
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('采集时长超过上限后同样停止', async () => {
    const stopped = vi.fn()
    const item = await makeRecorder({
      startedMonoMs: performance.now() - VIDEO_MAX_DURATION_MS - 1000,
      onCaptureStopped: stopped,
    })
    await writeCapturedFrame(item, heartbeatFrame(1), [])
    expect(item.accepting).toBe(false)
    expect(item.truncated).toBe(true)
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('未达上限的帧照常写入', async () => {
    const item = await makeRecorder()
    await writeCapturedFrame(item, heartbeatFrame(1), [])
    expect(item.frames).toHaveLength(1)
    expect(item.accepting).toBe(true)
  })
})

describe('租约失效后的录屏收尾', () => {
  it('运行已取消：丢弃采集目录，视频证据记为 run_cancelled，录屏器移出登记', async () => {
    db.getRunSessionOwner.mockResolvedValue({ status: 'CANCELLED', sessionId: 'session' })
    const item = await makeRecorder({ sealed: true })
    const manager = managerWith(item)
    await settleStoppedVideo.call(manager as never, item.leaseId)
    expect(db.markEvidenceMissing).toHaveBeenCalledWith({}, { id: 'ev-1', reason: 'run_cancelled' })
    expect(manager.videoRecorders.has(item.leaseId)).toBe(false)
    await expect(stat(item.dir)).rejects.toThrow()
  })

  it('运行未取消：只封存，留给租约释放或会话回收走正常收尾', async () => {
    db.getRunSessionOwner.mockResolvedValue({ status: 'RUNNING', sessionId: 'session' })
    const item = await makeRecorder({ sealed: true })
    const manager = managerWith(item)
    await settleStoppedVideo.call(manager as never, item.leaseId)
    expect(db.markEvidenceMissing).not.toHaveBeenCalled()
    expect(manager.videoRecorders.get(item.leaseId)).toBe(item)
    await expect(stat(item.dir)).resolves.toBeTruthy()
  })

  it('没有对应录屏器时无事发生', async () => {
    const manager = { videoRecorders: new Map(), lives: new Map(), dbHandle: {}, logger: { warn: vi.fn() } }
    await settleStoppedVideo.call(manager as never, 'missing')
    expect(db.getRunSessionOwner).not.toHaveBeenCalled()
  })

  it('finalize 时运行已取消：不编码，直接记缺失', async () => {
    db.getRunSessionOwner.mockResolvedValue({ status: 'CANCELLED', sessionId: 'session' })
    const item = await makeRecorder({ sealed: true })
    await writeFile(join(item.dir, 'frame_00000.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const manager = managerWith(item)
    await finalizeSealedVideo.call(manager as never, { recorder: item, leaseId: item.leaseId })
    expect(db.markEvidenceMissing).toHaveBeenCalledWith({}, { id: 'ev-1', reason: 'run_cancelled' })
    expect(manager.videoRecorders.has(item.leaseId)).toBe(false)
    await expect(stat(item.dir)).rejects.toThrow()
  })

  it('读不到运行状态时按未取消处理，不误删', async () => {
    db.getRunSessionOwner.mockRejectedValue(new Error('db down'))
    const item = await makeRecorder({ sealed: true })
    const manager = managerWith(item)
    await settleStoppedVideo.call(manager as never, item.leaseId)
    expect(db.markEvidenceMissing).not.toHaveBeenCalled()
    expect(manager.videoRecorders.has(item.leaseId)).toBe(true)
  })
})

describe('遗留采集目录回收', () => {
  it('只回收无活跃录屏器且超过保留期的 cairn-video-* 目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-sweep-root-'))
    const old = new Date(Date.now() - 48 * 3_600_000)
    const mk = async (name: string, mtime?: Date) => {
      const dir = join(root, name)
      await mkdir(dir)
      if (mtime) await utimes(dir, mtime, mtime)
      return dir
    }
    const stale = await mk('cairn-video-stale', old)
    const fresh = await mk('cairn-video-fresh')
    const active = await mk('cairn-video-active', old)
    const unrelated = await mk('other-stale', old)
    const manager = { videoRecorders: new Map([['l', { dir: active } as RunVideoRecorder]]) }
    const removed = await sweepStaleVideoDirs.call(manager as never, root)
    expect(removed).toBe(1)
    await expect(stat(stale)).rejects.toThrow()
    for (const keep of [fresh, active, unrelated]) await expect(stat(keep)).resolves.toBeTruthy()
  })
})
