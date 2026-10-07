import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { FormProvider, useForm } from 'react-hook-form'
import { FACTORY_ALERT_RULES, type AlertRule, type PlatformConfigDocument } from '@cairn/shared'
import { AlertingFields } from './alerting-fields'

const channel = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '运维群',
  kind: 'webhook',
  host: 'hooks.example.com',
  enabled: true,
  allowAlerts: true,
  ...over,
})

function Harness({ rules, channels, onGoChannels }: { rules: AlertRule[]; channels: unknown[]; onGoChannels?: () => void }) {
  const form = useForm<PlatformConfigDocument>({
    defaultValues: { alerting: { rules }, outbound: { channels } } as never,
  })
  return (
    <FormProvider {...form}>
      <AlertingFields hideChannels canWrite revision={1} reason='x' busy={false} onRegistered={async () => undefined} onGoChannels={onGoChannels} />
    </FormProvider>
  )
}

const withRule = (id: string, patch: Record<string, unknown>) =>
  FACTORY_ALERT_RULES.map((rule) => (rule.id === id ? ({ ...rule, ...patch } as AlertRule) : rule))

const customRule = (over: Record<string, unknown> = {}): AlertRule =>
  ({ kind: 'threshold', id: 'custom.abc', name: '自定义阈值', metricKey: 'queue.oldestWaitMs', scope: 'platform', comparator: 'gte', threshold: 1000, forSeconds: 60, severity: 'warning', channelIds: [], enabled: false, ...over }) as AlertRule

describe('告警规则编辑器（面向普通用户）', () => {
  it('默认只展示建议规则，每条带一句中文描述；自定义规则折叠，没有时标明一般不用配', async () => {
    const screen = await render(<Harness rules={[...FACTORY_ALERT_RULES]} channels={[]} />)
    const text = screen.container.textContent ?? ''
    expect(text).toContain('下面是系统建议的告警情况，默认都关闭')
    expect(text).toContain('接口耗时频繁超阈')
    expect(text).toContain('目标系统接口耗时超阈次数（近 1 小时） 大于等于 10')
    expect(text).toMatch(/自定义规则高级 · 一般不用配/)
    expect(text).not.toContain('添加自定义规则')
    expect(text).not.toContain('worker.status.ready')
  })

  it('已有自定义规则时仍折叠，只显示条数与已开启数；展开后能看到并添加', async () => {
    const screen = await render(<Harness rules={[...FACTORY_ALERT_RULES, customRule({ enabled: true })]} channels={[channel()]} />)
    expect(screen.container.textContent).toContain('1 条，已开启 1 条')
    expect(screen.container.textContent).not.toContain('添加自定义规则')
    await screen.getByRole('button', { name: '自定义告警规则' }).click()
    expect(screen.container.textContent).toContain('添加自定义规则')
    expect(screen.container.textContent).toContain('自定义阈值')
  })

  it('规则已开启但没有可用渠道：提示并给「去添加推送渠道」', async () => {
    const onGo = vi.fn()
    const screen = await render(<Harness rules={withRule('factory.target.api_slow', { enabled: true })} channels={[]} onGoChannels={onGo} />)
    await expect.element(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.container.textContent).toContain('还没有可用于告警的推送渠道，触发了也不会通知任何人')
    await screen.getByRole('button', { name: '去添加推送渠道' }).click()
    expect(onGo).toHaveBeenCalledTimes(1)
  })

  it('有渠道但没勾选：提示去勾选；勾选后提示消失；关闭的规则不提示', async () => {
    const off = await render(<Harness rules={[...FACTORY_ALERT_RULES]} channels={[channel()]} />)
    expect(off.container.querySelector('[role="alert"]')).toBeNull()

    const screen = await render(<Harness rules={withRule('factory.target.api_slow', { enabled: true })} channels={[channel()]} />)
    expect(screen.container.textContent).toContain('还没选择通知发到哪里')
    const article = Array.from(screen.container.querySelectorAll('article')).find((item) => item.textContent?.includes('接口耗时频繁超阈'))!
    ;(article.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await expect.poll(() => screen.container.querySelector('[role="alert"]')).toBeNull()
    expect(screen.container.querySelector('[role="alert"]')).toBeNull()

    const selected = await render(<Harness rules={withRule('factory.target.api_slow', { enabled: true, channelIds: [channel().id] })} channels={[channel()]} />)
    expect(selected.container.querySelector('[role="alert"]')).toBeNull()
  })
})
