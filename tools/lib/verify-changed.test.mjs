import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_EDGES,
  analyzeVerificationScope,
  evaluateRemoteFreshness,
  getDownstreamPackages,
  mapPathToPackage,
  planRelatedRun,
} from './verify-changed.mjs'

describe('分层验证路径映射与决策逻辑 (Phase 3 验收)', () => {
  it('依赖拓扑下游计算准确', () => {
    assert.deepEqual(getDownstreamPackages(['@cairn/web']), [])
    assert.deepEqual(getDownstreamPackages(['@cairn/api']), [])
    assert.deepEqual(getDownstreamPackages(['@cairn/storage']), ['@cairn/api', '@cairn/worker'])
    assert.deepEqual(getDownstreamPackages(['@cairn/db']), ['@cairn/api', '@cairn/worker'])

    // shared 被全仓依赖
    const sharedDownstream = getDownstreamPackages(['@cairn/shared'])
    const allExceptShared = Object.keys(ALLOWED_EDGES).filter((p) => p !== '@cairn/shared').sort()
    assert.deepEqual(sharedDownstream, allExceptShared)
  })

  it('场景 1: 只改 web → 只跑 web (L1 局部执行)', () => {
    const res = analyzeVerificationScope(['packages/web/src/features/runs/index.tsx'])
    assert.equal(res.isFull, false)
    assert.equal(res.isDocsOnly, false)
    assert.deepEqual(res.changedPackages, ['@cairn/web'])
    assert.deepEqual(res.targetPackages, ['@cairn/web'])
    assert.equal(res.turboCommand, 'turbo run typecheck lint test --filter=@cairn/web')
  })

  it('场景 2: 改 shared 契约 → 升级全量 (L2 升级)', () => {
    const res = analyzeVerificationScope(['packages/shared/src/index.ts'])
    assert.equal(res.isFull, true)
    assert.ok(res.reasons.some((r) => r.includes('packages/shared')))
    assert.equal(res.fullCommand, 'pnpm check && pnpm lint && pnpm typecheck && pnpm test')
  })

  it('场景 3: 改迁移 → 升级全量 (L2 升级)', () => {
    const res = analyzeVerificationScope(['packages/db/migrations/0140_new_schema.sql'])
    assert.equal(res.isFull, true)
    assert.ok(res.reasons.some((r) => r.includes('数据库迁移')))
  })

  it('场景 4: 改 tools/ → 升级全量 (L2 升级)', () => {
    const res = analyzeVerificationScope(['tools/check-deps.mjs'])
    assert.equal(res.isFull, true)
    assert.ok(res.reasons.some((r) => r.includes('根目录工具')))
  })

  it('场景 5: 改到未知路径 → 升级全量 (L2 升级)', () => {
    const res = analyzeVerificationScope(['some/random/untracked/path.txt'])
    assert.equal(res.isFull, true)
    assert.ok(res.reasons.some((r) => r.includes('未识别路径')))
  })

  it('场景 6: 改 worker engine → 升级全量，并提示 L3 专项命令', () => {
    const res = analyzeVerificationScope(['packages/worker/src/engine/engine.loop.ts'])
    assert.equal(res.isFull, true)
    assert.ok(res.reasons.some((r) => r.includes('运行生命周期')))
    assert.ok(res.l3Suggestions.includes('pnpm test:reliability'))
  })

  it('场景 6b: 改 worker 非核心源码 → 本地门降为 test:fast + test:db（约 95s），浏览器段由 CI 兜底', () => {
    const res = analyzeVerificationScope(['packages/worker/src/map/consumption.service.ts'])
    assert.equal(res.isFull, false)
    assert.deepEqual(res.changedPackages, ['@cairn/worker'])
    assert.ok(res.turboCommand.includes('turbo run typecheck lint --filter=@cairn/worker'))
    assert.ok(res.turboCommand.includes('pnpm --filter @cairn/worker test:fast'))
    assert.ok(res.turboCommand.includes('pnpm --filter @cairn/worker test:db'))
    assert.ok(!/turbo run typecheck lint test /.test(res.turboCommand), '非核心降档不得再跑包级全量 test')
    assert.ok(res.gateNotes.some((n) => n.includes('test:fast')))
  })

  it('场景 6c: 改 worker 核心（runtime/session）→ 仍升级全量，不降档', () => {
    for (const file of [
      'packages/worker/src/browser/session-manager.ts',
      'packages/worker/src/runtime/lifecycle.ts',
    ]) {
      const res = analyzeVerificationScope([file])
      assert.equal(res.isFull, true, `${file} 属运行/会话核心，必须全量`)
      assert.deepEqual(res.gateNotes, [])
    }
  })

  it('场景 6d: worker 非核心改动连带其他包（上游/下游）→ 不降档，维持包级全量', () => {
    // db 是 worker 的上游：db 变更可能影响任何 worker 层，保持全量
    const withUpstream = analyzeVerificationScope(['packages/worker/src/map/consumption.service.ts', 'packages/db/src/runs/runs.ts'])
    assert.equal(withUpstream.isFull, false)
    assert.ok(/turbo run typecheck lint test /.test(withUpstream.turboCommand))
    assert.deepEqual(withUpstream.gateNotes, [])
    // 多包直接改动同理
    const multi = analyzeVerificationScope(['packages/worker/src/map/consumption.service.ts', 'packages/api/src/users/users.controller.ts'])
    assert.equal(multi.isFull, false)
    assert.ok(/turbo run typecheck lint test /.test(multi.turboCommand))
  })

  it('场景 6e: 改 worker 浏览器/AI 层源码 → 降档同时提示补跑浏览器守卫段', () => {
    const res = analyzeVerificationScope(['packages/worker/src/browser/totp.ts'])
    assert.equal(res.isFull, false)
    assert.ok(res.turboCommand.includes('pnpm --filter @cairn/worker test:fast'))
    assert.ok(res.l3Suggestions.includes('pnpm --filter @cairn/worker test:browser'))
  })

  it('扩展场景: 改定位/表面执行核心 → 提示补跑 worker 浸泡档（采样默认 3 次，深浸泡须显式触发）', () => {
    for (const file of [
      'packages/worker/src/browser/surface.ts',
      'packages/worker/src/browser/observe.ts',
      'packages/worker/src/browser/resolver.ts',
      'packages/worker/src/browser/element-candidate-inspector.ts',
    ]) {
      const res = analyzeVerificationScope([file])
      assert.ok(
        res.l3Suggestions.includes('pnpm --filter @cairn/worker test:soak'),
        `${file} 应提示补跑浸泡档`,
      )
    }
    // 普通浏览器文件不误报
    const plain = analyzeVerificationScope(['packages/worker/src/browser/totp.ts'])
    assert.ok(!plain.l3Suggestions.includes('pnpm --filter @cairn/worker test:soak'))
  })

  it('扩展场景: 改演示档对应子系统 → 提示补跑 worker 演示档（默认套件不跑 DEMO）', () => {
    for (const file of [
      'packages/worker/src/browser/file-submission.lab.spec.ts',
      'packages/worker/src/engine/run-file-workspace.ts',
      'packages/worker/src/browser/upload-runtime.ts',
      'packages/worker/src/ai/demonstration.lab.spec.ts',
    ]) {
      const res = analyzeVerificationScope([file])
      assert.ok(
        res.l3Suggestions.includes('pnpm --filter @cairn/worker test:demo'),
        `${file} 应提示补跑演示档`,
      )
    }
    // 普通浏览器文件不误报
    const plain = analyzeVerificationScope(['packages/worker/src/browser/totp.ts'])
    assert.ok(!plain.l3Suggestions.includes('pnpm --filter @cairn/worker test:demo'))
  })

  it('场景 7: 改 api 普通模块 → 跑 api 及其下游 (L1 局部执行)', () => {
    const res = analyzeVerificationScope(['packages/api/src/users/users.controller.ts'])
    assert.equal(res.isFull, false)
    assert.deepEqual(res.changedPackages, ['@cairn/api'])
    assert.deepEqual(res.targetPackages, ['@cairn/api'])
    assert.equal(res.turboCommand, 'turbo run typecheck lint test --filter=@cairn/api')
  })

  it('扩展场景: 改 storage 库模块 → 跑 storage 及其下游 api 和 worker', () => {
    const res = analyzeVerificationScope(['packages/storage/src/minio-client.ts'])
    assert.equal(res.isFull, false)
    assert.deepEqual(res.changedPackages, ['@cairn/storage'])
    assert.deepEqual(res.targetPackages, ['@cairn/api', '@cairn/storage', '@cairn/worker'])
    assert.equal(
      res.turboCommand,
      'turbo run typecheck lint test --filter=@cairn/api --filter=@cairn/storage --filter=@cairn/worker',
    )
  })

  it('纯文档场景: 只改方案或 Markdown → 提示无需测试并按需提示 check:specs', () => {
    const res = analyzeVerificationScope([
      'docs/spec/2026-09-28-test-pipeline-acceleration-and-clean-baseline.md',
      'README.md',
    ])
    assert.equal(res.isFull, false)
    assert.equal(res.isDocsOnly, true)
    assert.deepEqual(res.targetPackages, [])
    assert.ok(res.l3Suggestions.includes('pnpm check:specs'))
  })

  it('远端基准时效性评估: 超过阈值提示过期，近距离不报错', () => {
    const nowMs = 1700000000000
    const oneHourAgoSec = (nowMs - 3600 * 1000) / 1000
    const freshRes = evaluateRemoteFreshness(oneHourAgoSec, nowMs, 24)
    assert.equal(freshRes.isStale, false)
    assert.equal(freshRes.ageHours, 1)

    const twoDaysAgoSec = (nowMs - 48 * 3600 * 1000) / 1000
    const staleRes = evaluateRemoteFreshness(twoDaysAgoSec, nowMs, 24)
    assert.equal(staleRes.isStale, true)
    assert.equal(staleRes.ageHours, 48)

    // 无效输入兜底
    assert.equal(evaluateRemoteFreshness(null, nowMs).isStale, false)
    assert.equal(evaluateRemoteFreshness(NaN, nowMs).isStale, false)
  })
})

describe('迭代档 --related 计划生成', () => {
  const kinds = (plan) => plan.steps.map((s) => `${s.kind}:${s.pkg}`)

  it('worker 源码：typecheck + 纯逻辑相关 + db 项目；默认不含真浏览器', () => {
    const plan = planRelatedRun(['packages/worker/src/browser/totp.ts'])
    assert.deepEqual(kinds(plan), ['typecheck:@cairn/worker', 'related:@cairn/worker', 'related:@cairn/worker'])
    const cmds = plan.steps.map((s) => s.command)
    assert.ok(cmds[1].includes('vitest related src/browser/totp.ts --run --passWithNoTests --config vitest.config.mts'))
    assert.ok(cmds[2].includes('--config vitest.integration.config.mts --project integration-db'))
    assert.ok(!cmds.some((c) => c.includes('browser-serial')))
    assert.ok(plan.notes.some((n) => n.includes('--browser')))
  })

  it('worker + --browser：纳入 browser-serial / browser-parallel', () => {
    const plan = planRelatedRun(['packages/worker/src/browser/totp.ts'], () => true, { browser: true })
    assert.equal(plan.steps.length, 4)
    assert.ok(plan.steps[3].command.includes('--project browser-serial --project browser-parallel'))
    assert.ok(!plan.notes.some((n) => n.includes('默认不跑')))
  })

  it('web：带 --browser.headless，文件路径相对包目录', () => {
    const plan = planRelatedRun(['packages/web/src/lib/utils.ts'])
    assert.equal(plan.steps[1].command, 'pnpm --filter @cairn/web exec vitest related src/lib/utils.ts --run --passWithNoTests --browser.headless')
  })

  it('迁移 / 配置 / 非代码文件：该包退回全量 test，并说明原因', () => {
    for (const file of ['packages/db/migrations/0150_x.sql', 'packages/db/vitest.config.mts', 'packages/db/package.json']) {
      const plan = planRelatedRun([file, 'packages/db/src/testing.ts'])
      assert.deepEqual(kinds(plan), ['typecheck:@cairn/db', 'full:@cairn/db'], file)
      assert.equal(plan.steps[1].command, 'pnpm --filter @cairn/db test')
      assert.deepEqual(plan.steps[1].because, [file])
    }
  })

  it('已删除文件：该包退回全量，不把不存在的路径交给 vitest', () => {
    const plan = planRelatedRun(['packages/api/src/gone.ts'], () => false)
    assert.deepEqual(kinds(plan), ['typecheck:@cairn/api', 'full:@cairn/api'])
    assert.ok(plan.steps[1].because[0].includes('已删除'))
  })

  it('下游包未覆盖要明说；改下游自身不报它', () => {
    const plan = planRelatedRun(['packages/db/src/testing.ts'])
    assert.deepEqual(plan.uncoveredDownstream, ['@cairn/api', '@cairn/worker'])
    assert.ok(plan.notes.some((n) => n.includes('下游包未覆盖')))
    assert.deepEqual(planRelatedRun(['packages/web/src/lib/utils.ts']).uncoveredDownstream, [])
  })

  it('多包按依赖顺序执行：上游先于下游', () => {
    const plan = planRelatedRun(['packages/worker/src/a.ts', 'packages/web/src/b.ts', 'packages/shared/src/c.ts', 'packages/db/src/d.ts'])
    const order = [...new Set(plan.steps.map((s) => s.pkg))]
    assert.deepEqual(order, ['@cairn/shared', '@cairn/db', '@cairn/worker', '@cairn/web'])
  })

  it('文档与不属于带测试包的改动：不产生步骤，未处理的改动要列出', () => {
    const plan = planRelatedRun(['docs/spec/a.md', 'packages/web/README.md', 'tools/x.mjs'])
    assert.deepEqual(plan.steps, [])
    assert.ok(plan.notes.some((n) => n.includes('tools/x.mjs')))
  })

  it('永远提示：迭代档不含 lint、不等于交付门', () => {
    const plan = planRelatedRun(['packages/web/src/lib/utils.ts'])
    assert.ok(plan.notes.some((n) => n.includes('不含 lint')))
  })
})
