import { beforeEach, describe, expect, it, vi } from 'vitest'
import { processReliabilityIncrement } from '../reliability.consumer.js'
import type { Database } from '@cairn/db'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  evaluateBatch: vi.fn(),
  loadData: vi.fn(),
  writeEval: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock('@cairn/db', () => ({
  claimReliabilityEvaluation: mocks.claim,
  evaluateReliabilityBatch: mocks.evaluateBatch,
  loadReliabilityIncrementalData: mocks.loadData,
  writeReliabilityEvaluation: mocks.writeEval,
  reconcileHangingIncidents: mocks.reconcile,
}))

describe('Reliability Consumer (RISA01~RISA08)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips processing when slot cannot be claimed', async () => {
    mocks.claim.mockResolvedValueOnce(null)

    const result = await processReliabilityIncrement({} as Database, {
      workerId: 'worker-1',
      targetId: 't-1',
    })

    expect(result.processed).toBe(false)
    expect(mocks.evaluateBatch).not.toHaveBeenCalled()
    expect(mocks.loadData).not.toHaveBeenCalled()
    expect(mocks.writeEval).not.toHaveBeenCalled()
  })

  it('routes v2-enabled targets to the batch evaluator and never touches the v1 watermark path', async () => {
    const targetId = 'target-v2-1'
    mocks.claim.mockResolvedValueOnce({
      targetId,
      watermarkVector: { runCompletedSeq: 50, mapCommittedSeq: 0, validationSeq: 0 },
      fencingToken: 3,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      v2Enabled: true,
    })
    mocks.evaluateBatch.mockResolvedValueOnce({
      processed: true,
      targetId,
      receiptsCount: 4,
      signalsCount: 6,
      samplesCount: 8,
      incidentsCreated: 1,
      incidentsUpdated: 2,
      reconciledCount: 0,
    })

    const result = await processReliabilityIncrement({} as Database, {
      workerId: 'worker-1',
      targetId,
    })

    expect(mocks.evaluateBatch).toHaveBeenCalledOnce()
    expect(mocks.evaluateBatch.mock.calls[0]![1]).toMatchObject({
      workerId: 'worker-1',
      targetId,
      fencingToken: 3,
    })
    // v1 水位路径绝不介入 v2 目标
    expect(mocks.loadData).not.toHaveBeenCalled()
    expect(mocks.writeEval).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()

    expect(result.processed).toBe(true)
    expect(result.sampleCount).toBe(8)
    expect(result.incidentCount).toBe(3)
  })

  it('consumes incremental runs via the legacy watermark path for v1 targets (real contract enums only)', async () => {
    const targetId = 'target-test-1'
    mocks.claim.mockResolvedValueOnce({
      targetId,
      watermarkVector: { runCompletedSeq: 50, mapCommittedSeq: 0, validationSeq: 0 },
      fencingToken: 1,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      v2Enabled: false,
    })

    const runCreatedAt = new Date()
    mocks.loadData.mockResolvedValueOnce({
      maxEventSeq: 75,
      runRows: [
        {
          id: 'run-1',
          eventSeq: 60,
          targetAccountId: 'acc-1',
          scenarioId: 'sc-1',
          scenarioVersionId: 'scv-1',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          createdAt: runCreatedAt,
        },
        {
          id: 'run-2',
          eventSeq: 75,
          targetAccountId: 'acc-1',
          scenarioId: 'sc-1',
          scenarioVersionId: 'scv-1',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          createdAt: runCreatedAt,
        },
      ],
      stepRows: [
        // 契约只接受 deterministic/map/ai/failed；v1 消费端回退检测与契约不符（恒不触发），
        // 因此真实数据下成功步骤一律视为主命中——这正是 v2 重写要修复的缺陷。
        {
          stepRunId: 'sr-1',
          runId: 'run-1',
          name: 'Step 1',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          startedAt: new Date(1000),
          finishedAt: new Date(1100), // 100ms
          attemptId: 'att-1',
          attemptNo: 1,
          attemptStatus: 'SUCCEEDED',
          attemptError: null,
          decisionKind: 'deterministic',
          reasonCode: null,
        },
        {
          stepRunId: 'sr-2',
          runId: 'run-1',
          name: 'Step 2',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          startedAt: new Date(2000),
          finishedAt: new Date(2250), // 250ms
          attemptId: 'att-2',
          attemptNo: 1,
          attemptStatus: 'SUCCEEDED',
          attemptError: null,
          decisionKind: 'map',
          reasonCode: null,
        },
        {
          stepRunId: 'sr-3',
          runId: 'run-2',
          name: 'Step 3',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          startedAt: new Date(3000),
          finishedAt: new Date(3200),
          attemptId: 'att-3',
          attemptNo: 1,
          attemptStatus: 'FAILED',
          attemptError: { code: 'ELEMENT_NOT_FOUND', message: 'Element not found' },
          decisionKind: null,
          reasonCode: null,
        },
        {
          stepRunId: 'sr-3',
          runId: 'run-2',
          name: 'Step 3',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          startedAt: new Date(3200),
          finishedAt: new Date(3500),
          attemptId: 'att-4',
          attemptNo: 2,
          attemptStatus: 'FAILED',
          attemptError: { code: 'ELEMENT_NOT_FOUND', message: 'Element not found' },
          decisionKind: null,
          reasonCode: null,
        },
      ],
    })

    mocks.writeEval.mockResolvedValueOnce({ id: 'eval-1' })
    mocks.reconcile.mockResolvedValueOnce({ reconciledCount: 0 })

    const result = await processReliabilityIncrement({} as Database, {
      workerId: 'worker-1',
      targetId,
    })

    expect(mocks.evaluateBatch).not.toHaveBeenCalled()
    expect(result.processed).toBe(true)
    expect(result.targetId).toBe(targetId)
    expect(result.sampleCount).toBe(3)

    // Verify writeReliabilityEvaluation was called with advanced watermark
    expect(mocks.writeEval).toHaveBeenCalledOnce()
    const writeArg = mocks.writeEval.mock.calls[0]![1]

    expect(writeArg.targetId).toBe(targetId)
    expect(writeArg.watermarkVector.runCompletedSeq).toBe(75)
    expect(writeArg.featureWindows.length).toBe(1)

    // 真实契约枚举下：仅最终失败的 sr-3 产生一条 resolution_drift 信号
    expect(writeArg.sparseSignals.length).toBe(1)
    expect(writeArg.sparseSignals[0].kind).toBe('resolution_drift')

    // Incidents clustered by groupingKey
    expect(writeArg.incidents.length).toBeGreaterThanOrEqual(1)
    expect(writeArg.incidents[0].groupingKey).toBeDefined()
    expect(writeArg.incidents[0].status).toBe('DETECTED')

    // Reconcile was called
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })
})
