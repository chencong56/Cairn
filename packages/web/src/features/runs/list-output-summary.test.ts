import { describe, expect, it } from 'vitest'
import { deriveFallbackSummary } from '@cairn/shared'
import { listFacingRunOutputSummary } from './list-output-summary'

describe('listFacingRunOutputSummary', () => {
  it('丢掉与状态/业务结果列同义的保底句', () => {
    expect(
      listFacingRunOutputSummary(
        '流程执行完成，但业务结果未评价。',
        'SUCCEEDED',
        'NOT_EVALUATED',
      ),
    ).toBeNull()
    expect(
      listFacingRunOutputSummary(
        deriveFallbackSummary('SUCCEEDED', 'PASS'),
        'SUCCEEDED',
        'PASS',
      ),
    ).toBeNull()
    expect(
      listFacingRunOutputSummary('执行过程中断。', 'FAILED', 'NOT_EVALUATED'),
    ).toBeNull()
    expect(
      listFacingRunOutputSummary(
        '任务已被人工或系统取消。',
        'CANCELLED',
        'NOT_EVALUATED',
      ),
    ).toBeNull()
  })

  it('保留带具体业务事实的结论', () => {
    expect(
      listFacingRunOutputSummary(
        '巡检发现 1 项登录超时异常',
        'SUCCEEDED',
        'FAIL',
      ),
    ).toBe('巡检发现 1 项登录超时异常')
    expect(
      listFacingRunOutputSummary(
        '执行过程中断：未找到提交按钮',
        'FAILED',
        'NOT_EVALUATED',
      ),
    ).toBe('执行过程中断：未找到提交按钮')
  })

  it('空结论不占位', () => {
    expect(listFacingRunOutputSummary(null, 'SUCCEEDED', 'PASS')).toBeNull()
    expect(listFacingRunOutputSummary('   ', 'SUCCEEDED', 'PASS')).toBeNull()
  })
})
