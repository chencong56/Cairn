import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, RotateCw } from 'lucide-react'
import {
  TABLE_NETWORK_METHODS,
  isTablePlanUnconfigured,
  type ExtractInput,
  type Step,
  type TableDetectedColumn,
  type TableNetworkPlan,
  type TableSample,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiRequestError } from '@/lib/api-client'
import { observeNetwork } from '@/lib/network-observe-api'
import { useAuthoringObserve } from '../observe'
import { NetworkPickerDialog } from './network-picker-dialog'
import type { PickerColumn } from './network-picker-model'
import { clearNetworkPickerRequest, hasNetworkPickerRequest } from './network-picker-request'
import { coverageSummary } from './table-plan-edit'
import { TablePreviewGrid } from './table-preview-grid'
import { setTableSample } from './table-sample-store'

type ExtractStep = Extract<Step, { type: 'extract' }>
type NetworkInput = Extract<ExtractInput, { source: 'network' }>

const ANY_METHOD = '__any'
const planKeyOf = (p: TableNetworkPlan): string => JSON.stringify([p.match, p.layout, p.rowsPath, p.totalPath, p.columns.map((c) => [c.key, c.path, c.valueType, c.sensitive])])

const errorText = (error: unknown) => (error instanceof ApiRequestError ? error.message : '预览失败，请稍后再试')

/** 对话框给出的候选字段 → 预览表可勾选的列（带 JSON 路径，勾回时保留）。 */
function asDetectedColumns(fields: readonly PickerColumn[]): Array<TableDetectedColumn & { path: string }> {
  return fields.map((f, i) => ({
    key: f.key,
    name: f.name,
    valueType: f.valueType,
    ...(f.numericKind && f.numericKind !== 'float' ? { numericKind: f.numericKind } : {}),
    source: 'header' as const,
    index: i,
    path: f.path,
  }))
}

/**
 * 「接口返回的数据（含图表）」：读页面自己发出的 JSON 接口响应。
 * 选接口在宽视野对话框里做；这里显示选了什么、数据在哪、什么时候读，以及按计划读到的预览。
 */
export function NetworkTableFields({
  step,
  disabled,
  onChange,
}: {
  step: ExtractStep
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  const observe = useAuthoringObserve()
  const owner = observe.networkOwner
  const plan = (step.input as NetworkInput).table
  const unconfigured = isTablePlanUnconfigured(plan)
  // 从图表引导卡切过来：一挂载就打开“选择接口”
  const [pickerOpen, setPickerOpen] = useState(() => Boolean(owner) && hasNetworkPickerRequest(step.id))
  const [fields, setFields] = useState<PickerColumn[] | null>(null)
  const [preview, setPreview] = useState<TableSample | null>(null)
  const [reading, setReading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    setTableSample(step.id, preview)
  }, [step.id, preview])

  // 预览按“读的是谁的捕获 + 计划”判断要不要重读：会话态换成调试挂起的运行时，捕获来源变了要重读
  const ownerKey = owner ? (owner.kind === 'run' ? `run:${owner.runId}` : `session:${owner.sessionId}`) : ''
  const previewKeyOf = (p: TableNetworkPlan) => `${ownerKey}|${planKeyOf(p)}`

  const commit = (next: TableNetworkPlan) => onChange({ ...step, input: { as: 'table', source: 'network', table: next } } as Step)
  const withPage = <T extends object>(op: T): T & { pageId?: string } => {
    const pageId = observe.viewedPageId()
    return pageId ? { ...op, pageId } : op
  }

  /** 按计划在受管画面的捕获里读一遍；reload 先刷新页面（捕获开着），能读到页面一加载就发出的接口。 */
  const readPreview = async (target: TableNetworkPlan, reload = false) => {
    if (!owner || isTablePlanUnconfigured(target)) return
    lastKey.current = previewKeyOf(target)
    setReading(true)
    setFailure(null)
    try {
      await observeNetwork(owner, withPage({ op: 'network' as const, subOp: reload ? ('reload' as const) : ('list' as const) }))
      const res = await observeNetwork(owner, withPage({ op: 'network' as const, subOp: 'read' as const, plan: target }))
      setPreview(res.sample ?? null)
      setFailure(res.reason?.message ?? null)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setReading(false)
    }
  }

  // 计划变了（改地址、勾列、改数据位置）就重新预览
  useEffect(() => {
    if (!owner || unconfigured) return
    if (previewKeyOf(plan) === lastKey.current) return
    const timer = setTimeout(() => void readPreview(plan), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKeyOf(plan), unconfigured])

  const summary = coverageSummary(preview)
  const method = plan.match.method ?? ANY_METHOD

  return (
    <div className='space-y-3' data-testid='table-network-fields'>
      <div className='space-y-1.5'>
        <Label>用哪个接口</Label>
        {!owner ? (
          <p className='rounded-md border border-dashed border-border-divider bg-muted/20 p-2.5 text-xs text-muted-foreground' data-testid='table-network-no-page'>
            要选接口，先连接受管会话（或调试运行到本步前挂起），在受管画面上打开要读的页面。
          </p>
        ) : null}
        {unconfigured ? (
          <p className='text-xs text-muted-foreground'>还没有选接口。打开“选择接口”，从受管画面上这一页发出的接口里挑一个。</p>
        ) : (
          <p className='break-all text-xs' data-testid='table-network-summary'>
            <span className='font-medium'>{plan.match.method ?? '任意方法'}</span> 地址包含 <span className='font-medium'>{plan.match.url}</span>
          </p>
        )}
        <Button type='button' size='sm' disabled={disabled || !owner} onClick={() => setPickerOpen(true)}>
          {unconfigured ? '选择接口' : '重新选择'}
        </Button>
      </div>

      {!unconfigured ? (
        <>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-xs'>
            <span className='flex items-center gap-1.5'>
              地址包含
              <Input
                key={plan.match.url}
                aria-label='地址包含'
                className='h-7 w-56'
                defaultValue={plan.match.url}
                disabled={disabled}
                onBlur={(e) => {
                  const url = e.target.value.trim()
                  if (url && url !== plan.match.url) commit({ ...plan, match: { ...plan.match, url } })
                  else e.target.value = plan.match.url
                }}
              />
            </span>
            <span className='flex items-center gap-1.5'>
              方法
              <Select
                value={method}
                disabled={disabled}
                onValueChange={(v) => {
                  const { method: _old, ...rest } = plan.match
                  commit({ ...plan, match: v === ANY_METHOD ? rest : { ...rest, method: v as TableNetworkPlan['match']['method'] } })
                }}
              >
                <SelectTrigger className='h-7 w-auto min-w-20' aria-label='请求方法'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_METHOD}>任意</SelectItem>
                  {TABLE_NETWORK_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </div>

          <p className='text-xs' data-testid='table-network-where' title={plan.layout === 'columns' ? plan.columns.map((c) => c.path).join('\n') : undefined}>
            数据在哪：
            {plan.layout === 'rows' ? `数据行 ${plan.rowsPath}` : `按下标拼成行（${plan.columns.map((c) => c.label ?? c.name).join('、')}）`}
            {plan.totalPath ? ` · 总条数 ${plan.totalPath}` : ''}
          </p>

          <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-xs'>
            <span className='flex items-center gap-1.5'>
              什么时候读
              <Select
                value={plan.window.since}
                disabled={disabled}
                onValueChange={(v) => commit({ ...plan, window: { ...plan.window, since: v as TableNetworkPlan['window']['since'] } })}
              >
                <SelectTrigger className='h-7 w-auto min-w-44' aria-label='什么时候读'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='page_load'>当前页面加载以来最近一次</SelectItem>
                  <SelectItem value='step_start'>等本步开始后的新响应</SelectItem>
                </SelectContent>
              </Select>
            </span>
            <span className='flex items-center gap-1.5'>
              最多等
              <Input
                key={plan.window.waitMs}
                aria-label='最多等几秒'
                className='h-7 w-16'
                inputMode='numeric'
                defaultValue={String(Math.round(plan.window.waitMs / 1000))}
                disabled={disabled}
                onBlur={(e) => {
                  const n = Number(e.target.value.trim())
                  if (Number.isFinite(n) && n >= 0 && n <= 60) commit({ ...plan, window: { ...plan.window, waitMs: Math.round(n * 1000) } })
                  else e.target.value = String(Math.round(plan.window.waitMs / 1000))
                }}
              />
              秒
            </span>
          </div>
          <p className='text-caption text-muted-foreground'>
            {plan.window.since === 'page_load'
              ? '取当前页面加载以来、地址匹配的最近一个响应；如果匹配的请求还在途，会等它返回。'
              : '只认本步开始之后才返回的响应，适合“前一步点了查询、这一步读结果”。'}
          </p>

          {failure ? (
            <div className='space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs' role='alert'>
              <p className='text-destructive'>{failure}</p>
              <p className='text-muted-foreground'>捕获从打开编辑开始，页面一加载就发出的接口可能没捕获到：可以“重新加载并预览”。</p>
            </div>
          ) : null}

          {owner ? (
            <div className='flex flex-wrap gap-2'>
              <Button type='button' size='sm' variant='outline' disabled={disabled || reading} onClick={() => void readPreview(plan)}>
                <RefreshCw className='mr-1 size-3.5' />
                刷新预览
              </Button>
              <Button type='button' size='sm' variant='outline' disabled={disabled || reading} onClick={() => void readPreview(plan, true)}>
                <RotateCw className='mr-1 size-3.5' />
                重新加载并预览
              </Button>
            </div>
          ) : null}

          {preview ? (
            <div className='space-y-2'>
              <p className='text-xs' data-testid='table-network-preview-summary'>
                {preview.source.request ? `读的是 ${preview.source.request.method} ${preview.source.request.url} · ${preview.source.request.status} · ` : ''}
                共 {preview.rowCount} 行{preview.pageInfo?.totalRows !== undefined ? ` · 接口给的总条数 ${preview.pageInfo.totalRows}` : ''}
              </p>
              {summary && summary.tone !== 'ok' ? (
                <p className={summary.tone === 'warn' ? 'text-xs text-amber-700' : 'text-xs text-destructive'}>{summary.text}</p>
              ) : null}
            </div>
          ) : null}
          <TablePreviewGrid plan={plan} columns={fields ? asDetectedColumns(fields) : null} sample={preview} unit='列' disabled={disabled} onChange={commit} />

          <div className='space-y-2'>
            <button
              type='button'
              className='flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground'
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
              一般不用动
            </button>
            {advancedOpen ? (
              <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border-divider p-2.5 text-xs'>
                <span className='flex items-center gap-1.5'>
                  匹配到多个时
                  <Select value={plan.pick} disabled={disabled} onValueChange={(v) => commit({ ...plan, pick: v as TableNetworkPlan['pick'] })}>
                    <SelectTrigger className='h-7 w-auto min-w-32' aria-label='匹配到多个时'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='latest'>取最近一个</SelectItem>
                      <SelectItem value='single'>必须只有一个，否则报错</SelectItem>
                    </SelectContent>
                  </Select>
                </span>
                <span className='flex items-center gap-1.5'>
                  期望状态码
                  <Input
                    aria-label='期望状态码'
                    className='h-7 w-20'
                    inputMode='numeric'
                    placeholder='2xx'
                    defaultValue={plan.match.status ? String(plan.match.status) : ''}
                    disabled={disabled}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const { status: _old, ...rest } = plan.match
                      if (raw === '') return commit({ ...plan, match: rest })
                      const n = Number(raw)
                      if (Number.isInteger(n) && n >= 100 && n <= 599) commit({ ...plan, match: { ...rest, status: n } })
                      else e.target.value = plan.match.status ? String(plan.match.status) : ''
                    }}
                  />
                </span>
                <span className='flex items-center gap-1.5'>
                  最多读取
                  <Input
                    aria-label='最多读取行数'
                    className='h-7 w-24'
                    inputMode='numeric'
                    defaultValue={String(plan.limits.maxRows)}
                    disabled={disabled}
                    onBlur={(e) => {
                      const n = Number(e.target.value.trim())
                      if (Number.isInteger(n) && n >= 1 && n <= 50_000) commit({ ...plan, limits: { maxRows: n } })
                      else e.target.value = String(plan.limits.maxRows)
                    }}
                  />
                  行
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {owner ? (
        <NetworkPickerDialog
          open={pickerOpen}
          onOpenChange={(next) => {
            if (!next) clearNetworkPickerRequest(step.id)
            setPickerOpen(next)
          }}
          owner={owner}
          pageId={observe.viewedPageId()}
          initial={unconfigured ? null : plan}
          onConfirm={(result) => {
            lastKey.current = previewKeyOf(result.plan)
            setFields(result.fields)
            setPreview(result.sample)
            setFailure(null)
            commit(result.plan)
          }}
        />
      ) : null}
    </div>
  )
}
