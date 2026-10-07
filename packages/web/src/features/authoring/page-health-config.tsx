import {
  PAGE_HEALTH_RESOURCE_TYPES,
  PAGE_HEALTH_STATUS_CLASSES,
  resolveNetworkHealthConfig,
  resolveScriptErrorsConfig,
  type NetworkHealthConfig,
  type PageHealthResourceType,
  type PageHealthStatusClass,
  type RuntimeInvariant,
  type ScriptErrorsConfig,
} from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { formatSlowRules, parseSlowRules } from './page-health-config-utils'

const RESOURCE_LABELS: Record<PageHealthResourceType, string> = {
  document: '页面加载',
  xhr: '接口（XHR）',
  fetch: '接口（Fetch）',
  script: '脚本文件',
  stylesheet: '样式文件',
  image: '图片',
  font: '字体',
  other: '其他',
}

const STATUS_LABELS: Record<PageHealthStatusClass, string> = {
  '4xx': '4xx 客户端错误（404、401 等）',
  '5xx': '5xx 服务端错误（500、503 等）',
}

function toggle<T>(list: readonly T[], item: T, on: boolean): T[] {
  const without = list.filter((value) => value !== item)
  return on ? [...without, item] : without
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

function CheckRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className='flex items-center gap-2'>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className='font-normal'>
        {label}
      </Label>
    </div>
  )
}

export function PageHealthConfigForm({
  invariant,
  disabled,
  onChange,
}: {
  invariant: RuntimeInvariant
  disabled?: boolean
  onChange: (next: RuntimeInvariant) => void
}) {
  if (invariant.kind === 'network_health') {
    const config = resolveNetworkHealthConfig(invariant.network)
    const patch = (next: Partial<NetworkHealthConfig>) =>
      onChange({ ...invariant, network: { ...invariant.network, ...next } })
    return (
      <div className='space-y-3'>
        <p className='text-label text-muted-foreground'>
          只监听页面发出的请求，不拦截。只检查目标系统自己的地址（入口、登录地址、运行中打开过的页面及同一主域名、内网地址）；页面加载一律检查。
        </p>
        <div className='space-y-1.5'>
          <Label>算作错误的状态</Label>
          {PAGE_HEALTH_STATUS_CLASSES.map((cls) => (
            <CheckRow
              key={cls}
              id={`ph-${invariant.id}-${cls}`}
              label={STATUS_LABELS[cls]}
              checked={config.statusClasses.includes(cls)}
              disabled={disabled}
              onChange={(on) => {
                const next = toggle(config.statusClasses, cls, on)
                if (next.length > 0) patch({ statusClasses: next })
              }}
            />
          ))}
          <CheckRow
            id={`ph-${invariant.id}-failed`}
            label='请求失败（连接被拒绝、超时、域名解析失败等）'
            checked={config.requestFailed}
            disabled={disabled}
            onChange={(on) => patch({ requestFailed: on })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label>检查的请求类型</Label>
          <div className='grid gap-1.5 sm:grid-cols-2'>
            {PAGE_HEALTH_RESOURCE_TYPES.map((type) => (
              <CheckRow
                key={type}
                id={`ph-${invariant.id}-rt-${type}`}
                label={RESOURCE_LABELS[type]}
                checked={config.resourceTypes.includes(type)}
                disabled={disabled}
                onChange={(on) => {
                  const next = toggle(config.resourceTypes, type, on)
                  if (next.length > 0) patch({ resourceTypes: next })
                }}
              />
            ))}
          </div>
        </div>
        <CheckRow
          id={`ph-${invariant.id}-external`}
          label='也检查外部地址（外部 CDN、字体、统计脚本等）'
          checked={config.includeExternal}
          disabled={disabled}
          onChange={(on) => patch({ includeExternal: on })}
        />
        <div className='space-y-1'>
          <Label htmlFor={`ph-${invariant.id}-slow`}>关键接口耗时阈值（一行一条）</Label>
          <Textarea
            id={`ph-${invariant.id}-slow`}
            rows={2}
            disabled={disabled}
            placeholder='POST /api/v1/checkout 800'
            defaultValue={formatSlowRules(config.slowRules)}
            onBlur={(event) => patch({ slowRules: parseSlowRules(event.target.value) })}
          />
          <p className='text-label text-muted-foreground'>
            格式：[方法] 地址 阈值毫秒。测的是浏览器看到的耗时（含网络），不等于服务端耗时。
          </p>
          {config.slowRules.length > 0 ? (
            <div className='flex items-center gap-2'>
              <Label htmlFor={`ph-${invariant.id}-allow`} className='font-normal'>每条规则允许超阈次数</Label>
              <Input
                id={`ph-${invariant.id}-allow`}
                type='number'
                min={0}
                className='w-20'
                disabled={disabled}
                defaultValue={config.slowAllowExceed}
                onBlur={(event) => patch({ slowAllowExceed: Math.max(0, Math.min(1000, Math.trunc(Number(event.target.value) || 0))) })}
              />
            </div>
          ) : null}
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`ph-${invariant.id}-extra`}>附加系统地址（一行一个）</Label>
          <Textarea
            id={`ph-${invariant.id}-extra`}
            rows={2}
            disabled={disabled}
            placeholder='https://cdn.corp.example:8443 或 *.corp.example'
            defaultValue={config.extraOrigins.join('\n')}
            onBlur={(event) => patch({ extraOrigins: lines(event.target.value).slice(0, 20) })}
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`ph-${invariant.id}-ignore`}>忽略的地址（一行一个）</Label>
          <Textarea
            id={`ph-${invariant.id}-ignore`}
            rows={2}
            disabled={disabled}
            placeholder='/favicon.ico 或 https://stat.example/**'
            defaultValue={config.ignore.join('\n')}
            onBlur={(event) => patch({ ignore: lines(event.target.value).slice(0, 50) })}
          />
          <p className='text-label text-muted-foreground'>以 / 开头只匹配路径；* 不跨目录，** 跨目录；不含查询参数。</p>
        </div>
      </div>
    )
  }
  if (invariant.kind === 'script_errors') {
    const config = resolveScriptErrorsConfig(invariant.script)
    const patch = (next: Partial<ScriptErrorsConfig>) =>
      onChange({ ...invariant, script: { ...invariant.script, ...next } })
    return (
      <div className='space-y-3'>
        <p className='text-label text-muted-foreground'>检查页面未捕获的脚本异常和未处理的 Promise 拒绝。</p>
        <CheckRow
          id={`ph-${invariant.id}-console`}
          label='同时检查控制台 error 日志'
          checked={config.includeConsoleError}
          disabled={disabled}
          onChange={(on) => patch({ includeConsoleError: on })}
        />
        <div className='space-y-1'>
          <Label htmlFor={`ph-${invariant.id}-script-ignore`}>忽略包含这些文字的异常（一行一个）</Label>
          <Textarea
            id={`ph-${invariant.id}-script-ignore`}
            rows={2}
            disabled={disabled}
            placeholder='ResizeObserver loop limit exceeded'
            defaultValue={config.ignore.join('\n')}
            onBlur={(event) => patch({ ignore: lines(event.target.value).slice(0, 50) })}
          />
        </div>
      </div>
    )
  }
  return null
}
