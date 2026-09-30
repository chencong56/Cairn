import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

export function isManagedUserDataDir(dir: string, profileRoot: string): boolean {
  const resolved = resolve(dir)
  const root = resolve(profileRoot)
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep)
}

export type ManagedProcessRoot = {
  pid: number
  rssBytes: number
  /** 从 --cairn-host=workerId/hostId 解析的宿主标识；独占启动无 hostId */
  hostId: string | null
}

export type ManagedProcessStats = {
  pids: number[]
  rootPids: number[]
  rssBytes: number
  count: number
  /** 每个受管根进程及其子进程树的 RSS 聚合，用于按宿主填充快照与预算 */
  roots: ManagedProcessRoot[]
}

/** 按「参数边界完整匹配」提取 --cairn-host=workerId/hostId 的 hostId */
export function parseHostMarker(command: string, workerId?: string): string | null {
  const marker = '--cairn-host='
  const idx = command.indexOf(marker)
  if (idx < 0) return null
  const rest = command.slice(idx + marker.length)
  const value = rest.startsWith('"') ? rest.slice(1, Math.max(1, rest.indexOf('"', 1))) : rest.split(/\s/, 1)[0]
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const owner = value.slice(0, slash)
  if (workerId && owner !== workerId) return null
  return value.slice(slash + 1)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isProcessOwnedByWorker(
  command: string,
  options: {
    workerId?: string
    workerInstanceId?: string
    profileDir?: string
  },
): boolean {
  if (!/(chrome|chromium)/i.test(command)) return false

  if (command.includes('--cairn-instance=')) {
    const instanceMarker = '--cairn-instance='
    const idx = command.indexOf(instanceMarker)
    const rest = command.slice(idx + instanceMarker.length)
    const instId = rest.split(/\s+/, 1)[0]
    if (options.workerInstanceId && instId !== options.workerInstanceId) {
      return false
    }
  }

  if (options.workerId) {
    const marker = `--cairn-host=${options.workerId}/`
    const regex = new RegExp(`(?:^|\\s)${escapeRegex(marker)}`)
    if (regex.test(command)) return true
  } else if (command.includes('--cairn-host=')) {
    return true
  }

  if (options.profileDir && command.includes('--user-data-dir=')) {
    const root = resolve(options.profileDir)
    const marker = '--user-data-dir='
    const index = command.indexOf(marker)
    const rest = command.slice(index + marker.length)
    const dir = rest.startsWith('"') ? rest.slice(1, Math.max(1, rest.indexOf('"', 1))) : rest.split(/\s/, 1)[0]
    if (dir && isManagedUserDataDir(dir, root)) {
      return true
    }
  }

  return false
}

/**
 * 扫描并汇总受管 Chromium 进程树（按 --cairn-host= 标记与 Profile 根目录双重识别）
 */
export async function scanManagedBrowserProcesses(options: {
  profileDir?: string
  workerId?: string
  workerInstanceId?: string
}): Promise<ManagedProcessStats | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,command='], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    })

    const pidMap = new Map<number, { ppid: number; rssKb: number; command: string }>()
    const rootPids: number[] = []

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!match) continue

      const pid = Number(match[1])
      const ppid = Number(match[2])
      const rssKb = Number(match[3])
      const command = match[4]!

      if (!/(chrome|chromium)/i.test(command)) continue

      pidMap.set(pid, { ppid, rssKb, command })

      if (isProcessOwnedByWorker(command, options)) {
        rootPids.push(pid)
      }
    }

    // 展开所有子孙进程树 (GPU, Renderer, Network 等)，并按根进程聚合子树 RSS
    const childrenOf = new Map<number, number[]>()
    for (const [pid, info] of pidMap.entries()) {
      const list = childrenOf.get(info.ppid) ?? []
      list.push(pid)
      childrenOf.set(info.ppid, list)
    }
    const treePids = new Set<number>(rootPids)
    const roots: ManagedProcessRoot[] = []
    for (const rootPid of rootPids) {
      const visited = new Set<number>([rootPid])
      const stack = [rootPid]
      let rootRssKb = pidMap.get(rootPid)?.rssKb ?? 0
      while (stack.length > 0) {
        const pid = stack.pop()!
        for (const child of childrenOf.get(pid) ?? []) {
          if (visited.has(child)) continue
          visited.add(child)
          treePids.add(child)
          rootRssKb += pidMap.get(child)?.rssKb ?? 0
          stack.push(child)
        }
      }
      roots.push({
        pid: rootPid,
        rssBytes: rootRssKb * 1024,
        hostId: parseHostMarker(pidMap.get(rootPid)?.command ?? '', options.workerId),
      })
    }

    let totalRssKb = 0
    for (const pid of treePids) {
      totalRssKb += pidMap.get(pid)?.rssKb ?? 0
    }

    return {
      pids: [...treePids],
      rootPids,
      rssBytes: totalRssKb * 1024,
      count: treePids.size,
      roots,
    }
  } catch {
    return null
  }
}

export async function countManagedBrowserProcesses(
  profileDir?: string,
  workerId?: string,
): Promise<number | null> {
  const stats = await scanManagedBrowserProcesses({ profileDir, workerId })
  return stats ? stats.count : null
}

export async function getManagedBrowserRssBytes(
  profileDir?: string,
  workerId?: string,
): Promise<number | null> {
  const stats = await scanManagedBrowserProcesses({ profileDir, workerId })
  return stats ? stats.rssBytes : null
}

/**
 * 清理残留孤儿进程（属于本 workerId 但不属于当前活跃进程集合）
 */
export async function cleanupOrphanBrowserProcesses(
  workerId: string,
  knownActivePids: Set<number>,
): Promise<number> {
  try {
    const stats = await scanManagedBrowserProcesses({ workerId })
    if (!stats) return 0
    let killed = 0
    for (const pid of stats.rootPids) {
      if (!knownActivePids.has(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
          killed += 1
        } catch {
          // already exited
        }
      }
    }
    return killed
  } catch {
    return 0
  }
}

/**
 * 强制结束卡死宿主进程
 */
export async function killHostBrowserProcess(
  workerId: string,
  hostId: string,
): Promise<boolean> {
  try {
    const targetMarker = `--cairn-host=${workerId}/${hostId}`
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
      timeout: 3_000,
    })
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (line.includes(targetMarker) && /(chrome|chromium)/i.test(line)) {
        const pid = Number(line.split(/\s+/)[0])
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
            return true
          } catch {
            return false
          }
        }
      }
    }
    return false
  } catch {
    return false
  }
}
