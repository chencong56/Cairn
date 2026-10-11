import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { NetworkObserveOwner } from '@/lib/network-observe-api'
import { resolveOutcomeWriteback } from '@cairn/authoring'
import {
  observationShowsFragileCss,
  type AuthoringCapabilities,
  type ObserveOperation,
  type TableDiscoveredItem,
  type TableDetectObservation,
  type TableObservation,
  type TableReadPlan,
  type RunDetailDto,
  type TargetDescriptor,
  type TargetObservation,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { detectTableOnRun, observeRun } from '@/lib/runs-api'
import { detectTableOnSession, observeSession, sampleTableOnSession } from '@/lib/sessions-api'
import { useRunObservation } from '@/features/runs/use-run-observation'
import {
  type ApplyPickedExtras,
  observationPreviewText,
  targetFromPickedLabel,
} from './pick-apply'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

export type ScreenAlignmentStatus =
  | 'aligned'
  | 'ahead'
  | 'behind'
  | 'session_initial'
  | 'offline_snapshot'
  | 'disconnected'

export function computeScreenAlignment(input: {
  sessionOpen: boolean
  liveRun?: {
    status: string
    checkpoint?: {
      stepId: string
      reason: string
    } | null
    stepRuns: Array<{ stepId: string; status: string }>
  } | null
  selectedStepId?: string | null
  stepOrder: string[]
  hasOfflineScreenshot?: boolean
}): ScreenAlignmentStatus {
  const { sessionOpen, liveRun, selectedStepId, stepOrder, hasOfflineScreenshot } = input
  if (!selectedStepId) return 'disconnected'

  const selIdx = stepOrder.indexOf(selectedStepId)
  if (selIdx < 0) return 'disconnected'

  if (!liveRun) {
    if (sessionOpen) {
      return selIdx === 0 ? 'aligned' : 'session_initial'
    }
    return hasOfflineScreenshot ? 'offline_snapshot' : 'disconnected'
  }

  const checkpoint = liveRun.checkpoint
  if (liveRun.status === 'HOLDING' && checkpoint) {
    const chkIdx = stepOrder.indexOf(checkpoint.stepId)
    if (chkIdx < 0) return 'disconnected'

    if (checkpoint.reason === 'author_pause') {
      if (selIdx === chkIdx) return 'aligned'
      return chkIdx < selIdx ? 'behind' : 'ahead'
    }

    if (checkpoint.reason === 'step_succeeded') {
      if (selIdx === chkIdx + 1) return 'aligned'
      return chkIdx + 1 < selIdx ? 'behind' : 'ahead'
    }

    if (selIdx === chkIdx) return 'aligned'
    return chkIdx < selIdx ? 'behind' : 'ahead'
  }

  return 'disconnected'
}

export type TableMarkers = {
  tables: TableDiscoveredItem[]
  /** 当前选中的表格序号；未选中为空。 */
  activeIndex?: number
  /** 画布点击线框时回调（序号对齐 tables）。 */
  onPick?: (index: number) => void
}

export type ViewedManagedPage = { pageId?: string; kind?: string }

type AuthoringObserveValue = {
  runId?: string
  sessionId?: string
  run?: RunDetailDto
  refresh?: () => Promise<unknown>
  holding: boolean
  livePage: boolean
  checkpointStepId?: string
  overlayStepId?: string
  highlight?: TargetObservation
  lastPicked?: TargetDescriptor
  enclosingTable?: TargetDescriptor
  /** 表格发现的画布线框标记；由验收面板写入，受管画面渲染并支持点选消歧。 */
  tableMarkers?: TableMarkers | null
  setTableMarkers: (markers: TableMarkers | null) => void
  pickMode: boolean
  canIndicate: boolean
  canHighlight: boolean
  canDebugHold: boolean
  setPickMode: (
    next: boolean,
    outcome?: { scope: 'step' | 'scenario'; contractId: string },
  ) => void
  highlightTarget: (target: TargetDescriptor, options?: { silent?: boolean }) => Promise<TargetObservation | undefined>
  pickAt: (x: number, y: number) => void
  /** 受管画面上报正在查看的页：指认、高亮作用于此页；pageId 省略表示跟随当前页。 */
  setViewedPage: (page: ViewedManagedPage | null) => void
  pickEnclosingTable?: () => void
  /** 点选识别：下一次点画面时识别整张表（不是指认单个元素），识别结果交给 onResult。 */
  beginTablePick: (onResult: (observation: TableDetectObservation) => void) => void
  /** 以指定表根重新识别（“范围大一点 / 小一点”“不是这一张”）。 */
  detectTableRoot: (rootSelector: string, framePath: TargetDescriptor['framePath']) => Promise<TableDetectObservation | undefined>
  /** 按计划读一遍当前画面，用于预览；没有可读的受管画面时返回 undefined。 */
  previewTable: (plan: TableReadPlan) => Promise<TableObservation | undefined>
  /** 画面正在查看的是不是“非执行当前页”的弹出页（执行时这一步在“当前页”运行，需要先切过去）。 */
  viewingPopup: () => boolean
  /** 接口来源的编写期操作发往哪里（调试挂起的运行或受管会话）；没有可用的受管画面时为空。 */
  networkOwner?: NetworkObserveOwner
  /** 受管画面正在查看的页（接口捕获按页区分）。 */
  viewedPageId: () => string | undefined
  applyForTrial: (target?: TargetDescriptor) => void
  clearOverlay: (stepId: string) => void
  writeBack: () => void
  applyPickedToStep: () => void
  adoptAlternative: (label: string) => void
  applyAsOutcome: () => void
  ensureStepOutputKey?: (stepId: string, outputKey: string) => void
}

const closedObserve: AuthoringObserveValue = {
  holding: false,
  livePage: false,
  pickMode: false,
  canIndicate: false,
  canHighlight: false,
  canDebugHold: false,
  setPickMode: () => undefined,
  highlightTarget: async () => undefined,
  setTableMarkers: () => undefined,
  pickAt: () => undefined,
  setViewedPage: () => undefined,
  pickEnclosingTable: () => undefined,
  beginTablePick: () => undefined,
  detectTableRoot: async () => undefined,
  previewTable: async () => undefined,
  viewingPopup: () => false,
  viewedPageId: () => undefined,
  applyForTrial: () => undefined,
  clearOverlay: () => undefined,
  writeBack: () => undefined,
  applyPickedToStep: () => undefined,
  adoptAlternative: () => undefined,
  applyAsOutcome: () => undefined,
}

export function overlayStepIdForSelection(
  run: {
    checkpoint?: Pick<NonNullable<RunDetailDto['checkpoint']>, 'stepId'> | null
    debugOverlay?: Pick<NonNullable<RunDetailDto['debugOverlay']>, 'stepOverrides'> | null
    snapshot?: Pick<RunDetailDto['snapshot'], 'outcomeManifest'>
  } | undefined,
  selectedStepId?: string | null,
): string | undefined {
  const overrides = run?.debugOverlay?.stepOverrides
  if (!overrides) return undefined
  if (selectedStepId && overrides[selectedStepId]) return selectedStepId
  const checkpointId = run?.checkpoint?.stepId
  if (!checkpointId || !overrides[checkpointId]) return undefined
  const writeback = resolveOutcomeWriteback(run.snapshot?.outcomeManifest, checkpointId)
  if (!writeback) return undefined
  if (writeback.scope === 'scenario' && !selectedStepId) return checkpointId
  if (writeback.sourceStepId && writeback.sourceStepId === selectedStepId) return checkpointId
  return undefined
}

const AuthoringObserveContext =
  createContext<AuthoringObserveValue>(closedObserve)

export function useAuthoringObserve() {
  return useContext(AuthoringObserveContext)
}

/** 识别失败的人话提示：服务端 5xx / 超时不把“内部服务错误”直接丢给用户 */
function detectErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status >= 500 || error.status === 504) {
      return '识别没有成功：受管浏览器忙或页面太大，请稍等几秒再点一次（也可以先点“范围小一点”）'
    }
    return error.message
  }
  return '识别表格失败，请再试一次'
}

export function AuthoringObserveProvider({
  runId,
  sessionId,
  selectedStepId,
  enabled,
  authoring,
  onApplyTarget,
  onWriteBack,
  onEnsureStepOutputKey,
  children,
}: {
  runId?: string
  sessionId?: string
  selectedStepId?: string | null
  enabled: boolean
  authoring?: AuthoringCapabilities
  onApplyTarget: (target: TargetDescriptor, extras?: ApplyPickedExtras) => void
  onWriteBack?: () => Promise<boolean>
  onEnsureStepOutputKey?: (stepId: string, outputKey: string) => void
  children: ReactNode
}) {
  const { run, refresh } = useRunObservation(
    runId ?? '',
    Boolean(runId && enabled)
  )
  const [pickMode, setPickModeState] = useState(false)
  const [pickOutcome, setPickOutcome] = useState<NonNullable<ApplyPickedExtras['outcomePick']>>()
  const [highlight, setHighlight] = useState<TargetObservation | undefined>()
  const [lastPicked, setLastPicked] = useState<TargetDescriptor | undefined>()
  const [enclosingTable, setEnclosingTable] = useState<TargetDescriptor | undefined>()
  const [tableMarkers, setTableMarkersState] = useState<TableMarkers | null>(null)
  const viewedPage = useRef<ViewedManagedPage | null>(null)
  const tablePickHandler = useRef<((observation: TableDetectObservation) => void) | null>(null)
  /** 识别在途时不再接受新的点击，避免重复并发请求 */
  const detectingRef = useRef(false)
  const setTableMarkers = (markers: TableMarkers | null) => setTableMarkersState(markers)
  const holding = Boolean(
    run && run.status === 'HOLDING' && run.debugMode !== 'runThrough'
  )
  const livePage = holding || Boolean(sessionId)
  const canIndicate = authoring?.indicate !== 'closed'
  const canHighlight = authoring?.highlight !== 'closed'
  const canDebugHold = authoring?.debugHold !== 'closed'

  const [disambiguationModal, setDisambiguationModal] = useState<{
    visibleText: string
    accessibleName: string
    observation: TargetObservation
  } | null>(null)
  const [disambiguationChoice, setDisambiguationChoice] = useState<'visible_text' | 'accessible_name'>('visible_text')

  const applyPickedTarget = (target: TargetDescriptor, previewText: string) => {
    onApplyTarget(target, {
      previewText,
      ...(pickOutcome ? { outcomePick: pickOutcome } : {}),
    })
    setPickOutcome(undefined)
    if (pickOutcome) {
      toast.success('已写入成功条件，请核对成功含义和期望')
    } else {
      toast.success(
        previewText ? `已写入当前步骤。画面上读到「${previewText}」` : '已写入当前步骤',
      )
      // 手动操作不会录成步骤：新标签页上的元素要在试跑里找得到，前面必须有一步把执行切过去。
      if (viewedPage.current?.kind === 'popup') {
        toast.message(
          '该元素在新标签页上。试跑时需要前面有一个点击步骤把「页面变化」设为「切换到弹出窗口」，否则会在原页面上执行而失败。',
          { duration: 10_000 },
        )
      }
    }
  }

  const confirmDisambiguation = (choice: 'visible_text' | 'accessible_name') => {
    if (!disambiguationModal) return
    const { visibleText, accessibleName, observation } = disambiguationModal
    let target = observation.target!
    let previewText: string

    if (choice === 'visible_text') {
      const rest = target.candidates.filter(
        (c) => !(c.by === 'text' && c.value === visibleText),
      )
      target = {
        ...target,
        candidates: [{ by: 'text' as const, value: visibleText }, ...rest].slice(0, 5),
      }
      previewText = visibleText
    } else {
      previewText = observationPreviewText(observation) || accessibleName
    }

    setLastPicked(target)
    setPickModeState(false)
    setDisambiguationModal(null)

    if (!holding || pickOutcome) {
      applyPickedTarget(target, previewText)
    } else {
      toast.success('已点到元素，可写入本次验证或写回草稿')
    }

    if (canHighlight) {
      void observePage({ op: 'highlight', target }).then(setHighlight).catch(() => undefined)
    }
  }

  const observePage = (operation: Exclude<ObserveOperation, { op: 'table' }>): Promise<TargetObservation> => {
    const pageId = viewedPage.current?.pageId
    const body = pageId ? { ...operation, pageId } : operation
    if (holding && runId) return observeRun(runId, body)
    if (sessionId) return observeSession(sessionId, body)
    return Promise.reject(new Error('没有可观察的受管页面'))
  }

  const withViewedPage = <T extends object>(operation: T): T & { pageId?: string } => {
    const pageId = viewedPage.current?.pageId
    return pageId ? { ...operation, pageId } : operation
  }
  const detectOnPage = (op: Extract<ObserveOperation, { op: 'table'; subOp: 'detect' }>): Promise<TableDetectObservation> => {
    const body = withViewedPage(op)
    if (holding && runId) return detectTableOnRun(runId, body)
    if (sessionId) return detectTableOnSession(sessionId, body)
    return Promise.reject(new Error('没有可观察的受管页面'))
  }

  const value = useMemo<AuthoringObserveValue>(
    () => ({
      runId,
      sessionId,
      run,
      refresh,
      holding,
      livePage,
      checkpointStepId: holding ? run?.checkpoint?.stepId : undefined,
      overlayStepId: overlayStepIdForSelection(run, selectedStepId),
      highlight,
      lastPicked,
      enclosingTable,
      tableMarkers,
      setTableMarkers,
      setViewedPage: (page) => {
        viewedPage.current = page
      },
      pickMode,
      canIndicate,
      canHighlight,
      canDebugHold,
      ensureStepOutputKey: onEnsureStepOutputKey,
      setPickMode: (next, outcome) => {
        if (next && (!canIndicate || !livePage)) {
          toast.message('没有可点选的受管画面。请先连接目标账号会话，或开试跑并等到步骤挂起。')
          return
        }
        if (next && outcome?.scope === 'step' && !selectedStepId) {
          toast.message('请先选择要设置成功条件的步骤')
          return
        }
        if (!next) tablePickHandler.current = null
        if (next) setEnclosingTable(undefined)
        setPickOutcome(next && outcome
          ? { ...outcome, ...(outcome.scope === 'step' ? { stepId: selectedStepId! } : {}) }
          : undefined)
        setPickModeState(next)
        if (next && livePage) {
          void observePage({ op: 'highlight' }).catch(() => undefined)
        }
      },
      highlightTarget: async (target, options) => {
        if (!canHighlight) return undefined
        if (!livePage) {
          if (!options?.silent) {
            toast.message('没有可点选的受管画面。请先连接目标账号会话，或开试跑并等到步骤挂起。')
          }
          return undefined
        }
        try {
          const observation = await observePage({ op: 'highlight', target })
          setHighlight(observation)
          setEnclosingTable(observation.enclosingTable)
          if (options?.silent) return observation
          if (observation.outcome === 'AMBIGUOUS') {
            toast.message(
              observation.alternatives?.[0]?.reason ??
                '找到多个匹配，请改候选或再点一次'
            )
            return observation
          }
          if (observation.outcome !== 'FOUND') {
            toast.message('没有找到唯一匹配')
            return observation
          }
          if (observationShowsFragileCss(observation)) {
            toast.message(
              '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
            )
          }
          return observation
        } catch (error) {
          toast.error(
            error instanceof ApiRequestError ? error.message : '校验失败'
          )
          return undefined
        }
      },
      pickAt: (x, y) => {
        if (!canIndicate || !livePage) return
        const tableHandler = tablePickHandler.current
        if (tableHandler) {
          if (detectingRef.current) return
          detectingRef.current = true
          // 页面很大 / 嵌套 frame 多时识别要几秒：立刻给反馈，别让人以为没点上
          const loadingId = toast.loading('正在识别表格…最多等 20 秒')
          void detectOnPage({ op: 'table', subOp: 'detect', x, y })
            .then((observation) => {
              tablePickHandler.current = null
              setPickModeState(false)
              tableHandler(observation)
            })
            .catch((error) => {
              tablePickHandler.current = null
              setPickModeState(false)
              toast.error(detectErrorText(error))
            })
            .finally(() => {
              detectingRef.current = false
              toast.dismiss(loadingId)
            })
          return
        }
        const pickLoadingId = toast.loading('正在读取点到的元素…')
        void observePage({ op: 'pick', x, y })
          .finally(() => toast.dismiss(pickLoadingId))
          .then((observation) => {
            setHighlight(observation)
            setEnclosingTable(observation.enclosingTable)
            if (observation.outcome === 'AMBIGUOUS') {
              setLastPicked(undefined)
              toast.message(
                observation.alternatives?.[0]?.reason ??
                  '找到多个匹配，请再点一次或改候选'
              )
              return
            }
            if (observation.target && observation.outcome === 'FOUND') {
              if (observation.disambiguation) {
                setDisambiguationModal({
                  visibleText: observation.disambiguation.visibleText,
                  accessibleName: observation.disambiguation.accessibleName,
                  observation,
                })
                setDisambiguationChoice('visible_text')
                return
              }
              setLastPicked(observation.target)
              setPickModeState(false)
              const previewText = observationPreviewText(observation)
              if (!holding || pickOutcome) {
                applyPickedTarget(observation.target, previewText)
              } else {
                toast.success('已点到元素，可写入本次验证或写回草稿')
              }
              if (observationShowsFragileCss(observation)) {
                toast.message(
                  '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
                )
              }
              if (canHighlight) {
                void observePage({ op: 'highlight', target: observation.target })
                  .then((obs) => {
                    setHighlight(obs)
                    setEnclosingTable(obs.enclosingTable)
                  })
                  .catch(() => undefined)
              }
            } else {
              setLastPicked(undefined)
              toast.message('没有点到可识别的元素')
            }
          })
          .catch((error) => {
            if (
              error instanceof ApiRequestError &&
              error.payload.code === 'OBSERVE_GRANT_EXPIRED'
            ) {
              toast.error('观察授权已过期，请再点一次「在页面上指认」')
              setPickModeState(false)
              setPickOutcome(undefined)
              return
            }
            toast.error(
              error instanceof ApiRequestError ? error.message : '指认失败'
            )
          })
      },
      pickEnclosingTable: () => {
        if (!enclosingTable) return
        setLastPicked(enclosingTable)
        setPickModeState(false)
        if (!holding || pickOutcome) {
          applyPickedTarget(enclosingTable, enclosingTable.semantic ?? '表格')
        } else {
          toast.success('已切换为所在表格，可写入本次验证或写回草稿')
        }
        if (canHighlight) {
          void observePage({ op: 'highlight', target: enclosingTable })
            .then((obs) => {
              setHighlight(obs)
              setEnclosingTable(obs.enclosingTable)
            })
            .catch(() => undefined)
        }
      },
      beginTablePick: (onResult) => {
        if (!canIndicate || !livePage) {
          toast.message('没有可点选的受管画面。请先连接目标账号会话，或开试跑并等到步骤挂起。')
          return
        }
        setEnclosingTable(undefined)
        setPickOutcome(undefined)
        tablePickHandler.current = onResult
        setPickModeState(true)
        void observePage({ op: 'highlight' }).catch(() => undefined)
      },
      detectTableRoot: async (rootSelector, framePath) => {
        if (!livePage) return undefined
        try {
          return await detectOnPage({ op: 'table', subOp: 'detect', rootSelector, framePath })
        } catch (error) {
          toast.error(detectErrorText(error))
          return undefined
        }
      },
      previewTable: async (plan) => {
        if (!livePage) return undefined
        const body = withViewedPage({ op: 'table' as const, subOp: 'sample' as const, plan })
        if (holding && runId) return observeRun(runId, body)
        if (sessionId) return sampleTableOnSession(sessionId, body)
        return undefined
      },
      // 只有查看的是“非执行当前页”的弹出页时才提示（跟随当前页时 pageId 为空）
      viewingPopup: () => viewedPage.current?.kind === 'popup' && viewedPage.current.pageId !== undefined,
      networkOwner: !livePage ? undefined : holding && runId ? { kind: 'run', runId } : sessionId ? { kind: 'session', sessionId } : undefined,
      viewedPageId: () => viewedPage.current?.pageId,
      applyForTrial: (target) => {
        const next = target ?? lastPicked ?? highlight?.target
        if (!runId || !holding || !next) {
          toast.message('请先在页面上指认或校验一个目标')
          return
        }
        void observePage({
          op: 'highlight',
          target: next,
          applyOverlay: true,
        })
          .then((observation) => {
            setHighlight(observation)
            void refresh()
            if (observation.outcome === 'FOUND')
              toast.success('已写入本次试跑覆盖，不影响草稿')
            else
              toast.message(
                observation.outcome === 'AMBIGUOUS'
                  ? '覆盖已记下，但页面上仍有多个匹配'
                  : '覆盖已记下，但页面上没有唯一匹配'
              )
          })
          .catch((error) => {
            toast.error(
              error instanceof ApiRequestError
                ? error.message
                : '无法写入本次验证'
            )
          })
      },
      clearOverlay: (stepId) => {
        if (!runId) return
        void observePage({ op: 'highlight', clearOverlayStepId: stepId })
          .then(() => {
            setHighlight(undefined)
            setEnclosingTable(undefined)
            void refresh()
          })
          .catch((error) => {
            toast.error(
              error instanceof ApiRequestError
                ? error.message
                : '无法恢复原始目标'
            )
          })
      },
      writeBack: () => {
        if (lastPicked) {
          onApplyTarget(lastPicked, { previewText: observationPreviewText(highlight) })
        }
        void onWriteBack?.().then((ok) => {
          if (ok) {
            setLastPicked(undefined)
            void refresh()
          }
        })
      },
      applyPickedToStep: () => {
        const next = lastPicked ?? highlight?.target
        if (!next) {
          toast.message('请先在画面上点到一个元素')
          return
        }
        onApplyTarget(next, { previewText: observationPreviewText(highlight) })
        setPickModeState(false)
        toast.success('已写入当前步骤')
      },
      adoptAlternative: (label) => {
        const next = targetFromPickedLabel(label, highlight?.target ?? lastPicked)
        setLastPicked(next)
        setPickModeState(false)
        if (!holding || pickOutcome) applyPickedTarget(next, label)
        else toast.success('已点到元素，可写入本次验证或写回草稿')
        void observePage({ op: 'highlight', target: next })
          .then((observation) => {
            setHighlight(observation)
            if (observation.outcome === 'AMBIGUOUS') {
              toast.message('这个内容在页面上不止一处，执行时可能对不上。请再点更具体的一格。')
            }
          })
          .catch(() => undefined)
      },
      applyAsOutcome: () => {
        const next = lastPicked ?? highlight?.target
        const previewText = observationPreviewText(highlight)
        if (!next && !previewText) {
          toast.message('请先在画面上点到要判断的内容')
          return
        }
        if (next) setLastPicked(next)
        onApplyTarget(next ?? { framePath: [], semantic: previewText, candidates: [{ by: 'text', value: previewText }] }, {
          previewText,
          addOutcome: true,
        })
        setPickModeState(false)
        toast.success(previewText ? `已添加成功条件：${previewText}` : '已添加成功条件')
      },
    }),
    [
      authoring,
      canDebugHold,
      canHighlight,
      canIndicate,
      highlight,
      holding,
      lastPicked,
      enclosingTable,
      livePage,
      observePage,
      onApplyTarget,
      onWriteBack,
      pickOutcome,
      pickMode,
      refresh,
      run,
      runId,
      selectedStepId,
      sessionId,
    ]
  )

  return (
    <AuthoringObserveContext.Provider value={value}>
      {children}
      {disambiguationModal ? (
        <Dialog open onOpenChange={(open) => !open && setDisambiguationModal(null)}>
          <DialogContent className='sm:max-w-md'>
            <DialogHeader>
              <DialogTitle className='flex items-center gap-1.5'>
                <span>🎯</span>
                <span>请确认目标语义</span>
              </DialogTitle>
              <DialogDescription>
                检测到该元素页面上显示的文本与底层无障碍名称存在差异，请确认采用哪一个作为定位描述：
              </DialogDescription>
            </DialogHeader>
            <RadioGroup
              value={disambiguationChoice}
              onValueChange={(val) => setDisambiguationChoice(val as 'visible_text' | 'accessible_name')}
              className='space-y-2 py-2'
            >
              <div className='flex items-center space-x-2 rounded-md border border-border-card p-3 bg-muted/20'>
                <RadioGroupItem value='visible_text' id='r-vis' />
                <Label htmlFor='r-vis' className='flex-1 cursor-pointer text-small'>
                  <span className='font-semibold text-foreground'>页面可见字：「{disambiguationModal.visibleText}」</span>
                  <span className='ml-2 text-status-success-foreground font-medium'>(推荐)</span>
                </Label>
              </div>
              <div className='flex items-center space-x-2 rounded-md border border-border-card p-3 bg-muted/20'>
                <RadioGroupItem value='accessible_name' id='r-aria' />
                <Label htmlFor='r-aria' className='flex-1 cursor-pointer text-small'>
                  <span className='font-semibold text-foreground'>无障碍名称：「{disambiguationModal.accessibleName}」</span>
                </Label>
              </div>
            </RadioGroup>
            <DialogFooter className='gap-2 sm:gap-0'>
              <Button variant='outline' onClick={() => setDisambiguationModal(null)}>
                取消
              </Button>
              <Button onClick={() => confirmDisambiguation(disambiguationChoice)}>
                确认采用
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </AuthoringObserveContext.Provider>
  )
}
