import { describe, expect, it } from 'vitest'
import { isManagedUserDataDir, isProcessOwnedByWorker } from './browser-processes'

describe('托管浏览器进程计数与归属识别 (A24)', () => {
  it('user-data-dir 必须落在 profile 根下，不能只看前缀', () => {
    expect(isManagedUserDataDir('/tmp/profiles/acc-1', '/tmp/profiles')).toBe(true)
    expect(isManagedUserDataDir('/tmp/profiles', '/tmp/profiles')).toBe(true)
    expect(isManagedUserDataDir('/tmp/profiles-evil/acc-1', '/tmp/profiles')).toBe(false)
    expect(isManagedUserDataDir('/tmp/other/acc-1', '/tmp/profiles')).toBe(false)
  })

  it('A24: 区分同 workerId 不同实例的进程，不误杀其他实例', () => {
    const cmdThisInstance =
      '/Applications/Chromium.app/Contents/MacOS/Chromium --cairn-host=worker-1/host-a --cairn-instance=inst-1 --disable-dev-shm-usage'
    const cmdOtherInstance =
      '/Applications/Chromium.app/Contents/MacOS/Chromium --cairn-host=worker-1/host-b --cairn-instance=inst-2 --disable-dev-shm-usage'

    expect(
      isProcessOwnedByWorker(cmdThisInstance, {
        workerId: 'worker-1',
        workerInstanceId: 'inst-1',
      }),
    ).toBe(true)

    expect(
      isProcessOwnedByWorker(cmdOtherInstance, {
        workerId: 'worker-1',
        workerInstanceId: 'inst-1',
      }),
    ).toBe(false)
  })

  it('A24: 标记按完整边界匹配，前缀重合的 workerId 不误判', () => {
    const cmdWorker10 =
      '/Applications/Chromium.app/Contents/MacOS/Chromium --cairn-host=worker-10/host-x'
    expect(
      isProcessOwnedByWorker(cmdWorker10, {
        workerId: 'worker-1',
      }),
    ).toBe(false)

    expect(
      isProcessOwnedByWorker(cmdWorker10, {
        workerId: 'worker-10',
      }),
    ).toBe(true)
  })
})

