import { describe, expect, it } from 'vitest'
import { compileScenarioDocument } from '../compiler.js'
import { FACTORY_PLATFORM_CONFIG, type ScenarioDocument, type Step } from '@cairn/shared'

const ids = {
  a: '00000000-0000-4000-8000-000000000071',
  b: '00000000-0000-4000-8000-000000000072',
  c: '00000000-0000-4000-8000-000000000073',
  d: '00000000-0000-4000-8000-000000000074',
  e: '00000000-0000-4000-8000-000000000075',
}

function echo(id: string, name: string, extra: { from?: string; value?: string; outputKey?: string }): Step {
  return {
    id,
    name,
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey: extra.outputKey,
    input: extra.from ? { from: extra.from } : { value: extra.value ?? 'x' },
  }
}

function navigate(id: string, url = 'https://lab.example'): Step {
  return { id, name: '打开', type: 'navigate', effectType: 'SIDE_EFFECT', input: { url } }
}

function document(steps: Step[], inputs: ScenarioDocument['inputs'] = []): ScenarioDocument {
  return { schemaVersion: 1, inputs, steps }
}

describe('compileScenarioDocument', () => {
  it('相同文档两次编译产物与诊断码相同，且产物等于源文档', () => {
    const source = document([
      navigate(ids.a),
      echo(ids.b, '回显', { value: 'ok', outputKey: 'echoed' }),
    ])
    const first = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    const second = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(first.definition).toEqual(source)
    expect(first.diagnostics.map((item) => item.code)).toEqual(second.diagnostics.map((item) => item.code))
    expect(first.ok).toBe(second.ok)
    expect(first.definition).not.toHaveProperty('policy')
  })

  it('保存期未解析 from 是 warning，发布期是 error', () => {
    const source = document([echo(ids.a, '读单号', { from: 'orderId' })])
    const saved = compileScenarioDocument(source, { mode: 'save' })
    expect(saved.ok).toBe(true)
    expect(saved.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNRESOLVED_REF', severity: 'warning' })]),
    )
    const released = compileScenarioDocument(source, { mode: 'release' })
    expect(released.ok).toBe(false)
    expect(released.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNRESOLVED_REF', severity: 'error' })]),
    )
  })

  it('声明输入后 from 可解析', () => {
    const source = document([echo(ids.a, '读单号', { from: 'orderId' })], [{ key: 'orderId', label: '单号' }])
    const result = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'SCENARIO_UNRESOLVED_REF')).toBe(false)
  })

  it('前向引用阻断发布', () => {
    const source = document([
      echo(ids.a, '先读', { from: 'later' }),
      echo(ids.b, '后写', { value: '1', outputKey: 'later' }),
    ])
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'SCENARIO_FORWARD_REF')).toBe(true)
  })

  it('未知 type 阻断', () => {
    const source = document([echo(ids.a, '回显', { value: '1' })])
    const result = compileScenarioDocument(source, { mode: 'release', executableTypes: ['navigate'] })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNKNOWN_STEP_TYPE' })]),
    )
  })

  it('停用 Target 在发布期是 error，保存期是 warning', () => {
    const source = document([echo(ids.a, '回显', { value: '1' })])
    expect(compileScenarioDocument(source, { mode: 'save', target: { exists: true, status: 'disabled' } }).ok).toBe(true)
    expect(
      compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'disabled' } }).ok,
    ).toBe(false)
  })

  it('重复 id / outputKey / input 键与保留名阻断发布', () => {
    const source = document(
      [
        echo(ids.a, '先写', { value: '1', outputKey: 'echoed' }),
        echo(ids.a, '同 id', { value: '2', outputKey: 'echoed' }),
      ],
      [
        { key: 'orderId', label: '单号' },
        { key: 'orderId', label: '又一份单号' },
        { key: 'constructor', label: '陷阱' },
      ],
    )
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'SCENARIO_INPUT_KEY_DUPLICATE',
      'SCENARIO_INPUT_KEY_FORBIDDEN',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_OUTPUT_KEY_DUPLICATE',
      'SCENARIO_STEP_ID_DUPLICATE',
    ])
  })

  it('对象输出未给 fromField 时阻断，字段名必须存在', () => {
    const extract: Step = {
      id: ids.a,
      name: '提取',
      type: 'ai_extract',
      effectType: 'READ_ONLY',
      outputKey: 'order',
      input: {
        instruction: '读取订单',
        outputSchema: { kind: 'object', fields: [{ name: 'orderNo', type: 'string' }] },
      },
    }
    const missing = compileScenarioDocument(
      document([extract, echo(ids.b, '回填', { from: 'order' })]),
      { mode: 'release' },
    )
    expect(missing.ok).toBe(false)
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_FROM_FIELD_MISSING' })]),
    )
    const unknown = compileScenarioDocument(
      document([
        extract,
        {
          id: ids.b,
          name: '回填',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { from: 'order', fromField: 'missing' },
        },
      ]),
      { mode: 'release' },
    )
    expect(unknown.ok).toBe(false)
    expect(unknown.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_FROM_FIELD_UNKNOWN' })]),
    )

    const listExtract: Step = {
      id: ids.a,
      name: '提取列表',
      type: 'ai_extract',
      effectType: 'READ_ONLY',
      outputKey: 'orders',
      input: {
        instruction: '提取单号列表',
        outputSchema: {
          kind: 'list',
          item: { kind: 'scalar', type: 'string' },
          maxItems: 10,
        },
      },
    }
    const listRef = compileScenarioDocument(
      document([listExtract, echo(ids.b, '尝试作为文本回显', { from: 'orders' })]),
      { mode: 'release' },
    )
    expect(listRef.ok).toBe(false)
    expect(listRef.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_FROM_LIST_NOT_TEXT' })]),
    )
  })

  it('AI Action 禁止自动重试，AI Assert 可充当断言', () => {
    const retried = compileScenarioDocument(
      document([
        {
          id: ids.a,
          name: '动作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          policy: { retryLimit: 1 },
          input: { instruction: '查询' },
        },
      ]),
      { mode: 'release' },
    )
    expect(retried.ok).toBe(false)
    expect(retried.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_AI_RETRY_FORBIDDEN' })]),
    )
    const asserted = compileScenarioDocument(
      document([
        navigate(ids.a),
        {
          id: ids.b,
          name: '判断',
          type: 'ai_assert',
          effectType: 'READ_ONLY',
          input: { instruction: '已成功' },
        },
      ]),
      { mode: 'release', target: { exists: true, status: 'active' } },
    )
    expect(asserted.ok).toBe(true)
    expect(asserted.diagnostics.some((item) => item.code === 'SCENARIO_NO_OUTCOME')).toBe(false)
  })

  it('仅 CSS 定位、无成功条件、未使用输入给出 warning', () => {
    const source = document(
      [
        navigate(ids.a),
        {
          id: ids.b,
          name: '点',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          input: { target: { framePath: [], candidates: [{ by: 'css', value: '#ok' }] } },
        },
        {
          id: ids.c,
          name: '抽',
          type: 'extract',
          effectType: 'READ_ONLY',
          input: { target: { framePath: [], candidates: [{ by: 'label', value: '名称' }] }, as: 'text' },
        },
      ],
      [{ key: 'unused', label: '未用' }],
    )
    const result = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'SCENARIO_EXTRACT_NO_OUTPUT_KEY',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_NO_OUTCOME',
      'SCENARIO_WEAK_LOCATOR',
    ])
  })

  it('表格 / 列表数据提取：占位计划发布时报错、草稿给提醒；真实计划不触发 CSS 弱定位提示', () => {
    const table = (plan: unknown) => ({
      id: ids.b,
      name: '读表',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'tbl',
      input: { target: (plan as { target: unknown }).target, as: 'table' as const, table: plan },
    })
    const rootTarget = { framePath: [], candidates: [{ by: 'css', value: '#report' }] }
    const placeholder = {
      protocol: 'table.read@2',
      target: rootTarget,
      columns: [{ key: 'col_1', name: '数据列', valueType: 'text' }],
    }
    const ready = {
      protocol: 'table.read@2',
      target: rootTarget,
      columns: [{ key: 'col_2', name: '区域', valueType: 'text' }],
    }
    const base = [navigate(ids.a)]

    const release = compileScenarioDocument(document([...base, table(placeholder) as never]), {
      mode: 'release',
      target: { exists: true, status: 'active' },
    })
    expect(release.ok).toBe(false)
    expect(release.diagnostics.some((item) => item.code === 'SCENARIO_TABLE_UNCONFIGURED' && item.severity === 'error')).toBe(true)

    const draft = compileScenarioDocument(document([...base, table(placeholder) as never]), { mode: 'save' })
    expect(draft.diagnostics.some((item) => item.code === 'SCENARIO_TABLE_UNCONFIGURED' && item.severity === 'warning')).toBe(true)

    const ok = compileScenarioDocument(document([...base, table(ready) as never]), {
      mode: 'release',
      target: { exists: true, status: 'active' },
    })
    const codes = ok.diagnostics.map((item) => item.code)
    expect(codes).not.toContain('SCENARIO_TABLE_UNCONFIGURED')
    expect(codes).not.toContain('SCENARIO_WEAK_LOCATOR')
  })

  it('数据检查与读取计划对不上时：发布报错、草稿提醒；对得上不报', () => {
    const rootTarget = { framePath: [], candidates: [{ by: 'css', value: '#board' }] }
    const planOf = (kind?: 'cards' | 'keyvalue') => ({
      protocol: 'table.read@2',
      target: rootTarget,
      ...(kind ? { kind } : {}),
      columns: [
        { key: 'col_1', name: '标题', valueType: 'text' },
        { key: 'col_2', name: 'CPU', valueType: 'number', numericKind: 'decimal' },
      ],
    })
    const extract = (plan: unknown) => ({
      id: ids.b,
      name: '读看板',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'board',
      input: { target: rootTarget, as: 'table' as const, table: plan },
    })
    const check = (rule: unknown) => ({
      contractId: ids.c,
      scope: 'step' as const,
      meaning: '检查',
      severity: 'MUST' as const,
      onViolation: 'continue' as const,
      provenance: 'manual' as const,
      stepId: ids.b,
      rule: { kind: 'context' as const, key: 'board', expect: { kind: 'table' as const, rule } },
    })
    const compile = (plan: unknown, rule: unknown, mode: 'save' | 'release') =>
      compileScenarioDocument(document([navigate(ids.a), extract(plan) as never]), {
        mode,
        target: { exists: true, status: 'active' },
        outcomeManifest: { entries: [check(rule) as never] },
      })
    const codes = (r: ReturnType<typeof compile>) => r.diagnostics.filter((d) => d.code === 'SCENARIO_TABLE_CHECK_INVALID')

    // 引用了已不存在的列
    const missing = compile(planOf(), { rule: 'column_unique', column: 'col_9' }, 'release')
    expect(codes(missing)[0]?.severity).toBe('error')
    expect(codes(missing)[0]?.stepId).toBe(ids.b)
    expect(missing.ok).toBe(false)
    expect(codes(compile(planOf(), { rule: 'column_unique', column: 'col_9' }, 'save'))[0]?.severity).toBe('warning')
    // 聚合只接受数字列
    expect(codes(compile(planOf(), { rule: 'column_stat', column: 'col_1', stat: 'sum', op: 'gt', value: 0, ignoreEmpty: false }, 'release'))).toHaveLength(1)
    // 卡片没有合计行
    expect(codes(compile(planOf('cards'), { rule: 'total_row_match', column: 'col_2', precision: 'display' }, 'release'))).toHaveLength(1)
    // 对得上
    expect(codes(compile(planOf('cards'), { rule: 'column_stat', column: 'col_2', stat: 'sum', op: 'gt', value: 0, ignoreEmpty: false }, 'release'))).toHaveLength(0)
    expect(codes(compile(planOf(), { rule: 'total_row_match', column: 'col_2', precision: 'display' }, 'release'))).toHaveLength(0)
    // 分页检查：不引用列；详情信息没有分页
    expect(codes(compile(planOf(), { rule: 'page_total', op: 'gt', value: 0 }, 'release'))).toHaveLength(0)
    expect(codes(compile(planOf(), { rule: 'page_consistency' }, 'release'))).toHaveLength(0)
    expect(codes(compile(planOf('keyvalue'), { rule: 'page_consistency' }, 'release'))).toHaveLength(1)
  })

  it('只有 INFO 条件时给出业务语义提示且不阻断发布', () => {
    const source = document([navigate(ids.a), echo(ids.b, '回显', { value: 'ok' })])
    const result = compileScenarioDocument(source, {
      mode: 'release',
      target: { exists: true, status: 'active' },
      outcomeManifest: {
        entries: [
          {
            contractId: ids.c,
            scope: 'scenario',
            meaning: '仅提示',
            severity: 'INFO',
            onViolation: 'continue',
            provenance: 'manual',
            stepId: ids.c,
            rule: {
              kind: 'deterministic',
              target: { framePath: [], candidates: [{ by: 'label', value: '提示' }] },
              expect: { kind: 'exists' },
            },
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SCENARIO_OUTCOME_INFO_ONLY', 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME']),
    )
  })

  it('副作用步后没有必须或应当条件时给出提示', () => {
    const source = document([
      navigate(ids.a),
      {
        id: ids.b,
        name: '点',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: { target: { framePath: [], candidates: [{ by: 'label', value: '提交' }] } },
      },
    ])
    const result = compileScenarioDocument(source, {
      mode: 'release',
      outcomeManifest: {
        entries: [
          {
            contractId: ids.c,
            scope: 'step',
            meaning: '打开后可见',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            stepId: ids.d,
            sourceStepId: ids.a,
            rule: {
              kind: 'deterministic',
              target: { framePath: [], candidates: [{ by: 'label', value: '结果' }] },
              expect: { kind: 'visible' },
            },
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME', stepId: ids.b }),
      ]),
    )
  })

  it('仅语义目标发布阻断：顺序包含规则就必须给规则候选', () => {
    const semanticOnly = document([
      {
        id: ids.a,
        name: '点',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: { target: { semantic: '查询按钮', candidates: [], framePath: [] } },
      },
    ])
    const released = compileScenarioDocument(semanticOnly, { mode: 'release' })
    expect(released.ok).toBe(false)
    expect(released.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_TARGET_EMPTY' })]),
    )
  })

  it('显式定位路线被平台或目标能力拒绝时报不可用', () => {
    const ruleOnlyPlatform = {
      ...FACTORY_PLATFORM_CONFIG,
      locator: { defaultPlan: { v: 2, order: ['rule' as const] }, limits: { v: 2, allowed: ['rule' as const] } },
    } as typeof FACTORY_PLATFORM_CONFIG
    const step = {
      id: ids.a,
      name: '点',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      policy: { locatorPlan: { v: 2 as const, order: ['text_ai' as const] } },
      input: { target: { framePath: [], candidates: [{ by: 'text', value: '查询' }] } },
    } as Step
    const source = document([step])
    expect(
      compileScenarioDocument(source, {
        mode: 'release',
        resolution: { locatorDocument: ruleOnlyPlatform },
      }).diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_LOCATOR_UNAVAILABLE', message: expect.stringContaining('平台定位能力上限') }),
      ]),
    )
    expect(
      compileScenarioDocument(source, {
        mode: 'release',
        resolution: {
          locatorDocument: FACTORY_PLATFORM_CONFIG,
          locatorTarget: { limits: { v: 2 as const, allowed: ['rule'] as const } },
        },
      }).diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_LOCATOR_UNAVAILABLE', message: expect.stringContaining('目标系统定位能力上限') }),
      ]),
    )
  })

  it('语义等待在 MS-5 前发布报不可用', () => {
    const source = document([
      {
        id: ids.a,
        name: '等',
        type: 'wait',
        effectType: 'READ_ONLY',
        input: { kind: 'semantic', text: '列表已刷出' },
      },
    ])
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_WAIT_KIND_UNAVAILABLE' })]),
    )
  })

  it('确定性成功条件缺 target 时草稿警告、发布阻断', () => {
    const source = document([navigate(ids.a)])
    const outcomeManifest = {
      entries: [
        {
          contractId: ids.b,
          scope: 'step' as const,
          meaning: '尚未从页面选择要检查的内容',
          severity: 'MUST' as const,
          onViolation: 'halt' as const,
          provenance: 'manual' as const,
          stepId: ids.a,
          rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
        },
      ],
    }
    const saved = compileScenarioDocument(source, { mode: 'save', outcomeManifest })
    expect(saved.ok).toBe(true)
    expect(saved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OUTCOME_RULE_TARGET_MISSING', severity: 'warning' }),
      ]),
    )
    const released = compileScenarioDocument(source, { mode: 'release', outcomeManifest })
    expect(released.ok).toBe(false)
    expect(released.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OUTCOME_RULE_TARGET_MISSING', severity: 'error' }),
      ]),
    )
  })

  it('aria_snapshot 成功条件允许省略 target', () => {
    const source = document([navigate(ids.a)])
    const result = compileScenarioDocument(source, {
      mode: 'release',
      outcomeManifest: {
        entries: [
          {
            contractId: ids.b,
            scope: 'scenario',
            meaning: '页面结构仍在',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            stepId: ids.a,
            rule: {
              kind: 'deterministic',
              expect: { kind: 'aria_snapshot', template: '- heading "首页"' },
            },
          },
        ],
      },
    })
    expect(result.diagnostics.some((item) => item.code === 'OUTCOME_RULE_TARGET_MISSING')).toBe(false)
  })

  it('整页出现 / 不出现某段文字的成功条件允许省略 target', () => {
    const source = document([navigate(ids.a)])
    for (const pageExpect of [
      { kind: 'text_absent' as const, value: '系统异常' },
      { kind: 'text_contains' as const, value: '提交成功' },
    ]) {
      const result = compileScenarioDocument(source, {
        mode: 'release',
        outcomeManifest: {
          entries: [
            {
              contractId: ids.b,
              scope: 'step',
              meaning: '整页文字检查',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'ai_compiled',
              stepId: ids.a,
              rule: { kind: 'deterministic', expect: pageExpect },
            },
          ],
        },
      })
      expect(result.diagnostics.some((item) => item.code === 'OUTCOME_RULE_TARGET_MISSING')).toBe(false)
    }
  })

  it('outputs 业务输出引用未定义变量产生 OUTPUT_VARIABLE_UNRESOLVED 警告', () => {
    const source = {
      ...document([navigate(ids.a)]),
      outputs: {
        summaryTemplate: '结果：${unknown_var}',
        metrics: [
          { key: 'item_count', name: '商品数', fromContextKey: 'unresolved_key' },
        ],
        dataRowFields: [
          { columnKey: 'col_a', columnHeader: '列A', fromContextKey: 'missing_row_key' },
        ],
        summaryFromContextKey: 'missing_summary_key',
      },
    }
    const result = compileScenarioDocument(source, { mode: 'save' })
    const unresolvedCodes = result.diagnostics.filter((d) => d.code === 'OUTPUT_VARIABLE_UNRESOLVED')
    expect(unresolvedCodes.length).toBe(4)
    expect(unresolvedCodes.every((d) => d.severity === 'warning')).toBe(true)
  })

  it('发布时阻断未知的业务结论模板变量', () => {
    const source = {
      ...document([navigate(ids.a)]),
      outputs: { summaryTemplate: '结果：${unknown_var}', metrics: [], dataRowFields: [] },
    }
    const draft = compileScenarioDocument(source, { mode: 'save' })
    expect(draft.diagnostics.find((item) => item.code === 'OUTPUT_VARIABLE_UNRESOLVED')?.severity).toBe('warning')
    const published = compileScenarioDocument(source, { mode: 'release' })
    expect(published.diagnostics.find((item) => item.code === 'OUTPUT_VARIABLE_UNRESOLVED')?.severity).toBe('error')
  })

  it('发布时允许业务结论模板引用已声明的指标 key', () => {
    const source = {
      ...document([echo(ids.a, '读取商品数', { value: '42', outputKey: 'count' })]),
      outputs: {
        summaryTemplate: '巡检完成，在售商品 ${item_count} 件',
        metrics: [{ key: 'item_count', name: '商品数', fromContextKey: 'count' }],
        dataRowFields: [],
      },
    }
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'OUTPUT_VARIABLE_UNRESOLVED')).toBe(false)
  })

  it('活跃步骤引用已停用步骤的输出变量产生 SCENARIO_DISABLED_STEP_OUTPUT_REFERENCED 警告', () => {
    const disabledExtract: Step = {
      id: ids.a,
      name: '停用提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      disabled: true,
      outputKey: 'token',
      input: { target: { framePath: [], candidates: [{ by: 'label', value: '令牌' }] }, as: 'text' },
    }
    const activeEcho: Step = {
      id: ids.b,
      name: '回显令牌',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { from: 'token' },
    }
    const source = document([disabledExtract, activeEcho])
    const result = compileScenarioDocument(source, { mode: 'save' })
    expect(
      result.diagnostics.some(
        (d) => d.code === 'SCENARIO_DISABLED_STEP_OUTPUT_REFERENCED' && d.severity === 'warning',
      ),
    ).toBe(true)
  })

  it('全部步骤停用时阻断试跑与发布；至少一步启用即可通过', () => {
    const allDisabled = document([
      { ...echo(ids.a, '甲', { value: '1' }), disabled: true },
      { ...echo(ids.b, '乙', { value: '2' }), disabled: true },
    ])
    for (const mode of ['save', 'release'] as const) {
      const result = compileScenarioDocument(allDisabled, { mode })
      expect(result.ok).toBe(false)
      expect(
        result.diagnostics.some((d) => d.code === 'SCENARIO_ALL_STEPS_DISABLED' && d.severity === 'error'),
      ).toBe(true)
    }

    const oneEnabled = document([
      { ...echo(ids.a, '甲', { value: '1' }), disabled: true },
      echo(ids.b, '乙', { value: '2' }),
    ])
    const result = compileScenarioDocument(oneEnabled, { mode: 'release' })
    expect(result.diagnostics.some((d) => d.code === 'SCENARIO_ALL_STEPS_DISABLED')).toBe(false)
  })

  it('停用的副作用步骤与存量断言不参与成功条件覆盖诊断', () => {
    const disabledClick: Step = {
      id: ids.a,
      name: '停用的提交',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      disabled: true,
      input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '提交' }] } },
    }
    const disabledAssert: Step = {
      id: ids.b,
      name: '停用的断言',
      type: 'assert',
      effectType: 'READ_ONLY',
      disabled: true,
      input: {
        target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '完成' }] },
        expect: { kind: 'visible' },
      },
    }
    const result = compileScenarioDocument(document([navigate(ids.c), disabledClick, disabledAssert]), {
      mode: 'save',
    })
    // 唯一的断言已停用：不能把它算成成功条件，也不对停用的提交追问成功条件。
    expect(result.diagnostics.some((d) => d.code === 'SCENARIO_NO_OUTCOME')).toBe(true)
    expect(
      result.diagnostics.some((d) => d.code === 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME' && d.stepId === ids.a),
    ).toBe(false)
  })
})
