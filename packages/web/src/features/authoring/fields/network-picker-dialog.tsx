import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  JsonOutlineNodeDto,
  NetworkCapturedEntry,
  NetworkInspectObservation,
  TableNetworkPlan,
  TableSample,
} from '@cairn/shared'
import { RefreshCw, RotateCw, Star } from 'lucide-react'
import { ApiRequestError } from '@/lib/api-client'
import {
  observeNetwork,
  type NetworkObserveOwner,
} from '@/lib/network-observe-api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  asRowsDraft,
  draftFromPlan,
  draftFromSuggestion,
  formatBytes,
  planFromDraft,
  rowFieldsOf,
  setTotalPath,
  toggleRowField,
  toggleSeries,
  type PickerColumn,
  type PickerDraft,
} from './network-picker-model'

const PREVIEW_ROWS = 5

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiRequestError ? error.message : fallback

function cellText(sample: TableSample, i: number, key: string): string {
  const f = sample.rows[i]?.[key]
  if (!f) return ''
  if (f.status === 'masked') return '••••'
  if (f.status === 'missing') return '—'
  if (f.status === 'error') return `${f.rawText ?? ''}（读不出）`
  return String(f.rawText ?? f.value ?? '')
}

function timeOf(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString()
}

const shortUrl = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export type NetworkPickResult = {
  plan: TableNetworkPlan
  fields: PickerColumn[]
  sample: TableSample | null
  entry: NetworkCapturedEntry
}

/**
 * 选择接口返回的数据：左边是本页捕获到的接口（★ 最像数据源），右边是所选响应的 JSON 结构，
 * 点数组“用作数据行”、勾字段成列；图表的列式数组“按下标拼成行”；数字字段“设为总条数”。底部是预览。
 * 捕获从打开窗口（或面板）开始，之前发出的请求看不到；看不到时可“重新加载并捕获”。
 */
type PickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  owner: NetworkObserveOwner
  pageId?: string
  /** 已有的读取计划：重新打开时沿用它的数据位置与字段。 */
  initial?: TableNetworkPlan | null
  onConfirm: (result: NetworkPickResult) => void
}

export function NetworkPickerDialog(props: PickerProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className='flex max-h-[88vh] w-[min(1100px,96vw)] max-w-none flex-col gap-3 sm:max-w-none'
        data-testid='network-picker'
      >
        {/* 每次打开重新挂载：捕获列表、所选响应与草稿都从头来 */}
        {props.open ? <PickerBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PickerBody({
  onOpenChange,
  owner,
  pageId,
  initial,
  onConfirm,
}: PickerProps) {
  const [entries, setEntries] = useState<NetworkCapturedEntry[]>([])
  const [since, setSince] = useState<string | null>(null)
  const [listing, setListing] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<NetworkCapturedEntry | null>(null)
  const [inspected, setInspected] = useState<NetworkInspectObservation | null>(
    null
  )
  const [draft, setDraft] = useState<PickerDraft | null>(null)
  /** 预览结果连同它对应的计划：计划变了就不再显示旧预览。 */
  const [previewed, setPreviewed] = useState<{
    key: string
    sample: TableSample | null
  } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const autoPicked = useRef(false)
  const withPage = <T extends object>(op: T): T & { pageId?: string } =>
    pageId ? { ...op, pageId } : op

  const list = async (reload: boolean) => {
    setListing(true)
    setProblem(null)
    try {
      const res = await observeNetwork(
        owner,
        withPage({
          op: 'network' as const,
          subOp: reload ? ('reload' as const) : ('list' as const),
        })
      )
      setEntries(res.entries)
      setSince(res.capturingSince)
      return res.entries
    } catch (error) {
      setProblem(errorText(error, '读取捕获列表失败'))
      return []
    } finally {
      setListing(false)
    }
  }

  const inspect = async (
    entry: NetworkCapturedEntry,
    preferInitial: boolean
  ) => {
    setSelected(entry)
    setInspected(null)
    setProblem(null)
    try {
      const res = await observeNetwork(
        owner,
        withPage({
          op: 'network' as const,
          subOp: 'inspect' as const,
          entryId: entry.id,
        })
      )
      setInspected(res)
      if (res.reason) setProblem(res.reason.message)
      const fromInitial =
        preferInitial && initial ? draftFromPlan(initial) : null
      setDraft(
        fromInitial ??
          (res.suggestions[0] ? draftFromSuggestion(res.suggestions[0]) : null)
      )
    } catch (error) {
      setProblem(errorText(error, '读取这个响应失败'))
    }
  }

  // 打开时开始捕获并列出；有星标的自动选上（重新打开时优先选与已有计划同一地址的）
  useEffect(() => {
    const timer = setTimeout(() => {
      void list(false).then((found) => {
        if (autoPicked.current) return
        const same = initial
          ? found.find(
              (e) =>
                e.url.includes(initial.match.url) &&
                (!initial.match.method || e.method === initial.match.method)
            )
          : undefined
        const pick = same ?? found.find((e) => e.best)
        if (pick) {
          autoPicked.current = true
          void inspect(pick, Boolean(same))
        }
      })
    }, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const plan = selected ? planFromDraft(selected, draft, initial) : null
  const planKey = plan ? JSON.stringify(plan) : ''

  const previewKey = selected && plan ? `${selected.id}:${planKey}` : ''
  const sample =
    previewed && previewed.key === previewKey ? previewed.sample : null

  // 草稿变了就按这个响应重新预览
  useEffect(() => {
    if (!selected || !plan) return
    const key = previewKey
    const timer = setTimeout(() => {
      void observeNetwork(
        owner,
        withPage({
          op: 'network' as const,
          subOp: 'read' as const,
          entryId: selected.id,
          plan,
        })
      )
        .then((res) => {
          setPreviewed({ key, sample: res.sample ?? null })
          setProblem(res.reason?.message ?? null)
        })
        .catch((error) => setProblem(errorText(error, '预览失败')))
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q
      ? entries.filter(
          (e) =>
            e.url.toLowerCase().includes(q) ||
            e.method.toLowerCase().includes(q)
        )
      : entries
  }, [entries, filter])

  const nodes = inspected?.nodes ?? []
  const suggestions = inspected?.suggestions ?? []
  const rowFields =
    draft?.layout === 'rows' && draft.rowsPath
      ? rowFieldsOf(nodes, draft.rowsPath, suggestions)
      : []
  const rowPrefix =
    draft?.layout === 'rows' && draft.rowsPath ? `${draft.rowsPath}.0.` : null

  const confirm = () => {
    if (!selected || !plan) return
    onConfirm({
      plan,
      fields: draft?.layout === 'rows' ? rowFields : (draft?.columns ?? []),
      sample,
      entry: selected,
    })
    onOpenChange(false)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>选择接口返回的数据</DialogTitle>
        <DialogDescription>
          只读页面自己发出的接口，不重放、不保存请求头与
          Cookie；保存的只有你选的字段。
          {since ? ` 捕获开始于 ${timeOf(since)}，之前发出的请求看不到。` : ''}
        </DialogDescription>
      </DialogHeader>

      <div className='grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'>
        {/* 左：捕获到的接口 */}
        <div className='flex min-h-0 flex-col gap-2'>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='筛选地址…'
            aria-label='筛选地址'
            className='h-8'
          />
          <div
            className='min-h-40 flex-1 overflow-y-auto rounded-md border'
            role='listbox'
            aria-label='捕获到的接口'
          >
            {shown.length === 0 ? (
              <p
                className='p-3 text-xs text-muted-foreground'
                data-testid='network-empty'
              >
                {listing
                  ? '正在读取…'
                  : '还没有捕获到接口。捕获从打开本窗口开始，之前发出的请求看不到：在受管画面上操作一下再点“刷新列表”，或“重新加载并捕获”。'}
              </p>
            ) : (
              shown.map((e) => (
                <button
                  key={e.id}
                  type='button'
                  role='option'
                  aria-selected={selected?.id === e.id}
                  onClick={() => void inspect(e, false)}
                  className={cn(
                    'flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/50',
                    selected?.id === e.id && 'bg-primary/10',
                    !e.json && 'text-muted-foreground'
                  )}
                >
                  <span className='w-16 shrink-0 text-muted-foreground tabular-nums'>
                    {timeOf(e.at)}
                  </span>
                  <span className='w-10 shrink-0 font-medium'>{e.method}</span>
                  <span className='min-w-0 flex-1 truncate' title={e.url}>
                    {shortUrl(e.url)}
                  </span>
                  {e.status >= 400 ? (
                    <span className='shrink-0 text-destructive'>
                      {e.status}
                    </span>
                  ) : null}
                  <span className='shrink-0 text-muted-foreground tabular-nums'>
                    {e.tooLarge
                      ? '过大'
                      : !e.json
                        ? '非 JSON'
                        : e.rowHint !== undefined
                          ? `${e.rowHint} 条`
                          : formatBytes(e.byteSize)}
                  </span>
                  {e.best ? (
                    <Star
                      aria-label='最像数据源'
                      className='size-3.5 shrink-0 fill-amber-400 text-amber-500'
                    />
                  ) : null}
                </button>
              ))
            )}
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={listing}
              onClick={() => void list(false)}
            >
              <RefreshCw className='mr-1 size-3.5' />
              刷新列表
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={listing}
              onClick={() => void list(true)}
            >
              <RotateCw className='mr-1 size-3.5' />
              重新加载并捕获
            </Button>
            <span className='self-center text-caption text-muted-foreground'>
              会刷新受管画面里的当前页
            </span>
          </div>
        </div>

        {/* 右：JSON 结构 */}
        <div className='flex min-h-0 flex-col gap-2'>
          <div
            className='min-h-40 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs'
            data-testid='network-tree'
          >
            {!selected ? (
              <p className='font-sans text-muted-foreground'>
                在左边选一个接口，这里显示它返回的数据结构。
              </p>
            ) : !inspected ? (
              <p className='font-sans text-muted-foreground'>正在读取…</p>
            ) : nodes.length === 0 ? (
              <p className='font-sans text-muted-foreground'>
                {inspected.reason?.message ?? '这个响应没有可读的结构'}
              </p>
            ) : (
              nodes.map((n) => (
                <TreeRow
                  key={n.path || '(root)'}
                  node={n}
                  draft={draft}
                  rowPrefix={rowPrefix}
                  field={
                    rowPrefix && n.path.startsWith(rowPrefix)
                      ? rowFields.find(
                          (f) => f.path === n.path.slice(rowPrefix.length)
                        )
                      : undefined
                  }
                  onRows={() =>
                    setDraft(asRowsDraft(draft, nodes, n.path, suggestions))
                  }
                  onSeries={(checked) =>
                    setDraft(toggleSeries(draft, n, checked, suggestions))
                  }
                  onTotal={() =>
                    setDraft(
                      setTotalPath(
                        draft,
                        draft?.totalPath === n.path ? undefined : n.path
                      )
                    )
                  }
                  onField={(f, checked) =>
                    draft && setDraft(toggleRowField(draft, f, checked))
                  }
                />
              ))
            )}
            {inspected?.truncated ? (
              <p className='mt-1 font-sans text-caption text-muted-foreground'>
                结构太大，只显示了一部分。
              </p>
            ) : null}
          </div>
          <p
            className='text-caption text-muted-foreground'
            data-testid='network-draft-summary'
          >
            {!draft
              ? '点一个数组“用作数据行”，或勾选几个等长数组“按下标拼成行”。'
              : draft.layout === 'rows'
                ? `数据行：${draft.rowsPath ?? '未选'} · 已选 ${draft.columns.length} 个字段${draft.totalPath ? ` · 总条数：${draft.totalPath}` : ''}`
                : `按下标拼成行：${draft.columns.map((c) => c.name).join('、') || '未选'}${draft.totalPath ? ` · 总条数：${draft.totalPath}` : ''}`}
          </p>
        </div>
      </div>

      {problem ? (
        <p
          className='rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive'
          role='alert'
        >
          {problem}
        </p>
      ) : null}

      {sample && sample.rows.length > 0 ? (
        <div
          className='overflow-x-auto rounded-md border'
          data-testid='network-preview'
        >
          <table className='w-full text-xs'>
            <thead className='bg-muted/50'>
              <tr>
                {sample.columns.map((c) => (
                  <th
                    key={c.key}
                    className='border-b px-2 py-1 text-left font-medium'
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.rows.slice(0, PREVIEW_ROWS).map((_, i) => (
                <tr key={i} className='border-b last:border-b-0'>
                  {sample.columns.map((c) => (
                    <td key={c.key} className='px-2 py-1'>
                      {cellText(sample, i, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className='px-2 py-1 text-caption text-muted-foreground'>
            预览前 {Math.min(PREVIEW_ROWS, sample.rows.length)} 行，共{' '}
            {sample.rowCount} 行
            {sample.pageInfo?.totalRows !== undefined
              ? ` · 接口给的总条数 ${sample.pageInfo.totalRows}`
              : ''}
          </p>
        </div>
      ) : null}

      <DialogFooter>
        <Button
          type='button'
          variant='outline'
          onClick={() => onOpenChange(false)}
        >
          取消
        </Button>
        <Button type='button' disabled={!plan} onClick={confirm}>
          确定
        </Button>
      </DialogFooter>
    </>
  )
}

function TreeRow({
  node,
  draft,
  rowPrefix,
  field,
  onRows,
  onSeries,
  onTotal,
  onField,
}: {
  node: JsonOutlineNodeDto
  draft: PickerDraft | null
  rowPrefix: string | null
  field?: PickerColumn
  onRows: () => void
  onSeries: (checked: boolean) => void
  onTotal: () => void
  onField: (field: PickerColumn, checked: boolean) => void
}) {
  const isRows = draft?.layout === 'rows' && draft.rowsPath === node.path
  const isSeries =
    draft?.layout === 'columns' &&
    draft.columns.some((c) => c.path === node.path)
  const isTotal = draft?.totalPath === node.path
  const inRowSample = rowPrefix !== null && node.path.startsWith(rowPrefix)
  const label = node.key === '' ? '（根）' : node.key
  return (
    <div
      className='flex min-h-6 items-center gap-1.5 py-0.5'
      style={{ paddingLeft: node.depth * 14 }}
      data-path={node.path}
    >
      {field ? (
        <Checkbox
          aria-label={`取字段「${field.path}」`}
          checked={draft?.columns.some((c) => c.path === field.path) ?? false}
          onCheckedChange={(v) => onField(field, v === true)}
        />
      ) : null}
      <span className={cn('font-medium', isRows && 'text-primary')}>
        {label}
      </span>
      {node.type === 'array' ? (
        <span className='text-muted-foreground'>[{node.length} 项]</span>
      ) : null}
      {node.type === 'object' ? (
        <span className='text-muted-foreground'>{'{…}'}</span>
      ) : null}
      {node.preview !== undefined ? (
        <span
          className='min-w-0 truncate text-muted-foreground'
          title={node.preview}
        >
          : {node.preview}
        </span>
      ) : null}
      {field ? (
        <span className='rounded bg-muted px-1 font-sans text-caption text-muted-foreground'>
          {field.valueType === 'number'
            ? '数字'
            : field.valueType === 'date'
              ? '日期'
              : field.valueType === 'boolean'
                ? '是否'
                : '文字'}
        </span>
      ) : null}
      <span className='ml-auto flex shrink-0 items-center gap-1 font-sans'>
        {node.rows ? (
          <Button
            type='button'
            size='sm'
            variant={isRows ? 'default' : 'outline'}
            className='h-6 px-2 text-caption'
            onClick={onRows}
          >
            {isRows ? '✓ 数据行' : '用作数据行'}
          </Button>
        ) : null}
        {node.series ? (
          <label className='flex items-center gap-1 text-caption'>
            <Checkbox
              aria-label={`按下标拼成行：${node.path}`}
              checked={isSeries}
              onCheckedChange={(v) => onSeries(v === true)}
            />
            拼成行
          </label>
        ) : null}
        {node.numeric && !inRowSample && node.path !== '' ? (
          <Button
            type='button'
            size='sm'
            variant={isTotal ? 'default' : 'ghost'}
            className='h-6 px-2 text-caption'
            onClick={onTotal}
          >
            {isTotal ? '✓ 总条数' : '设为总条数'}
          </Button>
        ) : null}
      </span>
    </div>
  )
}
