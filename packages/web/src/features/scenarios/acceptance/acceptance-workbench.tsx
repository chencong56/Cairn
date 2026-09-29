import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_ACCEPTANCE_INTENTS,
  type AcceptanceIntentKind,
  type AcceptanceIntentRequest,
  type AcceptanceProposalCard,
  type AssistantAcceptanceAuditReport,
  type AssistantAuthoringProposal,
  type EffectType,
  type RunDetailDto,
  type AcceptanceHistoryInsight,
  type AcceptanceTuningSuggestion,
  type AcceptanceTuningPatch,
} from '@cairn/shared'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  History,
  ListChecks,
  MousePointerClick,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { debugRun } from '@/lib/runs-api'
import { useAssistantStore } from '@/stores/assistant-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAuthoringObserve } from '../authoring-observe'
import {
  ACCEPTANCE_INTENT_META,
  ACCEPTANCE_INTENT_ORDER,
  buildAdoptionProposal,
  cardCanAdopt,
  cardNeedsLiveTest,
  cardVerification,
  initialCardState,
  newIntentDraft,
  nextStepId,
  toIntentRequest,
  type CardUiState,
  type CardVerification,
  type IntentDraft,
} from './acceptance-model'
import { requestAcceptanceAudit, requestAcceptanceProposal, fetchScenarioAcceptanceHistory } from './acceptance-api'

export type AcceptanceStep = {
  id: string
  name: string
  type: string
  effectType: EffectType
  outputKey?: string
  isBackbone?: boolean
}

export type AcceptanceWorkbenchProps = {
  scenarioId: string
  /** 草稿里按执行顺序展开的步骤。 */
  steps: AcceptanceStep[]
  summaryTemplate?: string
  disabled?: boolean
  /** Studio 当前跟随的试跑。 */
  run?: RunDetailDto
  baselineRunId?: string
  verifyRunId?: string
  ensureDraftSaved: () => Promise<number | null>
  onStartBaseline: (options: { pauseBeforeStepId?: string }) => void
  onStartVerification: () => void
  onLocateStep: (stepId: string) => void
  onClose: () => void
  /** 变化时立即执行一次验收体检（供场景配置工作区等外部入口触发）。 */
  auditSignal?: number
  onApplyUpdateOutcome?: (contractId: string, patch: AcceptanceTuningPatch) => Promise<{ ok: boolean; reason?: string }>
}

const COMPARE_OPTIONS = [
  { op: 'gte', label: '不小于' },
  { op: 'gt', label: '大于' },
  { op: 'eq', label: '等于' },
  { op: 'neq', label: '不等于' },
  { op: 'lte', label: '不大于' },
  { op: 'lt', label: '小于' },
] as const

const TEST_LABELS: Record<AcceptanceProposalCard['testResult'], string> = {
  FOUND: '已在页面命中',
  AMBIGUOUS: '命中多项',
  NOT_FOUND: '页面上没找到',
  SURFACE_LOST: '页面已不可用',
  UNTESTED: '待实测',
  NOT_REQUIRED: '无需实测',
}

const ACTIVE_RUN = new Set(['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'])

function targetLabel(draft: Pick<IntentDraft, 'target'>): string | undefined {
  const first = draft.target?.candidates[0]
  return first ? (first.name ?? first.value) : draft.target?.semantic
}

function verificationLabel(result: CardVerification): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (result.status === 'pending') return { text: '等待复跑结束', tone: 'muted' }
  if (result.status === 'not_evaluated') return { text: '未求值：检查步骤没有执行到', tone: 'bad' }
  if (result.status === 'report_only') {
    return result.value === undefined ? { text: '报告里没有取到值', tone: 'bad' } : { text: `报告取值：${String(result.value)}`, tone: 'ok' }
  }
  const suffix = result.actual !== undefined && result.actual !== null ? `（实际 ${JSON.stringify(result.actual).slice(0, 40)}）` : ''
  if (result.verdict === 'PASS') return { text: `通过${suffix}`, tone: 'ok' }
  if (result.verdict === 'WARN') return { text: `警告${suffix}`, tone: 'warn' }
  if (result.verdict === 'FAIL') return { text: `不通过${suffix}`, tone: 'bad' }
  return { text: '无法判定', tone: 'warn' }
}

const TONE_CLASS = {
  ok: 'text-status-success-foreground',
  warn: 'text-status-warning-foreground',
  bad: 'text-status-error-foreground',
  muted: 'text-muted-foreground',
} as const

export function AcceptanceWorkbench({
  scenarioId,
  steps,
  summaryTemplate,
  disabled,
  run,
  baselineRunId,
  verifyRunId,
  ensureDraftSaved,
  onStartBaseline,
  onStartVerification,
  onLocateStep,
  onClose,
  auditSignal = 0,
  onApplyUpdateOutcome,
}: AcceptanceWorkbenchProps) {
  const observe = useAuthoringObserve()
  const capabilities = useAssistantStore((s) => s.capabilities)
  const modelDisabled = capabilities !== null && !capabilities.modelEnabled
  const stepIds = useMemo(() => steps.map((step) => step.id), [steps])
  const stepName = (id: string) => steps.find((step) => step.id === id)?.name ?? '已删除的步骤'
  const keySeq = useRef(0)
  const [intents, setIntents] = useState<IntentDraft[]>([])
  const [intentErrors, setIntentErrors] = useState<Record<string, string>>({})
  const [generating, setGenerating] = useState(false)
  const [stage, setStage] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [proposal, setProposal] = useState<AssistantAuthoringProposal | null>(null)
  const [cardStates, setCardStates] = useState<Record<string, CardUiState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [adopted, setAdopted] = useState<AssistantAuthoringProposal | null>(null)
  const [pickingKey, setPickingKey] = useState<string>()
  const [freeformText, setFreeformText] = useState('')
  const [clarify, setClarify] = useState<{ question: string; round: number } | null>(null)
  const [clarifyAnswer, setClarifyAnswer] = useState('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditing, setAuditing] = useState(false)
  const [auditStage, setAuditStage] = useState<string>()
  const [auditError, setAuditError] = useState<string>()
  const [auditReport, setAuditReport] = useState<AssistantAcceptanceAuditReport | null>(null)

  // 面板可能在助手面板从未打开的页面使用，模型可用性需要主动拉一次。
  useEffect(() => {
    if (useAssistantStore.getState().capabilities === null) {
      void useAssistantStore.getState().loadCapabilities().catch(() => undefined)
    }
  }, [])

  // 外部入口（场景配置工作区）触发体检。
  useEffect(() => {
    if (auditSignal > 0) void startAudit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditSignal])

  const baselineRun = run && run.id === baselineRunId ? run : undefined
  const verifyRun = run && run.id === verifyRunId ? run : undefined
  const holdingStepId = observe.holding && baselineRun ? observe.checkpointStepId : undefined
  const firstSideEffect = steps.find((step) => step.effectType === 'SIDE_EFFECT')

  // 基线停到某步时，自动实测挂在这一步上的卡。
  useEffect(() => {
    if (!proposal || !holdingStepId) return
    for (const card of proposal.cards ?? []) {
      const state = cardStates[card.id]
      if (!state || card.stepId !== holdingStepId || !cardNeedsLiveTest(card) || state.testResult !== 'UNTESTED') continue
      void testCard(card)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingStepId, proposal])

  // 点选完成后把对象写回正在点选的意图卡。
  useEffect(() => {
    if (!pickingKey || !observe.lastPicked || observe.pickMode) return
    const picked = observe.lastPicked
    setIntents((items) => items.map((item) => (item.key === pickingKey ? { ...item, target: picked } : item)))
    setPickingKey(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observe.lastPicked, observe.pickMode])

  function addIntent(kind: AcceptanceIntentKind) {
    keySeq.current += 1
    const defaultStep = holdingStepId ?? steps[steps.length - 1]?.id ?? ''
    setIntents((items) => [...items, newIntentDraft(kind, defaultStep, `i${keySeq.current}`)])
  }

  function patchIntent(key: string, patch: Partial<IntentDraft>) {
    setIntents((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)))
    setIntentErrors((errors) => {
      const next = { ...errors }
      delete next[key]
      return next
    })
  }

  function startPick(draft: IntentDraft) {
    if (!observe.holding) {
      toast.message('请先开始基线运行，并停在这一步之后的页面上再点选')
      return
    }
    if (observe.checkpointStepId !== draft.stepId) {
      toast.message(`基线运行现在停在「${stepName(observe.checkpointStepId ?? '')}」之后，请停到「${stepName(draft.stepId ?? '')}」之后再点选`)
      return
    }
    setPickingKey(draft.key)
    observe.setPickMode(true)
  }

  async function testCard(card: AcceptanceProposalCard) {
    if (!card.target) return
    const observation = await observe.highlightTarget(card.target, { silent: true })
    if (!observation) return
    const outcome = observation.outcome
    const testResult: CardUiState['testResult'] =
      outcome === 'FOUND' || outcome === 'AMBIGUOUS' || outcome === 'NOT_FOUND' || outcome === 'SURFACE_LOST' ? outcome : 'UNTESTED'
    setCardStates((states) => {
      const current = states[card.id]
      if (!current) return states
      const next: CardUiState = { ...current, testResult }
      return { ...states, [card.id]: { ...next, selected: current.selected || cardCanAdopt(card, next) } }
    })
  }

  async function generate(descriptionOverride?: string) {
    const description = descriptionOverride ?? freeformText.trim()
    const hasFreeform = Boolean(description)
    if ((intents.length === 0 && !hasFreeform) || generating) return
    const errors: Record<string, string> = {}
    const requests = intents.flatMap((draft) => {
      const result = toIntentRequest(draft)
      if (!result.ok) errors[draft.key] = result.message
      return result.ok ? [result.value] : []
    })
    setIntentErrors(errors)
    if (Object.keys(errors).length > 0) return
    const revision = await ensureDraftSaved()
    if (revision === null) return
    setGenerating(true)
    setMessage(undefined)
    setStage(undefined)
    try {
      const outcome = await requestAcceptanceProposal({
        scenarioId,
        draftRevision: revision,
        acceptance: {
          intents: requests,
          ...(hasFreeform ? { description } : {}),
          ...(baselineRunId ? { baselineRunId } : {}),
        },
        onStage: setStage,
      })
      if (outcome.kind === 'clarify') {
        // 与表单向导一致的澄清熔断：只在自由描述路径追问一轮，第二轮起按普通消息呈现。
        if (hasFreeform && clarify === null) {
          setClarify({ question: outcome.message, round: 1 })
        } else {
          setMessage(outcome.message)
        }
        return
      }
      if (outcome.kind === 'message') {
        setMessage(outcome.message)
        return
      }
      setProposal(outcome.proposal)
      setAdopted(null)
      setCardStates(Object.fromEntries((outcome.proposal.cards ?? []).map((card) => [card.id, initialCardState(card)])))
      setClarify(null)
      setClarifyAnswer('')
      // 自由描述拆解结果回填为可编辑意图卡：改参删改后可再次生成，原描述不再重复参与拆解。
      const parsed = outcome.proposal.parsedIntents ?? []
      if (parsed.length > 0) {
        const remaining = MAX_ACCEPTANCE_INTENTS - intents.length
        const drafts = parsed.map((intent) => intentRequestToDraft(intent)).slice(0, Math.max(0, remaining))
        if (drafts.length > 0) setIntents((items) => [...items, ...drafts])
        if (drafts.length < parsed.length) {
          toast.message(`意图已达 ${MAX_ACCEPTANCE_INTENTS} 项上限，仅回填前 ${drafts.length} 项拆解结果，其余请先删减后再生成`)
        } else {
          toast.success(`已把描述拆解为 ${drafts.length} 张意图卡，可调整参数后再次生成`)
        }
        setFreeformText('')
      }
    } catch (error) {
      setMessage(error instanceof ApiRequestError ? error.message : '生成失败，请稍后重试')
    } finally {
      setGenerating(false)
      setStage(undefined)
    }
  }

  function submitClarify() {
    const answer = clarifyAnswer.trim()
    if (!clarify || !answer || generating) return
    const merged = `${freeformText.trim()}\n补充：${answer}`.slice(0, 500)
    setClarify(null)
    setClarifyAnswer('')
    setFreeformText(merged)
    void generate(merged)
  }

  async function startAudit() {
    const revision = await ensureDraftSaved()
    if (revision === null) return
    setAuditOpen(true)
    setAuditing(true)
    setAuditError(undefined)
    setAuditReport(null)
    setAuditStage(undefined)
    try {
      const outcome = await requestAcceptanceAudit({
        scenarioId,
        draftRevision: revision,
        onStage: setAuditStage,
      })
      if (outcome.kind === 'message') {
        setAuditError(outcome.message)
      } else {
        setAuditReport(outcome.report)
      }
    } catch (error) {
      setAuditError(error instanceof ApiRequestError ? error.message : '验收体检失败，请稍后重试')
    } finally {
      setAuditing(false)
      setAuditStage(undefined)
    }
  }

  /** 结构化意图（模型拆解或体检建议）转成可编辑的意图卡草稿。 */
  function intentRequestToDraft(intent: AcceptanceIntentRequest): IntentDraft {
    keySeq.current += 1
    const common = {
      key: `i${keySeq.current}`,
      kind: intent.kind,
      severity: intent.severity,
    }
    switch (intent.kind) {
      case 'scenario_duration':
        return { ...common, maxMs: String(intent.maxMs) }
      case 'value_consistency':
        return {
          ...common,
          stepIdA: intent.stepIdA,
          stepIdB: intent.stepIdB,
          tolerance: intent.tolerance !== undefined ? String(intent.tolerance) : '0',
          metricName: intent.metricName ?? '',
        }
      case 'page_duration':
        return { ...common, stepId: intent.stepId, maxMs: String(intent.maxMs) }
      case 'number_range':
        return {
          ...common,
          stepId: intent.stepId,
          op: intent.op,
          value: String(intent.value),
          metricName: intent.metricName ?? '',
          target: intent.target,
        }
      case 'table_non_empty':
        return { ...common, stepId: intent.stepId, metricName: intent.metricName ?? '', target: intent.target }
      case 'text_present_or_absent':
        return { ...common, stepId: intent.stepId, text: intent.text, absent: intent.absent }
      case 'extract_to_report':
        return { ...common, stepId: intent.stepId, metricName: intent.metricName, unit: intent.unit ?? '', target: intent.target }
      default:
        return { ...common, stepId: 'stepId' in intent ? (intent as { stepId?: string }).stepId : undefined }
    }
  }

  function handleApplySuggestedIntents(suggestions: AssistantAcceptanceAuditReport['suggestedIntents']) {
    const remaining = MAX_ACCEPTANCE_INTENTS - intents.length
    if (suggestions.length > remaining) {
      toast.error(
        remaining > 0
          ? `最多保留 ${MAX_ACCEPTANCE_INTENTS} 项意图，当前还可加入 ${remaining} 项；请先删减已有意图卡或减少勾选`
          : `意图已达 ${MAX_ACCEPTANCE_INTENTS} 项上限，请先删减已有意图卡再加入建议`,
      )
      return
    }
    const newDrafts = suggestions.map((s) => intentRequestToDraft(s.intent))
    setIntents((prev) => [...prev, ...newDrafts])
    setAuditOpen(false)
    toast.success(`已添加 ${newDrafts.length} 项建议意图`)
  }

  async function adoptSelected() {
    if (!proposal) return
    const next = buildAdoptionProposal({
      proposal,
      states: cardStates,
      existingSummaryTemplate: summaryTemplate,
      summaryOperationId: `acc-summary-${proposal.proposalId}`,
    })
    const adopt = useAssistantStore.getState().adoptHandler
    if (!next || !adopt) return
    const result = await adopt(next)
    if (!result.ok) {
      toast.error(result.reason)
      return
    }
    setAdopted(next)
    toast.success(`已采纳 ${next.cards?.length ?? 0} 项验收，保存后复跑验证`)
  }

  async function continueBaseline() {
    if (!baselineRun || baselineRun.status !== 'HOLDING') return
    const checkpointStep = baselineRun.snapshot.steps.find((step) => step.id === baselineRun.checkpoint?.stepId)
    try {
      await debugRun(baselineRun.id, {
        action: 'continue',
        fencingToken: baselineRun.checkpoint?.fencingToken,
        ...(checkpointStep?.effectType === 'SIDE_EFFECT' ? { confirmSideEffect: true } : {}),
      })
      void observe.refresh?.()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '继续失败')
    }
  }

  async function verify() {
    const revision = await ensureDraftSaved()
    if (revision === null) return
    onStartVerification()
  }

  const cards = proposal?.cards ?? []
  const selectedCount = cards.filter((card) => cardStates[card.id]?.selected && cardCanAdopt(card, cardStates[card.id]!)).length

  return (
    <section aria-label='补全验收' className='@container flex min-h-0 flex-1 flex-col overflow-hidden bg-card'>
      <header className='flex items-start justify-between gap-2 border-b border-border-divider bg-surface-header p-3'>
        <div className='min-w-0'>
          <h2 className='flex items-center gap-1.5 text-body font-semibold'>
            <ListChecks className='size-4 text-primary' />
            补全验收
          </h2>
          <p className='mt-0.5 text-label text-muted-foreground'>说清要检查什么、报告看什么，助手按基线页面生成检查与指标。</p>
        </div>
        <div className='flex items-center gap-1.5'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='gap-1.5 h-8 text-xs'
            disabled={disabled || auditing}
            onClick={() => void startAudit()}
            title='对场景验收设计进行静态体检与智能补全建议'
          >
            <Stethoscope className='size-3.5 text-primary' />
            {auditing ? '体检中…' : '验收体检'}
          </Button>
          <Button type='button' size='icon' variant='ghost' aria-label='关闭补全验收' onClick={onClose}>
            <X className='size-4' />
          </Button>
        </div>
      </header>

      <div className='min-h-0 flex-1 space-y-4 overflow-y-auto p-3'>
        {/* 1. 基线运行 */}
        <div className='space-y-2 rounded-md border border-border-default p-3'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-small font-semibold'>① 基线运行</h3>
            {baselineRun ? <Badge variant='outline'>{runStatusText(baselineRun, stepName)}</Badge> : null}
          </div>
          {!baselineRun ? (
            <>
              <p className='text-label text-muted-foreground'>
                从第一步执行并在每步后停住，采集页面结构。助手据此定位要检查的对象，你也可以在停住的页面上点选。
              </p>
              {firstSideEffect ? (
                <p className='text-label text-status-warning-foreground'>
                  含写操作步骤（如「{firstSideEffect.name}」）：跑到它之前会停住，需要你确认才继续。
                </p>
              ) : null}
              <Button type='button' size='sm' disabled={disabled || Boolean(run && ACTIVE_RUN.has(run.status))} onClick={() => onStartBaseline({})}>
                <Play className='mr-1.5 size-3.5' />
                开始基线运行
              </Button>
            </>
          ) : (
            <div className='flex flex-wrap items-center gap-2'>
              {baselineRun.status === 'HOLDING' ? (
                <Button type='button' size='sm' variant='outline' onClick={() => void continueBaseline()}>
                  继续下一步
                </Button>
              ) : null}
              {!ACTIVE_RUN.has(baselineRun.status) ? (
                <Button type='button' size='sm' variant='outline' onClick={() => onStartBaseline({})}>
                  <RefreshCw className='mr-1.5 size-3.5' />
                  重新基线运行
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {/* 2. 意图卡 */}
        <div className='space-y-2'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-small font-semibold'>② 要检查什么</h3>
            <Select
              value=''
              disabled={disabled || intents.length >= MAX_ACCEPTANCE_INTENTS || steps.length === 0}
              onValueChange={(kind) => addIntent(kind as AcceptanceIntentKind)}
            >
              <SelectTrigger size='sm' className='w-auto gap-1' aria-label='添加验收项'>
                <Plus className='size-3.5' />
                <SelectValue placeholder='添加验收项' />
              </SelectTrigger>
              <SelectContent>
                {ACCEPTANCE_INTENT_ORDER.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ACCEPTANCE_INTENT_META[kind].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 自然语言自由描述 */}
          <div className='space-y-1.5 rounded-md border border-border-default bg-surface-subtle p-2.5'>
            <div className='flex items-center justify-between gap-2'>
              <Label className='text-label font-medium'>自然语言描述验收要求（可选）</Label>
              <span className='text-xs text-muted-foreground'>{freeformText.length}/500</span>
            </div>
            <Textarea
              value={freeformText}
              disabled={disabled || generating || modelDisabled}
              maxLength={500}
              rows={3}
              placeholder='可直接描述验收要求（≤500字），例如：“检查订单列表必须有数据，全程耗时不超过1分钟，结算金额与支付金额一致”'
              onChange={(e) => setFreeformText(e.target.value)}
              className='resize-none text-small bg-background'
            />
            {modelDisabled ? (
              <p className='flex items-center gap-1 text-xs text-status-warning-foreground'>
                <AlertTriangle className='size-3.5 shrink-0' />
                平台 AI 尚未启用或未配置模型，无法解析自然语言描述，请直接使用下方的结构化意图卡。
              </p>
            ) : freeformText.trim() ? (
              <p className='text-xs text-muted-foreground'>
                提交时助手将自动分析描述中的检查要求，并与下方的结构化意图卡合并生成。
              </p>
            ) : null}
            {clarify ? (
              <div className='space-y-1.5 rounded-md border border-status-warning-border/50 bg-background p-2'>
                <p className='text-xs text-status-warning-foreground'>助手需要补充信息：{clarify.question}</p>
                <div className='flex items-center gap-1.5'>
                  <Input
                    value={clarifyAnswer}
                    disabled={disabled || generating}
                    placeholder='补充说明（将合并到原描述后重新生成）'
                    className='h-8 text-xs'
                    onChange={(event) => setClarifyAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitClarify()
                    }}
                  />
                  <Button type='button' size='sm' className='h-8 shrink-0' disabled={disabled || generating || !clarifyAnswer.trim()} onClick={submitClarify}>
                    重新生成
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    className='h-8 shrink-0'
                    onClick={() => {
                      setClarify(null)
                      setClarifyAnswer('')
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {intents.length === 0 ? (
            <p className='rounded-md border border-dashed border-border-divider p-3 text-label text-muted-foreground'>
              可在上方输入自然语言描述，或通过右上角「添加验收项」配置结构化检查规则。最多 {MAX_ACCEPTANCE_INTENTS} 项。
            </p>
          ) : (
            <ul className='space-y-2'>
              {intents.map((draft) => (
                <li key={draft.key}>
                  <IntentEditor
                    draft={draft}
                    steps={steps}
                    disabled={disabled}
                    error={intentErrors[draft.key]}
                    picking={pickingKey === draft.key && observe.pickMode}
                    canPick={Boolean(observe.holding && draft.stepId && observe.checkpointStepId === draft.stepId)}
                    onPatch={(patch) => patchIntent(draft.key, patch)}
                    onPick={() => startPick(draft)}
                    onRemove={() => setIntents((items) => items.filter((item) => item.key !== draft.key))}
                  />
                </li>
              ))}
            </ul>
          )}
          <Button
            type='button'
            size='sm'
            className='w-full'
            disabled={disabled || generating || (intents.length === 0 && (!freeformText.trim() || modelDisabled))}
            onClick={() => void generate()}
          >
            <Sparkles className='mr-1.5 size-3.5' />
            {generating ? `正在生成…${stage ? `（${stageText(stage)}）` : ''}` : '生成验收方案'}
          </Button>
          {!baselineRunId && intents.some((draft) => ACCEPTANCE_INTENT_META[draft.kind].needsTarget && !draft.target) ? (
            <p className='text-label text-muted-foreground'>需要页面对象的项，请先做基线运行或在页面上点选；否则会被拦下。</p>
          ) : null}
          {message ? <p className='rounded-md bg-status-warning-background p-2 text-label text-status-warning-foreground'>{message}</p> : null}
        </div>

        {/* 3. 验收方案 */}
        {proposal ? (
          <div className='space-y-2'>
            <h3 className='text-small font-semibold'>③ 验收方案</h3>
            {proposal.unsupported && proposal.unsupported.length > 0 ? (
              <div className='space-y-1.5 rounded-md border border-status-warning-border bg-status-warning-background/20 p-2.5 text-label'>
                <div className='flex items-center gap-1.5 font-medium text-status-warning-foreground'>
                  <AlertTriangle className='size-4' />
                  <span>以下自然语言描述暂不支持或未识别为有效意图：</span>
                </div>
                <ul className='list-inside list-disc space-y-0.5 pl-1 text-muted-foreground'>
                  {proposal.unsupported.map((item, idx) => (
                    <li key={idx}>
                      <span className='font-medium text-foreground'>「{item.excerpt}」</span>：{item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className='space-y-2'>
              {cards.map((card) => {
                const state = cardStates[card.id] ?? initialCardState(card)
                const adoptable = cardCanAdopt(card, state)
                const ops = proposal.operations.filter((op) => card.operationIds.includes(op.id))
                const ahead = holdingStepId && card.stepId ? stepIds.indexOf(card.stepId) > stepIds.indexOf(holdingStepId) : false
                return (
                  <li key={card.id} className={cn('space-y-1.5 rounded-md border p-2.5', adoptable ? 'border-border-default' : 'border-border-divider bg-surface-subtle')}>
                    <div className='flex items-start gap-2'>
                      <Checkbox
                        checked={state.selected && adoptable}
                        disabled={!adoptable || Boolean(adopted)}
                        aria-label={`采纳：${card.meaning}`}
                        onCheckedChange={(checked) =>
                          setCardStates((states) => ({ ...states, [card.id]: { ...state, selected: checked === true } }))
                        }
                      />
                      <div className='min-w-0 flex-1 space-y-1'>
                        <p className='text-small font-medium break-words'>{card.meaning}</p>
                        <div className='flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                          {card.stepId ? (
                            <button type='button' className='text-link hover:underline' onClick={() => onLocateStep(card.stepId!)}>
                              {stepName(card.stepId)}
                            </button>
                          ) : (
                            <Badge variant='outline' className='bg-primary/5 text-primary border-primary/20'>场景级</Badge>
                          )}
                          {card.targetSource ? <Badge variant='secondary'>{card.targetSource === 'model' ? '助手定位' : '人工点选'}</Badge> : null}
                          {card.provenance === 'ai_compiled' ? <Badge variant='outline'>AI 生成</Badge> : null}
                          {!card.blockedReason ? <span>{TEST_LABELS[state.testResult]}</span> : null}
                        </div>
                        {card.blockedMessage ? <p className='text-label text-status-warning-foreground'>{card.blockedMessage}</p> : null}
                        {card.rationale ? <p className='text-label text-muted-foreground'>定位依据：{card.rationale}</p> : null}
                        {cardNeedsLiveTest(card) && !adoptable ? (
                          <p className='text-label text-muted-foreground'>
                            {state.testResult === 'NOT_FOUND' || state.testResult === 'SURFACE_LOST'
                              ? '实测没命中，不能采纳。请回到意图卡点选对象后重新生成。'
                              : card.stepId && holdingStepId === card.stepId
                                ? '正在这一步，可点「实测」确认。'
                                : ahead
                                  ? '基线运行还没到这一步，请继续基线运行。'
                                  : '需要停在这一步之后的页面上实测。'}
                          </p>
                        ) : null}
                      </div>
                      {ACCEPTANCE_INTENT_META[card.intentKind]?.judged && !card.blockedReason ? (
                        <Select
                          value={state.severity === 'MUST' ? 'MUST' : 'SHOULD'}
                          disabled={Boolean(adopted)}
                          onValueChange={(value) =>
                            setCardStates((states) => ({ ...states, [card.id]: { ...state, severity: value as CardUiState['severity'] } }))
                          }
                        >
                          <SelectTrigger size='sm' className='w-[88px]' aria-label='不满足时'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='MUST'>判异常</SelectItem>
                            <SelectItem value='SHOULD'>判警告</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                    <div className='flex flex-wrap items-center gap-1.5 pl-6'>
                      {cardNeedsLiveTest(card) ? (
                        card.stepId && holdingStepId === card.stepId ? (
                          <Button type='button' size='sm' variant='outline' onClick={() => void testCard(card)}>
                            实测
                          </Button>
                        ) : !ahead && baselineRun && card.stepId && !ACTIVE_RUN.has(baselineRun.status) ? (
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            onClick={() => onStartBaseline({ pauseBeforeStepId: nextStepId(stepIds, card.stepId!) })}
                          >
                            重新跑到这一步
                          </Button>
                        ) : null
                      ) : null}
                      {ops.length > 0 ? (
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='gap-1'
                          onClick={() => setExpanded((items) => ({ ...items, [card.id]: !items[card.id] }))}
                        >
                          {expanded[card.id] ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
                          查看配置
                        </Button>
                      ) : null}
                    </div>
                    {expanded[card.id] ? (
                      <ul className='ml-6 space-y-1 rounded border border-border-divider bg-surface-subtle p-2 text-label'>
                        {ops.map((op) => (
                          <li key={op.id}>{describeOperation(op)}</li>
                        ))}
                      </ul>
                    ) : null}
                    {adopted?.cards?.some((item) => item.id === card.id) ? (
                      <CardVerificationLine result={cardVerification(card, adopted, verifyRun)} started={Boolean(verifyRun)} />
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {!adopted ? (
              <Button type='button' size='sm' className='w-full' disabled={disabled || selectedCount === 0} onClick={() => void adoptSelected()}>
                采纳所选 {selectedCount} 项
              </Button>
            ) : (
              <div className='space-y-2 rounded-md border border-border-default p-3'>
                <h3 className='text-small font-semibold'>④ 复跑验证</h3>
                <p className='text-label text-muted-foreground'>
                  已写入草稿，可在步骤检查器里继续修改。保存后完整跑一遍，确认每项检查都真的出了结论。
                </p>
                <Button
                  type='button'
                  size='sm'
                  disabled={disabled || Boolean(run && ACTIVE_RUN.has(run.status))}
                  onClick={() => void verify()}
                >
                  <MousePointerClick className='mr-1.5 size-3.5' />
                  保存并复跑验证
                </Button>
                {verifyRun?.output ? (
                  <div className='space-y-1 rounded border border-border-divider bg-surface-subtle p-2 text-label'>
                    <p className='font-medium'>报告预览：{verifyRun.output.summary}</p>
                    {Object.entries(verifyRun.output.metrics).map(([key, value]) => (
                      <p key={key} className='text-muted-foreground'>
                        {key}：{String(value)}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <AcceptanceAuditDialog
        scenarioId={scenarioId}
        open={auditOpen}
        onOpenChange={setAuditOpen}
        loading={auditing}
        stage={auditStage}
        error={auditError}
        report={auditReport}
        modelDisabled={modelDisabled}
        maxAddable={Math.max(0, MAX_ACCEPTANCE_INTENTS - intents.length)}
        stepName={stepName}
        onLocateStep={(stepId) => {
          setAuditOpen(false)
          onLocateStep(stepId)
        }}
        onApplySuggestedIntents={handleApplySuggestedIntents}
        onApplyUpdateOutcome={onApplyUpdateOutcome}
      />
    </section>
  )
}

function CardVerificationLine({ result, started }: { result: CardVerification; started: boolean }) {
  if (!started) return <p className='pl-6 text-label text-muted-foreground'>已采纳，待复跑验证</p>
  const { text, tone } = verificationLabel(result)
  return <p className={cn('pl-6 text-label font-medium', TONE_CLASS[tone])}>复跑：{text}</p>
}

function IntentEditor({
  draft,
  steps,
  disabled,
  error,
  picking,
  canPick,
  onPatch,
  onPick,
  onRemove,
}: {
  draft: IntentDraft
  steps: AcceptanceStep[]
  disabled?: boolean
  error?: string
  picking: boolean
  canPick: boolean
  onPatch: (patch: Partial<IntentDraft>) => void
  onPick: () => void
  onRemove: () => void
}) {
  const meta = ACCEPTANCE_INTENT_META[draft.kind]
  const picked = targetLabel(draft)
  return (
    <div className='space-y-2 rounded-md border border-border-default p-2.5'>
      <div className='flex items-center justify-between gap-2'>
        <div className='min-w-0'>
          <p className='text-small font-medium'>{meta.label}</p>
          <p className='text-label text-muted-foreground'>{meta.description}</p>
        </div>
        <Button type='button' size='icon' variant='ghost' aria-label={`移除${meta.label}`} disabled={disabled} onClick={onRemove}>
          <Trash2 className='size-3.5' />
        </Button>
      </div>
      <div className='grid gap-2 @xs:grid-cols-2'>
        {draft.kind === 'scenario_duration' ? (
          <div className='flex items-center gap-1.5 py-1 text-label text-muted-foreground @xs:col-span-2'>
            <Badge variant='outline' className='bg-primary/5 text-primary border-primary/20'>场景级</Badge>
            <span>覆盖全场景端到端耗时</span>
          </div>
        ) : draft.kind === 'value_consistency' ? (
          (() => {
            const eligibleSteps = steps.filter((s) => s.isBackbone !== false && Boolean(s.outputKey))
            return (
              <div className='space-y-2 @xs:col-span-2'>
                <div className='grid gap-2 @xs:grid-cols-2'>
                  <div className='space-y-1'>
                    <Label className='text-label'>步骤 A（主干取数步骤）</Label>
                    <Select value={draft.stepIdA ?? ''} disabled={disabled} onValueChange={(stepIdA) => onPatch({ stepIdA })}>
                      <SelectTrigger size='sm' className='w-full' aria-label='步骤 A'>
                        <SelectValue placeholder='选择步骤 A' />
                      </SelectTrigger>
                      <SelectContent>
                        {eligibleSteps.map((step) => (
                          <SelectItem key={step.id} value={step.id}>
                            {step.name}（{step.outputKey}）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1'>
                    <Label className='text-label'>步骤 B（主干比对步骤）</Label>
                    <Select value={draft.stepIdB ?? ''} disabled={disabled} onValueChange={(stepIdB) => onPatch({ stepIdB })}>
                      <SelectTrigger size='sm' className='w-full' aria-label='步骤 B'>
                        <SelectValue placeholder='选择步骤 B' />
                      </SelectTrigger>
                      <SelectContent>
                        {eligibleSteps.map((step) => (
                          <SelectItem key={step.id} value={step.id}>
                            {step.name}（{step.outputKey}）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {eligibleSteps.length < 2 ? (
                  <p className='text-xs text-status-warning-foreground'>
                    草稿中产出 outputKey 的主干步骤不足 2 个（当前 {eligibleSteps.length} 个）。请在相关提取/计算步骤配置中填入 outputKey 后再进行对账。
                  </p>
                ) : null}
                <div className='space-y-1'>
                  <Label className='text-label'>容差（允许绝对差值，默认 0）</Label>
                  <Input
                    value={draft.tolerance ?? '0'}
                    inputMode='decimal'
                    disabled={disabled}
                    placeholder='0'
                    onChange={(event) => onPatch({ tolerance: event.target.value })}
                  />
                </div>
              </div>
            )
          })()
        ) : (
          <div className='space-y-1'>
            <Label className='text-label'>{draft.kind === 'page_duration' ? '计时的步骤' : '在哪一步之后检查'}</Label>
            <Select value={draft.stepId} disabled={disabled} onValueChange={(stepId) => onPatch({ stepId, target: undefined })}>
              <SelectTrigger size='sm' className='w-full' aria-label='步骤'>
                <SelectValue placeholder='选择步骤' />
              </SelectTrigger>
              <SelectContent>
                {steps.map((step, index) => (
                  <SelectItem key={step.id} value={step.id}>
                    {index + 1}. {step.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {meta.judged ? (
          <div className='space-y-1'>
            <Label className='text-label'>不满足时</Label>
            <Select value={draft.severity} disabled={disabled} onValueChange={(severity) => onPatch({ severity: severity as IntentDraft['severity'] })}>
              <SelectTrigger size='sm' className='w-full' aria-label='不满足时'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='MUST'>判异常</SelectItem>
                <SelectItem value='SHOULD'>判警告</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {draft.kind === 'page_duration' || draft.kind === 'scenario_duration' ? (
          <div className='space-y-1'>
            <Label className='text-label'>耗时上限（毫秒）</Label>
            <Input value={draft.maxMs ?? ''} inputMode='numeric' disabled={disabled} onChange={(event) => onPatch({ maxMs: event.target.value })} />
          </div>
        ) : null}
        {draft.kind === 'text_present_or_absent' ? (
          <>
            <div className='space-y-1'>
              <Label className='text-label'>检查方式</Label>
              <Select value={draft.absent ? 'absent' : 'present'} disabled={disabled} onValueChange={(value) => onPatch({ absent: value === 'absent' })}>
                <SelectTrigger size='sm' className='w-full' aria-label='检查方式'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='present'>要出现</SelectItem>
                  <SelectItem value='absent'>不能出现</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1 @xs:col-span-2'>
              <Label className='text-label'>文字</Label>
              <Input value={draft.text ?? ''} disabled={disabled} placeholder='如：提交成功 / 系统异常' onChange={(event) => onPatch({ text: event.target.value })} />
            </div>
          </>
        ) : null}
        {draft.kind === 'number_range' ? (
          <div className='grid grid-cols-2 gap-2 @xs:col-span-2'>
            <Select value={draft.op ?? 'gte'} disabled={disabled} onValueChange={(op) => onPatch({ op: op as IntentDraft['op'] })}>
              <SelectTrigger size='sm' aria-label='比较'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPARE_OPTIONS.map((item) => (
                  <SelectItem key={item.op} value={item.op}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={draft.value ?? ''} inputMode='decimal' aria-label='比较值' disabled={disabled} onChange={(event) => onPatch({ value: event.target.value })} />
          </div>
        ) : null}
        {draft.kind === 'table_non_empty' || draft.kind === 'number_range' || draft.kind === 'extract_to_report' || draft.kind === 'value_consistency' ? (
          <div className='space-y-1'>
            <Label className='text-label'>{draft.kind === 'extract_to_report' ? '报告指标名' : '报告指标名（可选）'}</Label>
            <Input
              value={draft.metricName ?? ''}
              disabled={disabled}
              placeholder={draft.kind === 'table_non_empty' ? '如：今日订单数' : draft.kind === 'value_consistency' ? '如：余额对账差额' : '如：库存数量'}
              onChange={(event) => onPatch({ metricName: event.target.value })}
            />
          </div>
        ) : null}
        {draft.kind === 'extract_to_report' ? (
          <div className='space-y-1'>
            <Label className='text-label'>单位（可选）</Label>
            <Input value={draft.unit ?? ''} disabled={disabled} placeholder='如：元' onChange={(event) => onPatch({ unit: event.target.value })} />
          </div>
        ) : null}
      </div>
      {meta.needsTarget ? (
        <div className='flex flex-wrap items-center gap-1.5 text-label'>
          <span className='text-muted-foreground'>{picked ? `已点选「${picked}」` : '页面对象：由助手按基线页面定位'}</span>
          <Button type='button' size='sm' variant='outline' disabled={disabled || picking} onClick={onPick} title={canPick ? undefined : '停在这一步之后的页面上才能点选'}>
            <MousePointerClick className='mr-1 size-3.5' />
            {picking ? '请在画面上点选…' : '从页面点选'}
          </Button>
          {picked ? (
            <Button type='button' size='sm' variant='ghost' disabled={disabled} onClick={() => onPatch({ target: undefined })}>
              清除
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className='text-label text-status-error-foreground'>{error}</p> : null}
    </div>
  )
}

function describeOperation(op: AssistantAuthoringProposal['operations'][number]): string {
  switch (op.kind) {
    case 'insert_step':
      return `新增步骤「${op.step.name}」（${op.step.type === 'extract' ? '取数' : op.step.type === 'compute' ? '计算' : op.step.type}，只读）`
    case 'add_outcome':
      return `成功条件：${op.meaning}`
    case 'set_outputs':
      return op.metrics?.length
        ? `报告指标：${op.metrics.map((metric) => `${metric.name}${metric.unit ? `（${metric.unit}）` : ''}`).join('、')}`
        : '报告结论模板'
    default:
      return op.kind
  }
}

function runStatusText(run: RunDetailDto, stepName: (id: string) => string): string {
  if (run.status === 'HOLDING') return `停在「${stepName(run.checkpoint?.stepId ?? '')}」之后`
  if (run.status === 'SUCCEEDED') return '已跑完'
  if (run.status === 'FAILED') return '失败结束'
  if (run.status === 'CANCELLED') return '已取消'
  return '运行中'
}

function stageText(stage: string): string {
  if (stage === 'loading_facts') return '读取基线页面'
  if (stage === 'generating') return '定位与生成'
  if (stage === 'validating') return '校验'
  return '排队'
}

export function AcceptanceAuditDialog({
  scenarioId,
  open,
  onOpenChange,
  loading,
  stage,
  error,
  report,
  modelDisabled,
  maxAddable,
  stepName,
  onLocateStep,
  onApplySuggestedIntents,
  onApplyUpdateOutcome,
}: {
  scenarioId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  stage?: string
  error?: string
  report: AssistantAcceptanceAuditReport | null
  /** 平台未配置模型时，AI 增补建议不可用，仅展示确定性体检。 */
  modelDisabled?: boolean
  /** 意图卡剩余可加入数量，超出时提示先删减。 */
  maxAddable?: number
  stepName: (id: string) => string
  onLocateStep: (stepId: string) => void
  onApplySuggestedIntents: (selected: AssistantAcceptanceAuditReport['suggestedIntents']) => void
  onApplyUpdateOutcome?: (contractId: string, patch: AcceptanceTuningPatch) => Promise<{ ok: boolean; reason?: string }>
}) {
  const [activeTab, setActiveTab] = useState<'audit' | 'history'>('audit')
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())

  // 历史洞察状态
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string>()
  const [historyInsights, setHistoryInsights] = useState<AcceptanceHistoryInsight[]>([])
  const [adoptedSuggestionKeys, setAdoptedSuggestionKeys] = useState<Set<string>>(new Set())

  const loadHistory = useCallback(async () => {
    if (!scenarioId) return
    setHistoryLoading(true)
    setHistoryError(undefined)
    try {
      const res = await fetchScenarioAcceptanceHistory(scenarioId)
      setHistoryInsights(res.insights ?? [])
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : '获取历史洞察失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [scenarioId])

  useEffect(() => {
    if (open) {
      void loadHistory()
    }
  }, [open, loadHistory])

  useEffect(() => {
    if (report?.suggestedIntents) {
      setCheckedIds(new Set(report.suggestedIntents.map((item) => item.id)))
    }
  }, [report])

  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleAdoptSuggestion = async (contractId: string, suggestion: AcceptanceTuningSuggestion, key: string) => {
    if (!suggestion.suggestedPatch) return
    if (!onApplyUpdateOutcome) {
      toast.error('当前无法应用到草稿，请在场景配置工作区打开')
      return
    }
    const res = await onApplyUpdateOutcome(contractId, suggestion.suggestedPatch)
    if (res.ok) {
      setAdoptedSuggestionKeys((prev) => new Set(prev).add(key))
      toast.success('已写入草稿，可保存或复核')
    } else {
      toast.error(res.reason || '采纳失败')
    }
  }

  const selectedSuggestions = (report?.suggestedIntents ?? []).filter((item) => checkedIds.has(item.id))
  const overLimit = maxAddable !== undefined && selectedSuggestions.length > maxAddable

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl max-h-[85vh] flex flex-col p-0'>
        <DialogHeader className='p-4 border-b border-border-divider'>
          <DialogTitle className='flex items-center gap-2'>
            <Stethoscope className='size-5 text-primary' />
            场景验收体检与历史洞察
          </DialogTitle>
          <DialogDescription>
            静态体检当前草稿的验收成功条件与指标完整性，并基于历史运行判定提供数据驱动的条件调优建议。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as 'audit' | 'history')} className='flex flex-col flex-1 min-h-0'>
          <div className='px-4 pt-2 border-b border-border-divider bg-surface-subtle/50'>
            <TabsList className='grid grid-cols-2 w-52'>
              <TabsTrigger value='audit' className='flex items-center gap-1.5'>
                <Stethoscope className='size-3.5' />
                体检发现
                {report && report.findings.length > 0 ? (
                  <Badge variant='secondary' className='ml-1 text-2xs px-1.5 py-0'>
                    {report.findings.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value='history' className='flex items-center gap-1.5'>
                <History className='size-3.5' />
                历史洞察
                {historyInsights.some((i) => i.suggestions.length > 0) ? (
                  <Badge variant='outline' className='ml-1 text-2xs px-1.5 py-0 text-primary border-primary/30'>
                    建议
                  </Badge>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value='audit' className='flex-1 m-0 min-h-0 flex flex-col'>
            <ScrollArea className='flex-1 p-4'>
              {loading ? (
                <div className='flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2'>
                  <Sparkles className='size-6 animate-spin text-primary' />
                  <span>正在体检当前场景验收设计…{stage ? `（${stageText(stage)}）` : ''}</span>
                </div>
              ) : error ? (
                <div className='rounded-md border border-status-warning-border bg-status-warning-background/20 p-4 text-small text-status-warning-foreground'>
                  {error}
                </div>
              ) : report ? (
                <div className='space-y-4'>
                  {/* 体检概览 */}
                  <div className='grid grid-cols-2 gap-2 rounded-md border border-border-default bg-surface-subtle p-3 text-small'>
                    <div>
                      <span className='font-medium text-foreground'>有成功条件的浏览器步骤：</span>
                      <span className='text-muted-foreground'>
                        {report.coverage.coveredBrowserStepsCount}/{report.coverage.browserStepsCount}（
                        {Math.round(report.coverage.browserStepCoverage * 100)}%）
                      </span>
                    </div>
                    <div>
                      <span className='font-medium text-foreground'>取数进报告：</span>
                      <span className='text-muted-foreground'>
                        {report.coverage.coveredOutputsCount}/{report.coverage.outputsCount}（
                        {Math.round(report.coverage.outputMetricCoverage * 100)}%）
                      </span>
                    </div>
                    <div>
                      <span className='font-medium text-foreground'>发现问题：</span>
                      <span className={cn('font-semibold', report.findings.length > 0 ? 'text-status-warning-foreground' : 'text-status-success-foreground')}>
                        {report.findings.length} 个
                      </span>
                    </div>
                    <div>
                      <span className='font-medium text-foreground'>补全建议：</span>
                      <span className='font-semibold text-primary'>{report.suggestedIntents.length} 项</span>
                    </div>
                  </div>

                  {/* 发现清单 */}
                  <div className='space-y-2'>
                    <h4 className='text-small font-semibold flex items-center gap-1.5'>
                      {report.findings.length > 0 ? <AlertTriangle className='size-4 text-status-warning-foreground' /> : <CheckCircle2 className='size-4 text-status-success-foreground' />}
                      体检发现（{report.findings.length}）
                    </h4>
                    {report.findings.length === 0 ? (
                      <p className='rounded-md border border-border-default bg-surface-subtle p-3 text-label text-muted-foreground'>
                        ✓ 未发现明显的验收设计缺陷或孤立取数问题。
                      </p>
                    ) : (
                      <ul className='space-y-2'>
                        {report.findings.map((finding) => (
                          <li key={finding.id} className='rounded-md border border-border-default p-2.5 text-label space-y-1 bg-surface-subtle'>
                            <div className='flex items-center gap-2'>
                              <Badge variant={finding.severity === 'warning' ? 'secondary' : 'outline'}>
                                {finding.severity === 'warning' ? '警告' : '提示'}
                              </Badge>
                              <span className='font-medium text-foreground'>{finding.message}</span>
                              {finding.stepId ? (
                                <button
                                  type='button'
                                  className='text-link hover:underline'
                                  onClick={() => onLocateStep(finding.stepId!)}
                                  title='跳转到对应步骤'
                                >
                                  （步骤「{finding.stepName ?? stepName(finding.stepId)}」）
                                </button>
                              ) : finding.stepName ? (
                                <span className='text-muted-foreground'>（步骤「{finding.stepName}」）</span>
                              ) : null}
                            </div>
                            {finding.rationale ? <p className='text-xs text-muted-foreground pl-1'>{finding.rationale}</p> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 建议清单 */}
                  <div className='space-y-2'>
                    <h4 className='text-small font-semibold flex items-center gap-1.5'>
                      <Sparkles className='size-4 text-primary' />
                      智能补全建议（{report.suggestedIntents.length}）
                    </h4>
                    {modelDisabled ? (
                      <p className='rounded-md border border-status-warning-border/40 bg-status-warning-background/20 p-2.5 text-label text-status-warning-foreground'>
                        平台 AI 尚未启用或未配置模型，AI 增补建议不可用；以下仅包含确定性体检给出的建议。
                      </p>
                    ) : null}
                    {report.suggestedIntents.length === 0 ? (
                      <p className='rounded-md border border-dashed border-border-divider p-3 text-label text-muted-foreground'>
                        当前场景验收设计已较为完备，暂无补充建议。
                      </p>
                    ) : (
                      <ul className='space-y-2'>
                        {report.suggestedIntents.map((item) => {
                          const checked = checkedIds.has(item.id)
                          return (
                            <li
                              key={item.id}
                              className={cn(
                                'flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer transition-colors',
                                checked ? 'border-primary/40 bg-primary/5' : 'border-border-default bg-surface-subtle'
                              )}
                              onClick={() => toggleCheck(item.id)}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleCheck(item.id)}
                                className='mt-0.5'
                                aria-label={`选择建议：${item.label}`}
                              />
                              <div className='min-w-0 flex-1 space-y-1 text-label'>
                                <div className='flex flex-wrap items-center gap-1.5'>
                                  <span className='font-medium text-foreground'>{item.label}</span>
                                  <Badge variant='outline'>{ACCEPTANCE_INTENT_META[item.intent.kind]?.label ?? item.intent.kind}</Badge>
                                  {item.needsTarget ? <Badge variant='secondary'>需页面对象</Badge> : null}
                                  {item.needsBaseline ? <Badge variant='secondary'>需基线</Badge> : null}
                                </div>
                                <p className='text-xs text-muted-foreground'>{item.rationale}</p>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              ) : null}
            </ScrollArea>

            {report && report.suggestedIntents.length > 0 ? (
              <DialogFooter className='p-3 border-t border-border-divider bg-surface-footer flex justify-between items-center sm:justify-between'>
                <span className={cn('text-xs', overLimit ? 'text-status-warning-foreground' : 'text-muted-foreground')}>
                  已选中 {selectedSuggestions.length} / {report.suggestedIntents.length} 项建议
                  {maxAddable !== undefined ? ` · 还可加入 ${maxAddable} 项意图` : ''}
                  {overLimit ? `，超出上限，请减少勾选或先删减已有意图卡` : ''}
                </span>
                <Button
                  type='button'
                  size='sm'
                  disabled={selectedSuggestions.length === 0 || overLimit}
                  onClick={() => onApplySuggestedIntents(selectedSuggestions)}
                >
                  把勾选建议加入意图（{selectedSuggestions.length}）
                </Button>
              </DialogFooter>
            ) : null}
          </TabsContent>

          <TabsContent value='history' className='flex-1 m-0 min-h-0 flex flex-col'>
            <ScrollArea className='flex-1 p-4'>
              {historyLoading ? (
                <div className='flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2'>
                  <RefreshCw className='size-6 animate-spin text-primary' />
                  <span>正在分析近 50 次运行判定历史与分布…</span>
                </div>
              ) : historyError ? (
                <div className='rounded-md border border-status-warning-border bg-status-warning-background/20 p-4 text-small text-status-warning-foreground'>
                  {historyError}
                </div>
              ) : historyInsights.length === 0 ? (
                <div className='py-12 text-center text-muted-foreground text-sm space-y-2'>
                  <History className='size-8 mx-auto text-muted-foreground/60 mb-2' />
                  <p className='font-medium text-foreground'>暂无足够的运行历史数据</p>
                  <p className='text-xs max-w-sm mx-auto'>
                    需要至少 10 次 runThrough 运行以形成可靠的判定分布与数据驱动的阈值调优建议。
                  </p>
                </div>
              ) : (
                <div className='space-y-4'>
                  {historyInsights.map((insight) => (
                    <div
                      key={insight.contractId}
                      className='rounded-lg border border-border-default bg-surface-subtle p-3.5 space-y-3'
                    >
                      <div className='flex items-center justify-between gap-2 border-b border-border-divider pb-2'>
                        <div className='flex items-center gap-2 min-w-0'>
                          <span className='font-medium text-foreground truncate'>{insight.meaning}</span>
                          <Badge variant='outline'>{insight.scope === 'step' ? '步骤级' : '场景级'}</Badge>
                        </div>
                        {insight.priorSegmentSampleCount ? (
                          <span className='text-xs text-muted-foreground shrink-0'>
                            调整前历史：{insight.priorSegmentSampleCount} 次
                          </span>
                        ) : null}
                      </div>

                      {/* 判定分布条 */}
                      <div className='space-y-1.5'>
                        <div className='flex items-center justify-between text-xs text-muted-foreground'>
                          <div className='flex items-center gap-3'>
                            <span>
                              样本：<strong className='text-foreground'>{insight.sampleCount}</strong> 次
                            </span>
                            <span>
                              PASS：<strong className='text-status-success-foreground'>{insight.passCount}</strong>
                            </span>
                            <span>
                              FAIL：
                              <strong
                                className={cn(
                                  insight.failCount > 0 ? 'text-status-warning-foreground font-semibold' : 'text-muted-foreground'
                                )}
                              >
                                {insight.failCount}
                              </strong>
                            </span>
                            {insight.unknownCount > 0 ? (
                              <span>
                                UNKNOWN：<strong className='text-muted-foreground'>{insight.unknownCount}</strong>
                              </span>
                            ) : null}
                            {insight.inspectionalFailCount > 0 ? (
                              <span className='text-status-warning-foreground font-medium'>
                                巡检型失败：<strong>{insight.inspectionalFailCount}</strong> 次
                              </span>
                            ) : null}
                          </div>
                        </div>

                        {insight.sampleCount > 0 ? (
                          <div className='h-2 w-full rounded-full bg-surface-base border border-border-default overflow-hidden flex'>
                            <div
                              className='bg-status-success-foreground h-full'
                              style={{ width: `${(insight.passCount / insight.sampleCount) * 100}%` }}
                              title={`PASS: ${insight.passCount}`}
                            />
                            <div
                              className='bg-status-warning-foreground h-full'
                              style={{ width: `${(insight.failCount / insight.sampleCount) * 100}%` }}
                              title={`FAIL: ${insight.failCount}`}
                            />
                            <div
                              className='bg-muted-foreground/30 h-full'
                              style={{ width: `${(insight.unknownCount / insight.sampleCount) * 100}%` }}
                              title={`UNKNOWN: ${insight.unknownCount}`}
                            />
                          </div>
                        ) : null}
                      </div>

                      {/* 数值 / 耗时分布摘要 */}
                      {insight.actualDistribution ? (
                        <div className='rounded bg-surface-base border border-border-default px-2.5 py-1.5 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1'>
                          <span className='font-medium text-foreground flex items-center gap-1'>
                            <BarChart3 className='size-3.5 text-primary' /> 分布摘要：
                          </span>
                          <span>
                            P50:{' '}
                            <strong className='text-foreground'>
                              {insight.actualDistribution.p50}
                              {insight.actualDistribution.unitHint ?? ''}
                            </strong>
                          </span>
                          <span>
                            P95:{' '}
                            <strong className='text-foreground'>
                              {insight.actualDistribution.p95}
                              {insight.actualDistribution.unitHint ?? ''}
                            </strong>
                          </span>
                          <span>
                            极值范围: {insight.actualDistribution.min} ~ {insight.actualDistribution.max}
                            {insight.actualDistribution.unitHint ?? ''}
                          </span>
                        </div>
                      ) : null}

                      {/* 条件调整卡 */}
                      <div className='space-y-2 pt-1'>
                        <div className='text-xs font-medium text-muted-foreground flex items-center gap-1'>
                          <TrendingUp className='size-3.5 text-primary' /> 条件调整建议：
                        </div>
                        {insight.suggestions.length === 0 ? (
                          <p className='text-xs text-muted-foreground pl-1 italic'>
                            当前条件与近期运行表现吻合，无需调整。
                          </p>
                        ) : (
                          <div className='space-y-2'>
                            {insight.suggestions.map((sug) => {
                              const key = `${insight.contractId}-${sug.kind}-${sug.ruleName}`
                              const isAdopted = adoptedSuggestionKeys.has(key)
                              const kindLabel =
                                sug.kind === 'loosen_threshold'
                                  ? '放宽阈值'
                                  : sug.kind === 'tighten_threshold'
                                    ? '收紧阈值'
                                    : sug.kind === 'lower_severity'
                                      ? '降低等级'
                                      : sug.kind === 'measurement_missing'
                                        ? '度量缺失'
                                        : '失效条件'

                              return (
                                <div
                                  key={key}
                                  className='rounded-md border border-border-default bg-surface-base p-2.5 space-y-2 text-xs'
                                >
                                  <div className='flex items-start justify-between gap-2'>
                                    <div className='space-y-1 min-w-0'>
                                      <div className='flex items-center gap-1.5 flex-wrap'>
                                        <Badge variant={sug.kind === 'tighten_threshold' ? 'secondary' : 'outline'}>
                                          {kindLabel}
                                        </Badge>
                                        <span className='font-medium text-foreground'>{sug.ruleName}</span>
                                      </div>
                                      {sug.fromValue !== undefined && sug.toValue !== undefined ? (
                                        <div className='font-mono text-xs text-muted-foreground pt-0.5'>
                                          旧值: <span className='line-through'>{sug.fromValue}</span> → 建议值:{' '}
                                          <strong className='text-primary'>{sug.toValue}</strong>
                                        </div>
                                      ) : null}
                                      <p className='text-muted-foreground text-xs leading-relaxed'>{sug.rationale}</p>
                                      {sug.kind === 'tighten_threshold' ? (
                                        <p className='text-status-warning-foreground text-xs'>
                                          ⚠️ 风险提示：收紧阈值可能暴露潜在偶发抖动，采纳后请复跑验证。
                                        </p>
                                      ) : null}
                                      <div className='text-2xs text-muted-foreground/80'>
                                        依据：{sug.sampleCount} 次历史样本
                                      </div>
                                    </div>

                                    <div className='shrink-0 pt-0.5'>
                                      {isAdopted ? (
                                        <Badge
                                          variant='outline'
                                          className='text-status-success-foreground border-status-success-border bg-status-success-background/20'
                                        >
                                          已写入草稿
                                        </Badge>
                                      ) : sug.suggestedPatch ? (
                                        <Button
                                          size='sm'
                                          variant='outline'
                                          className='h-7 text-xs px-2.5'
                                          onClick={() => handleAdoptSuggestion(insight.contractId, sug, key)}
                                        >
                                          采纳
                                        </Button>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            <DialogFooter className='p-3 border-t border-border-divider bg-surface-footer flex justify-between items-center sm:justify-between'>
              <span className='text-xs text-muted-foreground'>
                洞察基于近 50 次 runThrough 运行统计；采纳调整将更新草稿中的条件阈值。
              </span>
              <Button type='button' variant='outline' size='sm' onClick={loadHistory} disabled={historyLoading}>
                <RefreshCw className={cn('size-3.5 mr-1', historyLoading ? 'animate-spin' : '')} />
                刷新历史
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
