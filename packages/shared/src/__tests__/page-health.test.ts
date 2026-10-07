import { describe, expect, it } from 'vitest'
import { aggregateRunOutcomeStatus } from '../outcome.js'
import {
  isPageHealthResult,
  isSystemAddress,
  looksIntranetHost,
  matchesPageHealthIgnore,
  mergePageHealthSamples,
  normalizePageUrl,
  pageHealthSummaryText,
  resolveNetworkHealthConfig,
  type PageHealthSample,
} from '../page-health.js'
import {
  createRuntimeInvariant,
  defaultPageHealthInvariants,
  deriveRuntimeInvariantResults,
  runtimeInvariantSchema,
} from '../runtime-invariant.js'
import { assembleRunOutput } from '../run-output.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const registrableDomain = (host: string) => host.split('.').slice(-2).join('.')

describe('页面健康：契约与默认', () => {
  it('默认 SHOULD + continue + each_step，且只能 each_step', () => {
    for (const kind of ['network_health', 'script_errors'] as const) {
      const inv = createRuntimeInvariant(kind, id(1))
      expect(inv).toMatchObject({ severity: 'SHOULD', onViolation: 'continue', evaluateAt: 'each_step' })
      expect(() => runtimeInvariantSchema.parse({ ...inv, evaluateAt: 'step_boundary' })).toThrow()
    }
    expect(() => runtimeInvariantSchema.parse({ ...createRuntimeInvariant('script_errors', id(2)), network: {} })).toThrow()
    expect(defaultPageHealthInvariants(() => id(3))).toHaveLength(2)
  })

  it('默认不含图片和字体，4xx 与 5xx 都算', () => {
    const config = resolveNetworkHealthConfig(undefined)
    expect(config.resourceTypes).not.toContain('image')
    expect(config.resourceTypes).not.toContain('font')
    expect(config.statusClasses).toEqual(['4xx', '5xx'])
    expect(config.includeExternal).toBe(false)
  })
})

describe('页面健康：地址归一化与忽略', () => {
  it('去查询串、ID 段归一', () => {
    expect(normalizePageUrl('https://a.corp.com/api/order/123456/items?token=abc#x')?.display).toBe('https://a.corp.com/api/order/*/items')
    expect(normalizePageUrl('https://a.corp.com/api/12')?.display).toBe('https://a.corp.com/api/12')
    expect(normalizePageUrl('data:text/plain,hi')).toBeNull()
  })

  it('忽略规则：以 / 开头只匹配路径，* 不跨目录，** 跨目录', () => {
    const url = { origin: 'https://s.example', path: '/static/a/b.js' }
    expect(matchesPageHealthIgnore(url, ['/static/**'])).toBe(true)
    expect(matchesPageHealthIgnore(url, ['/static/*'])).toBe(false)
    expect(matchesPageHealthIgnore(url, ['https://s.example/static/**'])).toBe(true)
    expect(matchesPageHealthIgnore(url, ['https://other.example/**'])).toBe(false)
  })

  it('同一样本合并计数并限制数量', () => {
    const sample: PageHealthSample = { type: 'http', method: 'GET', url: 'https://a/x', status: 500, count: 1, stepRunId: 's1' }
    const merged = mergePageHealthSamples([sample, sample, { ...sample, status: 404 }])
    expect(merged.samples).toHaveLength(2)
    expect(merged.samples[0]!.count).toBe(2)
    expect(mergePageHealthSamples([sample, { ...sample, url: 'https://a/y' }], 1).overflow).toBe(1)
  })
})

describe('页面健康：系统地址', () => {
  const known = new Set(['https://portal.corp.com'])
  const check = (origin: string, extra: string[] = []) =>
    isSystemAddress(origin, { knownOrigins: known, extraOrigins: extra, registrableDomain })

  it('入口、同站、加载过页面的源', () => {
    expect(check('https://portal.corp.com')).toBe(true)
    expect(check('https://api.corp.com')).toBe(true)
    expect(check('https://sso.other.org')).toBe(false)
    expect(isSystemAddress('https://sso.other.org', { knownOrigins: new Set(['https://sso.other.org']), registrableDomain })).toBe(true)
  })

  it('内网写法按地址本身判断（不依赖服务器 IP）', () => {
    for (const host of ['10.1.2.3', '172.20.0.5', '192.168.1.9', '127.0.0.1', '100.100.1.1', 'oa', 'erp.local', 'hr.internal']) {
      expect(looksIntranetHost(host), host).toBe(true)
    }
    for (const host of ['8.8.8.8', '172.32.0.1', 'cdn.example.com', '100.128.0.1']) {
      expect(looksIntranetHost(host), host).toBe(false)
    }
    expect(check('http://10.9.9.9:8080')).toBe(true)
  })

  it('外部 CDN 默认不是系统地址，附加地址可补充', () => {
    expect(check('https://cdn.jsdelivr.net')).toBe(false)
    expect(check('https://cdn.jsdelivr.net', ['https://cdn.jsdelivr.net'])).toBe(true)
    expect(check('https://static.vendor.example', ['*.vendor.example'])).toBe(true)
  })

  it('IP 字面量只认同一主机，忽略端口', () => {
    const ipKnown = new Set(['http://203.0.113.5:8080'])
    expect(isSystemAddress('http://203.0.113.5:9090', { knownOrigins: ipKnown, registrableDomain })).toBe(true)
    expect(isSystemAddress('http://203.0.113.6', { knownOrigins: ipKnown, registrableDomain })).toBe(false)
  })
})

describe('页面健康：结论只降不升', () => {
  const manifestOf = (severity: 'SHOULD' | 'MUST') => {
    const inv = { ...createRuntimeInvariant('network_health', id(10)), severity }
    return { entries: [inv] }
  }
  const failRow = { id: id(20), contractId: id(10), stepRunId: id(21), attemptId: id(22), verdict: 'FAIL' as const, provenance: 'runtime_invariant' as const }

  it('只有健康约束、无违规：未评价（SHOULD 与 MUST 都不会变通过 / 无法判断）', () => {
    expect(aggregateRunOutcomeStatus(null, [], manifestOf('SHOULD'))).toBe('NOT_EVALUATED')
    expect(aggregateRunOutcomeStatus(null, [], manifestOf('MUST'))).toBe('NOT_EVALUATED')
  })

  it('有违规：SHOULD 为警告，MUST 为失败', () => {
    expect(aggregateRunOutcomeStatus(null, [failRow], manifestOf('SHOULD'))).toBe('WARN')
    expect(aggregateRunOutcomeStatus(null, [failRow], manifestOf('MUST'))).toBe('FAIL')
  })

  it('运行结束不补判 PASS / UNKNOWN', () => {
    const invariants = defaultPageHealthInvariants(() => id(30))
    const derived = deriveRuntimeInvariantResults({
      invariants,
      windows: [{ stepId: id(1), stepRunId: id(2), attemptId: id(3), stepType: 'navigate', effectType: 'READ_ONLY', status: 'SUCCEEDED' }],
      errorSurfaces: [{ attemptId: id(3), stepRunId: id(2), stepId: id(1), probed: true, matches: [] }],
      runFinished: true,
    })
    expect(derived).toEqual([])
  })
})

describe('页面健康：发现项', () => {
  const actual = (url: string, count: number) => ({
    kind: 'network_health',
    total: count,
    byClass: { '5xx': count },
    samples: [{ type: 'http', method: 'POST', url, status: 503, count, stepId: id(1) }],
  })
  const result = (n: number, url: string, count: number) => ({
    id: id(n),
    contractId: id(100),
    meaning: '页面接口不得报错',
    severity: 'SHOULD',
    verdict: 'FAIL',
    expected: { kind: 'network_health', violations: 0 },
    actual: actual(url, count),
    stepId: id(1),
  })

  it('同一约束多个违规尝试合并成一条可读发现项', () => {
    const output = assembleRunOutput({
      definition: { steps: [{ id: id(1), name: '提交', type: 'click', effectType: 'SIDE_EFFECT', input: { target: { kind: 'role', role: 'button', name: 'x' } } } as never] },
      outcomeResults: [result(1, 'https://a/api/order', 2), result(2, 'https://a/api/pay', 1)],
      stepRuns: [],
      status: 'SUCCEEDED',
      outcomeStatus: 'WARN',
    })
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]!.severity).toBe('WARN')
    expect(output.findings[0]!.detail).toContain('共 3 处')
    expect(output.findings[0]!.detail).toContain('第 1 步')
    expect(output.status).toBe('WARNING')
  })

  it('警告类发现项不能压掉执行失败发现项', () => {
    const output = assembleRunOutput({
      outcomeResults: [result(1, 'https://a/api/order', 1)],
      stepRuns: [],
      status: 'FAILED',
      outcomeStatus: 'WARN',
      error: { safeMessage: '步骤执行超时' },
    })
    expect(output.findings.map((item) => item.id)).toContain('f-execution-failed')
  })

  it('识别页面健康结果；摘要文字', () => {
    expect(isPageHealthResult(result(1, 'https://a/x', 1))).toBe(true)
    expect(isPageHealthResult({ expected: { kind: 'error_surface' } })).toBe(false)
    const text = pageHealthSummaryText([actual('https://a/x', 2) as never], () => '第 2 步')
    expect(text).toBe('共 2 处：第 2 步 POST https://a/x → 503 ×2')
  })
})

describe('页面请求条件（page_request）', () => {
  const req = (over: Partial<import('../page-health.js').WatchedRequest>) => ({ method: 'POST', url: 'https://a.corp/api/order/*', status: 200, durationMs: 100, ...over })
  const rule = { match: '/api/order/*', method: 'POST', status: '2xx' as const }

  it('契约：只能挂在步骤上，默认状态 2xx，非浏览器步骤被拒', async () => {
    const { outcomeContractSchema, scenarioAuthoringDocumentV2Schema } = await import('../index.js')
    const contract = {
      id: id(1), scope: 'step', meaning: '提交后必须调用下单接口', severity: 'MUST', onViolation: 'halt', provenance: 'manual',
      rule: { kind: 'page_request', match: '/api/order/*', method: 'post' },
    }
    const parsed = outcomeContractSchema.parse(contract)
    expect(parsed.rule).toMatchObject({ kind: 'page_request', method: 'POST', status: '2xx' })
    expect(() => outcomeContractSchema.parse({ ...contract, scope: 'scenario' })).toThrow()
    const doc = (type: 'click' | 'echo') => ({
      authoringSchemaVersion: 2, schemaVersion: 1, inputs: [],
      nodes: [{ kind: 'step', step: type === 'click'
        ? { id: id(2), name: '点击', type: 'click', effectType: 'SIDE_EFFECT', input: { target: { framePath: [], candidates: [{ by: 'css', value: 'a' }] } } }
        : { id: id(2), name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { value: 1 } }, outcomes: [contract] }],
    })
    expect(() => scenarioAuthoringDocumentV2Schema.parse(doc('click'))).not.toThrow()
    expect(() => scenarioAuthoringDocumentV2Schema.parse(doc('echo'))).toThrow(/浏览器步骤/)
  })

  it('没有命中请求判失败；命中且状态满足判通过', async () => {
    const { evaluatePageRequestRule } = await import('../page-health.js')
    expect(evaluatePageRequestRule(rule, [], { prematched: true })).toMatchObject({ verdict: 'FAIL', reason: '步骤期间没有出现该请求' })
    expect(evaluatePageRequestRule(rule, [req({})], { prematched: true }).verdict).toBe('PASS')
    expect(evaluatePageRequestRule(rule, [req({ url: 'https://a.corp/api/other' })]).reason).toBe('步骤期间没有出现该请求')
  })

  it('状态 / 耗时 / 次数：多次命中以最后一次为准', async () => {
    const { evaluatePageRequestRule } = await import('../page-health.js')
    expect(evaluatePageRequestRule(rule, [req({ status: 500 })], { prematched: true }).reason).toContain('返回 500')
    expect(evaluatePageRequestRule(rule, [req({ status: 500 }), req({ status: 200 })], { prematched: true }).verdict).toBe('PASS')
    expect(evaluatePageRequestRule(rule, [req({ status: 200 }), req({ status: 503 })], { prematched: true }).verdict).toBe('FAIL')
    expect(evaluatePageRequestRule({ ...rule, status: '2xx_3xx' }, [req({ status: 302 })], { prematched: true }).verdict).toBe('PASS')
    expect(evaluatePageRequestRule({ ...rule, maxMs: 50 }, [req({ durationMs: 120 })], { prematched: true }).reason).toContain('超过上限 50ms')
    expect(evaluatePageRequestRule({ ...rule, minCount: 2 }, [req({})], { prematched: true }).reason).toContain('至少需要 2 次')
    expect(evaluatePageRequestRule(rule, [req({ failed: true, status: 0 })], { prematched: true }).reason).toContain('请求失败')
  })
})
