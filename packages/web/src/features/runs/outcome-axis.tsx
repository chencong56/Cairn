import {
  candidateGroupsOf,
  expectKindLabel,
  joinOutcomeEvaluations,
  loopBodyHeadersOf,
  joinRuntimeInvariantEvaluations,
  STEP_SKIP_REASON_LABELS,
  type JoinedOutcomeEvaluation,
  faceScreenshot,
  type OutcomeStatus,
  type RunDetailDto,
  type EvidenceMetadata,
  isPageHealthKind,
  describePageRequestRule,
  pageHealthFactFromResult,
  pageHealthSampleText,
  type PageHealthSample,
} from '@cairn/shared'
import { RUNTIME_INVARIANT_KIND_LABELS } from '@/features/authoring/invariant-editor'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { cn } from '@/lib/utils'
import {
  type PageHealthIgnoreRule,
  RUN_OUTCOME_STATUS_HINTS,
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from './outcome-labels'

export type { PageHealthIgnoreRule } from './outcome-labels'
export {
  RUN_EXECUTION_AXIS_LABELS,
  RUN_OUTCOME_STATUS_HINTS,
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from './outcome-labels'

function evidenceForOutcomeResult(
  result: { evidenceId?: string | null; attemptId?: string | null } | undefined,
  evidenceItems: EvidenceMetadata[] | undefined,
): EvidenceMetadata[] {
  if (!evidenceItems?.length || !result) return []
  if (result.evidenceId) {
    const matched = evidenceItems.filter((item) => item.id === result.evidenceId)
    if (matched.length > 0) return matched
  }
  const face = result.attemptId ? faceScreenshot(evidenceItems, result.attemptId) : undefined
  return face ? [face] : []
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '无法展示'
  }
}

function formatExpected(value: unknown, kindLabel: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return kindLabel
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return kindLabel
}

type TableCheckDetails = {
  totalRowsChecked?: number
  violatingRowsCount?: number | null
  violatingRows?: { rowIndex: number; reasonSummary?: string }[]
}

function tableCheckOf(result: { details?: Record<string, unknown> | null } | undefined): {
  table: TableCheckDetails | null
  message: string | null
} {
  /** 条件行检查：一句人话、命中的行、找不到时最接近的名称 */
  lookup?: { summary?: string; matched?: { rowIndex: number; cells: { column: string; text: string }[] }[]; closest?: string[] }
  const details = result?.details
  const table = details && typeof details.table === 'object' && details.table ? (details.table as TableCheckDetails) : null
  const message = details && typeof details.safeMessage === 'string' ? details.safeMessage : null
  return { table, message }
}

function TableCheckResult({ result }: { result: { details?: Record<string, unknown> | null } | undefined }) {
  const { table, message } = tableCheckOf(result)
  if (!table && !message) return null
  const rows = (table?.violatingRows ?? []).slice(0, 5)
  const total = table?.violatingRowsCount ?? rows.length
  return (
    <div className='space-y-1 text-label text-muted-foreground' data-testid='table-check-result'>
      {table?.totalRowsChecked !== undefined ? <p>检查了 {table.totalRowsChecked} 行数据</p> : null}
      {message ? <p>{message}</p> : null}
      {rows.length > 0 ? (
        <ul className='list-disc pl-4'>
          {rows.map((row, i) => (
            <li key={`${row.rowIndex}-${i}`}>
              {row.reasonSummary ?? `第 ${row.rowIndex + 1} 行不满足`}
      {table?.lookup?.summary && table.lookup.summary !== message ? <p>{table.lookup.summary}</p> : null}
            </li>
      {table?.lookup?.matched && table.lookup.matched.length > 0 ? (
        <table className='w-full border-collapse text-[11px]' aria-label='命中的行'>
          <thead>
            <tr>
              <th className='border border-border-divider/60 px-1.5 py-0.5 text-left font-normal'>#</th>
              {table.lookup.matched[0]?.cells.map((c) => (
                <th key={c.column} className='border border-border-divider/60 px-1.5 py-0.5 text-left font-normal'>{c.column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.lookup.matched.map((row) => (
              <tr key={row.rowIndex} className='bg-primary/5'>
                <td className='border border-border-divider/60 px-1.5 py-0.5'>{row.rowIndex + 1}</td>
                {row.cells.map((c) => (
                  <td key={c.column} className='border border-border-divider/60 px-1.5 py-0.5'>{c.text}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {table?.lookup?.closest && table.lookup.closest.length > 0 ? (
        <div>
          <p>最接近的名称：</p>
          <ul className='list-disc pl-4'>
            {table.lookup.closest.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
          ))}
          {total > rows.length ? <li>另有 {total - rows.length} 处未列出</li> : null}
        </ul>
      ) : null}
    </div>
  )
}


/** 页面健康违规表：接口 / 脚本错误按发起步骤列出，可跳证据、可就地忽略（试跑里）。 */
function PageHealthResult({
  invariantId,
  kind,
  run,
  onFocusEvidence,
  onIgnorePageHealth,
  onOpenScenarioConfig,
}: {
  invariantId: string
  kind: 'network_health' | 'script_errors'
  run: Pick<RunDetailDto, 'snapshot' | 'outcomeResults'>
  onFocusEvidence?: (evidenceId: string) => void
  onIgnorePageHealth?: (invariantId: string, rules: PageHealthIgnoreRule[]) => void
  onOpenScenarioConfig?: () => void
}) {
  const results = (run.outcomeResults ?? []).filter(
    (item) => item.contractId === invariantId && (item.verdict === 'FAIL' || item.verdict === 'WARN'),
  )
  const stepIndex = new Map((run.snapshot.steps ?? []).map((step, index) => [step.id, { index: index + 1, name: step.name }]))
  const rows: { sample: PageHealthSample; evidenceId?: string | null }[] = []
  for (const result of results) {
    const fact = pageHealthFactFromResult(result)
    for (const sample of fact?.samples ?? []) rows.push({ sample, evidenceId: result.evidenceId })
  }
  if (rows.length === 0) return null
  const total = results.reduce((sum, item) => sum + (pageHealthFactFromResult(item)?.total ?? 0), 0)
  const shown = rows.slice(0, 30)
  const stepText = (sample: PageHealthSample) => {
    const step = sample.stepId ? stepIndex.get(sample.stepId) : undefined
    if (!step) return '-'
    return `第 ${step.index} 步${sample.afterStep ? '之后' : ''} · ${step.name}`
  }
  const ignoreValue = (sample: PageHealthSample) => sample.type === 'script_error' ? sample.text : sample.url
  const distinctIgnoreValues = Array.from(new Set(shown.map(({ sample }) => ignoreValue(sample)).filter((v): v is string => Boolean(v))))
  return (
    <div className='space-y-1 text-label' data-testid='page-health-result'>
      <p className='text-muted-foreground'>
        共 {total} 处{kind === 'network_health' ? '接口错误' : '脚本异常'}
        {rows.length < total ? `，下表列出 ${shown.length} 类` : ''}
      </p>
      {onIgnorePageHealth && distinctIgnoreValues.length > 1 ? (
        <button
          type='button'
          className='text-primary hover:underline'
          onClick={() => onIgnorePageHealth(invariantId, distinctIgnoreValues.map((value) => ({ kind, value })))}
        >
          忽略以上全部（{distinctIgnoreValues.length} 项）
        </button>
      ) : null}
      {!onIgnorePageHealth && onOpenScenarioConfig ? (
        <button type='button' className='text-primary hover:underline' onClick={onOpenScenarioConfig}>
          去场景配置里忽略
        </button>
      ) : null}
      <ul className='space-y-1'>
        {shown.map(({ sample, evidenceId }, index) => {
          const value = ignoreValue(sample)
          return (
            <li key={`${index}-${sample.stepRunId ?? sample.stepId ?? ''}`} className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
              <span className='text-muted-foreground'>{stepText(sample)}</span>
              <span className='font-mono break-all'>
                {pageHealthSampleText(sample)}
                {sample.count > 1 ? ` ×${sample.count}` : ''}
              </span>
              {evidenceId ? (
                <button type='button' className='text-primary hover:underline' onClick={() => onFocusEvidence?.(evidenceId)}>
                  查看证据
                </button>
              ) : null}
              {onIgnorePageHealth && value ? (
                <button
                  type='button'
                  className='text-primary hover:underline'
                  onClick={() => onIgnorePageHealth(invariantId, [{ kind, value }])}
                >
                  {sample.type === 'script_error' ? '忽略此消息' : '忽略此地址'}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 页面请求条件的结果：期望一句话，实际写命中次数、没通过的原因与最近几条请求。 */
function PageRequestOutcome({
  expected,
  actual,
  rule,
}: {
  expected: unknown
  actual: unknown
  rule: Parameters<typeof describePageRequestRule>[0]
}) {
  const detail = actual && typeof actual === 'object' && !Array.isArray(actual) ? (actual as { matchedCount?: number; reason?: string; samples?: { method?: string; url?: string; status?: number; durationMs?: number; failed?: boolean }[] }) : null
  return (
    <div className='space-y-1 text-label text-muted-foreground' data-testid='page-request-outcome'>
      <p>期望：{typeof expected === 'string' ? expected : describePageRequestRule(rule)}</p>
      {detail ? (
        <>
          <p>
            实际：命中 {detail.matchedCount ?? 0} 次{detail.reason ? `；${detail.reason}` : ''}
          </p>
          {(detail.samples ?? []).length > 0 ? (
            <ul className='list-disc pl-4 font-mono'>
              {(detail.samples ?? []).map((sample, index) => (
                <li key={index} className='break-all'>
                  {sample.method} {sample.url} → {sample.failed ? '请求失败' : sample.status}
                  {sample.durationMs !== undefined ? `（${sample.durationMs}ms）` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function outcomeStatusHint(status: OutcomeStatus, hasContracts?: boolean): string {
  if (status !== 'NOT_EVALUATED') return RUN_OUTCOME_STATUS_HINTS[status]
  return hasContracts
    ? '业务条件还没评完（还没跑到，或历史运行未纳入结果轴）。'
    : RUN_OUTCOME_STATUS_HINTS.NOT_EVALUATED
}

export function OutcomeAxisSummary({
  executionLabel,
  outcomeStatus,
  hasContracts,
}: {
  executionLabel: string
  outcomeStatus: OutcomeStatus
  hasContracts?: boolean
}) {
  const executionTone: StatusTone =
    executionLabel === '执行完成'
      ? 'success'
      : executionLabel === '执行异常'
        ? 'error'
        : executionLabel === '需人工核查'
          ? 'warning'
          : 'neutral'

  return (
    <div className='grid gap-3 sm:grid-cols-2'>
      <div
        className={cn(
          'rounded-md border p-3 transition-colors',
          executionTone === 'success'
            ? 'border-status-success/30 bg-status-success-background/15'
            : executionTone === 'error'
              ? 'border-status-error/30 bg-status-error-background/15'
              : executionTone === 'warning'
                ? 'border-status-warning/30 bg-status-warning-background/15'
                : 'border-border-card bg-muted/30'
        )}
        aria-label='执行轴'
      >
        <p className='text-label text-muted-foreground'>执行</p>
        <div className='mt-1 flex items-center gap-2'>
          <StatusBadge tone={executionTone}>{executionLabel}</StatusBadge>
        </div>
      </div>
      <div
        className={cn(
          'rounded-md border p-3 transition-colors',
          outcomeStatus === 'PASS'
            ? 'border-status-success/30 bg-status-success-background/15'
            : outcomeStatus === 'FAIL'
              ? 'border-status-error/30 bg-status-error-background/15'
              : outcomeStatus === 'WARN'
                ? 'border-status-warning/30 bg-status-warning-background/15'
                : 'border-border-card bg-muted/30'
        )}
        aria-label='业务结果轴'
      >
        <p className='text-label text-muted-foreground'>业务结果</p>
        <div className='mt-1 flex flex-wrap items-center gap-2'>
          <StatusBadge tone={runOutcomeStatusTone(outcomeStatus)}>
            {RUN_OUTCOME_STATUS_LABELS[outcomeStatus]}
          </StatusBadge>
        </div>
        <p className='mt-1 text-label text-muted-foreground'>
          {outcomeStatusHint(outcomeStatus, hasContracts)}
        </p>
      </div>
    </div>
  )
}

export function OutcomeConditionList({
  runId: _runId,
  run,
  evidenceItems,
  onEdit,
  onFocusEvidence,
  onIgnorePageHealth,
  onOpenScenarioConfig,
}: {
  runId: string
  run: Pick<RunDetailDto, 'snapshot' | 'outcomeResults'> & {
    stepRuns?: RunDetailDto['stepRuns']
  }
  evidenceItems?: EvidenceMetadata[]
  onEdit?: (item: JoinedOutcomeEvaluation) => void
  onFocusEvidence?: (evidenceId: string) => void
  /** 试跑里就地把违规地址 / 消息加入约束的忽略清单。 */
  onIgnorePageHealth?: (invariantId: string, rules: PageHealthIgnoreRule[]) => void
  /** 运行详情里不就地改草稿，提供去场景配置里忽略的入口（调用方负责权限判断）。 */
  onOpenScenarioConfig?: () => void
}) {
  const rows = joinOutcomeEvaluations(
    run.snapshot.outcomeManifest,
    run.outcomeResults,
    run.stepRuns,
    candidateGroupsOf(run.snapshot),
    loopBodyHeadersOf(run.snapshot.controlFlow),
  )
  // 页面健康约束只在有违规时出现：没有违规不显示「未求值」「通过」之类占位。
  const invariantRows = joinRuntimeInvariantEvaluations(
    run.snapshot.runtimeInvariantManifest,
    run.outcomeResults,
  ).filter((row) => !isPageHealthKind(row.entry.kind) || Boolean(row.result))
  if (rows.length === 0 && invariantRows.length === 0) {
    return <p className='text-small text-muted-foreground'>这次运行没有可显示的成功条件或运行期约束结果。</p>
  }
  return (
    <div className='space-y-4'>
    {rows.length > 0 ? (
    <ul className='space-y-3' aria-label='成功条件判定'>
      {rows.map((row) => {
        const evidence = evidenceForOutcomeResult(row.result, evidenceItems)
        const expectLabel =
          row.entry.rule.kind === 'deterministic'
            ? expectKindLabel(row.entry.rule.expect.kind)
            : row.entry.rule.kind === 'page_request'
              ? '页面请求'
              : '按业务指令判断'
        return (
          <li
            key={row.entry.contractId}
            className='space-y-2 rounded-md border border-border-card p-3'
          >
            <div className='flex flex-wrap items-start justify-between gap-2'>
              <p className='text-body font-medium'>{row.entry.meaning}</p>
              <StatusBadge tone={runOutcomeStatusTone(row.displayVerdict)}>
                {row.displayVerdict === 'NOT_EVALUATED'
                  ? '未求值'
                  : row.displayVerdict === 'UNKNOWN'
                    ? '无法判断'
                    : row.displayVerdict === 'NOT_APPLICABLE'
                      ? '不适用'
                      : RUN_OUTCOME_STATUS_LABELS[row.displayVerdict]}
              </StatusBadge>
            </div>
            {row.entry.rule.kind === 'context' && row.entry.rule.expect.kind === 'table' ? (
              <TableCheckResult result={row.result ?? undefined} />
            ) : row.entry.rule.kind === 'page_request' ? (
              <PageRequestOutcome expected={row.result?.expected} actual={row.result?.actual} rule={row.entry.rule} />
            ) : (
              <p className='text-label text-muted-foreground'>
                {expectLabel}
                {' · '}
                期望 {formatExpected(row.result?.expected ?? (row.entry.rule.kind === 'deterministic' ? row.entry.rule.expect : undefined), expectLabel)}
                {' · '}
                实际 {formatValue(row.result?.actual)}
              </p>
            )}
            {row.displayVerdict === 'NOT_EVALUATED' ? (
              <p className='text-label text-muted-foreground'>运行尚未执行到这条条件。</p>
            ) : null}
            {row.evaluationCount && row.evaluationCount > 1 ? (
              <details className='text-label text-muted-foreground'>
                <summary className='cursor-pointer'>求值 {row.evaluationCount} 次</summary>
                <ul className='mt-1 space-y-1'>
                  {(row.history ?? []).map((item, index) => (
                    <li key={`${item.attemptId ?? index}-${item.evaluatedAt ?? index}`}>
                      第 {index + 1} 次：{item.verdict}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {row.displayVerdict === 'NOT_APPLICABLE' ? (
              <p className='text-label text-muted-foreground'>
                不适用（{row.notApplicableReason ? STEP_SKIP_REASON_LABELS[row.notApplicableReason] : '已跳过'}）
              </p>
            ) : null}
            {row.displayVerdict === 'UNKNOWN' ? (
              <p className='text-label text-muted-foreground'>
                取值或定位没有完成，不能把这种情况记成业务不通过。
              </p>
            ) : null}
            {evidence && evidence.length > 0 ? (
              <button
                type='button'
                className='text-label text-primary hover:underline'
                onClick={() => evidence[0] && onFocusEvidence?.(evidence[0].id)}
              >
                查看对应步骤证据
              </button>
            ) : null}
            {onEdit && row.displayVerdict === 'FAIL' ? (
              <button
                type='button'
                className='text-label text-primary hover:underline'
                onClick={() => onEdit(row)}
              >
                修改这条规则
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
    ) : null}
    {invariantRows.length > 0 ? (
      <ul className='space-y-3' aria-label='运行期约束判定'>
        {invariantRows.map((row) => {
          const evidence = evidenceForOutcomeResult(row.result, evidenceItems)
          const pageHealthKind = row.entry.kind === 'network_health' || row.entry.kind === 'script_errors' ? row.entry.kind : null
          // 应当 / 提示级的页面健康违规一律显示「警告」，不显示红色「业务异常」。
          const softViolation = pageHealthKind !== null && row.displayVerdict === 'FAIL' && row.entry.severity !== 'MUST'
          return (
            <li key={row.entry.id} className='space-y-2 rounded-md border border-border-card p-3'>
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <p className='text-body font-medium'>{row.entry.meaning}</p>
                <StatusBadge tone={softViolation ? 'warning' : runOutcomeStatusTone(row.displayVerdict)}>
                  {softViolation
                    ? '警告'
                    : row.displayVerdict === 'NOT_EVALUATED'
                    ? '未求值'
                    : row.displayVerdict === 'UNKNOWN'
                      ? '无法判断'
                      : row.displayVerdict === 'NOT_APPLICABLE'
                        ? '不适用'
                        : RUN_OUTCOME_STATUS_LABELS[row.displayVerdict]}
                </StatusBadge>
              </div>
              {pageHealthKind ? (
                <PageHealthResult
                  invariantId={row.entry.id}
                  kind={pageHealthKind}
                  run={run}
                  onFocusEvidence={onFocusEvidence}
                  onIgnorePageHealth={onIgnorePageHealth}
                  onOpenScenarioConfig={onOpenScenarioConfig}
                />
              ) : (
                <p className='text-label text-muted-foreground'>
                  {RUNTIME_INVARIANT_KIND_LABELS[row.entry.kind]}
                  {' · '}
                  期望 {formatExpected(row.result?.expected, RUNTIME_INVARIANT_KIND_LABELS[row.entry.kind])}
                  {' · '}
                  实际 {formatValue(row.result?.actual)}
                </p>
              )}
              {row.displayVerdict === 'NOT_EVALUATED' ? (
                <p className='text-label text-muted-foreground'>这次运行还没有观察到这条约束。</p>
              ) : null}
              {row.displayVerdict === 'NOT_APPLICABLE' ? (
                <p className='text-label text-muted-foreground'>所在步骤已被跳过或停用，此约束不适用。</p>
              ) : null}
              {!pageHealthKind && evidence && evidence.length > 0 ? (
                <button
                  type='button'
                  className='text-label text-primary hover:underline'
                  onClick={() => evidence[0] && onFocusEvidence?.(evidence[0].id)}
                >
                  查看对应步骤证据
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    ) : null}
    </div>
  )
}
