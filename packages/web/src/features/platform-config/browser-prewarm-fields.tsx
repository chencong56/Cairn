import { useQuery } from '@tanstack/react-query'
import { useWatch, type Control } from 'react-hook-form'
import { BROWSER_PREWARM_MODES, type PlatformConfigDocument } from '@cairn/shared'
import { FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchWorkers, fetchWorkerNodeHealth } from '@/lib/workers-api'
import { PREWARM_MODE_LABELS } from './labels'
import { FieldGrid, NumberSetting, SettingLabel, SettingSection } from './setting-layout'

export function BrowserPrewarmFields({
  canWrite,
  control,
}: {
  canWrite: boolean
  control: Control<PlatformConfigDocument, unknown>
}) {
  const mode = useWatch({ control, name: 'browserPrewarm.mode' })
  return (
    <div className='space-y-6'>
      <SettingSection
        title='浏览器预热'
        hint='只对共享浏览器生效：提前保留可用的空浏览器宿主，减少新会话冷启动等待。全独占部署保持关闭即可，不会为预热额外维持宿主。'
      >
        <FieldGrid>
          <FormField
            name='browserPrewarm.mode'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='预热策略'
                  help='关闭＝按需启动；固定＝每个执行节点维持固定数量的空宿主；自动＝在上下限内按冷启动未命中情况阶梯调整（1→3→5）。'
                />
                <Select
                  disabled={!canWrite}
                  value={field.value ?? 'off'}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {BROWSER_PREWARM_MODES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {PREWARM_MODE_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {mode === 'fixed' ? (
            <NumberSetting
              name='browserPrewarm.fixedIdle'
              label='固定备用数量'
              unit='个/执行节点'
              canWrite={canWrite}
              min={1}
              max={16}
              help='每个执行节点尝试保留的空宿主数量；实际数量受节点宿主与内存预算约束。'
            />
          ) : null}
          {mode === 'adaptive' ? (
            <>
              <NumberSetting
                name='browserPrewarm.minIdle'
                label='自动下限'
                unit='个/执行节点'
                canWrite={canWrite}
                min={0}
                max={16}
                help='正常负载下的保底备用数量；内存压力时可临时低于保底直至 0。'
              />
              <NumberSetting
                name='browserPrewarm.maxIdle'
                label='自动上限'
                unit='个/执行节点'
                canWrite={canWrite}
                min={1}
                max={16}
                help='自动阶梯不超过该数量；节点资源不足时按预算自行压低。'
              />
            </>
          ) : null}
        </FieldGrid>
      </SettingSection>
      <PrewarmNodeStatus />
    </div>
  )
}

function PrewarmNodeStatus() {
  const workersQuery = useQuery({
    queryKey: ['workers', 'prewarm-status'],
    queryFn: () => fetchWorkers({ limit: 20, heartbeatFresh: undefined }),
    refetchInterval: 30_000,
  })
  const workers = workersQuery.data?.items ?? []
  return (
    <SettingSection
      title='各执行节点应用状态'
      hint='策略保存后各执行节点约 30 秒内热应用；此处为节点实时观测（每 30 秒刷新），不可达或资源受限会给出原因。'
    >
      <div className='space-y-2 text-small'>
        {workers.length === 0 ? (
          <p className='text-muted-foreground'>暂无已登记的执行节点。</p>
        ) : (
          workers.map((worker) => <PrewarmNodeRow key={worker.workerId} workerId={worker.workerId} />)
        )}
      </div>
    </SettingSection>
  )
}

function PrewarmNodeRow({ workerId }: { workerId: string }) {
  const probe = useQuery({
    queryKey: ['worker-node-health', workerId],
    queryFn: () => fetchWorkerNodeHealth(workerId),
    refetchInterval: 30_000,
    retry: false,
  })
  const prewarm = probe.data?.health?.browserPrewarm
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-1 border-b pb-2 last:border-b-0'>
      <span className='font-mono text-label'>{workerId}</span>
      {probe.isFetching ? (
        <span className='text-muted-foreground'>查询中…</span>
      ) : !probe.data?.reachable ? (
        <span className='text-destructive'>
          不可达（{probe.data?.reason ?? '未知原因'}）
        </span>
      ) : !prewarm ? (
        <span className='text-muted-foreground'>非执行角色或旧版本节点，无预热状态</span>
      ) : (
        <>
          <span>
            策略 {PREWARM_MODE_LABELS[prewarm.mode]}（修订 {prewarm.policyRevision}）
          </span>
          <span>
            目标 {prewarm.configuredTarget} / 资源允许 {prewarm.effectiveTarget} / 实际空闲{' '}
            {prewarm.actualIdleCount}
          </span>
          <span>
            宿主 {prewarm.activeCount} 活跃 · {prewarm.startingCount} 启动中 ·{' '}
            {prewarm.contextsCount} 上下文
          </span>
          <span>
            命中 {prewarm.warmHits} / 冷启动 {prewarm.coldMisses} / 复用 {prewarm.reuseHits}
          </span>
          {prewarm.underMemoryPressure ? (
            <span className='text-destructive'>内存压力中，预热已收缩</span>
          ) : null}
          {prewarm.lastPrewarmSkipReason ? (
            <span className='text-muted-foreground'>受限：{prewarm.lastPrewarmSkipReason}</span>
          ) : null}
          {prewarm.lastPrewarmError ? (
            <span className='text-destructive'>预热降级：{prewarm.lastPrewarmError}</span>
          ) : null}
          {prewarm.lastAdjustmentReason ? (
            <span className='text-muted-foreground'>调档：{prewarm.lastAdjustmentReason}</span>
          ) : null}
        </>
      )}
    </div>
  )
}
