/**
 * 分层验证分析模块 (L1 / L2 / L3)
 *
 * 依据 docs/spec/2026-09-28-test-pipeline-acceleration-and-clean-baseline.md
 * 计算变更文件影响半径、是否触发全量升级条件，以及 L3 专项领域提示。
 */

export const ALLOWED_EDGES = {
  '@cairn/shared': [],
  '@cairn/authoring': ['@cairn/shared'],
  '@cairn/storage': ['@cairn/shared'],
  '@cairn/secret': ['@cairn/shared'],
  '@cairn/table-file': ['@cairn/shared'],
  '@cairn/db': ['@cairn/shared', '@cairn/authoring'],
  '@cairn/map': ['@cairn/shared', '@cairn/authoring'],
  '@cairn/api': ['@cairn/db', '@cairn/authoring', '@cairn/map', '@cairn/secret', '@cairn/shared', '@cairn/storage', '@cairn/table-file'],
  '@cairn/worker': ['@cairn/db', '@cairn/authoring', '@cairn/map', '@cairn/secret', '@cairn/shared', '@cairn/storage', '@cairn/table-file'],
  '@cairn/web': ['@cairn/shared', '@cairn/authoring'],
  '@cairn/extension-playwright-crx': ['@cairn/shared', '@cairn/authoring'],
}

/**
 * 计算某个包或一组包的所有下游依赖（直接与间接引用方）
 */
export function getDownstreamPackages(packages) {
  const result = new Set()
  const queue = [...packages]

  while (queue.length > 0) {
    const current = queue.shift()
    for (const [pkg, deps] of Object.entries(ALLOWED_EDGES)) {
      if (deps.includes(current) && !result.has(pkg)) {
        result.add(pkg)
        queue.push(pkg)
      }
    }
  }

  return [...result].sort()
}

/**
 * 将相对路径映射到仓内包名
 */
export function mapPathToPackage(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.startsWith('packages/shared/')) return '@cairn/shared'
  if (normalized.startsWith('packages/authoring/')) return '@cairn/authoring'
  if (normalized.startsWith('packages/storage/')) return '@cairn/storage'
  if (normalized.startsWith('packages/secret/')) return '@cairn/secret'
  if (normalized.startsWith('packages/table-file/')) return '@cairn/table-file'
  if (normalized.startsWith('packages/db/')) return '@cairn/db'
  if (normalized.startsWith('packages/map/')) return '@cairn/map'
  if (normalized.startsWith('packages/api/')) return '@cairn/api'
  if (normalized.startsWith('packages/worker/')) return '@cairn/worker'
  if (normalized.startsWith('packages/web/')) return '@cairn/web'
  if (normalized.startsWith('packages/extension/')) return '@cairn/extension-playwright-crx'
  if (normalized.startsWith('vendor/page-agent/')) return '@cairn/worker'
  return null
}

/**
 * 判断是否属于纯文档或说明元数据文件
 */
export function isDocumentationOrMeta(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  if (
    normalized.startsWith('docs/') ||
    normalized.endsWith('.md') ||
    normalized === '.gitignore' ||
    normalized === '.npmrc' ||
    normalized === '.nvmrc' ||
    normalized === 'LICENSE' ||
    normalized.startsWith('deploy/') ||
    normalized.startsWith('tmp/')
  ) {
    return true
  }
  return false
}

/**
 * 分析变更文件清单，得出验证决策
 *
 * @param {string[]} files 变更文件相对路径列表
 * @returns {object} 验证决策结果
 */
export function analyzeVerificationScope(files) {
  const normalizedFiles = files.map((f) => f.replace(/\\/g, '/')).filter(Boolean)

  if (normalizedFiles.length === 0) {
    return {
      isFull: false,
      isDocsOnly: true,
      reasons: ['未检测到任何变更文件'],
      changedPackages: [],
      targetPackages: [],
      l3Suggestions: [],
    }
  }

  const reasons = []
  const l3Suggestions = new Set()
  const changedPackagesSet = new Set()
  let hasCodeChanges = false

  for (const file of normalizedFiles) {
    // 1. 检查根目录配置、构建与工程脚本
    if (
      file.startsWith('tools/') ||
      file.startsWith('scripts/') ||
      file.startsWith('tests/') ||
      file.startsWith('.github/') ||
      file.endsWith('package.json') ||
      file.includes('tsconfig') ||
      file.includes('vitest') ||
      file.endsWith('turbo.json') ||
      file.includes('pnpm-')
    ) {
      reasons.push(`改动根目录工具、构建配置或 CI 工作流: ${file}`)
      hasCodeChanges = true
      continue
    }

    // 2. 检查包内路径
    const pkg = mapPathToPackage(file)
    if (pkg) {
      changedPackagesSet.add(pkg)
      hasCodeChanges = true

      // 检查 shared 契约导出
      if (pkg === '@cairn/shared' && file.startsWith('packages/shared/src/')) {
        reasons.push(`改动 packages/shared 导出契约或核心: ${file}`)
      }

      // 检查 db 迁移与 schema 定义
      if (
        pkg === '@cairn/db' &&
        (file.startsWith('packages/db/migrations/') || file.startsWith('packages/db/src/schema/'))
      ) {
        reasons.push(`改动数据库迁移或 Schema 定义: ${file}`)
      }

      // 检查运行生命周期、会话、租约核心
      if (
        (pkg === '@cairn/worker' &&
          (file.startsWith('packages/worker/src/engine/') ||
            file.startsWith('packages/worker/src/runtime/') ||
            file.includes('/browser/session') ||
            file.includes('/browser/runtime'))) ||
        (pkg === '@cairn/db' && file.startsWith('packages/db/src/sessions/'))
      ) {
        reasons.push(`改动运行生命周期、会话或租约核心: ${file}`)
        l3Suggestions.add('pnpm test:reliability')
      }

      // 专项 L3 领域探针识别
      if (file.includes('reliability')) {
        l3Suggestions.add('pnpm test:reliability')
      }
      if (file.includes('action-module')) {
        l3Suggestions.add('pnpm test:action-modules-e2e')
      }
      if (file.includes('omf') || file.includes('demonstration')) {
        l3Suggestions.add('pnpm test:omf-e2e')
      }
      if (file.includes('lease') || file.includes('occupancy')) {
        l3Suggestions.add('pnpm test:rf06')
      }
      // 定位/表面执行核心：surface.lab 的浸泡用例默认只采样 3 次，
      // 改动这些文件时必须补跑 20 次深浸泡，防止低概率误点回归漏网。
      if (
        file === 'packages/worker/src/browser/surface.ts' ||
        file === 'packages/worker/src/browser/observe.ts' ||
        file === 'packages/worker/src/browser/resolver.ts' ||
        file === 'packages/worker/src/browser/element-candidate-inspector.ts'
      ) {
        l3Suggestions.add('pnpm --filter @cairn/worker test:soak')
      }
      // 演示档（DEMO）：全链路演示默认不跑，改动对应子系统时提示补跑。
      if (
        file.includes('run-video') ||
        file.includes('run-file') ||
        file.includes('file-submission') ||
        file.includes('upload') ||
        (file.includes('demonstration') && file.startsWith('packages/worker/'))
      ) {
        l3Suggestions.add('pnpm --filter @cairn/worker test:demo')
      }
      // worker 非核心降档的补偿控制：改浏览器/AI 层源码时提示补跑浏览器守卫段
      // （本地门降为 fast+db 后，浏览器段对非核心改动由 CI 兜底；此提示供提前本地验证）。
      if (
        pkg === '@cairn/worker' &&
        (file.startsWith('packages/worker/src/browser/') || file.startsWith('packages/worker/src/ai/'))
      ) {
        l3Suggestions.add('pnpm --filter @cairn/worker test:browser')
      }
      continue
    }

    // 3. 检查文档与元数据
    if (isDocumentationOrMeta(file)) {
      continue
    }

    // 4. 未识别路径一律安全升级
    reasons.push(`未识别路径 [${file}]，安全升级全量`)
    hasCodeChanges = true
  }

  // 纯文档变更判定
  if (!hasCodeChanges) {
    const hasSpecChange = normalizedFiles.some((f) => f.startsWith('docs/spec/'))
    return {
      isFull: false,
      isDocsOnly: true,
      reasons: ['仅涉及文档或辅助元数据改动，无需执行代码验证'],
      changedPackages: [],
      targetPackages: [],
      l3Suggestions: hasSpecChange ? ['pnpm check:specs'] : [],
    }
  }

  const isFull = reasons.length > 0
  const changedPackages = [...changedPackagesSet].sort()
  const downstream = getDownstreamPackages(changedPackages)
  const targetPackages = [...new Set([...changedPackages, ...downstream])].sort()

  // worker 包内分档（2026-09-29 决议）：非核心 worker 改动的本地交付门降为
  // test:fast + test:db（约 95s、全确定性红绿）；浏览器守卫段由两条自动机制兜底——
  // 核心改动（engine/runtime/session，升级清单内）仍自动全量，CI 的 pnpm test 保持全量。
  // 仅当 worker 是唯一改动包（无 db/shared 上游连带）时降档；上游改动可能影响任何层，保持全量。
  const workerFastGate =
    !isFull &&
    changedPackages.length === 1 &&
    changedPackages[0] === '@cairn/worker'

  const turboFilters = targetPackages.map((p) => `--filter=${p}`).join(' ')
  let turboCommand = targetPackages.length > 0 ? `turbo run typecheck lint test ${turboFilters}` : null
  const gateNotes = []
  if (workerFastGate && turboCommand) {
    turboCommand = [
      `turbo run typecheck lint ${turboFilters}`,
      'pnpm --filter @cairn/worker test:fast',
      'pnpm --filter @cairn/worker test:db',
    ].join(' && ')
    gateNotes.push(
      'worker 非核心改动：本地交付门降为 test:fast + test:db（约 95s，全确定性红绿）。',
      '浏览器守卫段本次未跑：由 CI 全量兜底；命中浏览器/AI 层源码时见上方 test:browser 提示，核心改动仍自动全量。',
    )
  }
  const fullCommand = 'pnpm check && pnpm lint && pnpm typecheck && pnpm test'

  return {
    isFull,
    isDocsOnly: false,
    reasons,
    changedPackages,
    targetPackages,
    l3Suggestions: [...l3Suggestions].sort(),
    turboCommand,
    gateNotes,
    fullCommand,
  }
}

/**
 * 迭代档（--related）：每个包只跑与改动文件有依赖关系的用例，并跑该包 typecheck。
 *
 * 只作 AI / 人的内循环，不替代交付门：
 * - vitest 的依赖图只在包内有效，改 @cairn/db 源码不会带出 api / worker 的用例，
 *   所以计划里列出「未覆盖的下游包」，交付前仍须跑 analyzeVerificationScope 给出的命令；
 * - 配置、构建、迁移、数据文件等无法判断影响面的改动，该包退回全量 test；
 * - 不含 lint（lint 只覆盖有该脚本的包，交付前统一跑）。
 */
const RELATED_RUNNERS = {
  '@cairn/shared': [{ args: '' }],
  '@cairn/authoring': [{ args: '' }],
  '@cairn/storage': [{ args: '' }],
  '@cairn/secret': [{ args: '' }],
  '@cairn/table-file': [{ args: '' }],
  '@cairn/map': [{ args: '' }],
  '@cairn/db': [{ args: '' }],
  '@cairn/api': [{ args: '' }],
  // worker：纯逻辑（fast）+ 集成配置里的 db 项目（真 PG、假浏览器，约 20s）。
  // 真 Chromium 的 browser-serial / browser-parallel 项目约 5 分钟，不属于内循环：
  // 间接被大量引用的模块（如 totp.ts）会把 30 余个浏览器用例都带出来，迭代档退化成全量。需要时加 --browser。
  '@cairn/worker': [
    { args: '--config vitest.config.mts' },
    { args: '--config vitest.integration.config.mts --project integration-db' },
    { args: '--config vitest.integration.config.mts --project browser-serial --project browser-parallel', browserOnly: true },
  ],
  '@cairn/web': [{ args: '--browser.headless' }],
}

/** 依赖顺序：上游先跑，失败尽早暴露 */
const RELATED_ORDER = Object.keys(RELATED_RUNNERS)

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const CONFIG_FILE = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vitest[^/]*\.m?[jt]s|vite\.config\.[mc]?[jt]s|eslint\.config\.[mc]?[jt]s|knip\.config\.[mc]?[jt]s)$/

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * @param {string[]} files 变更文件（仓库相对路径）
 * @param {(file: string) => boolean} exists 文件当前是否存在（已删除的文件不能交给 vitest related）
 */
export function planRelatedRun(files, exists = () => true, options = {}) {
  const withBrowser = options.browser === true
  const byPackage = new Map()
  const notes = []
  const skipped = []

  for (const raw of files) {
    const file = raw.replace(/\\/g, '/')
    if (!file) continue
    const pkg = mapPathToPackage(file)
    if (!pkg || !RELATED_RUNNERS[pkg]) {
      if (!isDocumentationOrMeta(file)) skipped.push(file)
      continue
    }
    if (file.endsWith('.md') || file.includes('/dist/') || file.includes('/node_modules/')) continue
    const entry = byPackage.get(pkg) ?? { related: [], fullBecause: [] }
    byPackage.set(pkg, entry)

    const rel = file.slice(file.indexOf('/', file.indexOf('/') + 1) + 1) // packages/<name>/<rel>
    if (CONFIG_FILE.test(file) || !CODE_FILE.test(file) || file.endsWith('.d.ts')) {
      entry.fullBecause.push(file)
    } else if (!exists(file)) {
      // 已删除：改动面无法由文件本身推出，退回包全量
      entry.fullBecause.push(`${file}（已删除）`)
    } else {
      entry.related.push(rel)
    }
  }

  const steps = []
  for (const pkg of RELATED_ORDER) {
    const entry = byPackage.get(pkg)
    if (!entry) continue
    steps.push({ kind: 'typecheck', pkg, command: `pnpm --filter ${pkg} typecheck` })
    if (entry.fullBecause.length > 0) {
      steps.push({
        kind: 'full',
        pkg,
        because: entry.fullBecause,
        command: `pnpm --filter ${pkg} test`,
      })
      continue
    }
    if (entry.related.length === 0) continue
    const fileArgs = entry.related.map(shellQuote).join(' ')
    for (const runner of RELATED_RUNNERS[pkg]) {
      if (runner.browserOnly && !withBrowser) continue
      steps.push({
        kind: 'related',
        pkg,
        files: entry.related,
        command:
          `pnpm --filter ${pkg} exec vitest related ${fileArgs} --run --passWithNoTests ${runner.args}`.trimEnd(),
      })
    }
  }

  const changedPackages = [...byPackage.keys()].sort()
  const uncovered = getDownstreamPackages(changedPackages).filter((pkg) => RELATED_RUNNERS[pkg])
  if (uncovered.length > 0) {
    notes.push(
      `下游包未覆盖（vitest 依赖图只在包内）：${uncovered.join('、')}。改动若影响其对外行为，交付前须按交付门跑到这些包。`,
    )
  }
  if (steps.some((step) => step.kind === 'full')) {
    notes.push('含配置、迁移、已删除文件或非代码文件的包已退回该包全量 test（无法判断影响面）。')
  }
  if (skipped.length > 0) {
    notes.push(`以下改动不属于任何带测试的包，迭代档不处理：${skipped.join('、')}`)
  }
  if (!withBrowser && changedPackages.includes('@cairn/worker')) {
    notes.push('worker 的真 Chromium 用例（browser-serial / browser-parallel，约 5 分钟）迭代档默认不跑：加 --browser 纳入，或交付前跑 pnpm test:worker:browser。')
  }
  notes.push('迭代档不含 lint；交付前仍须按 pnpm verify:changed（不带 --related）给出的命令跑完整的受影响包。')

  return { steps, notes, changedPackages, uncoveredDownstream: uncovered }
}

/**
 * 评估本地 origin/main 或对比分支的时效性
 * @param {number} commitTimestampSeconds - git commit timestamp (秒)
 * @param {number} nowMs - 当前毫秒时间戳
 * @param {number} thresholdHours - 告警阈值小时数 (默认 24)
 */
export function evaluateRemoteFreshness(commitTimestampSeconds, nowMs = Date.now(), thresholdHours = 24) {
  if (!commitTimestampSeconds || Number.isNaN(commitTimestampSeconds)) {
    return { isStale: false, ageHours: 0 }
  }
  const ageMs = nowMs - commitTimestampSeconds * 1000
  const ageHours = Math.max(0, Math.round(ageMs / (1000 * 60 * 60)))
  return {
    isStale: ageHours >= thresholdHours,
    ageHours,
  }
}
