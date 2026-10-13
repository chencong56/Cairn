import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Send,
  CalendarClock,
  ChevronDown,
  Edit2,
  Play,
  Save,
  ListChecks,
  Settings,
  Zap,
  CheckCircle2,
  AlertCircle,
  Info,
  Loader2,
  Square,
  Trash2,
} from 'lucide-react'
import type {
  RunDetailDto,
  ScenarioDetailDto,
  TargetDto,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ObjectSchedules } from '@/features/schedules/object-schedules'
import { useAssistantStore } from '@/stores/assistant-store'
import { SCENARIO_STATUS_LABELS } from './labels'
import { cn } from '@/lib/utils'

export type StudioToolbarProps = {
  scenario: ScenarioDetailDto | undefined
  target: TargetDto | undefined
  scenarioId: string
  revision: number
  dirty: boolean
  hasDraftDirty: boolean
  saving: boolean
  publishing: boolean
  canWrite: boolean
  canTrial: boolean
  canStartFormalRun: boolean
  trialDisabledReason: string | undefined
  trialRun?: RunDetailDto | null
  canPublish: boolean
  unpublishedDraft: boolean
  compileOk: boolean | undefined
  canReadTarget: boolean
  canRecord: boolean
  canDelete: boolean
  disabled: boolean
  isScenarioView?: boolean
  pendingImportDraftId?: string | null
  onPreviewImportDraft?: () => void
  onSave: () => void
  onPublish: () => void
  onStartTrial: () => void
  onCancelTrial?: () => void
  canCancelTrial?: boolean
  cancellingTrial?: boolean
  onOpenTrialResult?: () => void
  onOpenRun: () => void
  onOpenImport: () => void
  onOpenRename: () => void
  onRename?: (newName: string) => Promise<boolean | void> | void
  onToggleStatus: () => void
  /** 复制为新场景；未提供时不显示入口（如非普通场景）。 */
  onCopy?: () => void
  copying?: boolean
  onOpenRemove: () => void
  onOpenSettings?: () => void
  /** 打开右栏「补全验收」。 */
  onOpenAcceptance?: () => void
  isAcceptanceView?: boolean
  onLeave: (e: React.MouseEvent) => void
}

export function StudioToolbar({
  scenario,
  target,
  revision,
  dirty,
  hasDraftDirty,
  saving,
  publishing,
  canWrite,
  canTrial,
  canStartFormalRun,
  trialDisabledReason,
  trialRun,
  canPublish,
  unpublishedDraft,
  compileOk,
  canReadTarget,
  canRecord,
  canDelete,
  disabled,
  isScenarioView = false,
  pendingImportDraftId,
  onPreviewImportDraft,
  onSave,
  onPublish,
  onStartTrial,
  onCancelTrial,
  canCancelTrial: canCancelTrialProp,
  cancellingTrial = false,
  onOpenTrialResult,
  onOpenRun,
  onOpenImport,
  onOpenRename,
  onRename,
  onToggleStatus,
  onCopy,
  copying = false,
  onOpenRemove,
  onOpenSettings,
  onOpenAcceptance,
  isAcceptanceView,
  onLeave,
}: StudioToolbarProps) {
  const headerRef = useRef<HTMLElement>(null)
  const isAssistantDocked = useAssistantStore((s) => s.open && s.mode === 'docked')
  const assistantDockWidth = useAssistantStore((s) => s.dockWidth)

  // 内联重命名状态机
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(scenario?.name ?? '')
  const [savingName, setSavingName] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isEditingName && scenario?.name) {
      setTempName(scenario.name)
    }
  }, [scenario?.name, isEditingName])

  useEffect(() => {
    if (isEditingName) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditingName])

  const commitRename = async () => {
    const trimmed = tempName.trim()
    if (!trimmed || trimmed === scenario?.name) {
      setTempName(scenario?.name ?? '')
      setIsEditingName(false)
      return
    }
    if (onRename) {
      setSavingName(true)
      try {
        await onRename(trimmed)
        setIsEditingName(false)
      } catch {
        setTempName(scenario?.name ?? '')
        setIsEditingName(false)
      } finally {
        setSavingName(false)
      }
    } else {
      setIsEditingName(false)
      onOpenRename()
    }
  }

  // 试跑运行态判定
  const isTrialQueued = Boolean(trialRun && ['QUEUED', 'SCHEDULED'].includes(trialRun.status))
  const isTrialRunning = Boolean(
    trialRun && ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(trialRun.status),
  )
  const trialNoExecutor =
    trialRun?.placement?.waitReason === 'NO_ELIGIBLE_WORKER' ||
    trialRun?.placement?.waitReason === 'WORKER_PROTOCOL_MISSING'
  const trialLiveLabel = trialNoExecutor ? '没有执行节点' : isTrialQueued ? '试跑排队中' : '试跑中…'
  const canCancelTrial = canCancelTrialProp ?? Boolean(onCancelTrial)
  const [isCancelHovered, setIsCancelHovered] = useState(false)

  // 容器可用宽度状态（首帧合理估算，后续由 ResizeObserver 精确测量）
  const [containerWidth, setContainerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 1200
    const w = window.innerWidth
    const dockedOffset = isAssistantDocked ? (assistantDockWidth || 400) : 0
    return Math.max(320, w - 240 - dockedOffset)
  })

  useEffect(() => {
    const el = headerRef.current
    if (!el) return

    if (el.getBoundingClientRect().width > 0) {
      setContainerWidth(el.getBoundingClientRect().width)
    }

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 自适应响应式断点：
  // 上下文状态微徽章（极窄时收起胶囊保障标题和主操作）
  const showPill = containerWidth >= 540

  return (
    <header
      ref={headerRef}
      className='flex h-14 shrink-0 items-center justify-between border-b border-border-divider bg-card px-3 sm:px-4 shadow-sm gap-2 overflow-hidden'
    >
      {/* 左侧：返回、目标系统父级面包屑、场景标识与极简微状态徽章 */}
      <div className='flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5 overflow-hidden'>
        <Link
          to='/scenarios'
          className='inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors'
          onClick={onLeave}
          title='返回场景编排'
          aria-label='返回场景编排'
        >
          <ArrowLeft className='size-4' />
        </Link>
        <span className='h-4 w-px bg-border-divider shrink-0' />

        {/* 目标系统父级面包屑 */}
        {scenario ? (
          <div className='flex min-w-0 items-center gap-1.5 shrink-0'>
            {canReadTarget ? (
              <Link
                to='/targets/$targetId'
                params={{ targetId: scenario.targetId }}
                className='max-w-[90px] sm:max-w-[130px] md:max-w-[160px] truncate text-label font-medium text-muted-foreground hover:text-link hover:underline transition-colors'
                title={`目标系统：${target?.name ?? scenario.targetId}`}
              >
                {target?.name ?? scenario.targetId}
              </Link>
            ) : (
              <span
                className='max-w-[90px] sm:max-w-[130px] truncate text-label font-medium text-muted-foreground font-mono'
                title={`目标系统：${scenario.targetId}`}
              >
                {scenario.targetId}
              </span>
            )}
            <span className='text-muted-foreground/40 select-none'>/</span>
          </div>
        ) : null}

        {/* 场景名称与重命名 */}
        <div className='flex min-w-0 shrink items-center gap-1.5 max-w-[150px] sm:max-w-[200px] md:max-w-[260px] xl:max-w-[340px]'>
          {isEditingName ? (
            <div className='flex items-center gap-1 min-w-0'>
              <input
                ref={inputRef}
                type='text'
                value={tempName}
                maxLength={100}
                disabled={savingName}
                aria-label='场景名称输入'
                className='h-7 w-36 sm:w-48 md:w-56 rounded-md border border-control bg-surface-control px-2 text-body font-semibold text-foreground shadow-control-focus outline-none focus:border-primary'
                onChange={(e) => setTempName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(false)
                  }
                }}
                onBlur={() => {
                  void commitRename()
                }}
              />
              {savingName ? <span className='size-3 animate-spin rounded-full border-2 border-primary border-t-transparent' /> : null}
            </div>
          ) : (
            <>
              <h1
                className='truncate text-body font-semibold text-foreground cursor-pointer hover:text-primary transition-colors'
                title={scenario?.name ?? '场景'}
                onClick={() => {
                  if (canWrite) {
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(true)
                  }
                }}
              >
                {scenario?.name ?? '场景'}
              </h1>
              {canWrite ? (
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-6 shrink-0 text-muted-foreground hover:text-foreground'
                  title='重命名'
                  onClick={() => {
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(true)
                  }}
                >
                  <Edit2 className='size-3.5' />
                  <span className='sr-only'>重命名</span>
                </Button>
              ) : null}
            </>
          )}
        </div>

        {/* 现代微状态胶囊：版本、草稿、编译、启用指示灯 */}
        {scenario && showPill ? (
          <div
            className='flex items-center gap-1.5 rounded-full border border-border-default/80 bg-surface-subtle px-2 py-0.5 text-caption whitespace-nowrap shrink-0 select-none'
            title={`${scenario.latestVersionNo ? `已发布版本 v${scenario.latestVersionNo}` : '尚未发布'} · 本地草稿修订号 r${revision}${dirty ? '（未保存修改）' : hasDraftDirty ? '（未发布草稿）' : '（已同步）'}${scenario.status === 'active' ? ' · 已启用' : ' · 已停用'}`}
            data-testid='studio-micro-badge'
          >
            <span className='font-mono font-medium text-foreground' title={`${scenario.latestVersionNo ? `已发布版本 v${scenario.latestVersionNo}` : '尚未发布'}`}>
              {scenario.latestVersionNo ? `v${scenario.latestVersionNo}` : '未发布'}
            </span>
            <span className='text-muted-foreground/30'>·</span>
            <span
              className={cn('font-mono font-medium', (dirty || hasDraftDirty) && 'text-status-warning-foreground')}
              title={`本地草稿修订号 r${revision}${dirty ? '（未保存修改）' : hasDraftDirty ? '（未发布草稿）' : ''}`}
            >
              r{revision}{dirty || hasDraftDirty ? '*' : ''}
            </span>
            {compileOk === false ? (
              <>
                <span className='text-muted-foreground/30'>·</span>
                <span className='text-status-error font-medium'>编译失败</span>
              </>
            ) : null}
            <span className='text-muted-foreground/30'>·</span>
            <span className='inline-flex items-center gap-1 font-medium'>
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  scenario.status === 'active' ? 'bg-status-success' : 'bg-muted-foreground/40',
                )}
                aria-hidden='true'
              />
              <span className={scenario.status === 'active' ? 'text-status-success-foreground' : 'text-muted-foreground'}>
                {SCENARIO_STATUS_LABELS[scenario.status]}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {/* 右侧：主次动作 */}
      {scenario ? (
        <div className='flex shrink-0 items-center gap-1.5 sm:gap-2'>

          {onOpenAcceptance ? (
            <Button
              size={containerWidth >= 1280 ? 'sm' : 'icon'}
              variant={isAcceptanceView ? 'secondary' : 'outline'}
              className={cn(
                containerWidth < 1280 && 'size-8',
                isAcceptanceView && 'border-primary/40 bg-primary/10 text-primary font-medium shadow-xs',
              )}
              onClick={onOpenAcceptance}
              title='按目标补全检查与报告指标'
              aria-label='补全验收'
              data-testid='toolbar-acceptance'
            >
              <ListChecks className={cn('size-3.5', containerWidth >= 1280 && 'mr-1')} />
              {containerWidth >= 1280 ? '补全验收' : null}
            </Button>
          ) : null}

          {/* 场景配置全局入口（稳定可见，断点优先保障） */}
          {onOpenSettings ? (
            containerWidth >= 960 ? (
              <Button
                size='sm'
                variant={isScenarioView ? 'secondary' : 'outline'}
                className={cn(isScenarioView && 'border-primary/40 bg-primary/10 text-primary font-medium shadow-xs')}
                onClick={onOpenSettings}
                title='整个场景配置'
                data-testid='toolbar-scenario-config'
              >
                <Settings className='size-3.5 mr-1' />
                场景配置
              </Button>
            ) : (
              <Button
                size='icon'
                variant={isScenarioView ? 'secondary' : 'outline'}
                className={cn('size-8', isScenarioView && 'border-primary/40 bg-primary/10 text-primary')}
                onClick={onOpenSettings}
                title='整个场景配置'
                aria-label='场景配置'
                data-testid='toolbar-scenario-config'
              >
                <Settings className='size-3.5' />
              </Button>
            )
          ) : null}

          {/* 待导入录制草稿高亮入口：吸收进顶栏，高度固定锁死 */}
          {pendingImportDraftId && canRecord && onPreviewImportDraft ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary font-medium shadow-xs shrink-0'
              onClick={onPreviewImportDraft}
              title='检测到录制草稿，点击预览并转换为操作步骤'
              data-testid='toolbar-import-draft-btn'
            >
              <Zap className='size-3.5 mr-1 text-primary' />
              {containerWidth >= 800 ? <span>导入录制草稿</span> : <span>导入草稿</span>}
            </Button>
          ) : null}

          {/* 核心主动作（各分辨率均保持可达） */}
          {canWrite ? (
            <Button
              size='sm'
              variant='outline'
              className={dirty ? 'border-primary text-primary hover:bg-primary/5 font-medium shadow-xs' : ''}
              disabled={!dirty || saving}
              loading={saving}
              onClick={onSave}
            >
              <Save className='size-3.5 mr-1' />
              保存草稿
            </Button>
          ) : null}

          {isTrialRunning ? (
            canCancelTrial && onCancelTrial ? (
              <Button
                size='sm'
                variant='outline'
                className={cn(
                  'h-8 px-2.5 text-label gap-1.5 transition-colors',
                  isCancelHovered || cancellingTrial
                    ? 'border-status-error/40 bg-status-error/10 text-status-error hover:border-status-error/60 hover:bg-status-error/15 hover:text-status-error'
                    : 'border-border text-muted-foreground hover:border-status-error/40 hover:bg-status-error/10 hover:text-status-error',
                )}
                disabled={cancellingTrial}
                onClick={onCancelTrial}
                onMouseEnter={() => setIsCancelHovered(true)}
                onMouseLeave={() => setIsCancelHovered(false)}
                title={
                  trialNoExecutor
                    ? '当前没有可用的执行节点，试跑不会开始；点击可中止'
                    : isTrialQueued
                      ? '试跑还在排队，尚未开始执行；点击可中止'
                      : '试跑执行中，点击可中止'
                }
              >
                {cancellingTrial ? (
                  <>
                    <Loader2 className='size-3.5 animate-spin text-status-error' />
                    <span>正在中止…</span>
                  </>
                ) : isCancelHovered ? (
                  <>
                    <Square className='size-3.5 fill-current text-status-error' aria-hidden='true' />
                    <span>中止试跑</span>
                  </>
                ) : (
                  <>
                    <Loader2 className='size-3.5 animate-spin text-primary' />
                    <span>{trialLiveLabel}</span>
                  </>
                )}
              </Button>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='h-8 px-2.5 text-label text-muted-foreground gap-1.5'
                disabled
                title={
                  trialNoExecutor
                    ? '当前没有可用的执行节点，试跑不会开始'
                    : isTrialQueued
                      ? '试跑还在排队，尚未开始执行'
                      : '试跑执行中…'
                }
              >
                <Loader2 className='size-3.5 animate-spin text-primary' />
                <span>{trialLiveLabel}</span>
              </Button>
            )
          ) : canTrial ? (
            <Button size='sm' className='action-shadow' onClick={onStartTrial}>
              <Play className='size-3.5 mr-1' />
              试跑
            </Button>
          ) : canStartFormalRun ? (
            <Button size='sm' variant='outline' disabled title={trialDisabledReason}>
              <Play className='size-3.5 mr-1' />
              试跑
            </Button>
          ) : null}

          {onOpenTrialResult && trialRun && !isTrialRunning ? (
            <Button
              size='sm'
              variant='outline'
              className={cn(
                'h-8 px-2.5 text-label font-medium gap-1.5 transition-colors',
                trialRun.status === 'SUCCEEDED' && 'border-status-success/40 text-status-success-foreground hover:bg-status-success/10',
                trialRun.status === 'FAILED' && 'border-status-error/40 text-status-error-foreground hover:bg-status-error/10',
                trialRun.status === 'NEEDS_REVIEW' && 'border-status-warning/40 text-status-warning-foreground hover:bg-status-warning/10',
              )}
              onClick={onOpenTrialResult}
              title='查看试跑结果'
            >
              {trialRun.status === 'SUCCEEDED' ? (
                <CheckCircle2 className='size-3.5 text-status-success' />
              ) : trialRun.status === 'FAILED' ? (
                <AlertCircle className='size-3.5 text-status-error' />
              ) : (
                <Info className='size-3.5 text-status-warning' />
              )}
              <span>试跑结果</span>
            </Button>
          ) : null}

          {canWrite && (dirty || unpublishedDraft) ? (
            <Button
              size='sm'
              variant='outline'
              disabled={!canPublish || publishing}
              loading={publishing}
              onClick={onPublish}
            >
              发布
            </Button>
          ) : null}

          {/* 更多下拉菜单（挂载助手/笔记本/窄屏下承接次要操作，大屏承接高级操作） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='sm' variant='outline'>
                更多
                <ChevronDown className='size-3.5 ml-1' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-52'>
              {/* 运维与外部触发入口（常驻收纳，保障顶栏专注流水线编排） */}
              <ObjectSchedules
                context={{
                  type: 'scenario_run',
                  targetId: scenario.targetId,
                  objectId: scenario.id,
                  name: scenario.name,
                  versionId: scenario.latestVersionId ?? undefined,
                }}
                trigger={({ onClick }) => (
                  <DropdownMenuItem onSelect={onClick}>
                    <CalendarClock className='mr-2 size-3.5 shrink-0' />
                    <span className='whitespace-nowrap'>定时任务</span>
                  </DropdownMenuItem>
                )}
              />
              <DropdownMenuItem asChild>
                <Link to='/outbound' search={{ tab: 'results', scenarioId: scenario.id }}>
                  <Send className='mr-2 size-3.5 shrink-0' />
                  <span className='whitespace-nowrap'>结果推送</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              {/* 常规操作项（场景配置在顶栏已有常驻入口，此处不再重复呈现） */}
              {canWrite && !dirty && !unpublishedDraft ? (
                <DropdownMenuItem disabled={!canPublish || publishing} onClick={onPublish}>
                  <span className='whitespace-nowrap'>发布</span>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!canStartFormalRun} onClick={onOpenRun}>
                <span className='whitespace-nowrap'>运行已发布版本</span>
              </DropdownMenuItem>
              {canRecord ? (
                <DropdownMenuItem
                  disabled={disabled}
                  onClick={onOpenImport}
                  data-testid='toolbar-more-import-item'
                >
                  <Zap className='mr-2 size-3.5 text-primary shrink-0' />
                  <span className='whitespace-nowrap'>导入已有录制</span>
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onOpenRename}>
                    <span className='whitespace-nowrap'>重命名</span>
                  </DropdownMenuItem>
                  {onCopy ? (
                    <DropdownMenuItem disabled={copying} onClick={onCopy}>
                      <span className='whitespace-nowrap'>{copying ? '复制中…' : '复制场景'}</span>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem disabled={disabled} onClick={onToggleStatus}>
                    <span className='whitespace-nowrap'>{scenario?.status === 'active' ? '停用' : '启用'}</span>
                  </DropdownMenuItem>
                </>
              ) : null}
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className='text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer' onClick={onOpenRemove}>
                    <Trash2 className='size-3.5 mr-2' />
                    <span className='whitespace-nowrap'>删除</span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </header>
  )
}

export { StudioToolbar as StudioHeaderBar }
