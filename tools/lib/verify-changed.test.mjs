import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_EDGES,
  analyzeVerificationScope,
  evaluateRemoteFreshness,
  getDownstreamPackages,
  mapPathToPackage,
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
