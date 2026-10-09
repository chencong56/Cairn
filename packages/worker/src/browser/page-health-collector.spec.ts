import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createRuntimeInvariant, type RuntimeInvariant } from '@cairn/shared'
import { PageHealthCollector, PAGE_HEALTH_GAP_MS, pageHealthKnownOrigins } from './page-health-collector.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function req(url: string, opts: { method?: string; type?: string; failure?: string } = {}) {
  return {
    url: () => url,
    method: () => opts.method ?? 'GET',
    resourceType: () => opts.type ?? 'xhr',
    failure: () => (opts.failure ? { errorText: opts.failure } : null),
  }
}
const resp = (request: ReturnType<typeof req>, status: number) => ({ url: () => request.url(), status: () => status, request: () => request })

function setup(invariants: RuntimeInvariant[] = [createRuntimeInvariant('network_health', id(1)), createRuntimeInvariant('script_errors', id(2))], now = { t: 1_000 }) {
  const context = new EventEmitter()
  const collector = new PageHealthCollector(context, { invariants, knownOrigins: ['https://portal.corp.com'], now: () => now.t })
  collector.attach()
  const fire = (request: ReturnType<typeof req>, status?: number) => {
    context.emit('request', request)
    if (status !== undefined) context.emit('response', resp(request, status))
  }
  return { context, collector, fire, now }
}

describe('PageHealthCollector', () => {
  it('没有页面健康约束时不挂监听', () => {
    const context = new EventEmitter()
    const collector = new PageHealthCollector(context, { invariants: [], knownOrigins: [] })
    collector.attach()
    expect(context.listenerCount('response')).toBe(0)
  })

  it('点击后延迟返回的 503 归到发起它的步骤，而不是取数时的步骤', () => {
    const { collector, context, fire } = setup()
    collector.beginStep({ stepId: 'step-2', stepRunId: 'sr-2', attemptId: 'at-2' })
    const slow = req('https://portal.corp.com/api/order/123456', { method: 'POST' })
    context.emit('request', slow)
    collector.endStep()
    collector.beginStep({ stepId: 'step-3', stepRunId: 'sr-3', attemptId: 'at-3' })
    context.emit('response', resp(slow, 503))
    fire(req('https://portal.corp.com/api/ok'), 200)
    const drained = collector.drain()
    expect(drained.network?.samples).toHaveLength(1)
    expect(drained.network?.samples[0]).toMatchObject({ stepId: 'step-2', stepRunId: 'sr-2', status: 503, url: 'https://portal.corp.com/api/order/*' })
  })

  it('4xx 与 5xx 都计，图片默认不计，忽略规则生效，ERR_ABORTED 不计，其它请求失败计', () => {
    const { collector, fire, context } = setup([
      { ...createRuntimeInvariant('network_health', id(1)), network: { ignore: ['/ignored/**'] } },
    ])
    collector.beginStep({ stepId: 's' })
    fire(req('https://portal.corp.com/a'), 404)
    fire(req('https://portal.corp.com/b'), 500)
    fire(req('https://portal.corp.com/logo.png', { type: 'image' }), 404)
    fire(req('https://portal.corp.com/ignored/x'), 404)
    const aborted = req('https://portal.corp.com/c', { failure: 'net::ERR_ABORTED' })
    context.emit('request', aborted)
    context.emit('requestfailed', aborted)
    const refused = req('https://portal.corp.com/d', { failure: 'net::ERR_CONNECTION_REFUSED' })
    context.emit('request', refused)
    context.emit('requestfailed', refused)
    const fact = collector.drain().network!
    expect(fact.total).toBe(3)
    expect(fact.byClass).toEqual({ '4xx': 1, '5xx': 1, failed: 1 })
  })

  it('外部地址默认不计，页面加载一律计；加载过页面的源之后成为系统地址', () => {
    const { collector, fire } = setup()
    collector.beginStep({ stepId: 's' })
    fire(req('https://cdn.vendor.example/lib.js', { type: 'script' }), 404)
    fire(req('https://sub.other.org/page', { type: 'document' }), 500)
    fire(req('https://sub.other.org/api/data'), 500)
    fire(req('http://oa/api/x'), 500)
    const urls = collector.drain().network!.samples.map((sample) => sample.url)
    expect(urls).toEqual(['https://sub.other.org/page', 'https://sub.other.org/api/data', 'http://oa/api/x'])
  })

  it('开启包含外部地址后外部 CDN 计入', () => {
    const { collector, fire } = setup([{ ...createRuntimeInvariant('network_health', id(1)), network: { includeExternal: true } }])
    collector.beginStep({ stepId: 's' })
    fire(req('https://cdn.vendor.example/lib.js', { type: 'script' }), 404)
    expect(collector.drain().network!.total).toBe(1)
  })

  it('步骤之后 5 秒内记为「之后」，超过的（挂起 / 认证 / 人工接管）不计', () => {
    const { collector, fire, now } = setup()
    collector.beginStep({ stepId: 's1', stepRunId: 'sr-1' })
    collector.endStep()
    now.t += 1_000
    fire(req('https://portal.corp.com/poll'), 500)
    now.t += PAGE_HEALTH_GAP_MS + 1
    fire(req('https://portal.corp.com/manual'), 500)
    const samples = collector.drain().network!.samples
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ stepId: 's1', afterStep: true })
  })

  it('脚本未捕获异常按发生步骤归属，消息脱敏，忽略文字生效', () => {
    const { collector, context } = setup([
      { ...createRuntimeInvariant('script_errors', id(2)), script: { ignore: ['ResizeObserver'] } },
    ])
    collector.beginStep({ stepId: 's1', stepRunId: 'sr-1' })
    context.emit('weberror', { error: () => new Error('TypeError: x is undefined token=abc123') })
    context.emit('weberror', { error: () => new Error('ResizeObserver loop limit exceeded') })
    const fact = collector.drain().script!
    expect(fact.total).toBe(1)
    expect(fact.samples[0]!.text).toContain('token=***')
    expect(fact.samples[0]).toMatchObject({ type: 'script_error', stepRunId: 'sr-1' })
  })

  it('无违规时取数为空，不产生样本；dispose 后摘除监听', () => {
    const { collector, fire, context } = setup()
    collector.beginStep({ stepId: 's' })
    fire(req('https://portal.corp.com/ok'), 200)
    const drained = collector.drain()
    expect(drained.network).toBeUndefined()
    expect(drained.script).toBeUndefined()
    collector.dispose()
    expect(context.listenerCount('response')).toBe(0)
  })
})

describe('pageHealthKnownOrigins', () => {
  const targetAuth = {
    entryUrl: 'https://erp.example-a.com/home',
    loginUrl: 'https://sso.example-b.com/login',
    authMethod: 'NONE',
    captchaMode: 'NONE',
    loginFields: {},
  } as never

  it('入口与登录页一开始就算系统地址，不依赖快照里已不再写入的 allowedOrigins', () => {
    expect(pageHealthKnownOrigins({ targetAuth }).sort()).toEqual(['https://erp.example-a.com', 'https://sso.example-b.com'])
    expect(pageHealthKnownOrigins({ allowedOrigins: ['https://old.example-c.com'], loginOrigin: 'https://sso.example-b.com' }).sort()).toEqual([
      'https://old.example-c.com',
      'https://sso.example-b.com',
    ])
  })

  it('复用会话、本次没有整页跳转时，入口系统的接口错误也计入', () => {
    const context = new EventEmitter()
    const collector = new PageHealthCollector(context, {
      invariants: [createRuntimeInvariant('network_health', id(1))],
      knownOrigins: pageHealthKnownOrigins({ targetAuth }),
    })
    collector.attach()
    collector.beginStep({ stepId: 's' })
    const request = req('https://erp.example-a.com/api/orders')
    context.emit('request', request)
    context.emit('response', resp(request, 500))
    expect(collector.drain().network?.samples.map((sample) => sample.url)).toEqual(['https://erp.example-a.com/api/orders'])
  })
})

describe('PageHealthCollector 会话重建', () => {
  it('rebind 后新上下文的违规照常采集，旧上下文摘除，已缓存的保留', () => {
    const { collector, context, fire } = setup()
    collector.beginStep({ stepId: 's' })
    fire(req('https://portal.corp.com/a'), 500)
    const next = new EventEmitter()
    collector.rebind(next)
    expect(context.listenerCount('response')).toBe(0)
    expect(collector.isBoundTo(next)).toBe(true)
    const request = req('https://portal.corp.com/b')
    next.emit('request', request)
    next.emit('response', resp(request, 404))
    expect(collector.drain().network!.total).toBe(2)
  })
})

describe('PageHealthCollector 耗时阈值与控制台', () => {
  const finished = (context: EventEmitter, request: ReturnType<typeof req>, responseEnd: number) => {
    context.emit('request', request)
    context.emit('requestfinished', Object.assign(request, { timing: () => ({ responseEnd }) }))
  }

  it('超阈才算，按方法与地址匹配，允许超阈次数内不算', () => {
    const { collector, context } = setup([
      {
        ...createRuntimeInvariant('network_health', id(1)),
        network: { slowRules: [{ match: '/api/v1/checkout', method: 'POST', maxMs: 800 }], slowAllowExceed: 1 },
      },
    ])
    collector.beginStep({ stepId: 's' })
    finished(context, req('https://portal.corp.com/api/v1/checkout', { method: 'POST' }), 900)
    expect(collector.drain().network).toBeUndefined()
    finished(context, req('https://portal.corp.com/api/v1/checkout', { method: 'POST' }), 700)
    finished(context, req('https://portal.corp.com/api/v1/checkout', { method: 'GET' }), 5000)
    finished(context, req('https://portal.corp.com/api/v1/checkout', { method: 'POST' }), 1200)
    const fact = collector.drain().network!
    expect(fact.byClass).toEqual({ slow: 1 })
    expect(fact.samples[0]).toMatchObject({ type: 'slow', durationMs: 1200, maxMs: 800, method: 'POST' })
  })

  it('没有耗时规则时不挂 requestfinished 监听', () => {
    const { context } = setup()
    expect(context.listenerCount('requestfinished')).toBe(0)
  })

  it('开启 console.error 后记录控制台错误，默认不记', () => {
    const consoleMessage = (type: string, text: string) => ({ type: () => type, text: () => text, location: () => ({ url: 'https://portal.corp.com/app.js', lineNumber: 1 }) })
    const off = setup()
    off.collector.beginStep({ stepId: 's' })
    off.context.emit('console', consoleMessage('error', 'x'))
    expect(off.collector.drain().script).toBeUndefined()
    const on = setup([{ ...createRuntimeInvariant('script_errors', id(2)), script: { includeConsoleError: true } }])
    on.collector.beginStep({ stepId: 's' })
    on.context.emit('console', consoleMessage('warning', 'w'))
    on.context.emit('console', consoleMessage('error', 'Failed to load resource token=abc'))
    const fact = on.collector.drain().script!
    expect(fact.total).toBe(1)
    expect(fact.samples[0]!.text).toContain('token=***')
  })
})

describe('PageHealthCollector 关注清单（page_request）', () => {
  const finishedWith = (context: EventEmitter, request: ReturnType<typeof req>, status: number, responseEnd: number) => {
    context.emit('request', request)
    context.emit('response', resp(request, status))
    context.emit('requestfinished', Object.assign(request, { timing: () => ({ responseEnd }) }))
  }
  const watchSetup = () => {
    const context = new EventEmitter()
    const collector = new PageHealthCollector(context, {
      invariants: [],
      knownOrigins: [],
      watchRules: [{ match: '/api/order/*', method: 'POST' }, { match: '/api/ok' }],
    })
    collector.attach()
    return { context, collector }
  }

  it('只有关注清单、没有页面健康约束也会挂监听；只记命中的请求，带命中下标与发起步骤，不受系统地址限制', () => {
    const { context, collector } = watchSetup()
    expect(collector.enabled).toBe(true)
    collector.beginStep({ stepId: 's1', stepRunId: 'sr-1' })
    finishedWith(context, req('https://cdn.external.example/api/order/123456', { method: 'POST' }), 200, 150)
    finishedWith(context, req('https://portal.corp.com/api/ok'), 200, 20)
    finishedWith(context, req('https://portal.corp.com/api/other'), 200, 20)
    const hits = collector.peekWatched('s1')
    expect(hits.map((hit) => hit.rules)).toEqual([[0], [1]])
    expect(hits[0]).toMatchObject({ method: 'POST', url: 'https://cdn.external.example/api/order/*', status: 200, durationMs: 150, stepId: 's1' })
    expect(collector.peekWatched('other-step')).toEqual([])
    // 取数后清空；没有页面健康约束时取数结果为空
    expect(collector.drain()).toEqual({ dropped: 0 })
    expect(collector.peekWatched('s1')).toEqual([])
  })

  it('请求失败记 status 0 / failed，ERR_ABORTED 不记，方法不符不命中', () => {
    const { context, collector } = watchSetup()
    collector.beginStep({ stepId: 's1' })
    const refused = req('https://a.corp/api/order/9', { method: 'POST', failure: 'net::ERR_CONNECTION_REFUSED' })
    context.emit('request', refused)
    context.emit('requestfailed', refused)
    const aborted = req('https://a.corp/api/order/8', { method: 'POST', failure: 'net::ERR_ABORTED' })
    context.emit('request', aborted)
    context.emit('requestfailed', aborted)
    finishedWith(context, req('https://a.corp/api/order/7', { method: 'GET' }), 200, 5)
    const hits = collector.peekWatched('s1')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ failed: true, status: 0, rules: [0] })
  })
})
