import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { SMTPServer } from 'smtp-server'
import type { OutboundJob } from '@cairn/db'
import {
  outboundEmailText,
  outboundWebhookBody,
  resolveOutboundDestination,
  sendOutboundEmail,
  sendOutboundWebhook,
  withOutboundDeadline,
} from './outbound-delivery'

const fixedDate = new Date('2026-09-19T08:00:00.000Z')
function job(): OutboundJob {
  return {
    deliveryId: randomUUID(),
    event: {
      id: randomUUID(),
      type: 'run.finished',
      occurredAt: fixedDate,
      observedAt: fixedDate,
      runId: randomUUID(),
      targetId: randomUUID(),
      scenarioId: randomUUID(),
      consoleUrl: 'https://console.example.com/runs/abc',
      payload: {
        title: '运行结果：订单检查',
        scenarioName: '<img src=x onerror=alert(1)>',
        status: 'SUCCEEDED',
        outcomeStatus: 'NOT_EVALUATED',
        evidenceStatus: 'PENDING',
        summaryStage: 'evidence_pending',
      },
    },
    delivery: { binding: { channel: { format: 'cairn.outbound@1' } } },
  } as unknown as OutboundJob
}

describe('消息推送真实 HTTPS / SMTP 协议与外部副作用', () => {
  let dir: string, key: Buffer, cert: Buffer, originalCAs: string[]
  const servers: Array<Server | SMTPServer> = []
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-outbound-tls-'))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,DNS:outbound.test,IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'pipe' },
    )
    key = readFileSync(join(dir, 'key.pem'))
    cert = readFileSync(join(dir, 'cert.pem'))
    originalCAs = getCACertificates()
    setDefaultCACertificates([...originalCAs, cert.toString()])
  })
  afterAll(() => {
    setDefaultCACertificates(originalCAs)
    for (const server of servers) {
      if ('closeAllConnections' in server) server.closeAllConnections()
      server.close()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('终止信号清理监听器且不可再次触发', async () => {
    const controller = new AbortController()
    const work = withOutboundDeadline(new Promise(() => undefined), controller.signal)
    controller.abort()
    await expect(work).rejects.toMatchObject({ code: 'send_aborted' })
  })

  const addresses = [{ address: '127.0.0.1', family: 4 }]
  async function httpsReceiver(handler: (req: any, res: any) => void) {
    const server = createServer({ key, cert }, handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return { url: `https://outbound.test:${port}/notify`, port }
  }

  it('Webhook 递送验证签名、时间戳、投递 ID 及数据脱敏', async () => {
    const received: Array<{ body: string; signature: string; timestamp: string; delivery: string }> =
      []
    const { url } = await httpsReceiver((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        received.push({
          body,
          signature: String(req.headers['x-cairn-signature']),
          timestamp: String(req.headers['x-cairn-timestamp']),
          delivery: String(req.headers['x-cairn-delivery-id']),
        })
        res.writeHead(204)
        res.end()
      })
    })
    const j = job(),
      body = outboundWebhookBody(j)
    expect(
      await sendOutboundWebhook({
        url,
        addresses,
        body,
        deliveryId: j.deliveryId,
        signingKey: 'test-only-key',
        signal: AbortSignal.timeout(5000),
      }),
    ).toMatchObject({ outcome: 'accepted', responseCode: 204 })
    expect(received).toHaveLength(1)
    expect(received[0]?.body).toBe(body)
    expect(received[0]?.signature).toBe(
      `v1=${createHmac('sha256', 'test-only-key').update(`${received[0]!.timestamp}.${body}`).digest('hex')}`,
    )
    expect(received[0]?.delivery).toBe(j.deliveryId)
    expect(JSON.parse(body).data).not.toHaveProperty('input')
  })

  it('禁止公网策略中的私有/元数据地址，重定向不跟随', async () => {
    for (const url of [
      'https://127.0.0.1/n',
      'https://[::1]/n',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/n',
      'http://example.com/n',
    ])
      await expect(resolveOutboundDestination(url)).rejects.toMatchObject({
        code: 'destination_blocked',
      })
    let redirected = 0
    const target = await httpsReceiver((_req, res) => {
      redirected++
      res.end()
    })
    const redirect = await httpsReceiver((_req, res) => {
      res.writeHead(302, { Location: target.url })
      res.end()
    })
    expect(
      await sendOutboundWebhook({
        url: redirect.url,
        addresses,
        body: '{}',
        deliveryId: randomUUID(),
        signal: AbortSignal.timeout(5000),
      }),
    ).toMatchObject({ outcome: 'failed', responseCode: 302 })
    expect(redirected).toBe(0)
  })

  it('HTTP 5xx 不能证明未接收；已提交后断连或超时是 unknown', async () => {
    let submissions = 0
    const failure = await httpsReceiver((req, res) => {
      req.resume()
      req.on('end', () => {
        submissions++
        res.writeHead(503)
        res.end()
      })
    })
    const input = {
      url: failure.url,
      addresses,
      body: '{}',
      deliveryId: randomUUID(),
      signal: AbortSignal.timeout(5000),
    }
    expect(await sendOutboundWebhook(input)).toMatchObject({
      outcome: 'unknown',
      responseCode: 503,
    })
    expect(await sendOutboundWebhook({ ...input, receiverDeduplicates: true })).toMatchObject({
      outcome: 'retryable',
    })
    const broken = await httpsReceiver((req, res) => {
      req.resume()
      req.on('end', () => {
        submissions++
        res.socket?.destroy()
      })
    })
    expect(await sendOutboundWebhook({ ...input, url: broken.url })).toMatchObject({
      outcome: 'unknown',
    })
    const slow = await httpsReceiver((req) => {
      req.resume()
      req.on('end', () => {
        submissions++
      })
    })
    expect(
      await sendOutboundWebhook({ ...input, url: slow.url, signal: AbortSignal.timeout(100) }),
    ).toMatchObject({ outcome: 'unknown' })
    expect(submissions).toBe(4)
  })

  it('旧告警格式保留 at，不加推送 envelope；新模板正确表达三轴', () => {
    const j = job()
    j.delivery.binding.channel.format = 'legacy_alert@1'
    j.event.payload = {
      title: '告警',
      alert: {
        kind: 'firing',
        alertId: randomUUID(),
        ruleId: 'factory.worker.lost',
        ruleName: 'Worker 失联',
        metricKey: 'worker.status.lost',
        source: null,
        scope: 'platform',
        scopeId: 'platform',
        value: 1,
        threshold: 0,
        comparator: 'gt',
        severity: 'critical',
        occurredAt: fixedDate.toISOString(),
        consolePath: '/monitoring',
      },
    }
    const body = JSON.parse(outboundWebhookBody(j))
    expect(body.at).toBe(fixedDate.toISOString())
    expect(body).not.toHaveProperty('protocol')
    expect(body).not.toHaveProperty('occurredAt')
    expect(outboundEmailText(job())).toContain('业务结果：未评价业务结果')
    expect(outboundEmailText(job())).toContain('证据仍在收集中')
  })

  it('目标级告警：推送里看得出哪个系统、哪个指标与读数；IM 机器人出卡片，旧格式不带 scopeName', () => {
    const alertJob = () => {
      const j = job()
      j.event.type = 'alert.firing'
      j.event.runId = null
      j.event.scenarioId = null
      j.event.consoleUrl = 'https://console.example.com/monitoring'
      j.event.payload = {
        title: '告警触发：页面接口错误',
        alert: {
          kind: 'firing',
          alertId: randomUUID(),
          ruleId: 'factory.target.api_error',
          ruleName: '页面接口错误',
          metricKey: 'target.apiErrorCount',
          source: null,
          scope: 'target',
          scopeId: randomUUID(),
          scopeName: '订单中心',
          value: 12,
          threshold: 10,
          comparator: 'gte',
          severity: 'critical',
          occurredAt: fixedDate.toISOString(),
          consolePath: '/monitoring',
        },
      }
      ;(j.delivery.binding.channel as { host: string }).host = 'hooks.example.com'
      return j
    }
    const text = outboundEmailText(alertJob())
    expect(text).toContain('告警：页面接口错误（触发 / 严重）')
    expect(text).toContain('目标系统：订单中心')
    expect(text).toContain('目标系统接口错误次数（近 1 小时），当前 12，规则 大于等于 10')

    const feishu = alertJob()
    ;(feishu.delivery.binding.channel as { host: string }).host = 'open.feishu.cn'
    const card = JSON.parse(outboundWebhookBody(feishu))
    expect(card.msg_type).toBe('interactive')
    expect(card.card.header.template).toBe('red')
    expect(card.card.elements[0].text.content).toContain('目标系统：订单中心')
    expect(card.card.elements[1].actions[0].url).toBe('https://console.example.com/monitoring')

    const body = JSON.parse(outboundWebhookBody(alertJob()))
    expect(body).toMatchObject({ protocol: 'cairn.outbound@1', type: 'alert.firing' })
    expect(body.data.alert.scopeName).toBe('订单中心')

    const legacy = alertJob()
    legacy.delivery.binding.channel.format = 'legacy_alert@1'
    const notice = JSON.parse(outboundWebhookBody(legacy))
    expect(notice).not.toHaveProperty('scopeName')
    expect(notice.scope).toBe('target')
  })

  it('周期耗时报告：IM 机器人地址出卡片，其它地址走 cairn.outbound@1，邮件正文带周期与要点', () => {
    const reportJob = () => {
      const j = job()
      j.event.type = 'report.duration_period'
      j.event.runId = null
      j.event.scenarioId = null
      j.event.consoleUrl = 'https://console.example.com/reports/r1'
      j.event.payload = {
        title: '商城 耗时周报 · 2026 年第 40 周（9/28–10/4）',
        report: {
          reportId: randomUUID(),
          title: '商城 耗时周报 · 2026 年第 40 周（9/28–10/4）',
          periodLabel: '2026 年第 40 周（9/28–10/4）',
          targetName: '商城',
          highlights: ['本周整体执行耗时 P50 为 13s，比上周慢 30%。', '明显变慢 1 个场景，最突出的是『订单巡检』（+30%）。'],
          consolePath: '/reports/r1',
        },
      }
      return j
    }
    const wechat = reportJob()
    ;(wechat.delivery.binding.channel as { host: string }).host = 'qyapi.weixin.qq.com'
    const card = JSON.parse(outboundWebhookBody(wechat))
    expect(card.msgtype).toBe('markdown')
    expect(card.markdown.content).toContain('本周整体执行耗时 P50 为 13s')
    expect(card.markdown.content).toContain('https://console.example.com/reports/r1')

    const generic = reportJob()
    ;(generic.delivery.binding.channel as { host: string }).host = 'hooks.example.com'
    const body = JSON.parse(outboundWebhookBody(generic))
    expect(body).toMatchObject({ protocol: 'cairn.outbound@1', type: 'report.duration_period', consoleUrl: 'https://console.example.com/reports/r1' })
    expect(body.data.report.highlights).toHaveLength(2)

    const text = outboundEmailText(reportJob(), { hasAttachment: true })
    expect(text).toContain('目标系统：商城')
    expect(text).toContain('周期：2026 年第 40 周（9/28–10/4）')
    expect(text).toContain('· 明显变慢 1 个场景')
    expect(text).toContain('附件：已包含耗时报告 HTML')
    expect(text).toContain('https://console.example.com/reports/r1')
  })

  async function smtpReceiver(
    secure: boolean,
    behavior: 'accept' | 'authfail' | 'temporary' | 'permanent' | 'disconnect' = 'accept',
  ) {
    const messages: string[] = [],
      envelopes: string[][] = []
    const server = new SMTPServer({
      secure,
      key,
      cert,
      logger: false,
      onAuth(_auth, _session, callback) {
        callback(behavior === 'authfail' ? new Error('bad credentials') : null, { user: 'fixture' })
      },
      onRcptTo(address, _session, callback) {
        callback(
          address.address.startsWith('reject')
            ? Object.assign(new Error('denied'), { responseCode: 550 })
            : undefined,
        )
      },
      onData(stream, session, callback) {
        let message = ''
        stream.on('data', (c) => {
          message += c.toString()
        })
        stream.on('end', () => {
          messages.push(message)
          envelopes.push(session.envelope.rcptTo.map((a) => a.address))
          if (behavior === 'disconnect') {
            for (const connection of (server as unknown as { connections: Set<{ close(): void }> })
              .connections ?? [])
              connection.close()
            return
          }
          if (behavior === 'temporary' || behavior === 'permanent')
            callback(
              Object.assign(new Error('fixture rejection'), {
                responseCode: behavior === 'temporary' ? 451 : 550,
              }),
            )
          else callback()
        })
      },
    })
    server.on('error', () => undefined)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.server.address() as { port: number }).port
    return {
      server,
      messages,
      envelopes,
      smtp: {
        host: 'localhost',
        port,
        tls: secure ? ('tls' as const) : ('starttls' as const),
        username: 'fixture',
        password: 'test-only-password',
        from: 'sender@example.test',
      },
    }
  }

  it.each([true, false])(
    'SMTP secure=%s 验证 TLS/STARTTLS、独立收件人、稳定 Message-ID 与 HTML 转义',
    async (secure) => {
      const receiver = await smtpReceiver(secure),
        j = job()
      const result = await sendOutboundEmail({
        smtp: receiver.smtp,
        recipient: 'a@example.test',
        job: j,
        signal: AbortSignal.timeout(5000),
      })
      expect(result.outcome).toBe('accepted')
      expect(receiver.envelopes).toEqual([['a@example.test']])
      expect(receiver.messages[0]).toContain(`Message-ID: <${j.deliveryId}@cairn.outbound>`)
      expect(receiver.messages[0]).toContain('text/html')
      expect(receiver.messages[0]).not.toContain('<img src=x')
      expect(
        (
          await sendOutboundEmail({
            smtp: receiver.smtp,
            recipient: 'reject@example.test',
            job: j,
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).toBe('failed')
      expect(receiver.messages).toHaveLength(1)
    },
  )

  it('SMTP 4xx / 5xx 明确拒收和认证失败不记 accepted', async () => {
    for (const [behavior, expected] of [
      ['temporary', 'retryable'],
      ['permanent', 'failed'],
      ['authfail', 'failed'],
    ] as const) {
      const receiver = await smtpReceiver(true, behavior)
      expect(
        (
          await sendOutboundEmail({
            smtp: receiver.smtp,
            recipient: 'a@example.test',
            job: job(),
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).toBe(expected)
      expect(receiver.messages.length).toBe(behavior === 'authfail' ? 0 : 1)
    }
  })

  it('证书验证失败无邮件提交', async () => {
    const receiver = await smtpReceiver(true)
    setDefaultCACertificates(originalCAs)
    try {
      expect(
        (
          await sendOutboundEmail({
            smtp: receiver.smtp,
            recipient: 'a@example.test',
            job: job(),
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).not.toBe('accepted')
      expect(receiver.messages).toHaveLength(0)
    } finally {
      setDefaultCACertificates([...originalCAs, cert.toString()])
    }
  })

  it('SMTP 已接收 DATA 但回执前断连，保留 unknown 并核对实际接收次数', async () => {
    const receiver = await smtpReceiver(false, 'disconnect')
    expect(
      (
        await sendOutboundEmail({
          smtp: receiver.smtp,
          recipient: 'a@example.test',
          job: job(),
          signal: AbortSignal.timeout(5000),
        })
      ).outcome,
    ).toBe('unknown')
    expect(receiver.messages).toHaveLength(1)
  })
})
