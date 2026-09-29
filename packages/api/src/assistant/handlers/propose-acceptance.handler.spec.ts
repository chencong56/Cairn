import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AcceptanceIntentRequest,
  type AssistantAuthoringProposal,
  type AssistantResult,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  loadRunDetail: vi.fn(),
  listRunStructureSnapshots: vi.fn().mockResolvedValue([]),
  expandWithLoader: vi.fn().mockResolvedValue({ diagnostics: [] }),
  newId: vi.fn(() => crypto.randomUUID()),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('../model-session.js', () => ({
  generateAcceptanceTargets: vi.fn(),
  generateAcceptanceIntents: vi.fn(),
}))

import { getScenario, listRunStructureSnapshots, loadRunDetail } from '@cairn/db'
import { generateAcceptanceIntents, generateAcceptanceTargets } from '../model-session.js'
import {
  countHeaderRows,
  handleScenarioProposeAcceptance,
  isCandidateGrounded,
  isVolatileValueText,
} from './propose-acceptance.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

const NAV_ID = '11111111-1111-4111-8111-111111111111'
const CLICK_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const EVIDENCE_ID = '44444444-4444-4444-8444-444444444444'

const TABLE_SNAPSHOT = [
  '- heading "订单管理" [level=1]',
  '- table "订单列表":',
  '  - rowgroup:',
  '    - row "订单号 金额":',
  '      - columnheader "订单号"',
  '      - columnheader "金额"',
  '  - rowgroup:',
  '    - row "A001 120":',
  '      - cell "A001"',
  '      - cell "120"',
  '    - row "A002 80":',
  '      - cell "A002"',
  '      - cell "80"',
  '- status "共 2 条"',
].join('\n')

function sampleScenario(): ScenarioDetailDto {
  const doc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [],
    nodes: [
      {
        kind: 'step',
        step: { id: NAV_ID, name: '打开订单页面', type: 'navigate', effectType: 'READ_ONLY', input: { url: 'https://example.com/orders' } },
      },
      {
        kind: 'step',
        step: {
          id: CLICK_ID,
          name: '点击查询',
          type: 'click',
          effectType: 'IDEMPOTENT',
          input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '查询' }] } },
        },
      },
    ],
  }
  return {
    id: 'sc-123',
    targetId: 'tgt-1',
    name: '订单查询',
    status: 'draft',
    draft: { revision: 3, document: doc },
  } as unknown as ScenarioDetailDto
}

function context(
  acceptance: { baselineRunId?: string; intents: AcceptanceIntentRequest[] } | undefined,
  overrides: Partial<AssistantCapabilityHandlerContext> = {},
): AssistantCapabilityHandlerContext {
  return {
    db: {} as never,
    actor: { id: 'usr-1', permissions: ['ai:assist', 'workflow:write', 'workflow:read', 'target:read'] } as never,
    slots: { scenarioId: 'sc-123' },
    question: '为当前场景补全验收',
    body: {
      question: '为当前场景补全验收',
      capabilityHint: 'scenario.propose-acceptance',
      ...(acceptance ? { acceptance } : {}),
    },
    session: null,
    platformConfig: {} as never,
    targets: {} as never,
    models: {} as never,
    onProgress: vi.fn(),
    ...overrides,
  }
}

function asProposal(result: AssistantResult): AssistantAuthoringProposal & { cards: NonNullable<AssistantAuthoringProposal['cards']> } {
  expect(result.kind).toBe('authoring_proposal')
  const p = result as AssistantAuthoringProposal
  expect(p.cards).toBeDefined()
  return p as AssistantAuthoringProposal & { cards: NonNullable<AssistantAuthoringProposal['cards']> }
}

function withBaseline() {
  vi.mocked(loadRunDetail).mockResolvedValue({ id: RUN_ID, scenarioId: 'sc-123' } as never)
  vi.mocked(listRunStructureSnapshots).mockResolvedValue([
    {
      evidenceId: EVIDENCE_ID,
      stepRunId: 'sr-2',
      attemptId: 'att-2',
      stepId: CLICK_ID,
      snapshot: TABLE_SNAPSHOT,
      truncated: false,
      createdAt: new Date(),
    },
  ])
}

describe('handleScenarioProposeAcceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getScenario).mockResolvedValue(sampleScenario())
    vi.mocked(loadRunDetail).mockResolvedValue(null as never)
    vi.mocked(listRunStructureSnapshots).mockResolvedValue([])
  })

  it('耗时与整页文字意图不依赖定位：一次出多卡，条件违规后继续并记为 ai_compiled', async () => {
    const result = await handleScenarioProposeAcceptance(
      context({
        intents: [
          { key: 'k1', kind: 'page_duration', stepId: NAV_ID, severity: 'SHOULD', maxMs: 3000 },
          { key: 'k2', kind: 'text_present_or_absent', stepId: CLICK_ID, severity: 'MUST', text: '系统异常', absent: true },
        ],
      }),
    )
    const proposal = asProposal(result)
    expect(proposal.source).toBe('acceptance')
    expect(proposal.cards?.map((card) => card.intentKey)).toEqual(['k1', 'k2'])
    expect(proposal.cards?.every((card) => card.testResult === 'NOT_REQUIRED')).toBe(true)
    const outcomes = proposal.operations.filter((op) => op.kind === 'add_outcome')
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((op) => op.kind === 'add_outcome' && op.onViolation === 'continue' && op.provenance === 'ai_compiled')).toBe(true)
    const textRule = outcomes[1]!.kind === 'add_outcome' ? outcomes[1]!.rule : undefined
    expect(textRule).toEqual({ kind: 'deterministic', expect: { kind: 'text_absent', value: '系统异常' } })
    const metrics = proposal.operations.find((op) => op.kind === 'set_outputs')
    expect(metrics?.kind === 'set_outputs' && metrics.metrics?.[0]?.fromStepDuration).toEqual({ stepId: NAV_ID })
    expect(proposal.cards?.[0]?.summarySnippet).toMatch(/\$\{acc_ms_[a-z0-9]+\}/)
  })

  it('需要定位的意图在没有基线也没有点选时被拦下；全部拦下时改为澄清', async () => {
    const result = await handleScenarioProposeAcceptance(
      context({ intents: [{ key: 'k1', kind: 'table_non_empty', stepId: CLICK_ID, severity: 'MUST' }] }),
    )
    expect(result.kind).toBe('clarify')
    if (result.kind === 'clarify') expect(result.question).toContain('基线运行')
  })

  it('人工点选的表格行：插入取数与计数步骤，按基线表头行数扣除，并把条件挂在计数步骤上', async () => {
    withBaseline()
    const result = await handleScenarioProposeAcceptance(
      context({
        baselineRunId: RUN_ID,
        intents: [
          {
            key: 'k1',
            kind: 'table_non_empty',
            stepId: CLICK_ID,
            severity: 'MUST',
            metricName: '订单数',
            target: { framePath: [], candidates: [{ by: 'role', value: 'row' }] },
          },
        ],
      }),
    )
    const proposal = asProposal(result)
    const card = proposal.cards![0]!
    expect(card.targetSource).toBe('manual')
    expect(card.expectsMany).toBe(true)
    expect(card.evidenceId).toBe(EVIDENCE_ID)
    const inserts = proposal.operations.filter((op) => op.kind === 'insert_step')
    expect(inserts).toHaveLength(2)
    const [extractOp, computeOp] = inserts
    expect(extractOp?.kind === 'insert_step' && extractOp.step.type).toBe('extract')
    expect(extractOp?.kind === 'insert_step' && extractOp.anchorStepId).toBe(CLICK_ID)
    expect(computeOp?.kind === 'insert_step' && computeOp.anchorStepId).toBe(extractOp?.kind === 'insert_step' ? extractOp.step.id : '')
    const expression = computeOp?.kind === 'insert_step' ? (computeOp.step.input as { expression: unknown }).expression : undefined
    expect(JSON.stringify(expression)).toContain('"value":-1')
    const outcome = proposal.operations.find((op) => op.kind === 'add_outcome')
    expect(outcome?.kind === 'add_outcome' && outcome.stepId).toBe(computeOp?.kind === 'insert_step' ? computeOp.step.id : '')
    expect(outcome?.kind === 'add_outcome' && outcome.rule.kind).toBe('context')
    expect(proposal.executable).toBe(true)
  })

  it('模型按基线结构定位：定位必须出现在快照里，否则拦下', async () => {
    withBaseline()
    vi.mocked(generateAcceptanceTargets).mockResolvedValue({
      output: {
        items: [
          { key: 'ok', candidates: [{ by: 'role', value: 'status', name: '共 2 条' }], label: '订单总数', rationale: '状态栏显示总条数' },
          { key: 'bad', candidates: [{ by: 'role', value: 'cell', name: '库存 999' }], rationale: '编造的名称' },
        ],
      },
    })
    const result = await handleScenarioProposeAcceptance(
      context(
        {
          baselineRunId: RUN_ID,
          intents: [
            { key: 'ok', kind: 'extract_to_report', stepId: CLICK_ID, severity: 'SHOULD', metricName: '订单总数' },
            { key: 'bad', kind: 'number_range', stepId: CLICK_ID, severity: 'MUST', op: 'gte', value: 1 },
          ],
        },
        { session: {} as never },
      ),
    )
    const proposal = asProposal(result)
    const [ok, bad] = proposal.cards!
    expect(ok?.targetSource).toBe('model')
    expect(ok?.operationIds.length).toBeGreaterThan(0)
    expect(bad?.blockedReason).toBe('MODEL_TARGET_UNGROUNDED')
    expect(bad?.operationIds).toEqual([])
    expect(generateAcceptanceTargets).toHaveBeenCalledTimes(1)
  })

  it('未配置模型且没有点选时提示点选，不去猜定位', async () => {
    withBaseline()
    const result = await handleScenarioProposeAcceptance(
      context({
        baselineRunId: RUN_ID,
        intents: [
          { key: 'k1', kind: 'page_reachable', stepId: CLICK_ID, severity: 'MUST' },
          { key: 'k2', kind: 'page_duration', stepId: CLICK_ID, severity: 'MUST', maxMs: 5000 },
        ],
      }),
    )
    const proposal = asProposal(result)
    expect(proposal.cards?.[0]?.blockedReason).toBe('NEEDS_MANUAL_PICK')
    expect(proposal.cards?.[1]?.blockedReason).toBeUndefined()
  })

  it('一次 6 张卡超过通用助手 4 项上限，验收提案照常放行', async () => {
    withBaseline()
    const target = { framePath: [], candidates: [{ by: 'role' as const, value: 'row' }] }
    const intents: AcceptanceIntentRequest[] = [
      { key: 'a', kind: 'table_non_empty', stepId: CLICK_ID, severity: 'MUST', target },
      { key: 'b', kind: 'table_non_empty', stepId: CLICK_ID, severity: 'SHOULD', target },
      { key: 'c', kind: 'page_duration', stepId: NAV_ID, severity: 'SHOULD', maxMs: 3000 },
      { key: 'd', kind: 'text_present_or_absent', stepId: CLICK_ID, severity: 'MUST', text: '暂无数据', absent: true },
      { key: 'e', kind: 'extract_to_report', stepId: CLICK_ID, severity: 'SHOULD', metricName: '总数', target },
      { key: 'f', kind: 'page_reachable', stepId: NAV_ID, severity: 'MUST', target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单管理' }] } },
    ]
    const proposal = asProposal(await handleScenarioProposeAcceptance(context({ baselineRunId: RUN_ID, intents })))
    expect(proposal.operations.length).toBeGreaterThan(4)
    expect(proposal.cards).toHaveLength(6)
  })

  it('只有一句话且未配置模型时澄清，引导到意图卡', async () => {
    const result = await handleScenarioProposeAcceptance(context(undefined))
    expect(result.kind).toBe('clarify')
  })

  it('一句话由模型拆成意图：不在草稿里的步骤被丢弃', async () => {
    vi.mocked(generateAcceptanceIntents).mockResolvedValue({
      output: {
        intents: [
          { kind: 'page_duration', stepId: NAV_ID, maxMs: 4000 },
          { kind: 'page_duration', stepId: 'not-in-draft', maxMs: 4000 },
        ],
      },
    })
    const proposal = asProposal(await handleScenarioProposeAcceptance(context(undefined, { session: {} as never })))
    expect(proposal.cards).toHaveLength(1)
    expect(proposal.cards?.[0]?.stepId).toBe(NAV_ID)
  })
})

describe('会变的数值不能当定位', () => {
  it('纯数值、金额、百分比视为易变文字', () => {
    expect(isVolatileValueText('$9942.41')).toBe(true)
    expect(isVolatileValueText('308')).toBe(true)
    expect(isVolatileValueText('12.5%')).toBe(true)
    expect(isVolatileValueText('余额')).toBe(false)
    expect(isVolatileValueText('共 2 条')).toBe(false)
  })

  it('模型只给出数值文字时拦下，要求点选', async () => {
    withBaseline()
    vi.mocked(generateAcceptanceTargets).mockResolvedValue({
      output: { items: [{ key: 'k', candidates: [{ by: 'text', value: 'A001' }, { by: 'role', value: 'cell', name: '120' }], rationale: '金额' }] },
    })
    const proposal = await handleScenarioProposeAcceptance(
      context(
        {
          baselineRunId: RUN_ID,
          intents: [
            { key: 'k', kind: 'extract_to_report', stepId: CLICK_ID, severity: 'SHOULD', metricName: '金额' },
            { key: 'd', kind: 'page_duration', stepId: NAV_ID, severity: 'SHOULD', maxMs: 3000 },
          ],
        },
        { session: {} as never },
      ),
    )
    expect(proposal.kind).toBe('authoring_proposal')
    if (proposal.kind !== 'authoring_proposal') return
    // A001 是数据但不是纯数值，保留；120 是纯数值，剔除
    expect(proposal.cards?.[0]?.target?.candidates).toEqual([{ by: 'text', value: 'A001' }])
    vi.mocked(generateAcceptanceTargets).mockResolvedValue({
      output: { items: [{ key: 'k', candidates: [{ by: 'role', value: 'cell', name: '120' }], rationale: '金额' }] },
    })
    const blocked = await handleScenarioProposeAcceptance(
      context(
        {
          baselineRunId: RUN_ID,
          intents: [
            { key: 'k', kind: 'extract_to_report', stepId: CLICK_ID, severity: 'SHOULD', metricName: '金额' },
            { key: 'd', kind: 'page_duration', stepId: NAV_ID, severity: 'SHOULD', maxMs: 3000 },
          ],
        },
        { session: {} as never },
      ),
    )
    expect(blocked.kind === 'authoring_proposal' && blocked.cards?.[0]?.blockedReason).toBe('MODEL_TARGET_UNGROUNDED')
  })
})

describe('定位接地与表头统计', () => {
  it('角色与名称都要在快照里出现', () => {
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'role', value: 'row' })).toBe(true)
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'role', value: 'status', name: '共 2 条' })).toBe(true)
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'role', value: 'button', name: '导出' })).toBe(false)
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'role', value: 'rowgroup' })).toBe(true)
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'text', value: 'A001' })).toBe(true)
    expect(isCandidateGrounded(TABLE_SNAPSHOT, { by: 'css', value: 'tbody tr' })).toBe(false)
    const quoted = `- table:\n  - rowgroup:\n    - 'row "Select key dddd sk-2dd"':\n      - cell "dddd"`
    expect(isCandidateGrounded(quoted, { by: 'role', value: 'row' })).toBe(true)
    expect(countHeaderRows(`- 'row "A B"':\n  - 'columnheader "A"'\n- 'row "1 2"':\n  - cell "1"`)).toBe(1)
  })

  it('只数包含 columnheader 的行', () => {
    expect(countHeaderRows(TABLE_SNAPSHOT)).toBe(1)
    expect(countHeaderRows('- row "A":\n  - cell "A"')).toBe(0)
  })
})

describe('验收意图（二期）：自由描述、全程耗时与跨页一致', () => {
  beforeEach(() => {
    vi.mocked(getScenario).mockResolvedValue(sampleScenario())
  })

  it('自由描述拆解意图，且不支持的部分带出在 proposal.unsupported', async () => {
    vi.mocked(generateAcceptanceIntents).mockResolvedValue({
      output: {
        intents: [
          { kind: 'scenario_duration', maxMs: 15000, severity: 'MUST' },
        ],
        unsupported: [
          { excerpt: '发飞书消息', reason: '暂不支持发送飞书通知' },
        ],
      },
    })

    const res = await handleScenarioProposeAcceptance(
      context(
        undefined,
        {
          body: {
            question: '补全验收',
            acceptance: { intents: [], description: '整个流程不能超过 15 秒，结束后发飞书消息' },
          },
          session: {} as never,
        },
      ),
    )

    const proposal = asProposal(res)
    expect(proposal.unsupported).toEqual([
      { excerpt: '发飞书消息', reason: '暂不支持发送飞书通知' },
    ])
    expect(proposal.cards).toHaveLength(1)
    expect(proposal.cards[0]?.intentKind).toBe('scenario_duration')
    expect(proposal.cards[0]?.meaning).toContain('15秒')
  })

  it('全程耗时意图卡生成场景级 run_duration 条件与 fromRunDuration 指标', async () => {
    const res = await handleScenarioProposeAcceptance(
      context({
        intents: [
          { key: 'sd', kind: 'scenario_duration', maxMs: 30000, severity: 'MUST' },
        ],
      }),
    )

    const proposal = asProposal(res)
    expect(proposal.cards).toHaveLength(1)
    const card = proposal.cards[0]!
    expect(card.intentKind).toBe('scenario_duration')
    expect(card.stepId).toBeUndefined()
    expect(card.meaning).toBe('全程耗时不超过 30秒')
    expect(card.config).toMatchObject({ ruleKind: 'run_duration' })

    // 检查操作
    const outcomeOp = proposal.operations.find((op) => op.kind === 'add_outcome')
    expect(outcomeOp).toBeDefined()
    if (outcomeOp && outcomeOp.kind === 'add_outcome') {
      expect(outcomeOp.stepId).toBeUndefined()
      expect(outcomeOp.rule).toEqual({ kind: 'run_duration', op: 'lte', valueMs: 30000 })
    }

    const metricOp = proposal.operations.find((op) => op.kind === 'set_outputs')
    expect(metricOp).toBeDefined()
    if (metricOp && metricOp.kind === 'set_outputs') {
      expect(metricOp.metrics?.[0]?.fromRunDuration).toBe(true)
      expect(metricOp.metrics?.[0]?.name).toBe('全程耗时')
    }
  })

  it('跨页数值一致意图卡在较后一步插入 compute 步骤，并生成 context 场景级条件', async () => {
    const step1Id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const step2Id = 'bbbbbbbb-2222-4222-8222-222222222222'

    const customDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: step1Id,
            name: '提取账户余额',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'balanceBefore',
            input: { target: { framePath: [], candidates: [{ by: 'role', value: 'cell', name: '余额' }] }, as: 'text' },
          },
        },
        {
          kind: 'step',
          step: {
            id: step2Id,
            name: '提取结算金额',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'balanceAfter',
            input: { target: { framePath: [], candidates: [{ by: 'role', value: 'cell', name: '结算' }] }, as: 'text' },
          },
        },
      ],
    }

    vi.mocked(getScenario).mockResolvedValue({
      id: 'sc-123',
      targetId: 'tgt-1',
      name: '对账场景',
      status: 'draft',
      draft: { revision: 1, document: customDoc },
    } as unknown as ScenarioDetailDto)

    const res = await handleScenarioProposeAcceptance(
      context({
        intents: [
          {
            key: 'vc',
            kind: 'value_consistency',
            stepIdA: step1Id,
            stepIdB: step2Id,
            tolerance: 0.5,
            metricName: '余额对账差额',
            severity: 'MUST',
          },
        ],
      }),
    )

    const proposal = asProposal(res)
    expect(proposal.cards).toHaveLength(1)
    const card = proposal.cards[0]!
    expect(card.intentKind).toBe('value_consistency')
    expect(card.stepId).toBeUndefined()
    expect(card.meaning).toContain('差值不超过 0.5')

    // 检查插入 compute 步骤在 step2 之后
    const insertOp = proposal.operations.find((op) => op.kind === 'insert_step')
    expect(insertOp).toBeDefined()
    if (insertOp && insertOp.kind === 'insert_step') {
      expect(insertOp.anchorStepId).toBe(step2Id)
      expect(insertOp.step.type).toBe('compute')
      expect(insertOp.step.input).toMatchObject({
        expression: {
          kind: 'call',
          fn: 'abs',
          args: [
            {
              kind: 'call',
              fn: 'diff',
              args: [
                { kind: 'call', fn: 'extractNumber', args: [{ kind: 'ref', key: 'balanceBefore' }] },
                { kind: 'call', fn: 'extractNumber', args: [{ kind: 'ref', key: 'balanceAfter' }] },
              ],
            },
          ],
        },
      })
    }

    // 检查 outcome 条件
    const outcomeOp = proposal.operations.find((op) => op.kind === 'add_outcome')
    expect(outcomeOp).toBeDefined()
    if (outcomeOp && outcomeOp.kind === 'add_outcome') {
      expect(outcomeOp.rule).toMatchObject({
        kind: 'context',
        expect: { kind: 'number_compare', op: 'lte', value: 0.5 },
      })
    }
  })

  it('跨页一致步骤未提取 outputKey 时卡片被 VALUE_SOURCE_MISSING 拦下', async () => {
    // 伴随其他可用意图时生成提案并展示拦截原因
    const res = await handleScenarioProposeAcceptance(
      context({
        intents: [
          {
            key: 'vc-no-out',
            kind: 'value_consistency',
            stepIdA: NAV_ID,
            stepIdB: CLICK_ID,
            severity: 'MUST',
          },
          {
            key: 'sd-ok',
            kind: 'scenario_duration',
            maxMs: 30000,
            severity: 'SHOULD',
          },
        ],
      }),
    )

    const proposal = asProposal(res)
    expect(proposal.cards).toHaveLength(2)
    const blockedCard = proposal.cards.find((c) => c.intentKey === 'vc-no-out')
    expect(blockedCard?.blockedReason).toBe('VALUE_SOURCE_MISSING')
    expect(blockedCard?.blockedMessage).toContain('未提取变量')

    // 唯一步骤被拦截时降级为澄清
    const alone = await handleScenarioProposeAcceptance(
      context({
        intents: [
          {
            key: 'vc-no-out',
            kind: 'value_consistency',
            stepIdA: NAV_ID,
            stepIdB: CLICK_ID,
            severity: 'MUST',
          },
        ],
      }),
    )
    expect(alone.kind).toBe('clarify')
    if (alone.kind === 'clarify') {
      expect(alone.question).toContain('未提取变量')
    }
  })

  it('跨页一致步骤位于分支或循环内部时被 VALUE_SOURCE_MISSING 拦下', async () => {
    const blockStepId = 'cccccccc-3333-4333-8333-333333333333'
    const nestedDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: NAV_ID,
            name: '主干步骤',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'mainKey',
            input: { target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] }, as: 'text' },
          },
        },
        {
          kind: 'block',
          blockId: '01912345-0000-7000-8000-000000000010',
          control: { type: 'if', condition: { kind: 'ref', key: 'mainKey' } },
          then: [
            {
              kind: 'step',
              step: {
                id: blockStepId,
                name: '分支内步骤',
                type: 'extract',
                effectType: 'READ_ONLY',
                outputKey: 'subKey',
                input: { target: { framePath: [], candidates: [{ by: 'text', value: 'y' }] }, as: 'text' },
              },
            },
          ],
        },
      ],
    }

    vi.mocked(getScenario).mockResolvedValue({
      id: 'sc-123',
      targetId: 'tgt-1',
      name: '分支场景',
      status: 'draft',
      draft: { revision: 1, document: nestedDoc },
    } as unknown as ScenarioDetailDto)

    const res = await handleScenarioProposeAcceptance(
      context({
        intents: [
          {
            key: 'vc-block',
            kind: 'value_consistency',
            stepIdA: NAV_ID,
            stepIdB: blockStepId,
            severity: 'MUST',
          },
          {
            key: 'sd-ok',
            kind: 'scenario_duration',
            maxMs: 30000,
            severity: 'SHOULD',
          },
        ],
      }),
    )

    const proposal = asProposal(res)
    expect(proposal.cards).toHaveLength(2)
    const blockedCard = proposal.cards.find((c) => c.intentKey === 'vc-block')
    expect(blockedCard?.blockedReason).toBe('VALUE_SOURCE_MISSING')
    expect(blockedCard?.blockedMessage).toContain('位于分支或循环内部')
  })
})
