import { useState } from 'react'
import { accountOptionLabel } from '@/features/runs/target-account'
import type { SuiteDocument, SuiteMember, SuiteStage } from '@cairn/shared'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  Sliders,
  User,
  Variable,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { KeyValueEditor } from '../key-value-editor'
import { ReportProfileEditor, ReportProfileSelect } from '@/features/reports/profiles'
import { useCan } from '@/hooks/use-permissions'

export interface SuiteInspectorProps {
  name: string
  description: string
  document: SuiteDocument
  isStageMode?: boolean
  canWrite: boolean
  targetAccounts: Array<{ id: string; displayName: string; username: string | null; identityKind?: string | null }>
  targetId: string
  selectedMember?: SuiteMember | null
  selectedStage?: SuiteStage | null
  scenarioNames?: Map<string, string>
  onClearSelection: () => void
  onUpdateName: (name: string) => void
  onUpdateDescription: (desc: string) => void
  onUpdateDocument: (updater: (doc: SuiteDocument) => SuiteDocument) => void
  onUpdateMember?: (updater: (m: SuiteMember) => SuiteMember) => void
  onUpdateStage?: (updater: (s: SuiteStage) => SuiteStage) => void
  onOpenInputDialog?: (member: SuiteMember) => void
}

export function SuiteInspector({
  name,
  description,
  document,
  isStageMode = false,
  canWrite,
  targetAccounts,
  targetId,
  selectedMember = null,
  selectedStage = null,
  scenarioNames = new Map(),
  onClearSelection,
  onUpdateName,
  onUpdateDescription,
  onUpdateDocument,
  onUpdateMember,
  onUpdateStage,
  onOpenInputDialog,
}: SuiteInspectorProps) {
  const [sharedParamsOpen, setSharedParamsOpen] = useState(true)
  const [reportsOpen, setReportsOpen] = useState(true)
  const canExport = useCan('report:export')

  // ==========================================
  // LEVEL 3: Member Inspector (Context-Sensitive)
  // ==========================================
  if (selectedMember) {
    const scenarioName = scenarioNames.get(selectedMember.scenarioId) ?? selectedMember.scenarioId
    const overrideCount = Object.keys(selectedMember.input ?? {}).length

    return (
      <div className='flex flex-col gap-4 animate-in fade-in-50 duration-200'>
        {/* Context Breadcrumb Navigation Header */}
        <div className='flex items-center justify-between px-1 py-0.5'>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-mono text-label bg-primary/5 text-primary border-primary/20'>
              成员 {selectedMember.memberId}
            </Badge>
            <span className='text-label font-medium text-foreground truncate max-w-[180px]' title={scenarioName}>
              {selectedMember.displayName || scenarioName}
            </span>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={onClearSelection}
            className='h-7 px-2 text-label text-muted-foreground hover:text-foreground'
            title='返回全局流水线设置 (Esc)'
          >
            <ArrowLeft className='size-3 mr-1' />
            全局设置
          </Button>
        </div>

        {/* Member Entity & Alias Card */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center gap-2'>
            <Layers className='size-4 text-primary' />
            <h3 className='text-title font-semibold'>场景信息与展示名称</h3>
          </div>

          <div className='rounded-lg bg-muted/40 p-2.5 text-label space-y-1 border border-border-divider/50'>
            <div className='text-3xs text-muted-foreground'>关联场景</div>
            <div className='font-medium text-foreground truncate' title={scenarioName}>
              {scenarioName}
            </div>
            <div className='text-3xs font-mono text-muted-foreground pt-0.5'>
              版本: {selectedMember.scenarioVersionId.slice(0, 8)} · 节点: {selectedMember.memberId}
            </div>
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='member-display-name'>自定义别名 (可选)</Label>
            <Input
              id='member-display-name'
              aria-label={`${selectedMember.memberId} 展示名称`}
              value={selectedMember.displayName ?? ''}
              disabled={!canWrite}
              placeholder='如: 巡检前置登录 (默认同场景名)'
              className='h-8 text-body'
              onChange={(e) => {
                if (onUpdateMember) {
                  onUpdateMember((m) => ({ ...m, displayName: e.target.value }))
                }
              }}
            />
          </div>
        </Card>

        {/* Target Account Assignment Card */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <User className='size-4 text-muted-foreground' />
              <h3 className='text-title font-semibold'>执行目标账号</h3>
            </div>
            <Badge variant='outline' className='text-3xs font-normal text-muted-foreground'>
              {selectedMember.targetAccountId ? '独立指派' : '跟随默认'}
            </Badge>
          </div>

          <div className='grid gap-1.5'>
            <Select
              value={selectedMember.targetAccountId ?? '__default__'}
              disabled={!canWrite}
              onValueChange={(val) => {
                if (onUpdateMember) {
                  onUpdateMember((m) => ({ ...m, targetAccountId: val === '__default__' ? undefined : val }))
                }
              }}
            >
              <SelectTrigger
                id='member-target-account'
                aria-label={`${selectedMember.memberId} 目标账号`}
                className='h-8 text-label'
              >
                <SelectValue placeholder='跟随场景 / 集合默认' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__default__'>跟随场景 / 集合默认</SelectItem>
                {targetAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {accountOptionLabel(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-3xs text-muted-foreground mt-0.5 leading-relaxed'>
              受管账号独占策略下，若多个场景指定同一账号，调度器将自适应排队互斥，避免登录与会话冲突。
            </p>
          </div>
        </Card>

        {/* Inline Parameter Overrides (KeyValueEditor - Eliminates Modal Blockers!) */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <Sliders className='size-4 text-primary' />
              <h3 className='text-title font-semibold'>参数覆盖 (Overrides)</h3>
            </div>
            <div className='flex items-center gap-1.5'>
              <Badge variant='outline' className='text-label font-normal text-muted-foreground'>
                {overrideCount > 0 ? `已配置 ${overrideCount} 项` : '继承全局/默认'}
              </Badge>
              {onOpenInputDialog ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => onOpenInputDialog(selectedMember)}
                  className='h-6 px-1.5 text-3xs text-muted-foreground hover:text-primary'
                  title='在独立大弹窗中编辑或导入 JSON'
                >
                  大窗/JSON
                </Button>
              ) : null}
            </div>
          </div>

          <p className='text-label text-muted-foreground'>
            此处配置将优先覆盖全局公共变量（Shared Input）及场景自带的默认参数。
          </p>

          <KeyValueEditor
            value={selectedMember.input ?? {}}
            onChange={(input) => {
              if (onUpdateMember) {
                onUpdateMember((m) => ({ ...m, input }))
              }
            }}
            disabled={!canWrite}
            placeholderKey='覆盖参数名'
            placeholderValue='覆盖参数值'
          />
        </Card>

        {/* Member Sub-report Config */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center gap-2'>
            <FileText className='size-4 text-muted-foreground' />
            <h3 className='text-title font-semibold'>成员报告配置</h3>
          </div>
          <ReportProfileSelect
            targetId={targetId}
            source='RUN'
            label={`${selectedMember.memberId} 子报告默认配置`}
            value={selectedMember.reportProfileId}
            disabled={!canWrite}
            onChange={(profileId) => {
              if (onUpdateMember) {
                onUpdateMember((m) => ({ ...m, reportProfileId: profileId }))
              }
            }}
          />
        </Card>
      </div>
    )
  }

  // ==========================================
  // LEVEL 2: Stage Inspector (Context-Sensitive)
  // ==========================================
  if (selectedStage) {
    return (
      <div className='flex flex-col gap-4 animate-in fade-in-50 duration-200'>
        {/* Context Breadcrumb Navigation Header */}
        <div className='flex items-center justify-between px-1 py-0.5'>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-mono text-label bg-primary/5 text-primary border-primary/20'>
              Stage {selectedStage.ordinal + 1}
            </Badge>
            <span className='text-label font-medium text-foreground truncate max-w-[180px]'>
              {selectedStage.name}
            </span>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={onClearSelection}
            className='h-7 px-2 text-label text-muted-foreground hover:text-foreground'
            title='返回全局流水线设置 (Esc)'
          >
            <ArrowLeft className='size-3 mr-1' />
            全局设置
          </Button>
        </div>

        {/* Stage Identity Card */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center gap-2'>
            <Layers className='size-4 text-primary' />
            <h3 className='text-title font-semibold'>阶段基本信息</h3>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='stage-inspector-name'>阶段名称</Label>
            <Input
              id='stage-inspector-name'
              aria-label={`阶段 ${selectedStage.ordinal + 1} 名称`}
              value={selectedStage.name ?? ''}
              disabled={!canWrite}
              placeholder='阶段名称'
              className='h-8 text-body'
              onChange={(e) => {
                if (onUpdateStage) {
                  onUpdateStage((s) => ({ ...s, name: e.target.value }))
                }
              }}
            />
          </div>
        </Card>

        {/* Stage Execution & Concurrency Card */}
        <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <Sliders className='size-4 text-muted-foreground' />
              <h3 className='text-title font-semibold'>阶段内执行策略</h3>
            </div>
            <Badge variant='outline' className='text-3xs font-normal text-muted-foreground'>
              阶段独立
            </Badge>
          </div>

          <div className='grid gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='stage-inspector-mode'>阶段执行模式</Label>
              <Select
                value={selectedStage.executionMode}
                disabled={!canWrite}
                onValueChange={(val) => {
                  if (onUpdateStage) {
                    onUpdateStage((s) => ({ ...s, executionMode: val as 'parallel' | 'sequential' }))
                  }
                }}
              >
                <SelectTrigger id='stage-inspector-mode' className='h-8 text-label'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='parallel'>受控并发 (Worker 池)</SelectItem>
                  <SelectItem value='sequential'>严格串行 (逐一执行)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {selectedStage.executionMode === 'parallel' ? (
              <div className='grid gap-1.5'>
                <Label htmlFor='stage-inspector-concurrency'>阶段最大并发数 (1–10)</Label>
                <Input
                  id='stage-inspector-concurrency'
                  type='number'
                  min={1}
                  max={10}
                  value={selectedStage.maxConcurrency ?? 3}
                  disabled={!canWrite}
                  className='h-8 text-label'
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!Number.isNaN(val) && onUpdateStage) {
                      onUpdateStage((s) => ({ ...s, maxConcurrency: Math.max(1, Math.min(10, val)) }))
                    }
                  }}
                />
              </div>
            ) : null}

            <div className='grid gap-1.5'>
              <Label htmlFor='stage-inspector-failure'>阶段遇错策略</Label>
              <Select
                value={selectedStage.failurePolicy}
                disabled={!canWrite}
                onValueChange={(val) => {
                  if (onUpdateStage) {
                    onUpdateStage((s) => ({ ...s, failurePolicy: val as 'continue' | 'stop' }))
                  }
                }}
              >
                <SelectTrigger id='stage-inspector-failure' className='h-8 text-label'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='continue'>失败后继续推进后续成员</SelectItem>
                  <SelectItem value='stop'>遇错即停并熔断本阶段</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  // ==========================================
  // LEVEL 1: Global Suite Inspector (Default)
  // ==========================================
  const sharedInputCount = Object.keys(document.sharedInput ?? {}).length

  return (
    <div className='flex flex-col gap-4 animate-in fade-in-50 duration-200'>
      {/* 1. Basic Info Card */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
        <div className='flex items-center gap-2'>
          <h3 className='text-title font-semibold'>基本信息</h3>
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='suite-detail-name'>名称</Label>
          <Input
            id='suite-detail-name'
            value={name ?? ''}
            disabled={!canWrite}
            placeholder='输入场景集名称'
            className='h-8 text-body'
            onChange={(e) => onUpdateName(e.target.value)}
          />
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='suite-detail-desc'>说明</Label>
          <Textarea
            id='suite-detail-desc'
            value={description ?? ''}
            rows={2}
            disabled={!canWrite}
            placeholder='说明此场景集的用途与执行目标（可选）'
            className='text-body'
            onChange={(e) => onUpdateDescription(e.target.value)}
          />
        </div>
      </Card>

      {/* 2. Execution and Concurrency Policy Card */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Sliders className='size-4 text-muted-foreground' />
            <h3 className='text-title font-semibold'>
              {isStageMode ? '流水线执行与配额策略' : '执行与并发策略'}
            </h3>
          </div>
          <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
            {isStageMode
              ? `配额上限 (${document.maxConcurrency ?? 3})`
              : document.executionMode === 'sequential'
                ? '严格串行'
                : `受控并发 (${document.maxConcurrency ?? 3})`}
          </Badge>
        </div>

        {isStageMode ? (
          <div className='rounded-lg border border-border-divider/70 bg-muted/40 p-2.5 text-label space-y-1.5'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-foreground text-label'>阶段流水线编排已生效</span>
              <span className='text-3xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded'>各阶段独立配置</span>
            </div>
            <p className='text-muted-foreground text-3xs leading-relaxed'>
              各阶段按顺序依赖执行。阶段内部的并发数与失败策略由各阶段独立控制；此处配置整条流水线的全局 Worker 资源池上限与全局兜底策略。
            </p>
          </div>
        ) : null}

        <div className='grid gap-3'>
          {isStageMode ? (
            <div className='grid gap-1.5'>
              <Label htmlFor='suite-execution-mode'>流水线流转模式</Label>
              <div className='flex items-center justify-between h-8 px-3 rounded-md border border-border-divider bg-muted/30 text-label text-muted-foreground'>
                <span>阶段间依赖串行 · 阶段内策略独立</span>
                <Badge variant='secondary' className='text-3xs font-normal'>Stage 驱动</Badge>
              </div>
            </div>
          ) : (
            <div className='grid gap-1.5'>
              <Label htmlFor='suite-execution-mode'>执行模式</Label>
              <Select
                value={document.executionMode ?? 'parallel'}
                disabled={!canWrite}
                onValueChange={(value) =>
                  onUpdateDocument((doc) => ({
                    ...doc,
                    executionMode: value as SuiteDocument['executionMode'],
                  }))
                }
              >
                <SelectTrigger id='suite-execution-mode' aria-label='执行模式' className='h-8 text-label'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='parallel'>受控并发 (Worker 池)</SelectItem>
                  <SelectItem value='sequential'>严格串行 (单活)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-max-concurrency'>
              {isStageMode ? '全局 Worker 配额上限 (1–10)' : '最大并发数 (1–10)'}
            </Label>
            <Input
              id='suite-max-concurrency'
              aria-label='最大并发数 (1–10)'
              type='number'
              min={1}
              max={10}
              value={document.maxConcurrency ?? 3}
              disabled={!canWrite || (!isStageMode && document.executionMode === 'sequential')}
              className='h-8 text-label'
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!Number.isNaN(val)) {
                  onUpdateDocument((doc) => ({
                    ...doc,
                    maxConcurrency: Math.max(1, Math.min(10, val)),
                  }))
                }
              }}
            />
            {isStageMode ? (
              <span className='text-3xs text-muted-foreground'>
                控制场景集任意时刻分配的 Worker 最大数量。各阶段设置的并发数均以此上限为封顶阈值。
              </span>
            ) : null}
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-failure-policy'>
              {isStageMode ? '流水线全局熔断策略' : '失败策略'}
            </Label>
            <Select
              value={document.failurePolicy}
              disabled={!canWrite}
              onValueChange={(value) =>
                onUpdateDocument((doc) => ({
                  ...doc,
                  failurePolicy: value as SuiteDocument['failurePolicy'],
                }))
              }
            >
              <SelectTrigger id='suite-failure-policy' aria-label='失败策略' className='h-8 text-label'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='continue'>
                  {isStageMode ? '阶段自主决策 (允许阶段内配置遇错即停或继续)' : '失败后继续'}
                </SelectItem>
                <SelectItem value='stop'>
                  {isStageMode ? '全局快速熔断 (任一阶段失败立即停止整条流水线)' : '失败后停止后续'}
                </SelectItem>
              </SelectContent>
            </Select>
            {isStageMode ? (
              <span className='text-3xs text-muted-foreground'>
                若设为全局快速熔断，任一阶段异常将立即阻断后续执行；若设为阶段自主决策，则按各阶段自身的失败策略推进。
              </span>
            ) : null}
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-default-target-account'>默认目标账号</Label>
            <Select
              value={document.defaultTargetAccountId ?? '__none__'}
              disabled={!canWrite}
              onValueChange={(value) =>
                onUpdateDocument((doc) => ({
                  ...doc,
                  defaultTargetAccountId: value === '__none__' ? undefined : value,
                }))
              }
            >
              <SelectTrigger id='suite-default-target-account' aria-label='默认目标账号' className='h-8 text-label'>
                <SelectValue placeholder='目标默认账号' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>目标默认账号</SelectItem>
                {targetAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {accountOptionLabel(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className='text-label text-muted-foreground'>
          {isStageMode
            ? '受管账号独占策略下，若多个阶段或成员指定同一目标账号，调度器将自适应排队互斥，避免登录与会话冲突。'
            : '并发模式下最多同时放行指定数量的成员。受管账号独占策略下，若多个成员指定同一账号，调度器将自适应排队互斥，避免登录冲突。'}
        </p>
      </Card>

      {/* 3. Shared Inputs Card (Collapsible) */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div
          className='flex items-center justify-between cursor-pointer select-none'
          onClick={() => setSharedParamsOpen(!sharedParamsOpen)}
        >
          <div className='flex items-center gap-2'>
            <Variable className='size-4 text-muted-foreground' />
            <h2 className='text-title font-semibold'>全局公共参数 (Shared Input)</h2>
          </div>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              {sharedInputCount > 0 ? `已配置 ${sharedInputCount} 项` : '无公共参数'}
            </Badge>
            <Button variant='ghost' size='icon' className='size-6 text-muted-foreground'>
              {sharedParamsOpen ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
            </Button>
          </div>
        </div>

        {sharedParamsOpen ? (
          <div className='space-y-3 pt-1'>
            <p className='text-label text-muted-foreground'>
              发布并执行整集时，所有成员均可引用的公共输入键值。若成员未做单独覆盖，将以全局参数为准。
            </p>
            <KeyValueEditor
              value={document.sharedInput ?? {}}
              onChange={(sharedInput) =>
                onUpdateDocument((doc) => ({ ...doc, sharedInput }))
              }
              disabled={!canWrite}
              placeholderKey='公共参数名 (如 region / tenantId)'
              placeholderValue='公共参数值 (如 cn-north-1 / 1001)'
            />
          </div>
        ) : null}
      </Card>

      {/* 4. Consolidated Report Card (Collapsible) */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div
          className='flex items-center justify-between cursor-pointer select-none'
          onClick={() => setReportsOpen(!reportsOpen)}
        >
          <div className='flex items-center gap-2'>
            <FileText className='size-4 text-muted-foreground' />
            <h2 className='text-title font-semibold'>集合报告</h2>
          </div>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              {document.reportProfileId ? '已绑定模板' : '系统默认'}
            </Badge>
            <Button variant='ghost' size='icon' className='size-6 text-muted-foreground'>
              {reportsOpen ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
            </Button>
          </div>
        </div>

        {reportsOpen ? (
          <div className='space-y-3 pt-1'>
            <ReportProfileSelect
              targetId={targetId}
              source='SUITE_RUN'
              value={document.reportProfileId}
              disabled={!canWrite}
              onChange={(reportProfileId) =>
                onUpdateDocument((doc) => ({ ...doc, reportProfileId }))
              }
            />

            <div className='space-y-3 rounded-md border border-border-default/60 p-3 bg-muted/20'>
              <label className='flex items-start gap-2 text-body cursor-pointer'>
                <input
                  type='checkbox'
                  disabled={!canWrite || !canExport}
                  checked={document.outputPolicy?.autoGenerateReport ?? document.autoGenerateFinalReport}
                  className='mt-1'
                  onChange={(event) =>
                    onUpdateDocument((doc) => ({
                      ...doc,
                      autoGenerateFinalReport: event.target.checked,
                      outputPolicy: {
                        ...doc.outputPolicy,
                        autoGenerateReport: event.target.checked,
                        memberReportPolicy: doc.outputPolicy?.memberReportPolicy ?? 'inherit',
                        aiSummaryPolicy: doc.outputPolicy?.aiSummaryPolicy ?? 'inherit',
                      },
                    }))
                  }
                />
                <div>
                  <div className='font-medium text-foreground'>自动生成集合总报告</div>
                  <div className='text-small text-muted-foreground'>
                    场景集全部成员运行完成并结算证据后，自动触发生成集合总报告与 Word / PDF。
                  </div>
                  {!canExport && canWrite ? (
                    <div className='text-small text-status-warning-foreground mt-1'>
                      开启自动生成报告需要导出权限 (report:export)
                    </div>
                  ) : null}
                </div>
              </label>

              {(document.outputPolicy?.autoGenerateReport ?? document.autoGenerateFinalReport) ? (
                <label className='flex items-start gap-2 text-body cursor-pointer pt-2 border-t border-border-default/40'>
                  <input
                    type='checkbox'
                    disabled={!canWrite}
                    checked={document.outputPolicy?.memberReportPolicy === 'suppress'}
                    className='mt-1'
                    onChange={(event) =>
                      onUpdateDocument((doc) => ({
                        ...doc,
                        outputPolicy: {
                          ...doc.outputPolicy,
                          autoGenerateReport: true,
                          memberReportPolicy: event.target.checked ? 'suppress' : 'inherit',
                          aiSummaryPolicy: doc.outputPolicy?.aiSummaryPolicy ?? 'inherit',
                        },
                      }))
                    }
                  />
                  <div>
                    <div className='font-medium text-foreground'>抑制成员单场景报告</div>
                    <div className='text-small text-muted-foreground'>
                      仅生成集合总报告，强制抑制子场景单报告导出，防止大集合并发耗尽 Worker 资源。
                    </div>
                  </div>
                </label>
              ) : null}
            </div>

            <p className='text-label text-muted-foreground'>
              配置随新运行冻结。生成失败单独记录，可从运行详情重试报告。
            </p>
            <ReportProfileEditor targetId={targetId} editScope='suite' />
          </div>
        ) : null}
      </Card>
    </div>
  )
}
