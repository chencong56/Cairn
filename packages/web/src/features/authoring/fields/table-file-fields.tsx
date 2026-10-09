import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileUp, RefreshCw } from 'lucide-react'
import {
  isTablePlanUnconfigured,
  type ExtractInput,
  type Step,
  type TableFilePlan,
  type TableFilePreviewRequest,
  type TableFilePreviewResponse,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiRequestError } from '@/lib/api-client'
import { fileToBase64, previewTableFile } from '@/lib/table-file-api'
import { useResolutionSource } from '../resolution-source'
import { coverageSummary } from './table-plan-edit'
import { TablePreviewGrid } from './table-preview-grid'
import { setTableSample } from './table-sample-store'

type ExtractStep = Extract<Step, { type: 'extract' }>
type FileInput = Extract<ExtractInput, { source: 'file' }>
type Upload = { name: string; base64: string }

const FORMAT_LABEL: Record<TableFilePreviewResponse['file']['format'], string> = {
  xlsx: 'Excel（.xlsx）',
  csv: 'CSV 文本',
  html: '网页表格（老系统导出的 .xls）',
}
const HEADER_ROWS = Array.from({ length: 10 }, (_, i) => i + 1)
const planKeyOf = (p: TableFilePlan): string => JSON.stringify([p.columns, p.range, p.encoding, p.delimiter, p.totalRow])

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.payload.code === 'TABLE_FILE_NO_RUN_FILE') return '最近的运行里还没有这个下载步骤产出的文件：先“运行到此步前置”或调试运行到下载步骤，也可以上传一个样例文件。'
    return error.message
  }
  return '预览失败，请稍后再试'
}

/** 「下载文件里的数据」：读下载步骤存下的文件。预览用最近一次运行的文件或上传的样例（只用于预览，不保存）。 */
export function FileTableFields({
  step,
  disabled,
  onChange,
}: {
  step: ExtractStep
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  const { scenarioId, steps } = useResolutionSource()
  const input = step.input as FileInput
  const plan = input.table
  const at = steps?.findIndex((s) => s.id === step.id) ?? -1
  const downloads = (steps ?? []).slice(0, Math.max(0, at)).filter((s) => s.type === 'download' && !s.disabled && s.outputKey)
  const source = downloads.find((s) => s.outputKey === plan.fromKey)
  const unconfigured = isTablePlanUnconfigured(plan)

  const [preview, setPreview] = useState<TableFilePreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [upload, setUpload] = useState<Upload | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastKey = useRef(planKeyOf(plan))

  useEffect(() => {
    setTableSample(step.id, preview?.sample ?? null)
  }, [step.id, preview])

  const commit = (next: TableFilePlan) => onChange({ ...step, input: { as: 'table', source: 'file', table: next } } as Step)

  /** keepPlan=false：换了文件 / 工作表 / 表头行，按识别结果重建列。 */
  const load = async (options: { upload?: Upload | null; hints?: TableFilePreviewRequest['hints']; keepPlan: boolean }) => {
    if (!scenarioId || !source) return
    const using = options.upload === undefined ? upload : options.upload
    setLoading(true)
    setFailure(null)
    try {
      const response = await previewTableFile(scenarioId, {
        fromKey: plan.fromKey,
        downloadStepId: source.id,
        ...(options.keepPlan && !unconfigured ? { plan } : {}),
        ...(options.hints ? { hints: options.hints } : {}),
        source: using ? { kind: 'upload', name: using.name, base64: using.base64 } : { kind: 'latest_run' },
      })
      setPreview(response)
      if (!options.keepPlan || unconfigured) {
        // 由预览结果写回的计划就是刚预览过的那份，不再触发“列变化 → 刷新预览”
        lastKey.current = planKeyOf(response.plan)
        commit(response.plan)
      }
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  // 前面只有一个下载步骤、还没选：直接选上它
  useEffect(() => {
    const only = downloads.length === 1 ? downloads[0] : undefined
    if (!source && only?.outputKey && !disabled) commit({ ...plan, fromKey: only.outputKey })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, downloads.length])

  // 选好了下载步骤、还没预览过：自动用最近一次运行的文件试一次
  const autoLoaded = useRef<string | null>(null)
  useEffect(() => {
    if (!source || !scenarioId || autoLoaded.current === `${step.id}:${source.id}`) return
    autoLoaded.current = `${step.id}:${source.id}`
    void load({ keepPlan: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, scenarioId, step.id])

  // 列勾选 / 改名后，防抖刷新预览（同一个文件）
  const planKey = planKeyOf(plan)
  useEffect(() => {
    if (!preview || lastKey.current === planKey) return
    lastKey.current = planKey
    const timer = setTimeout(() => void load({ keepPlan: true }), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  const pickUpload = async (file: File | undefined) => {
    if (!file) return
    const next = { name: file.name, base64: await fileToBase64(file) }
    setUpload(next)
    await load({ upload: next, keepPlan: false })
  }

  const summary = coverageSummary(preview?.sample)
  const summaryRowCount = preview?.sample.summaryRows?.length ?? 0
  const sheetName = plan.sheet?.name ?? preview?.file.sheet

  return (
    <div className='space-y-3' data-testid='table-file-fields'>
      <div className='space-y-1.5'>
        <Label>来自哪一步下载</Label>
        {downloads.length === 0 ? (
          <p className='rounded-md border border-dashed border-border-divider bg-muted/20 p-2.5 text-xs text-muted-foreground' data-testid='table-file-no-download'>
            前面没有下载步骤。先在步骤管线里加一个“下载”步骤，并填写“保存本步结果为”，再回来选择。
          </p>
        ) : (
          <Select
            value={source?.id ?? ''}
            disabled={disabled}
            onValueChange={(id) => {
              const picked = downloads.find((s) => s.id === id)
              if (picked?.outputKey) {
                setPreview(null)
                commit({ ...plan, fromKey: picked.outputKey })
              }
            }}
          >
            <SelectTrigger aria-label='来自哪一步下载'>
              <SelectValue placeholder='选择下载步骤' />
            </SelectTrigger>
            <SelectContent>
              {downloads.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  步骤 {(steps ?? []).indexOf(s) + 1}「{s.name}」→ {s.outputKey}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {source ? (
        <div className='space-y-1.5'>
          <p className='text-xs text-muted-foreground' data-testid='table-file-source'>
            {preview
              ? preview.source.kind === 'latest_run'
                ? `预览用的文件：最近一次运行 · ${new Date(preview.source.at).toLocaleString()} · ${preview.file.name}`
                : `预览用的文件：上传的样例 · ${preview.file.name}（只用于预览，不保存）`
              : loading
                ? '正在读取文件…'
                : '还没有预览'}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Button type='button' size='sm' variant='outline' disabled={disabled || loading} onClick={() => { setUpload(null); void load({ upload: null, keepPlan: !unconfigured }) }}>
              <RefreshCw className='mr-1 size-3.5' />
              用最近一次运行的文件
            </Button>
            <Button type='button' size='sm' variant='outline' disabled={disabled || loading} onClick={() => fileInput.current?.click()}>
              <FileUp className='mr-1 size-3.5' />
              上传样例文件
            </Button>
            <input
              ref={fileInput}
              type='file'
              className='hidden'
              aria-label='选择样例文件'
              accept='.csv,.txt,.xlsx,.xls,.html,.htm'
              onChange={(event) => {
                void pickUpload(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
        </div>
      ) : null}

      {failure ? (
        <p className='rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive' role='alert'>
          {failure}
        </p>
      ) : null}

      {preview ? (
        <div className='space-y-2'>
          <p className='text-xs' data-testid='table-file-detected'>
            识别：{FORMAT_LABEL[preview.file.format]} · 明细 {preview.sample.rowCount} 行
            {summaryRowCount > 0 ? `（另有合计行 ${summaryRowCount} 行，不计入明细）` : ''}
            {preview.file.encoding && preview.file.format !== 'xlsx' ? ` · 按 ${preview.file.encoding.toUpperCase()} 编码读取` : ''}
          </p>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-xs'>
            {preview.sheets && preview.sheets.length > 0 ? (
              <span className='flex items-center gap-1.5'>
                工作表
                <Select
                  value={sheetName ?? ''}
                  disabled={disabled || loading}
                  onValueChange={(name) => {
                    commit({ ...plan, sheet: { name } })
                    void load({ hints: { sheet: { name } }, keepPlan: false })
                  }}
                >
                  <SelectTrigger className='h-7 w-auto min-w-24' aria-label='工作表'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.sheets.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        {s.name}（{s.rows} 行）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
            ) : null}
            <span className='flex items-center gap-1.5'>
              表头在第
              <Select
                value={plan.header.row === 'auto' ? 'auto' : String(plan.header.row)}
                disabled={disabled || loading}
                onValueChange={(v) => {
                  const header = { row: v === 'auto' ? ('auto' as const) : Number(v), rows: plan.header.rows }
                  commit({ ...plan, header })
                  void load({ hints: { header, ...(plan.sheet ? { sheet: plan.sheet } : {}) }, keepPlan: false })
                }}
              >
                <SelectTrigger className='h-7 w-auto min-w-20' aria-label='表头在第几行'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='auto'>自动（第 {preview.headerRow} 行）</SelectItem>
                  {HEADER_ROWS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              行
            </span>
          </div>
          {/* 读全时第一行的“明细 N 行”已说明，只在读不全 / 读不出时另起一行 */}
          {summary && summary.tone !== 'ok' ? (
            <p className={summary.tone === 'warn' ? 'text-xs text-amber-700' : 'text-xs text-destructive'}>{summary.text}</p>
          ) : null}
          {preview.sample.rowCount > preview.sample.rows.length ? (
            <p className='text-xs text-muted-foreground'>预览只带回前 {preview.sample.rows.length} 行；保存后数据检查按全部 {preview.sample.rowCount} 行计算。</p>
          ) : null}
          <TablePreviewGrid plan={plan} columns={preview.columns} sample={preview.sample} unit='列' disabled={disabled} onChange={commit} />
        </div>
      ) : null}

      {!unconfigured ? (
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
            <div className='space-y-3 rounded-md border bg-muted/20 p-2.5 text-xs'>
              <div className='grid grid-cols-2 gap-2'>
                <div className='space-y-1'>
                  <Label>文本编码</Label>
                  <Select value={plan.encoding} disabled={disabled} onValueChange={(v) => commit({ ...plan, encoding: v as TableFilePlan['encoding'] })}>
                    <SelectTrigger aria-label='文本编码'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='auto'>自动识别</SelectItem>
                      <SelectItem value='utf-8'>UTF-8</SelectItem>
                      <SelectItem value='gb18030'>GBK / GB18030</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1'>
                  <Label>分隔符（CSV）</Label>
                  <Select value={plan.delimiter} disabled={disabled} onValueChange={(v) => commit({ ...plan, delimiter: v as TableFilePlan['delimiter'] })}>
                    <SelectTrigger aria-label='分隔符'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='auto'>自动识别</SelectItem>
                      <SelectItem value='comma'>逗号</SelectItem>
                      <SelectItem value='tab'>制表符</SelectItem>
                      <SelectItem value='semicolon'>分号</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1'>
                  <Label htmlFor={`table-file-start-${step.id}`}>数据从第几行开始</Label>
                  <Input
                    id={`table-file-start-${step.id}`}
                    type='number'
                    min={1}
                    placeholder='表头下一行'
                    defaultValue={plan.range.startRow ?? ''}
                    disabled={disabled}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      const { startRow: _s, ...rest } = plan.range
                      commit({ ...plan, range: e.target.value && n >= 1 ? { ...rest, startRow: Math.floor(n) } : rest })
                    }}
                  />
                </div>
                <div className='space-y-1'>
                  <Label htmlFor={`table-file-max-${step.id}`}>最多读取行数</Label>
                  <Input
                    id={`table-file-max-${step.id}`}
                    type='number'
                    min={1}
                    max={50000}
                    defaultValue={plan.limits.maxRows}
                    disabled={disabled}
                    onBlur={(e) => commit({ ...plan, limits: { maxRows: Math.min(50_000, Math.max(1, Math.floor(Number(e.target.value) || 50_000))) } })}
                  />
                </div>
              </div>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={plan.range.stopAtBlankRow}
                  disabled={disabled}
                  onCheckedChange={(checked) => commit({ ...plan, range: { ...plan.range, stopAtBlankRow: checked === true } })}
                />
                <span>遇到整行空白就停止（表格下方另有说明文字时保持勾选）</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
