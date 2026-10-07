import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  createRuntimeInvariant,
  type EvidenceMetadata,
  type OutcomeResultDto,
  type RunSnapshot,
} from '@cairn/shared'
import { OutcomeAxisSummary, OutcomeConditionList } from './outcome-axis'

const invariant = createRuntimeInvariant('auth_validity', '00000000-0000-4000-8000-000000000001')

const snapshot = {
  runtimeInvariantManifest: { entries: [invariant] },
} as RunSnapshot

const failRow: OutcomeResultDto = {
  id: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  stepRunId: '00000000-0000-4000-8000-000000000004',
  attemptId: '00000000-0000-4000-8000-000000000005',
  contractId: invariant.id,
  scope: 'scenario',
  meaning: invariant.meaning,
  severity: invariant.severity,
  onViolation: invariant.onViolation,
  provenance: 'runtime_invariant',
  verdict: 'FAIL',
  expected: { kind: 'auth_validity', status: 'authenticated' },
  actual: { status: 'recovered' },
  evaluatedAt: '2026-09-17T00:00:00.000Z',
}

describe('OutcomeConditionList 运行期约束', () => {
  it('与成功条件分列，并展示 Expected / Actual', async () => {
    const screen = await render(
      <OutcomeConditionList runId={failRow.runId} run={{ snapshot, outcomeResults: [failRow] }} />,
    )
    await expect.element(screen.getByRole('list', { name: '运行期约束判定' })).toBeInTheDocument()
    expect(screen.container.textContent).toMatch(/运行期间登录保持有效/)
    expect(screen.container.textContent).toMatch(/期望/)
    expect(screen.container.textContent).toMatch(/实际/)
    expect(screen.container.textContent).toMatch(/recovered/)
    expect(screen.container.textContent).not.toMatch(/"kind":"auth_validity"/)
  })

  it('结果行无 evidenceId 时回退 Attempt 截图', async () => {
    const screenshot: EvidenceMetadata = {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000010',
      runId: failRow.runId,
      stepRunId: failRow.stepRunId,
      attemptId: failRow.attemptId,
      type: 'screenshot',
      status: 'missing',
      createdAt: '2026-09-17T00:00:00.000Z',
      missingReason: 'capture_failed',
    }
    const screen = await render(
      <OutcomeConditionList
        runId={failRow.runId}
        run={{ snapshot, outcomeResults: [failRow] }}
        evidenceItems={[screenshot]}
      />,
    )
    expect(screen.container.textContent).toMatch(/查看对应步骤证据/)
  })
})

describe('OutcomeConditionList 成功条件', () => {
  it('期望展示对象存在而不是 JSON', async () => {
    const contractId = '00000000-0000-4000-8000-000000000021'
    const screen = await render(
      <OutcomeConditionList
        runId='00000000-0000-4000-8000-000000000022'
        run={{
          snapshot: {
            outcomeManifest: {
              entries: [
                {
                  contractId,
                  scope: 'step',
                  meaning: '内存使用率有数据',
                  severity: 'MUST',
                  onViolation: 'halt',
                  provenance: 'manual',
                  stepId: '00000000-0000-4000-8000-000000000023',
                  rule: { kind: 'deterministic', expect: { kind: 'exists' } },
                },
              ],
            },
          } as RunSnapshot,
          outcomeResults: [],
        }}
      />,
    )
    expect(screen.container.textContent).toMatch(/内存使用率有数据/)
    expect(screen.container.textContent).toMatch(/对象存在/)
    expect(screen.container.textContent).not.toMatch(/"kind":"exists"/)
  })

  it('重试后显示求值次数，跳过步骤显示不适用原因', async () => {
    const contractId = '00000000-0000-4000-8000-000000000031'
    const stepId = '00000000-0000-4000-8000-000000000032'
    const skippedStepId = '00000000-0000-4000-8000-000000000033'
    const screen = await render(
      <OutcomeConditionList
        runId='00000000-0000-4000-8000-000000000034'
        run={{
          snapshot: {
            outcomeManifest: {
              entries: [
                {
                  contractId,
                  scope: 'step',
                  meaning: '金额已核对',
                  severity: 'MUST',
                  onViolation: 'halt',
                  provenance: 'manual',
                  stepId,
                  rule: { kind: 'deterministic', expect: { kind: 'exists' } },
                },
                {
                  contractId: '00000000-0000-4000-8000-000000000035',
                  scope: 'step',
                  meaning: '停用步骤的核对',
                  severity: 'MUST',
                  onViolation: 'halt',
                  provenance: 'manual',
                  stepId: skippedStepId,
                  rule: { kind: 'deterministic', expect: { kind: 'exists' } },
                },
              ],
            },
          } as RunSnapshot,
          stepRuns: [
            { id: '00000000-0000-4000-8000-000000000041', stepId, ordinal: 1, name: '核对', type: 'assert', status: 'SUCCEEDED', outcomeStatus: 'PASS', startedAt: null, finishedAt: null, attempts: [] },
            { id: '00000000-0000-4000-8000-000000000042', stepId: skippedStepId, ordinal: 2, name: '停用', type: 'assert', status: 'SKIPPED', skipReason: 'disabled', outcomeStatus: 'NOT_EVALUATED', startedAt: null, finishedAt: null, attempts: [] },
          ],
          outcomeResults: [
            {
              id: '00000000-0000-4000-8000-000000000036',
              runId: '00000000-0000-4000-8000-000000000034',
              stepRunId: '00000000-0000-4000-8000-000000000041',
              attemptId: '00000000-0000-4000-8000-000000000037',
              contractId,
              scope: 'step',
              meaning: '金额已核对',
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
              verdict: 'UNKNOWN',
              evaluatedAt: '2026-09-24T00:00:00.000Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000038',
              runId: '00000000-0000-4000-8000-000000000034',
              stepRunId: '00000000-0000-4000-8000-000000000041',
              attemptId: '00000000-0000-4000-8000-000000000039',
              contractId,
              scope: 'step',
              meaning: '金额已核对',
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
              verdict: 'PASS',
              evaluatedAt: '2026-09-24T00:01:00.000Z',
            },
          ],
        }}
      />,
    )
    expect(screen.container.textContent).toMatch(/求值 2 次/)
    expect(screen.container.textContent).toMatch(/不适用（已停用）/)
  })
})

describe('OutcomeAxisSummary', () => {
  it('有成功条件且未评价时说还没评完，而不是没有条件', async () => {
    const screen = await render(
      <OutcomeAxisSummary executionLabel='执行挂起' outcomeStatus='NOT_EVALUATED' hasContracts />,
    )
    expect(screen.container.textContent).toMatch(/业务条件还没评完/)
    expect(screen.container.textContent).not.toMatch(/这次运行没有成功条件/)
  })

  it('确实没有成功条件时仍说这次没有成功条件', async () => {
    const screen = await render(
      <OutcomeAxisSummary executionLabel='执行完成' outcomeStatus='NOT_EVALUATED' hasContracts={false} />,
    )
    expect(screen.container.textContent).toMatch(/这次运行没有成功条件/)
    expect(screen.container.textContent).not.toMatch(/还没评完/)
  })
})

describe('OutcomeConditionList 表格数据检查', () => {
  const contractId = '00000000-0000-4000-8000-000000000041'
  const stepId = '00000000-0000-4000-8000-000000000042'
  const runId = '00000000-0000-4000-8000-000000000043'
  const tableSnapshot = {
    outcomeManifest: {
      entries: [
        {
          contractId,
          scope: 'step',
          meaning: '「收入」各行相加等于合计行',
          severity: 'MUST',
          onViolation: 'continue',
          provenance: 'manual',
          stepId,
          rule: { kind: 'context', key: 'report', expect: { kind: 'table', rule: { rule: 'total_row_match', column: 'amount', precision: 'display' } } },
        },
      ],
    },
  } as RunSnapshot

  it('只给出检查规模和原因，不倾倒整张表', async () => {
    const result: OutcomeResultDto = {
      id: '00000000-0000-4000-8000-000000000044',
      runId,
      stepRunId: '00000000-0000-4000-8000-000000000045',
      attemptId: '00000000-0000-4000-8000-000000000046',
      contractId,
      scope: 'step',
      meaning: '「收入」各行相加等于合计行',
      severity: 'MUST',
      onViolation: 'continue',
      provenance: 'manual',
      verdict: 'FAIL',
      expected: null,
      actual: { rowsChecked: 0, coverage: 'complete' },
      details: {
        safeMessage: '「收入」各行相加是 4480.75，合计行显示 4500.00',
        table: {
          protocol: 'table.outcome@1',
          totalRowsChecked: 3,
          violatingRowsCount: 1,
          violatingRows: [{ rowIndex: 0, reasonSummary: '各行相加 4480.75，合计行 4500.00' }],
        },
      },
      evaluatedAt: '2026-10-07T00:00:00.000Z',
    }
    const screen = await render(
      <OutcomeConditionList runId={runId} run={{ snapshot: tableSnapshot, outcomeResults: [result] }} />,
    )
    const text = screen.container.textContent ?? ''
    expect(text).toMatch(/检查了 3 行数据/)
    expect(text).toMatch(/合计行显示 4500\.00/)
    expect(text).toMatch(/各行相加 4480\.75，合计行 4500\.00/)
    expect(text).not.toMatch(/按业务指令判断/)
    expect(text).not.toMatch(/rowsChecked/)
  })

  it('条件行检查：展示命中行的迷你表；找不到时列出最接近的名称', async () => {
    const found: OutcomeResultDto = {
      id: '00000000-0000-4000-8000-000000000051',
      runId,
      stepRunId: '00000000-0000-4000-8000-000000000052',
      attemptId: '00000000-0000-4000-8000-000000000053',
      contractId,
      scope: 'step',
      meaning: '找到「报表名称」等于「需求订单统计表」的行，它的「最新数据」不等于 0',
      severity: 'MUST',
      onViolation: 'continue',
      provenance: 'manual',
      verdict: 'FAIL',
      expected: null,
      actual: { rowsChecked: 3, coverage: 'complete' },
      details: {
        safeMessage: '找到 1 行（第 2 行），「最新数据」是 0.00，不满足不等于 0',
        table: {
          protocol: 'table.outcome@1',
          totalRowsChecked: 3,
          violatingRowsCount: 1,
          violatingRows: [],
          lookup: { summary: '找到 1 行（第 2 行），「最新数据」是 0.00，不满足不等于 0', matched: [{ rowIndex: 1, cells: [{ column: '报表名称', text: '需求订单统计表' }, { column: '最新数据', text: '0.00' }] }], closest: [] },
        },
      },
      evaluatedAt: '2026-10-07T00:00:00.000Z',
    }
    const screen = await render(<OutcomeConditionList runId={runId} run={{ snapshot: tableSnapshot, outcomeResults: [found] }} />)
    const hit = screen.container.querySelector('table[aria-label="命中的行"]')
    expect(hit?.textContent).toContain('需求订单统计表')
    expect(hit?.textContent).toContain('0.00')
    await screen.unmount()

    const missing: OutcomeResultDto = {
      ...found,
      id: '00000000-0000-4000-8000-000000000054',
      details: {
        safeMessage: '没有找到「报表名称」等于「需求订单统计表」的行（共读取 3 行）',
        table: { protocol: 'table.outcome@1', totalRowsChecked: 3, violatingRowsCount: 0, violatingRows: [], lookup: { summary: '没有找到「报表名称」等于「需求订单统计表」的行（共读取 3 行）', matched: [], closest: ['需求订单统计报表', '需求订单明细表'] } },
      },
    }
    const second = await render(<OutcomeConditionList runId={runId} run={{ snapshot: tableSnapshot, outcomeResults: [missing] }} />)
    const text = second.container.textContent ?? ''
    expect(text).toContain('最接近的名称')
    expect(text).toContain('需求订单统计报表')
    expect(second.container.querySelector('table[aria-label="命中的行"]')).toBeNull()
  })
})
