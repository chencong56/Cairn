import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scenarioAuthoringDocumentV2Schema, scheduleDefinitionSchema, suiteDocumentSchema, moduleContractSchema, type ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { dispatchBusinessAnalyzer, detectBusinessIntent } from './analyzer-dispatcher.js'
import * as db from '@cairn/db'
vi.mock('@cairn/db', () => Object.fromEntries(['listSuites','getSuite','listSuiteRuns','loadScenarioVersion','assertTargetPermission','getAccountSessionDetail','getScenario','listScenarios','getActionModule','getActionModuleVersion','listModuleReferences','listRecordingDrafts','getAssistantRecordingProposalFacts','listSchedules','getSchedule','listScheduleOccurrences','getBatch','getBatchAnalysisFacts','getDataset','getDatasetRows','listBatches','preflightDataset'].map((name) => [name, vi.fn()])))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const targetId = id(1), scenarioId = id(2), versionId = id(3), suiteId = id(4)
const nav = (n: number, url = 'https://example.test') => ({ id: id(n), type: 'navigate' as const, effectType: 'SIDE_EFFECT' as const, name: '打开', input: { url } })
const authoring = (nodes = [nav(10), nav(11)]): ScenarioAuthoringDocumentV2 => scenarioAuthoringDocumentV2Schema.parse({ authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: nodes.map((step) => ({ kind: 'step', step })) })
function ctx(page = 'suite', ref = suiteId, question = '检查'): AssistantCapabilityHandlerContext {
  return { question, session: {} as never, models: {} as never, db: {} as never, actor: { id: id(9), permissions: ['ai:assist','suite:read','workflow:read','workflow:write','module:read','schedule:read','batch:read','dataset:read','session:read','run:read','target:read'], roles: [], displayName: 'User', status: 'active', email: 'test@example.test' }, body: { question, pageContext: { version: 2, routeKey: '/test', page: page as 'suite', pageKind: page as 'suite', primaryRef: { kind: page === 'action-module' ? 'actionModule' : page as 'suite', id: ref } } }, slots: {}, targets: {} as never, platformConfig: {} as never } as AssistantCapabilityHandlerContext
}
function suite() {
  const document = suiteDocumentSchema.parse({ schemaVersion: 1, executionMode: 'sequential', maxConcurrency: 1, failurePolicy: 'stop', sharedInput: {}, members: [], stages: [
    { id: 'first', ordinal: 0, name: '前置', executionMode: 'sequential', maxConcurrency: 1, failurePolicy: 'stop', members: [{ memberId: 'producer', ordinal: 0, scenarioId, scenarioVersionId: versionId, input: {} }] },
    { id: 'second', ordinal: 1, name: '后续', executionMode: 'sequential', maxConcurrency: 1, failurePolicy: 'stop', members: [{ memberId: 'consumer', ordinal: 0, scenarioId, scenarioVersionId: versionId, input: { total: '${stage[first].members[producer].output.total}', missing: '${stage[first].members[producer].output.missing}' } }] },
  ] })
  return { id: suiteId, name: '流程集', targetId, draft: { revision: 1, document }, published: { id: id(5), document } }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(db.assertTargetPermission).mockResolvedValue(undefined)
})
describe('business analyzers use domain contracts', () => {
  it.each([
    ['suite', '分析场景集依赖', 'suite.dependencies'], ['suite', '检查依赖与账号约束下的候选分组', 'suite.resource-groups'],
    ['action-module', '参数契约', 'module.input-contract'], ['recording', '录制质量', 'recording.quality'],
    ['schedule', '未来窗口重叠', 'schedule.window-overlap'], ['batch', '批量任务参数映射', 'batch.input-mapping'],
    ['batch', '批量任务并发', 'batch.resource-limits'],
  ])('routes %s / %s', (pageKind, question, intent) => expect(detectBusinessIntent({ pageKind }, question)).toBe(intent))
  it('reads fixed versions and recognizes real stage output expressions and undeclared outputs', async () => {
    vi.mocked(db.getSuite).mockResolvedValue(suite() as never)
    vi.mocked(db.loadScenarioVersion).mockResolvedValue({ scenario: { id: scenarioId, targetId }, version: { id: versionId, authoringDocument: { ...authoring(), outputs: { metrics: [{ key: 'total', name: '总计', fromRunDuration: true }], dataRowFields: [] } } } } as never)
    const result = await dispatchBusinessAnalyzer(ctx(), 'suite.dependencies')
    expect(result.analysis?.findings.map((f) => f.code)).toContain('SUITE_DEPENDENCY_EDGE')
    expect(result.analysis?.findings.map((f) => f.code)).toContain('SUITE_MISSING_OUTPUT')
    expect(db.loadScenarioVersion).toHaveBeenCalledWith(expect.anything(), scenarioId, versionId)
    expect(result.sourceManifest?.sources.some((s) => s.kind === 'scenario' && s.version === versionId)).toBe(true)
  })
  it('uses only recent, finished, same-version and same-strategy duration samples', async () => {
    const s = suite(); vi.mocked(db.getSuite).mockResolvedValue(s as never)
    const now = Date.now()
    const runs = [60, 90, 120, 150, 180].map((duration, i) => ({ id: id(30 + i), targetId, suiteVersionId: s.published.id, executionMode: s.published.document.executionMode, maxConcurrency: s.published.document.maxConcurrency, failurePolicy: s.published.document.failurePolicy, status: 'COMPLETED', createdAt: new Date(now - 200000).toISOString(), startedAt: new Date(now - 200000).toISOString(), finishedAt: new Date(now - 200000 + duration * 1000).toISOString() }))
    vi.mocked(db.listSuiteRuns).mockResolvedValue({ items: [...runs, { ...runs[0], id: id(99), suiteVersionId: id(100) }] } as never)
    let result = await dispatchBusinessAnalyzer(ctx(), 'suite.duration')
    expect(result.analysis?.sampleSize).toBe(5); expect(result.summary).toContain('中位数 120 秒'); expect(result.summary).toContain('P90 180 秒')
    vi.mocked(db.listSuiteRuns).mockResolvedValue({ items: runs.slice(0, 4) } as never)
    result = await dispatchBusinessAnalyzer(ctx(), 'suite.duration')
    expect(result.analysis?.coverage).toBe('partial'); expect(result.summary).not.toContain('P90')
  })
  it('compares actual scenario documents, ignores display names, and rejects different inputs', async () => {
    vi.mocked(db.listScenarios).mockResolvedValue({ items: [{ id: id(50) }, { id: id(51) }] } as never)
    const documents = [authoring(), authoring([nav(12), nav(13)])]
    vi.mocked(db.getScenario).mockImplementation(async (_db, ref) => ({ id: ref, targetId, name: '同名场景', draft: { revision: 1, document: documents[ref === id(50) ? 0 : 1] } }) as never)
    const c = ctx('action-module')
    c.body.pageContext = { version: 2, routeKey: '/action-modules', pageKind: 'action-module', page: 'action-module', view: { filters: { targetId, q: '模块名称' } } }
    let result = await dispatchBusinessAnalyzer(c, 'module.repeated-fragments')
    expect(result.analysis?.findings).toHaveLength(1)
    expect(result.analysis?.findings[0]?.message).toContain('出处：「同名场景」')
    expect(result.analysis?.scope).toMatchObject({ targetId, scannedScenarios: 2 })
    expect(result.analysis?.scope).not.toHaveProperty('q')
    expect(result.analysis?.missing?.join('')).toContain('仅按目标范围')
    documents[1] = authoring([nav(12, 'https://different.test'), nav(13)])
    result = await dispatchBusinessAnalyzer(ctx('action-module'), 'module.repeated-fragments')
    expect(result.analysis?.findings).toHaveLength(0)
  })
  it('does not invent module input default values absent from the actual contract', async () => {
    const contract = moduleContractSchema.parse({ inputs: [{ key: 'query', label: '查询', valueType: 'string', required: true }], outputs: [], effectCeiling: 'SIDE_EFFECT' })
    vi.mocked(db.getActionModule).mockResolvedValue({ id: id(60), targetId, name: '查询', draftRevision: 3, draftContent: { contract } } as never)
    const result = await dispatchBusinessAnalyzer(ctx('action-module', id(60)), 'module.input-contract')
    expect(result.analysis?.coverage).toBe('complete'); expect(result.analysis?.findings[0]?.message).toContain('必填')
    expect(result.analysis?.findings.some((f) => f.code.includes('DEFAULT'))).toBe(false)
  })
  it('detects intersecting windows with different start times and excludes disabled schedules', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
    try {
      const definition = (start: string, end: string) => scheduleDefinitionSchema.parse({ timezone: 'UTC', weekdays: [1,2,3,4,5,6,7], windowStart: start, windowEnd: end, misfire: 'skip', consumer: { type: 'knowledge_analysis', targetId, mode: 'map_quality' } })
      vi.mocked(db.listSchedules).mockResolvedValue({ items: [
        { scheduleId: id(61), targetId, name: 'A', enabled: true, definition: definition('09:00','10:00') },
        { scheduleId: id(62), targetId, name: 'B', enabled: true, definition: definition('09:30','10:30') },
        { scheduleId: id(63), targetId, name: 'Disabled', enabled: false, definition: definition('09:00','10:00') },
      ] } as never)
      const result = await dispatchBusinessAnalyzer(ctx('schedule'), 'schedule.window-overlap')
      expect(result.analysis?.findings.filter((f) => f.code === 'SCHEDULE_WINDOW_OVERLAP_DETECTED')).toHaveLength(1)
      expect(result.analysis?.findings.filter((f) => f.code === 'SCHEDULE_START_CLUSTER')).toHaveLength(0)
      expect(result.summary).toContain('2 个可准入窗口')
    } finally { vi.useRealTimers() }
  })
  it('counts seven-day scheduled occurrences separately from manual and older occurrences', async () => {
    vi.mocked(db.getSchedule).mockResolvedValue({ scheduleId: id(61), targetId, name: '计划' } as never)
    const fresh = new Date().toISOString(), old = new Date(Date.now() - 8 * 86400000).toISOString()
    vi.mocked(db.listScheduleOccurrences).mockResolvedValue({ items: [
      { occurrenceId: id(62), source: 'scheduled', admissionStatus: 'SKIPPED', reason: 'AUTH_PREPARATION_REQUIRED', createdAt: fresh },
      { occurrenceId: id(63), source: 'manual', admissionStatus: 'SKIPPED', reason: 'BUSY', createdAt: fresh },
      { occurrenceId: id(64), source: 'scheduled', admissionStatus: 'SKIPPED', reason: 'BUSY', createdAt: old },
    ] } as never)
    const result = await dispatchBusinessAnalyzer(ctx('schedule', id(61)), 'schedule.skip-summary')
    expect(result.summary).toContain('跳过 1 次'); expect(result.summary).toContain('手工触发 1 次')
    expect(result.analysis?.findings[0]?.message).toContain('认证尚未准备：1 次')
    expect(result.sourceManifest?.sources.some((s) => s.id === id(64))).toBe(false)
  })
  it('keeps mapping incomplete when the dataset cannot be read', async () => {
    vi.mocked(db.getBatchAnalysisFacts).mockResolvedValue({ batch: { id: id(70), name: '批量', datasetId: id(71) }, binding: {} } as never)
    vi.mocked(db.getDataset).mockRejectedValue(new Error('unavailable'))
    const result = await dispatchBusinessAnalyzer(ctx('batch', id(70)), 'batch.input-mapping')
    expect(result.analysis?.coverage).toBe('partial'); expect(result.summary).toContain('检查不完整')
  })
  it('does not guess concurrency from pacing configuration', async () => {
    vi.mocked(db.getBatch).mockResolvedValue({ id: id(70), name: '批量', scenarioId, pacingConfig: { minDelayMs: 500, maxDelayMs: 1000 } } as never)
    vi.mocked(db.getScenario).mockResolvedValue({ id: scenarioId, targetId } as never)
    const result = await dispatchBusinessAnalyzer(ctx('batch', id(70)), 'batch.resource-limits')
    expect(result.summary).toContain('500–1000'); expect(result.analysis?.coverage).toBe('partial')
    expect(result.summary).not.toContain('并发 1')
  })
  it('passes business filters and marks bounded collections partial', async () => {
    vi.mocked(db.listSuites).mockResolvedValue({ items: [], nextCursor: 'more' } as never)
    const c = ctx(); c.body.pageContext = { version: 2, routeKey: '/suites', pageKind: 'suite', page: 'suite', view: { filters: { targetId, search: '夜间' } } }
    const result = await dispatchBusinessAnalyzer(c, 'suite.collection-summary')
    expect(db.listSuites).toHaveBeenCalledWith(c.db, { targetId, search: '夜间', limit: 100 }, c.actor.id)
    expect(result.analysis?.coverage).toBe('partial'); expect(result.sourceManifest?.scope.ownerAccountId).toBe(c.actor.id)
  })
  it('requires permissions before reading domain facts', async () => {
    const c = ctx(); c.actor.permissions = ['ai:assist']
    const result = await dispatchBusinessAnalyzer(c, 'suite.dependencies')
    expect(result.missing[0]?.reason).toBe('permission_denied'); expect(db.getSuite).not.toHaveBeenCalled()
  })
})
