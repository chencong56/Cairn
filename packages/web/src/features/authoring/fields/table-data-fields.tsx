import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, MousePointerClick } from 'lucide-react'
import { toast } from 'sonner'
import {
  type ExtractInput,
  type Step,
  type TableDetectObservation,
  type TableDetected,
  type TableReadPlanV2,
  type TableSample,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { copyToClipboard } from '@/lib/clipboard'
import { useAuthoringObserve } from '../observe'
import { TablePreviewGrid } from './table-preview-grid'
import { setTableSample } from './table-sample-store'
import {
  columnLabel,
  coverageSummary,
  foundSummary,
  kindNoun,
  planKind,
  rootSelectorOf,
  scopeAlternatives,
  setColumnSource,
  setColumnType,
  setEmptyMeansNone,
  setHeaderMode,
  setTotalRow,
  totalRowsSummary,
  pageInfoSummary,
  setMaxRows,
  setRootSelector,
  tableInputFromDetected,
  tablePlanState,
  createPlaceholderNetworkPlan,
  setTreeLayout,
  TREE_SCOPE_LABEL,
  crosstabLayerNames,
  setCrosstabColumnDim,
  setCrosstabLayout,
  setCrosstabRowDims,
  setCrosstabValueName,
} from './table-plan-edit'
import { requestNetworkPicker } from './network-picker-request'

const CHART_LIB_LABEL: Record<'echarts' | 'chartjs' | 'highcharts' | 'other', string> = {
  echarts: 'ECharts',
  chartjs: 'Chart.js',
  highcharts: 'Highcharts',
  other: '图表库',
}

type ExtractTableStep = Extract<Step, { type: 'extract' }>
/** 页面来源的表格提取输入（文件来源见 table-file-fields）。 */
type TableInput = Exclude<Extract<ExtractInput, { as: 'table' }>, { source: 'file' | 'network' }>

/** 「表格 / 列表数据」提取：点一下、看预览、确认。高级设置折叠在最下面。 */
export function TableDataFields({
  step,
  disabled,
  onChange,
}: {
  step: ExtractTableStep
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  const observe = useAuthoringObserve()
  const input = step.input as TableInput
  const state = tablePlanState(input.table)
  const plan: TableReadPlanV2 | null = input.table.protocol === 'table.read@2' ? input.table : null

  const [detected, setDetected] = useState<TableDetected | null>(null)
  const [preview, setPreview] = useState<TableSample | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [failure, setFailure] = useState<{ message: string; feedback?: string } | null>(null)
  const [chart, setChart] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 数据检查要用最近一次预览（候选值 / 按预览提示结果）
  useEffect(() => {
    setTableSample(step.id, preview)
  }, [step.id, preview])
  const stepIdRef = useRef(step.id)

  // 换了步骤就清掉上一步的识别结果与预览
  useEffect(() => {
    if (stepIdRef.current !== step.id) {
      stepIdRef.current = step.id
      setDetected(null)
      setPreview(null)
      setFailure(null)
    }
  }, [step.id])

  const commit = (next: TableReadPlanV2) => {
    onChange({ ...step, input: { target: next.target, as: 'table', table: next } } as Step)
  }

  const refreshPreview = async (nextPlan: TableReadPlanV2) => {
    setPreviewing(true)
    try {
      const result = await observe.previewTable(nextPlan)
      if (result) setPreview(result.sample)
    } catch {
      // 预览失败不挡路：保存与试跑仍可继续
    } finally {
      setPreviewing(false)
    }
  }

  // 列勾选 / 类型等改动后，防抖刷新预览
  const planKey = plan ? JSON.stringify([plan.columns, plan.rows, plan.readiness, plan.limits, plan.layout]) : ''
  const lastPreviewKey = useRef(planKey)
  useEffect(() => {
    if (!plan || state !== 'ready' || !observe.livePage) return
    if (lastPreviewKey.current === planKey) return
    lastPreviewKey.current = planKey
    const timer = setTimeout(() => void refreshPreview(plan), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  const apply = (observation: TableDetectObservation | undefined) => {
    if (!observation) return
    if (observation.outcome === 'FOUND' && observation.detected) {
      const d = observation.detected
      setDetected(d)
      setPreview(d.sample)
      setFailure(null)
      lastPreviewKey.current = JSON.stringify([d.plan.columns, d.plan.rows, d.plan.readiness, d.plan.limits, d.plan.layout])
      onChange({ ...step, input: tableInputFromDetected(d) } as Step)
      if (observe.canHighlight) void observe.highlightTarget(d.plan.target, { silent: true })
      return
    }
    if (observation.chart) {
      setFailure(null)
      setChart(CHART_LIB_LABEL[observation.chart.lib])
      return
    }
    setFailure({
      message: observation.reason?.message ?? '没有认出这个表格，请点表格里的另一处。',
      feedback: observation.reason?.feedback,
    })
  }

  /** 图表的数字不在页面上：改读接口返回的数据，并直接打开“选择接口”。 */
  const switchToNetwork = () => {
    requestNetworkPicker(step.id)
    onChange({ ...step, input: { as: 'table', source: 'network', table: createPlaceholderNetworkPlan() } } as Step)
  }

  const startPick = () => {
    setFailure(null)
    setChart(null)
    observe.beginTablePick((observation) => apply(observation))
  }

  const switchScope = async (selector: string) => {
    if (!plan) return
    apply(await observe.detectTableRoot(selector, plan.target.framePath))
  }

  const copyFeedback = async () => {
    if (!failure?.feedback) return
    const ok = await copyToClipboard(`页面结构反馈（含页面文本，发送前请自行确认）\n${failure.feedback}`)
    if (ok) toast.success('已复制页面结构反馈')
    else toast.error('复制失败，请手动选择文字')
  }

  const popupNotice = observe.viewingPopup()
    ? '你现在看的是弹出页。执行时这一步在“当前页”运行：请先把上一步点击的“点击后页面”设为“切换到弹出窗口”，或用“运行到此步前置”。'
    : null

  const summary = coverageSummary(preview)
  /** 认出了层级（或已经按树形读）：才出现“读法 / 读取范围”。 */
  const treeCapable = plan?.layout !== undefined || detected?.plan.layout?.mode === 'tree' || Boolean(preview?.rowMeta)
  /** 像交叉表（或已经按交叉表读）：读法里出现“交叉表”，并给一条建议。 */
  const crossHint = detected?.crosstabHint
  const crossLayout = plan?.layout?.mode === 'crosstab' ? plan.layout : null
  const crosstabMode = crossLayout !== null
  const crosstabCapable = crosstabMode || Boolean(crossHint)
  const alternatives = detected ? scopeAlternatives(detected) : {}

  /** 切到交叉表读法：按建议（或现有勾选）取前 N 列作行维度，列维度层名先占位。 */
  const switchToCrosstab = () => {
    if (!plan) return
    const dims = crossHint?.rowDims ?? plan.columns.length
    const withRows = setCrosstabRowDims(plan, detected?.columns ?? [], dims)
    commit(setCrosstabLayout(withRows, { columnDims: crosstabLayerNames(crossHint?.depth ?? 1) }))
  }

  return (
    <div className='space-y-3'>
      <div className='space-y-1.5'>
        <Label>{state === 'ready' ? `要读取的${kindNoun(planKind(plan))}` : '要读取的表格'}</Label>
        {state === 'unconfigured' ? (
          <p className='text-xs text-muted-foreground'>
            请在受管画面上点一下表格、卡片或详情信息里的任意位置，系统会自己找出整块数据。
          </p>
        ) : state === 'legacy' ? (
          <p className='rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900'>
            这一步用的是旧版读取计划。重新点选一次表格即可升级，升级后可勾选列、看预览。
          </p>
        ) : (
          <p className='text-xs text-muted-foreground'>
            {detected?.title ? `已选：「${detected.title}」· ` : `已选${kindNoun(planKind(plan))} · `}
            {plan?.columns.length ?? 0} {planKind(plan) === 'table' ? '列' : '项'}
          </p>
        )}
        {popupNotice ? <p className='text-xs text-amber-700'>{popupNotice}</p> : null}
        <div className='flex flex-wrap gap-2'>
          <Button type='button' size='sm' disabled={disabled} onClick={startPick}>
            <MousePointerClick className='mr-1 size-4' />
            {state === 'ready' ? '重新点选' : '在页面上点选'}
          </Button>
          {state === 'ready' && alternatives.outer ? (
            <Button type='button' size='sm' variant='outline' disabled={disabled} onClick={() => void switchScope(alternatives.outer!.selector)}>
              范围大一点
            </Button>
          ) : null}
          {state === 'ready' && alternatives.inner ? (
            <Button type='button' size='sm' variant='outline' disabled={disabled} onClick={() => void switchScope(alternatives.inner!.selector)}>
              范围小一点
            </Button>
          ) : null}
        </div>
      </div>

      {chart ? (
        <div className='space-y-2 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-2 text-xs text-sky-900' data-testid='chart-guide'>
          <p>这是一个图表（{chart}），图表里的数字画在图上、不在页面文字里，没法在页面上读。</p>
          <p className='text-sky-800/80'>图表的数据来自页面背后的查询接口，可以改为读取接口返回的数据。</p>
          <Button type='button' size='sm' disabled={disabled} onClick={switchToNetwork}>
            改为读取接口返回的数据
          </Button>
        </div>
      ) : null}

      {failure ? (
        <div className='space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs'>
          <p className='text-destructive'>{failure.message}</p>
          <p className='text-muted-foreground'>可以点表格里的另一处再试；也可以展开下面的“一般不用动”手动指定。</p>
          <div className='flex flex-wrap gap-2'>
            <Button type='button' size='sm' variant='outline' onClick={() => setAdvancedOpen(true)}>
              手动指定
            </Button>
            {failure.feedback ? (
              <Button type='button' size='sm' variant='outline' onClick={() => void copyFeedback()}>
                <Copy className='mr-1 size-3.5' />
                复制页面结构反馈
              </Button>
            ) : null}
          </div>
          {failure.feedback ? <p className='text-muted-foreground'>反馈内容包含页面文本，发送前请自行确认。</p> : null}
        </div>
      ) : null}

      {state === 'ready' && crossHint && !crosstabMode ? (
        <div className='space-y-2 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-2 text-xs text-sky-900' data-testid='crosstab-hint'>
          <p>这张表像交叉表，按交叉表读更方便检查：前 {crossHint.rowDims} 列是行维度，列头有 {crossHint.depth} 层。</p>
          <Button type='button' size='sm' disabled={disabled} onClick={switchToCrosstab}>
            按交叉表读
          </Button>
        </div>
      ) : null}

      {state === 'ready' && plan && (treeCapable || crosstabCapable) ? (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-xs' data-testid='table-read-mode'>
            <span className='flex items-center gap-1.5'>
              读法
              <span role='group' aria-label='读法' className='inline-flex overflow-hidden rounded-md border'>
                {(['flat', 'tree', ...(crosstabCapable ? (['crosstab'] as const) : [])] as const).map((mode) => {
                  const current = plan.layout?.mode === 'tree' || plan.layout?.mode === 'crosstab' ? plan.layout.mode : 'flat'
                  const on = mode === current
                  return (
                    <button
                      key={mode}
                      type='button'
                      aria-pressed={on}
                      disabled={disabled}
                      className={on ? 'bg-primary px-2.5 py-1 text-primary-foreground' : 'px-2.5 py-1 hover:bg-muted'}
                      onClick={() => {
                        if (on) return
                        if (mode === 'tree') commit(setTreeLayout(plan, 'all'))
                        else if (mode === 'crosstab') switchToCrosstab()
                        else commit(setTreeLayout(plan, null))
                      }}
                    >
                      {mode === 'tree' ? '树形' : mode === 'crosstab' ? '交叉表' : '普通'}
                    </button>
                  )
                })}
              </span>
            </span>
            {plan.layout?.mode === 'tree' ? (
              <span className='flex items-center gap-1.5'>
                读取范围
                <Select value={plan.layout.scope} disabled={disabled} onValueChange={(v) => commit(setTreeLayout(plan, v as 'all' | 'top' | 'leaf'))}>
                  <SelectTrigger className='h-7 w-auto min-w-32' aria-label='读取范围'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['all', 'top', 'leaf'] as const).map((scope) => (
                      <SelectItem key={scope} value={scope}>
                        {TREE_SCOPE_LABEL[scope]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
            ) : null}
          </div>
          {crossLayout ? (
            <div className='space-y-1.5 text-xs' data-testid='crosstab-config'>
              <div className='flex flex-wrap items-center gap-1.5'>
                <span>前</span>
                <Input
                  aria-label='行维度列数'
                  className='h-7 w-14'
                  type='number'
                  min={1}
                  max={detected?.columns.filter((c) => !c.excludedReason).length || plan.columns.length}
                  defaultValue={plan.columns.length}
                  disabled={disabled}
                  onBlur={(event) => {
                    const n = Number(event.target.value.trim())
                    if (event.target.value.trim() !== '' && Number.isFinite(n)) commit(setCrosstabRowDims(plan, detected?.columns ?? [], n))
                    else event.target.value = String(plan.columns.length)
                  }}
                />
                <span>列是行维度，其余列是数值列；预览里会看到逆透视后的长表。</span>
              </div>
              {crossLayout.columnDims.map((name, i) => (
                <div key={i} className='flex flex-wrap items-center gap-1.5'>
                  <span>列头第 {i + 1} 层叫</span>
                  <Input
                    aria-label={`列头第 ${i + 1} 层的名字`}
                    className='h-7 w-28'
                    defaultValue={name}
                    disabled={disabled}
                    onBlur={(event) => commit(setCrosstabColumnDim(plan, i, event.target.value))}
                  />
                </div>
              ))}
              <div className='flex flex-wrap items-center gap-1.5'>
                <span>数值叫</span>
                <Input
                  aria-label='数值列的名字'
                  className='h-7 w-24'
                  defaultValue={crossLayout.value.name}
                  disabled={disabled}
                  onBlur={(event) => commit(setCrosstabValueName(plan, event.target.value))}
                />
                <span>（数字；空格当 0）</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {state === 'ready' && plan ? (
        <div className='space-y-2'>
          <p className='text-sm font-medium'>
            {detected
              ? foundSummary(detected)
              : preview
                ? `预览（${preview.rowCount} 行）`
                : '预览'}
            {previewing ? <span className='ml-2 text-xs font-normal text-muted-foreground'>刷新中…</span> : null}
          </p>
          {detected?.notes.length ? (
            <ul className='space-y-0.5 text-xs text-muted-foreground'>
              {detected.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          ) : null}
          {summary ? (
            <p
              className={
                summary.tone === 'ok'
                  ? 'text-xs text-emerald-700'
                  : summary.tone === 'warn'
                    ? 'text-xs text-amber-700'
                    : 'text-xs text-destructive'
              }
            >
              {summary.text}
            </p>
          ) : (
            <p className='text-xs text-muted-foreground'>
              {observe.livePage ? '点“重新点选”可刷新预览。' : '连接受管画面后可看到预览。'}
            </p>
          )}

          {totalRowsSummary(preview) ? <p className='text-xs text-muted-foreground'>{totalRowsSummary(preview)}</p> : null}
          {pageInfoSummary(preview) ? <p className='text-xs text-muted-foreground' data-testid='table-page-info'>{pageInfoSummary(preview)}</p> : null}
          <TablePreviewGrid
            plan={plan}
            columns={detected?.columns ?? null}
            sample={preview}
            unit={planKind(plan) === 'table' ? '列' : '项'}
            disabled={disabled}
            onChange={commit}
          />
        </div>
      ) : null}

      {plan ? (
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
          {advancedOpen ? <AdvancedSettings plan={plan} disabled={disabled} onChange={commit} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function AdvancedSettings({
  plan,
  disabled,
  onChange,
}: {
  plan: TableReadPlanV2
  disabled?: boolean
  onChange: (plan: TableReadPlanV2) => void
}) {
  return (
    <div className='space-y-3 rounded-md border bg-muted/20 p-2.5 text-xs'>
      <div className='space-y-1'>
        <Label htmlFor='table-root-selector'>表格在页面上的位置（选择器）</Label>
        <Input
          id='table-root-selector'
          defaultValue={rootSelectorOf(plan)}
          disabled={disabled}
          onBlur={(event) => onChange(setRootSelector(plan, event.target.value))}
        />
      </div>
      <div className='grid grid-cols-2 gap-2'>
        <div className='space-y-1'>
          <Label>表头在哪</Label>
          <Select value={plan.rows.header} disabled={disabled} onValueChange={(v) => onChange(setHeaderMode(plan, v as 'auto' | 'first_row' | 'none'))}>
            <SelectTrigger aria-label='表头在哪'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='auto'>自动判断</SelectItem>
              <SelectItem value='first_row'>第一行是表头</SelectItem>
              <SelectItem value='none'>没有表头</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-1'>
          <Label htmlFor='table-max-rows'>最多读取行数</Label>
          <Input
            id='table-max-rows'
            type='number'
            min={1}
            max={200}
            defaultValue={plan.limits.maxRows}
            disabled={disabled}
            onBlur={(event) => onChange(setMaxRows(plan, Number(event.target.value)))}
          />
        </div>
      </div>
      <label className='flex items-center gap-2'>
        <Checkbox
          checked={Boolean(plan.readiness?.emptyMeansNone)}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(setEmptyMeansNone(plan, checked === true))}
        />
        <span>这张表空着就代表没有数据（页面没有“暂无数据”提示时勾上）</span>
      </label>
      <div className='space-y-1'>
        <Label>合计行（可选）</Label>
        <p className='text-muted-foreground'>首列写着“合计 / 总计 / 小计”的行会自动识别。别的写法可以在这里指定：某一列等于某个文字的行就是合计行。</p>
        <div className='grid grid-cols-2 gap-2'>
          <Select
            value={plan.rows.totalRow?.columnKey ?? 'none'}
            disabled={disabled}
            onValueChange={(v) => onChange(setTotalRow(plan, v === 'none' ? null : v, plan.rows.totalRow?.equals ?? ''))}
          >
            <SelectTrigger aria-label='合计行所在的列'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不手工指定</SelectItem>
              {plan.columns.map((c) => (
                <SelectItem key={c.key} value={c.key}>{columnLabel(c)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label='合计行的文字'
            placeholder='例如：本页统计'
            defaultValue={plan.rows.totalRow?.equals ?? ''}
            disabled={disabled || !plan.rows.totalRow}
            onBlur={(event) => onChange(setTotalRow(plan, plan.rows.totalRow?.columnKey ?? null, event.target.value))}
          />
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label>每一列怎么读</Label>
        {plan.columns.map((column) => (
          <div key={column.key} className='grid grid-cols-[1fr_6rem_8rem] items-center gap-2'>
            <span className='truncate' title={column.valueType === 'date' ? `${column.name}（这一列被当作日期读取，不对可在右侧改回数字 / 文字）` : column.name}>
              {columnLabel(column)}
              {column.valueType === 'date' ? <span className='ml-1 rounded bg-primary/10 px-1 text-[11px] text-primary' data-testid='date-column-badge'>按日期读</span> : null}
            </span>
            <Select value={column.valueType} disabled={disabled} onValueChange={(v) => onChange(setColumnType(plan, column.key, v as 'text' | 'number' | 'boolean' | 'date'))}>
              <SelectTrigger aria-label={`「${column.name}」列的类型`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='text'>文字</SelectItem>
                <SelectItem value='number'>数字</SelectItem>
                <SelectItem value='boolean'>是 / 否</SelectItem>
                <SelectItem value='date'>日期</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={column.source === 'index' ? 'index' : 'header'}
              disabled={disabled}
              onValueChange={(v) => onChange(setColumnSource(plan, column.key, v as 'header' | 'index', column.index ?? Number(column.key.replace(/\D/g, '')) - 1))}
            >
              <SelectTrigger aria-label={`「${column.name}」列的取列方式`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='header'>按表头列名</SelectItem>
                <SelectItem value='index'>按第几列</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </div>
  )
}

