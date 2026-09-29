import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BROWSER_PARALLEL_SPEC_FILES, BROWSER_SERIAL_SPEC_FILES, BROWSER_SPEC_FILES, DB_SPEC_FILES, DEMO_SPEC_FILES, LIVE_SPEC_FILES, PURE_SPEC_FILES } from '../testing/test-groups.mjs'

function walkSpecFiles(dir: string, baseDir: string): string[] {
  const result: string[] = []
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      result.push(...walkSpecFiles(full, baseDir))
    } else if (entry.endsWith('.spec.ts')) {
      result.push(relative(baseDir, full))
    }
  }
  return result
}

const GROUPS = [BROWSER_SPEC_FILES, DB_SPEC_FILES, PURE_SPEC_FILES, LIVE_SPEC_FILES, DEMO_SPEC_FILES] as const

describe('Worker 测试套件分组完整性检查', () => {
  it('所有磁盘中的 .spec.ts 测试文件均已登记且无遗漏', () => {
    const baseDir = join(__dirname, '..')
    const diskFiles = walkSpecFiles(baseDir, baseDir).map((f) => `src/${f}`).sort()
    const allRegistered = GROUPS.flat().sort()

    const missing = diskFiles.filter((f) => !allRegistered.includes(f))
    const extra = allRegistered.filter((f) => !diskFiles.includes(f))

    expect(missing, '存在未在 test-groups.mts 中登记的测试文件（必须归入 BROWSER / DB / PURE / LIVE / DEMO 之一）').toEqual([])
    expect(extra, 'test-groups.mts 中存在已不存在的测试文件').toEqual([])
    expect(diskFiles.length).toBe(allRegistered.length)
  })

  it('BROWSER / DB / PURE / LIVE / DEMO 各组之间无重复', () => {
    const seen = new Map<string, number>()
    for (const group of GROUPS) {
      for (const file of group) seen.set(file, (seen.get(file) ?? 0) + 1)
    }
    const dups = [...seen.entries()].filter(([, count]) => count > 1).map(([file]) => file)
    expect(dups, '同一测试文件不能同时属于两组').toEqual([])
  })

  it('PURE_SPEC_FILES 具备静态分类兜底: 严禁申请真实数据库或启动真实浏览器', () => {
    const forbiddenInPure = [
      'openIsolatedDb',
      'requireReachableDb',
      'setupTestTemplateDatabase',
      'openContractDb',
      'new Pool(',
      'new pg.Pool(',
      'CairnTestHarness.create(',
      'CairnTestHarness.createWorkflowHarness(',
      'chromium.launch(',
      'launchPersistentContext(',
      'connectOverCDP(',
    ]
    const hardcodedPortPattern = /\.listen\s*\(\s*(?!0\b)\d+/

    const violations: { file: string; reason: string }[] = []
    const rootDir = join(__dirname, '..', '..')

    for (const file of PURE_SPEC_FILES) {
      // 排除自测文件自身对敏感关键字的定义
      if (file === 'src/__tests__/test-groups.spec.ts') continue
      const fullPath = join(rootDir, file)
      const content = readFileSync(fullPath, 'utf8')

      for (const pattern of forbiddenInPure) {
        if (content.includes(pattern)) {
          violations.push({
            file,
            reason: `包含违规真实资源调用 [${pattern}]。必须移入 DB_SPEC_FILES 或 BROWSER_SPEC_FILES，严禁进入并发 PURE 组！`,
          })
        }
      }

      if (hardcodedPortPattern.test(content)) {
        violations.push({
          file,
          reason: '包含硬编码固定端口 listen(port)。在并发组中必须使用动态端口 listen(0)！',
        })
      }
    }

    expect(
      violations,
      `PURE_SPEC_FILES 中存在触碰真实 DB、真浏览器或固定端口的文件，违背无争抢设计:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([])
  })

  it('DB_SPEC_FILES 具备静态分类兜底: 允许访问 PG 但严禁启动真实 Chromium', () => {
    const forbiddenInDb = [
      'chromium.launch(',
      'launchPersistentContext(',
      'connectOverCDP(',
    ]
    const hardcodedPortPattern = /\.listen\s*\(\s*(?!0\b)\d+/

    const violations: { file: string; reason: string }[] = []
    const rootDir = join(__dirname, '..', '..')

    for (const file of DB_SPEC_FILES) {
      const fullPath = join(rootDir, file)
      const content = readFileSync(fullPath, 'utf8')

      for (const pattern of forbiddenInDb) {
        if (content.includes(pattern)) {
          violations.push({
            file,
            reason: `包含真实浏览器启动调用 [${pattern}]。必须移入 BROWSER_SPEC_FILES，严禁留在 DB 串行组！`,
          })
        }
      }

      if (hardcodedPortPattern.test(content)) {
        violations.push({
          file,
          reason: '包含硬编码固定端口 listen(port)。必须使用动态端口 listen(0)！',
        })
      }
    }

    expect(
      violations,
      `DB_SPEC_FILES 中存在启动真实浏览器的文件:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([])
  })

  it('BROWSER 组的串行/并行拆分完整且互斥', () => {
    const union = [...BROWSER_SERIAL_SPEC_FILES, ...BROWSER_PARALLEL_SPEC_FILES].sort()
    const browserSorted = [...BROWSER_SPEC_FILES].sort()
    expect(union, 'BROWSER_SERIAL 与 BROWSER_PARALLEL 的并集必须恰好等于 BROWSER 组').toEqual(
      browserSorted,
    )

    const serialSet = new Set(BROWSER_SERIAL_SPEC_FILES)
    const dups = BROWSER_PARALLEL_SPEC_FILES.filter((file) => serialSet.has(file))
    expect(dups, '同一文件不能同时属于串行与并行档').toEqual([])
  })

  it('BROWSER_PARALLEL 具备静态分类兜底: 严禁访问真实数据库或固定端口', () => {
    const forbiddenInParallel = [
      'openIsolatedDb',
      'requireReachableDb',
      'setupTestTemplateDatabase',
      'openContractDb',
      'new Pool(',
      'new pg.Pool(',
      'CairnTestHarness.create(',
      'CairnTestHarness.createWorkflowHarness(',
    ]
    const hardcodedPortPattern = /\.listen\s*\(\s*(?!0\b)\d+/

    const violations: { file: string; reason: string }[] = []
    const rootDir = join(__dirname, '..', '..')

    for (const file of BROWSER_PARALLEL_SPEC_FILES) {
      const fullPath = join(rootDir, file)
      const content = readFileSync(fullPath, 'utf8')

      for (const pattern of forbiddenInParallel) {
        if (content.includes(pattern)) {
          violations.push({
            file,
            reason: `包含真实数据库访问 [${pattern}]。连库文件会克隆模板库，并发互踩，必须移入 BROWSER_SERIAL_SPEC_FILES！`,
          })
        }
      }

      if (hardcodedPortPattern.test(content)) {
        violations.push({
          file,
          reason: '包含硬编码固定端口 listen(port)。并行档中必须使用动态端口 listen(0)！',
        })
      }
    }

    expect(
      violations,
      `BROWSER_PARALLEL_SPEC_FILES 中存在连库或固定端口的文件，违背可并行设计:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([])
  })
})
