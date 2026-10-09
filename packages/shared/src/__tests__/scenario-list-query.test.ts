import { describe, expect, it } from 'vitest'
import { runRequirementsOf } from '../run-requirements.js'
import { scenarioListQuerySchema, scenarioSummaryQuerySchema, type ScenarioDefinition } from '../scenario.js'

describe('scenarioListQuerySchema', () => {
  it('健康度接受逗号分隔的多个值，排序默认按创建时间', () => {
    const parsed = scenarioListQuerySchema.parse({ health: 'failing,never' })
    expect(parsed.health).toEqual(['failing', 'never'])
    expect(parsed.sort).toBe('created')
  })

  it('拒绝不存在的健康度与排序', () => {
    expect(scenarioListQuerySchema.safeParse({ health: 'cancelled' }).success).toBe(false)
    expect(scenarioListQuerySchema.safeParse({ sort: 'stepCount' }).success).toBe(false)
  })

  it('创建人与创建时间范围：时刻须是 UTC 时间点', () => {
    const parsed = scenarioListQuerySchema.parse({
      createdBy: '01a1104f-1242-76e3-9289-ce30df9e4f19',
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdTo: '2026-10-08T00:00:00.000Z',
    })
    expect(parsed.createdFrom).toBe('2026-10-01T00:00:00.000Z')
    expect(scenarioListQuerySchema.safeParse({ createdFrom: '2026-10-01' }).success).toBe(false)
  })

  it('计数查询不接受健康度与分页参数', () => {
    const parsed = scenarioSummaryQuerySchema.parse({ health: 'failing', limit: 5, schedule: 'scheduled' })
    expect(parsed).toEqual({ schedule: 'scheduled' })
  })
})

describe('runRequirementsOf', () => {
  const steps = (types: string[], disabled: boolean[] = []) =>
    types.map((type, index) => ({ id: `s${index}`, type, input: {}, disabled: disabled[index] })) as unknown as ScenarioDefinition['steps']

  it('启用的浏览器步骤才需要账号', () => {
    expect(runRequirementsOf({ inputs: [], steps: steps(['echo']) }).needsAccount).toBe(false)
    expect(runRequirementsOf({ inputs: [], steps: steps(['navigate']) }).needsAccount).toBe(true)
    expect(runRequirementsOf({ inputs: [], steps: steps(['navigate'], [true]) }).needsAccount).toBe(false)
  })

  it('输入沿用正式运行的必填口径', () => {
    const requirements = runRequirementsOf({ inputs: [{ key: 'title', label: '工单标题' }], steps: steps(['echo']) })
    expect(requirements.inputs).toEqual([{ key: 'title', label: '工单标题' }])
  })
})
