import { ArrowLeft, Sparkles, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ScenarioResolutionStats } from '../../resolution-stats'
import type { ScenarioLocatorHealthResult } from '../../use-scenario-locator-health'

export interface ScenarioHealthInspectorProps {
  scenarioId: string
  steps?: readonly { id: string; name?: string }[]
  focusedStepId?: string | null
  focusedStepIndex?: number
  locatorHealth?: ScenarioLocatorHealthResult
  disabled?: boolean
  onBatchAdopt?: () => void
  onSelectStep?: (stepId: string) => void
  onReturnToStep?: () => void
  className?: string
}

export function ScenarioHealthInspector({
  scenarioId,
  steps = [],
  focusedStepId,
  focusedStepIndex,
  locatorHealth,
  disabled = false,
  onBatchAdopt,
  onSelectStep,
  onReturnToStep,
  className,
}: ScenarioHealthInspectorProps) {
  const healthyCount = locatorHealth?.healthyCount ?? 0
  const warningCount = locatorHealth?.warningCount ?? 0
  const failingCount = locatorHealth?.failingCount ?? 0
  const candidateCount = locatorHealth?.candidateCount ?? 0
  const hasTestedSteps = healthyCount > 0 || warningCount > 0 || failingCount > 0 || candidateCount > 0

  return (
    <section
      data-testid='scenario-health-inspector'
      aria-label='场景定位健康与自愈工作区'
      className={cn('flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card', className)}
    >
      {/* 顶栏：标题与返回最后选中步骤 */}
      <div className='border-b border-border-divider bg-surface-header p-3 shrink-0 flex items-center justify-between gap-2'>
        <div className='min-w-0'>
          <p className='text-caption text-muted-foreground flex items-center gap-1.5'>
            <Activity className='size-3.5 text-primary' />
            <span>场景级 · 运行可靠性</span>
          </p>
          <h3 className='mt-0.5 text-body font-semibold text-foreground truncate'>
            定位健康度与规则自愈
          </h3>
        </div>
        {onReturnToStep && focusedStepId && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onReturnToStep}
            className='shrink-0 h-7 px-2.5 text-label gap-1 font-medium hover:bg-muted text-primary border-primary/20 bg-primary/5 hover:bg-primary/10'
            title='返回之前选中的步骤配置'
            data-testid='health-inspector-return-step-btn'
          >
            <ArrowLeft className='size-3.5' />
            <span>返回步骤 {focusedStepIndex !== undefined ? focusedStepIndex + 1 : ''}</span>
          </Button>
        )}
      </div>

      {/* 滚动工作区 */}
      <div
        data-testid='scenario-health-scroll-area'
        className='flex-1 min-h-0 space-y-4 overflow-y-auto p-4 pb-28'
      >
        {/* 全局健康总览状态卡 */}
        <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-3'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div
                className={cn(
                  'size-2.5 rounded-full shrink-0',
                  !hasTestedSteps
                    ? 'bg-muted-foreground/40'
                    : warningCount > 0
                      ? 'bg-status-warning'
                      : failingCount > 0
                        ? 'bg-status-error'
                        : 'bg-status-success',
                )}
              />
              <h4 className='text-body font-semibold text-foreground'>
                {!hasTestedSteps
                  ? '尚未产生运行样本'
                  : warningCount > 0
                    ? `${warningCount} 个步骤规则衰减`
                    : failingCount > 0
                      ? `${failingCount} 个步骤定位失败`
                      : '全部规则 100% 稳定'}
              </h4>
            </div>

            {hasTestedSteps ? (
              <span
                className={cn(
                  'rounded px-2 py-0.5 text-caption font-semibold font-mono',
                  warningCount > 0
                    ? 'bg-status-warning/15 text-status-warning-foreground'
                    : failingCount > 0
                      ? 'bg-status-error/15 text-status-error-foreground'
                      : 'bg-status-success/15 text-status-success-foreground',
                )}
              >
                {warningCount > 0 ? `${warningCount} 步需维护` : failingCount > 0 ? `${failingCount} 步失效` : '100% 稳定'}
              </span>
            ) : (
              <span className='rounded px-2 py-0.5 text-caption font-semibold font-mono bg-muted/60 text-muted-foreground'>
                待试跑
              </span>
            )}
          </div>

          <p className='text-caption text-muted-foreground leading-relaxed'>
            {!hasTestedSteps
              ? '当前场景尚未执行试跑或正式运行。首次试跑后，系统将自动统计各步骤定位选择器的规则直接命中率、AI 视觉兜底次数与自愈建议。'
              : '统计历史运行中各步骤目标元素的健康度。命中率低于 100% 表示该步骤曾依赖自愈模式降级命中，建议及时采纳自愈建议以确保长期稳定性。'}
          </p>
        </div>

        {/* 冷启动未试跑时的空状态引导卡片 */}
        {!hasTestedSteps && (
          <div
            data-testid='health-empty-guidance'
            className='rounded-xl border border-dashed border-border-divider/80 bg-surface-subtle/40 p-6 flex flex-col items-center justify-center text-center space-y-3'
          >
            <div className='size-10 rounded-full bg-muted/80 flex items-center justify-center text-muted-foreground'>
              <Activity className='size-5' />
            </div>
            <div className='space-y-1 max-w-xs'>
              <p className='text-body font-medium text-foreground'>通过试跑获取定位稳定性</p>
              <p className='text-caption text-muted-foreground leading-relaxed'>
                定位健康度分析依赖真实的执行日志。首次试跑后，系统将自动统计规则命中率，并为频繁依赖 AI 视觉兜底的步骤生成一键自愈建议。
              </p>
            </div>
          </div>
        )}

        {/* 一键批量自愈置顶卡片 */}
        {candidateCount > 0 && onBatchAdopt && (
          <div
            data-testid='batch-healing-banner'
            className='flex items-center justify-between gap-3 p-3.5 rounded-xl border border-primary/25 bg-primary/5 shadow-xs'
          >
            <div className='flex items-center gap-2.5 min-w-0'>
              <div className='size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0'>
                <Sparkles className='size-4 text-primary' />
              </div>
              <div className='min-w-0'>
                <p className='text-body font-medium text-foreground truncate'>
                  检测到 <strong>{candidateCount}</strong> 个步骤有可用的定位自愈建议
                </p>
                <p className='text-caption text-muted-foreground truncate'>
                  AI 兜底已验证目标特征，可一键更新至当前草稿
                </p>
              </div>
            </div>
            <Button
              size='sm'
              variant='default'
              disabled={disabled}
              className='shrink-0 h-8 font-medium'
              onClick={onBatchAdopt}
              data-testid='batch-adopt-all-btn'
            >
              <Sparkles className='size-3.5 mr-1' />
              一键批量自愈
            </Button>
          </div>
        )}

        {/* 步骤稳定性报表 */}
        <ScenarioResolutionStats
          scenarioId={scenarioId}
          steps={steps}
          onSelectStep={onSelectStep}
        />
      </div>
    </section>
  )
}
