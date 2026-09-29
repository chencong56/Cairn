import { describe, expect, it } from 'vitest'
import {
  authoringOperationLimitsFor,
  type AuthoringOperation,
  type ScenarioAuthoringDocumentV2,
  normalizeAuthoringDocument,
  authoringDocumentDigest,
} from '@cairn/shared'
import { applyAuthoringOperations } from '../authoring-operations.js'
import { deterministicStepId } from '../expand.js'

describe('applyAuthoringOperations (原子应用与纯函数受限编辑)', () => {
  const baseDoc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
    authoringSchemaVersion: 2,
    inputs: [{ key: 'orderId', label: '订单号', type: 'string', required: true }],
    nodes: [
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000011',
          name: '打开订单列表',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://example.com/orders' },
        },
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000012',
          name: '提取客户编号',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: 'customerId',
          input: { as: 'text', target: { framePath: [], candidates: [{ by: 'css', value: '.cust-id' }] } },
        },
        origin: {
          kind: 'module_unwrap',
          moduleVersionId: '01912345-0000-7000-8000-000000000001',
          invocationId: '01912345-0000-7000-8000-000000000002',
        },
        outcomes: [
          {
            id: '01912345-0000-7000-8000-000000000003',
            scope: 'step',
            meaning: '必须提取到有效客户编号',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            rule: {
              kind: 'deterministic',
              target: { framePath: [], candidates: [{ by: 'css', value: '.cust-id' }] },
              expect: { kind: 'visible' },
            },
          },
        ],
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000013',
          name: '填写客户编号',
          type: 'fill',
          effectType: 'SIDE_EFFECT',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#input-cust' }] },
            from: 'customerId',
          },
        },
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000014',
          name: '断言结果',
          type: 'assert',
          effectType: 'READ_ONLY',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#msg' }] },
            expect: { kind: 'text_contains', value: '已处理' },
          },
        },
      },
    ],
  })

  it('P02/P03: 允许正常更新已有步骤的受限字段，并保全 origin 与 outcomes', async () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'update_step',
        id: 'op_1',
        stepId: '01912345-0000-7000-8000-000000000012',
        patch: {
          name: '提取最新客户编号',
        },
      },
      {
        kind: 'update_step',
        id: 'op_2',
        stepId: '01912345-0000-7000-8000-000000000014',
        patch: {
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#msg' }] },
            expect: { kind: 'text_contains', value: '查询成功' },
          },
        },
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const extNode = result.document.nodes[1] as any
    const baseNode1 = baseDoc.nodes[1] as any
    expect(extNode.step.name).toBe('提取最新客户编号')
    expect(extNode.origin).toEqual(baseNode1?.origin)
    expect(extNode.outcomes).toEqual(baseNode1?.outcomes)

    const assertNode = result.document.nodes[3] as any
    expect(assertNode.step.input.expect.value).toBe('查询成功')

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0]).toMatchObject({
      type: 'modify',
      stepId: '01912345-0000-7000-8000-000000000012',
      fieldPath: ['name'],
      from: '提取客户编号',
      to: '提取最新客户编号',
    })
    expect(result.diffs[1]).toMatchObject({
      type: 'modify',
      stepId: '01912345-0000-7000-8000-000000000014',
      fieldPath: ['input', 'expect'],
    })
  })

  it('P04/P05: 允许在指定锚点新增步骤，并正确计算添加 diff', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'insert_step',
        id: 'op_ins_1',
        step: {
          id: '01912345-0000-7000-8000-000000000015',
          name: '等待查询结果可见',
          type: 'wait',
          effectType: 'READ_ONLY',
          input: {
            kind: 'visible',
            target: { framePath: [], candidates: [{ by: 'css', value: '#table' }] },
          },
        },
        anchorStepId: '01912345-0000-7000-8000-000000000013',
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.nodes).toHaveLength(5)
    expect(result.document.nodes[3]?.kind === 'step' && result.document.nodes[3].step.id).toBe(
      '01912345-0000-7000-8000-000000000015',
    )
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toMatchObject({
      type: 'add',
      stepId: '01912345-0000-7000-8000-000000000015',
      index: 3,
      riskLevel: 'READ_ONLY',
    })
  })

  it('P07: 同分支纯重排只产生 move diff，位置未变报 NO_OP', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'move_step',
        id: 'op_move_1',
        stepId: '01912345-0000-7000-8000-000000000014',
        anchorStepId: '01912345-0000-7000-8000-000000000011', // 移到 step_nav_01 之后（index 1）
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.nodes[1]?.kind === 'step' && result.document.nodes[1].step.id).toBe(
      '01912345-0000-7000-8000-000000000014',
    )
    expect(result.diffs).toEqual([
      {
        type: 'move',
        stepId: '01912345-0000-7000-8000-000000000014',
        stepName: '断言结果',
        stepType: 'assert',
        parentBlockId: undefined,
        branchKey: undefined,
        fromIndex: 3,
        toIndex: 1,
        detail: '从序号 4 调整至序号 2',
      },
    ])

    // 位置未变报 NO_OP
    const noopResult = applyAuthoringOperations(baseDoc, [
      {
        kind: 'move_step',
        id: 'op_noop',
        stepId: '01912345-0000-7000-8000-000000000014',
        anchorStepId: '01912345-0000-7000-8000-000000000013', // 它本来就在 step_fill_01 之后
      },
    ])
    expect(noopResult.ok).toBe(false)
    if (!noopResult.ok) {
      expect(noopResult.error.code).toBe('NO_OP_OPERATION')
    }
  })

  it('N06: 拒绝删除产出被后续步骤引用的步骤', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'remove_step',
        id: 'op_del_1',
        stepId: '01912345-0000-7000-8000-000000000012', // customerId 被 step_fill_01 引用
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('REFERENCED_STEP_CANNOT_BE_REMOVED')
      expect(result.error.message).toContain('customerId')
    }
  })

  it('N07: 拒绝跨分支移动步骤', () => {
    const blockDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId: '01912345-0000-7000-8000-000000000010',
          control: { type: 'if', condition: { kind: 'literal', value: true } },
          then: [
            {
              kind: 'step',
              step: {
                id: '01912345-0000-7000-8000-000000000021',
                name: 'Then 内填写',
                type: 'fill',
                effectType: 'SIDE_EFFECT',
                input: { target: { framePath: [], candidates: [{ by: 'css', value: '#input' }] }, from: 'orderId' },
              },
            },
          ],
          else: [
            {
              kind: 'step',
              step: {
                id: '01912345-0000-7000-8000-000000000022',
                name: 'Else 内操作',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { framePath: [], candidates: [{ by: 'css', value: '#btn' }] } },
              },
            },
          ],
        },
      ],
    }

    const moveCrossResult = applyAuthoringOperations(blockDoc, [
      {
        kind: 'move_step',
        id: 'op_cross',
        stepId: '01912345-0000-7000-8000-000000000021',
        parentBlockId: '01912345-0000-7000-8000-000000000010',
        branchKey: 'else', // 试图移入 else
      },
    ])

    expect(moveCrossResult.ok).toBe(false)
    if (!moveCrossResult.ok) {
      expect(moveCrossResult.error.code).toBe('CROSS_BRANCH_MOVE_UNSUPPORTED')
    }
  })

  it('N08: 敏感 fill 步骤禁止传入字面口令', () => {
    const result = applyAuthoringOperations(baseDoc, [
      {
        kind: 'insert_step',
        id: 'op_pwd',
        step: {
          id: '01912345-0000-7000-8000-000000000016',
          name: '输入密码',
          type: 'fill',
          effectType: 'SIDE_EFFECT',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#pwd' }] },
            value: 'plaintext_password_123',
            sensitive: true,
          },
        },
      },
    ])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SENSITIVE_LITERAL_FORBIDDEN')
    }
  })

  it('硬性约束：单次最多 4 项操作，最多 2 项新增', () => {
    const fiveOps: AuthoringOperation[] = [
      { kind: 'update_step', id: '1', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '1' } },
      { kind: 'update_step', id: '2', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '2' } },
      { kind: 'update_step', id: '3', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '3' } },
      { kind: 'update_step', id: '4', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '4' } },
      { kind: 'update_step', id: '5', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '5' } },
    ]
    const r1 = applyAuthoringOperations(baseDoc, fiveOps)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.code).toBe('OPERATION_LIMIT_EXCEEDED')

    const threeInserts: AuthoringOperation[] = [
      {
        kind: 'insert_step',
        id: '1',
        step: {
          id: '01912345-0000-7000-8000-000000000091',
          name: '1',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://a.test' },
        },
      },
      {
        kind: 'insert_step',
        id: '2',
        step: {
          id: '01912345-0000-7000-8000-000000000092',
          name: '2',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://b.test' },
        },
      },
      {
        kind: 'insert_step',
        id: '3',
        step: {
          id: '01912345-0000-7000-8000-000000000093',
          name: '3',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://c.test' },
        },
      },
    ]
    const r2 = applyAuthoringOperations(baseDoc, threeInserts)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe('INSERT_LIMIT_EXCEEDED')
  })

  it('原子性保证：任一操作失败则整组回滚，原草稿完全不变', async () => {
    const originalDigest = await authoringDocumentDigest(baseDoc)

    const mixedOps: AuthoringOperation[] = [
      {
        kind: 'update_step',
        id: 'op_valid_1',
        stepId: '01912345-0000-7000-8000-000000000011',
        patch: { name: '正常修改名称' },
      },
      {
        kind: 'update_step',
        id: 'op_invalid_2',
        stepId: '01912345-0000-7000-8000-000000000099',
        patch: { name: '无效节点' },
      },
    ]

    const result = applyAuthoringOperations(baseDoc, mixedOps)
    expect(result.ok).toBe(false)

    const postDigest = await authoringDocumentDigest(baseDoc)
    expect(postDigest).toBe(originalDigest)
    expect(baseDoc.nodes[0]?.kind === 'step' && baseDoc.nodes[0].step.name).toBe('打开订单列表')
  })

  it('支持 set_outputs 操作更新场景摘要模板与指标声明，并生成 outputs_change 差异', () => {
    const setOutputsOp: AuthoringOperation = {
      kind: 'set_outputs',
      id: 'op_outputs_1',
      mode: 'replace',
      summaryTemplate: '订单巡检完成，在售商品 ${item_count} 件',
      metrics: [
        {
          key: 'item_count',
          name: '商品数量',
          fromContextKey: 'item_count',
        },
        {
          key: 'page_duration',
          name: '页面加载耗时',
          fromStepDuration: { stepId: '01912345-0000-7000-8000-000000000011' },
          unit: 'ms',
        },
      ],
    }

    const res = applyAuthoringOperations(baseDoc, [setOutputsOp])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.document.outputs?.summaryTemplate).toBe('订单巡检完成，在售商品 ${item_count} 件')
      expect(res.document.outputs?.metrics).toHaveLength(2)
      expect(res.document.outputs?.metrics?.[1]?.fromStepDuration?.stepId).toBe('01912345-0000-7000-8000-000000000011')
      expect(res.diffs).toHaveLength(1)
      const firstDiff = res.diffs[0]
      expect(firstDiff?.type).toBe('outputs_change')
      if (firstDiff && firstDiff.type === 'outputs_change') {
        expect(firstDiff.summaryTemplate?.to).toBe('订单巡检完成，在售商品 ${item_count} 件')
        expect(firstDiff.metricsAdded).toHaveLength(2)
      }
    }
  })

  it('set_outputs 的 replace 会移除未再声明的指标，merge 保留原有指标', () => {
    const seed = applyAuthoringOperations(baseDoc, [
      {
        kind: 'set_outputs',
        id: 'op_seed',
        mode: 'merge',
        metrics: [
          { key: 'old_metric', name: '旧指标', fromContextKey: 'old_metric' },
          { key: 'item_count', name: '商品数量', fromContextKey: 'item_count' },
        ],
      },
    ])
    expect(seed.ok).toBe(true)
    if (!seed.ok) return

    const merged = applyAuthoringOperations(seed.document, [
      { kind: 'set_outputs', id: 'op_merge', mode: 'merge', metrics: [{ key: 'item_count', name: '商品件数', fromContextKey: 'item_count' }] },
    ])
    expect(merged.ok).toBe(true)
    if (merged.ok) {
      expect(merged.document.outputs?.metrics.map((m) => m.key)).toEqual(['old_metric', 'item_count'])
      const diff = merged.diffs[0]
      expect(diff?.type === 'outputs_change' && diff.metricsUpdated?.map((m) => m.key)).toEqual(['item_count'])
    }

    const replaced = applyAuthoringOperations(seed.document, [
      { kind: 'set_outputs', id: 'op_replace', mode: 'replace', metrics: [{ key: 'item_count', name: '商品数量', fromContextKey: 'item_count' }] },
    ])
    expect(replaced.ok).toBe(true)
    if (replaced.ok) {
      expect(replaced.document.outputs?.metrics.map((m) => m.key)).toEqual(['item_count'])
      const diff = replaced.diffs[0]
      expect(diff?.type === 'outputs_change' && diff.metricsRemoved?.map((m) => m.key)).toEqual(['old_metric'])
      expect(diff?.type === 'outputs_change' && diff.metricsUpdated).toEqual([])
    }
  })

  it('验收提案的成功条件记为 ai_compiled，并按验收上限放行多卡操作', () => {
    const firstStep = baseDoc.nodes[0]
    if (!firstStep || firstStep.kind !== 'step') throw new Error('fixture')
    const ops: AuthoringOperation[] = Array.from({ length: 6 }, (_, i) => ({
      kind: 'add_outcome',
      id: `op_outcome_${i}`,
      stepId: firstStep.step.id,
      meaning: `条件 ${i}`,
      rule: { kind: 'step_duration', op: 'lte', valueMs: 3000 + i },
      severity: 'SHOULD',
      onViolation: 'continue',
      provenance: 'ai_compiled',
    }))
    expect(applyAuthoringOperations(baseDoc, ops).ok).toBe(false)
    const res = applyAuthoringOperations(baseDoc, ops, authoringOperationLimitsFor({ source: 'acceptance' }))
    expect(res.ok).toBe(true)
    if (res.ok) {
      const node = res.document.nodes[0]
      expect(node?.kind === 'step' && node.outcomes?.every((o) => o.provenance === 'ai_compiled')).toBe(true)
    }
  })

  it('支持插入 compute 计算步骤并挂载上下文输出', () => {
    const computeOp: AuthoringOperation = {
      kind: 'insert_step',
      id: 'op_insert_compute',
      step: {
        id: '01912345-0000-7000-8000-000000000099',
        name: '计算订单总数',
        type: 'compute',
        effectType: 'READ_ONLY',
        outputKey: 'item_count',
        input: {
          expression: {
            kind: 'call',
            fn: 'length',
            args: [{ kind: 'ref', key: 'items' }],
          },
        },
      },
      anchorStepId: '01912345-0000-7000-8000-000000000011',
    }

    const res = applyAuthoringOperations(baseDoc, [computeOp])
    expect(res.ok).toBe(true)
    if (res.ok) {
      const inserted = res.document.nodes.find((n) => n.kind === 'step' && n.step.id === '01912345-0000-7000-8000-000000000099')
      expect(inserted).toBeDefined()
      if (inserted && inserted.kind === 'step') {
        expect(inserted.step.type).toBe('compute')
        expect(inserted.step.outputKey).toBe('item_count')
      }
    }
  })

  it('通过 options 放宽单轮上限到 24 项操作与 12 项插入', () => {
    const ops: AuthoringOperation[] = Array.from({ length: 6 }, (_, i) => ({
      kind: 'insert_step' as const,
      id: `op_insert_${i}`,
      step: {
        id: `01912345-0000-7000-8000-0000000001${i.toString().padStart(2, '0')}`,
        name: `步骤 ${i}`,
        type: 'navigate' as const,
        effectType: 'READ_ONLY' as const,
        input: { url: `https://example.com/${i}` },
      },
    }))

    // 默认 4/2 会被拒绝
    const defaultRes = applyAuthoringOperations(baseDoc, ops)
    expect(defaultRes.ok).toBe(false)

    // 传入放宽参数后成功
    const relaxedRes = applyAuthoringOperations(baseDoc, ops, { maxOperations: 24, maxInserts: 12 })
    expect(relaxedRes.ok).toBe(true)
  })
})

describe('applyAuthoringOperations 场景级 add_outcome（二期）', () => {
  const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
    authoringSchemaVersion: 2,
    inputs: [],
    nodes: [
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000021',
          name: '打开页面',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://example.com' },
        },
      },
    ],
  })

  it('stepId 缺省时写入 scenarioOutcomes，确定性 ID 使用 scenario 前缀', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'add_outcome',
        id: 'op-sc-outcome',
        meaning: '全程耗时不超过 30 秒',
        rule: { kind: 'run_duration', op: 'lte', valueMs: 30_000 },
        severity: 'SHOULD',
        onViolation: 'continue',
        provenance: 'ai_compiled',
      },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const contract = res.document.scenarioOutcomes?.[0]
    expect(contract).toBeDefined()
    expect(contract?.id).toBe(deterministicStepId('scenario', 'op-sc-outcome', 'outcome'))
    expect(contract?.scope).toBe('scenario')
    expect(contract?.rule).toEqual({ kind: 'run_duration', op: 'lte', valueMs: 30_000 })
    // 草稿节点不受影响
    expect(res.document.nodes).toHaveLength(doc.nodes.length)
    // diff 记录场景级 outcome_add（无 stepId）
    const diff = res.diffs[0]
    expect(diff?.type === 'outcome_add' && diff.stepId === undefined && diff.scope === 'scenario').toBe(true)
  })

  it('step_duration 不允许挂场景级；run_duration 场景级不允许 halt', () => {
    const stepDuration = applyAuthoringOperations(doc, [
      {
        kind: 'add_outcome',
        id: 'op-bad-1',
        meaning: '步骤耗时挂场景级',
        rule: { kind: 'step_duration', op: 'lte', valueMs: 3_000 },
        severity: 'SHOULD',
        onViolation: 'continue',
        provenance: 'ai_compiled',
      },
    ])
    expect(stepDuration.ok).toBe(false)

    const halt = applyAuthoringOperations(doc, [
      {
        kind: 'add_outcome',
        id: 'op-bad-2',
        meaning: '全程耗时挂 halt',
        rule: { kind: 'run_duration', op: 'lte', valueMs: 3_000 },
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'ai_compiled',
      },
    ])
    expect(halt.ok).toBe(false)
  })
})

describe('applyAuthoringOperations 条件调优 update_outcome（三期）', () => {
  const stepId = '01912345-0000-7000-8000-000000000031'
  const scenarioOutcomeId = '01912345-0000-7000-8000-000000000032'
  const stepOutcomeId = '01912345-0000-7000-8000-000000000033'

  const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
    authoringSchemaVersion: 2,
    inputs: [],
    nodes: [
      {
        kind: 'step',
        step: {
          id: stepId,
          name: '点击按钮',
          type: 'click',
          effectType: 'IDEMPOTENT',
          input: { target: { framePath: [], candidates: [{ by: 'css', value: '#btn' }] } },
        },
        outcomes: [
          {
            id: stepOutcomeId,
            scope: 'step',
            meaning: '点击耗时不超过 1 秒',
            rule: { kind: 'step_duration', op: 'lte', valueMs: 1_000 },
            severity: 'MUST',
            onViolation: 'continue',
            provenance: 'manual',
          },
        ],
      },
    ],
    scenarioOutcomes: [
      {
        id: scenarioOutcomeId,
        scope: 'scenario',
        meaning: '全程耗时不超过 30 秒',
        rule: { kind: 'run_duration', op: 'lte', valueMs: 30_000 },
        severity: 'SHOULD',
        onViolation: 'continue',
        provenance: 'manual',
      },
    ],
  })

  it('成功更新场景级条件阈值，contractId 保持不变，产出 outcome_update diff', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'update_outcome',
        id: 'op-upd-1',
        contractId: scenarioOutcomeId,
        patch: {
          meaning: '全程耗时不超过 45 秒',
          rule: { kind: 'run_duration', op: 'lte', valueMs: 45_000 },
        },
      },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const updated = res.document.scenarioOutcomes?.find((c) => c.id === scenarioOutcomeId)
    expect(updated).toBeDefined()
    expect(updated?.id).toBe(scenarioOutcomeId) // contractId 不变
    expect(updated?.meaning).toBe('全程耗时不超过 45 秒')
    expect(updated?.rule).toEqual({ kind: 'run_duration', op: 'lte', valueMs: 45_000 })
    expect(updated?.severity).toBe('SHOULD') // 未 patch 保持原样

    const diff = res.diffs[0]
    expect(diff?.type).toBe('outcome_update')
    if (diff?.type === 'outcome_update') {
      expect(diff.contractId).toBe(scenarioOutcomeId)
      expect(diff.scope).toBe('scenario')
      expect(diff.before?.meaning).toBe('全程耗时不超过 30 秒')
      expect(diff.after?.meaning).toBe('全程耗时不超过 45 秒')
    }
  })

  it('成功更新步骤级条件严重度与阈值', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'update_outcome',
        id: 'op-upd-2',
        contractId: stepOutcomeId,
        patch: {
          severity: 'SHOULD',
          rule: { kind: 'step_duration', op: 'lte', valueMs: 2_000 },
        },
      },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const stepNode = res.document.nodes[0] as any
    const updated = stepNode.outcomes?.find((c: any) => c.id === stepOutcomeId)
    expect(updated?.severity).toBe('SHOULD')
    expect(updated?.rule).toEqual({ kind: 'step_duration', op: 'lte', valueMs: 2_000 })

    const diff = res.diffs[0]
    expect(diff?.type).toBe('outcome_update')
    if (diff?.type === 'outcome_update') {
      expect(diff.contractId).toBe(stepOutcomeId)
      expect(diff.scope).toBe('step')
      expect(diff.stepId).toBe(stepId)
    }
  })

  it('禁止跨 rule.kind 修改规则（硬约束）', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'update_outcome',
        id: 'op-upd-invalid-kind',
        contractId: stepOutcomeId,
        patch: {
          rule: { kind: 'run_duration', op: 'lte', valueMs: 2_000 },
        },
      },
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_OUTCOME_RULE_KIND')
    }
  })

  it('契约不存在时返回 OUTCOME_NOT_FOUND', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'update_outcome',
        id: 'op-upd-missing',
        contractId: '01912345-0000-7000-8000-999999999999',
        patch: {
          meaning: '不存在的条件',
        },
      },
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('OUTCOME_NOT_FOUND')
    }
  })

  it('SHOULD / INFO 级别不允许配置 halt', () => {
    const res = applyAuthoringOperations(doc, [
      {
        kind: 'update_outcome',
        id: 'op-upd-halt',
        contractId: scenarioOutcomeId,
        patch: {
          onViolation: 'halt',
        },
      },
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_OUTCOME_VIOLATION')
    }
  })
})

