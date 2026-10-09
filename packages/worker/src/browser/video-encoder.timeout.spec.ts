import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

const spawned = vi.hoisted(() => ({ children: [] as unknown[] }))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    spawned.children.push(child)
    return child
  }),
}))

import { spawn } from 'node:child_process'
import { EncoderTimeoutError, encodeJpegDirectoryToWebm, killInFlightEncoders } from './video-encoder.js'

beforeEach(() => {
  spawned.children.length = 0
  vi.mocked(spawn).mockClear()
})

describe('录屏编码子进程边界', () => {
  it('超时后 SIGKILL 子进程，且不重试', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-enc-timeout-'))
    const result = encodeJpegDirectoryToWebm({ dir, maxBytes: 1024, timeoutMs: 20 })
    await expect(result).rejects.toBeInstanceOf(EncoderTimeoutError)
    expect(spawn).toHaveBeenCalledTimes(1)
    const child = spawned.children[0] as FakeChild
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('子进程带内存上限参数启动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-enc-args-'))
    const pending = encodeJpegDirectoryToWebm({ dir, maxBytes: 1024, timeoutMs: 20 }).catch(() => undefined)
    await pending
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[]
    expect(args.some((arg) => arg.startsWith('--max-old-space-size='))).toBe(true)
  })

  it('killInFlightEncoders 终止在途子进程', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-enc-kill-'))
    const pending = encodeJpegDirectoryToWebm({ dir, maxBytes: 1024, timeoutMs: 60_000 }).catch(() => undefined)
    await vi.waitFor(() => expect(spawned.children.length).toBe(1))
    expect(killInFlightEncoders()).toBe(1)
    const child = spawned.children[0] as FakeChild
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('exit', null)
    // 非超时失败会重试一次，重试的子进程也要收掉。
    await vi.waitFor(() => expect(spawned.children.length).toBe(2))
    ;(spawned.children[1] as FakeChild).emit('exit', 1)
    await pending
    expect(killInFlightEncoders()).toBe(0)
  })

  it('编码串行：前一个结束前不启动下一个', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-enc-serial-'))
    const first = encodeJpegDirectoryToWebm({ dir, maxBytes: 1024, timeoutMs: 60_000 }).catch(() => undefined)
    const second = encodeJpegDirectoryToWebm({ dir, maxBytes: 1024, timeoutMs: 60_000 }).catch(() => undefined)
    await vi.waitFor(() => expect(spawned.children.length).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(spawned.children.length).toBe(1)
    // 第一个编码（含一次重试）全部结束后，第二个才会启动。
    ;(spawned.children[0] as FakeChild).emit('exit', 1)
    await vi.waitFor(() => expect(spawned.children.length).toBe(2))
    ;(spawned.children[1] as FakeChild).emit('exit', 1)
    await vi.waitFor(() => expect(spawned.children.length).toBe(3))
    ;(spawned.children[2] as FakeChild).emit('exit', 1)
    await vi.waitFor(() => expect(spawned.children.length).toBe(4))
    ;(spawned.children[3] as FakeChild).emit('exit', 1)
    await Promise.all([first, second])
  })
})
