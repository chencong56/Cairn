import { useState } from 'react'
import { newUuid } from '@/lib/uuid'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { assistantRecordingSelectionError, authoringNodeId, describePageRequestRule, expectKindLabel, normalizeAuthoringDocument, type AssistantRecordingProposalResult, type ConfirmRecordingOutcomeResult, type OutcomeRule, type RecordingInsertAnchor, type RecordingPreviewResult, type TargetDescriptor } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchScenario, fetchScenarios } from '@/lib/scenarios-api'
import { adoptRecordingProposal, confirmRecordingOutcome, fetchRecordingAdoptions, previewRecordingProposal, revertRecordingAdoption, selectRecordingProposal } from '@/lib/assistant-api'
import { stepTypeLabel } from '@/features/authoring/labels'

export function RecordingAdoptionReceipts({ recordingId, familyId, go }: { recordingId: string; familyId?: string; go: (href: string) => void }) {
  const client = useQueryClient()
  const receipts = useQuery({ queryKey: ['recording-adoptions', recordingId], queryFn: () => fetchRecordingAdoptions(recordingId) })
  const revert = useMutation({ mutationFn: (id: string) => revertRecordingAdoption(recordingId, id), onSuccess: () => { void client.invalidateQueries({ queryKey: ['recording-adoptions', recordingId] }); void client.invalidateQueries({ queryKey: ['scenarios'] }) } })
  const items = receipts.data?.filter((r) => !familyId || r.proposalFamilyId === familyId) ?? []
  return <div className='space-y-2'>
    {receipts.error ? <p role='alert' className='text-small text-destructive'>采纳回执读取失败，请刷新后重试。</p> : null}
    {items.map((receipt) => <div key={receipt.id} className='space-y-2 rounded-md border border-border-default p-3'>
      <p className='text-small font-medium'>{receipt.status === 'applied' ? '已写入场景草稿' : '已撤销采纳'}</p>
      <p className='text-caption text-text-muted'>{new Date(receipt.createdAt).toLocaleString()} · {receipt.proposalSummary}</p>
      <p className='text-caption text-text-muted'>撤销仅恢复采纳前的草稿内容；新建场景会保留为空草稿。后续已有编辑或发布时无法自动撤销。</p>
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' variant='outline' onClick={() => go(`/scenarios/${receipt.scenarioId}`)}>查看场景草稿</Button>
        {receipt.status === 'applied' ? <Button size='sm' variant='outline' disabled={revert.isPending} onClick={() => revert.mutate(receipt.id)}>撤销本次采纳</Button> : null}
      </div>
    </div>)}
    {revert.error ? <p role='alert' className='text-small text-destructive'>{revert.error.message}</p> : null}
  </div>
}

type RecordingProposalProps = { result: AssistantRecordingProposalResult; conversationId: string; turnId: string; go: (href: string) => void }

function locatorText(target: TargetDescriptor) {
  const labels = { role: '角色', label: '标签', text: '文字', title: '标题', testId: '测试标记', css: 'CSS' }
  return target.candidates.map((candidate) => `${labels[candidate.by]}：${candidate.value}${candidate.name ? `（${candidate.name}）` : ''}`).join(' → ')
}

function outcomeRuleText(rule: OutcomeRule): string {
  const operators = { eq: '等于', neq: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于' }
  if (rule.kind === 'ai') return `AI 核对：${rule.instruction}`
  if (rule.kind === 'page_request') return `页面请求：${describePageRequestRule(rule)}`
  if (rule.kind === 'step_duration' || rule.kind === 'run_duration') return `${rule.kind === 'step_duration' ? '步骤' : '场景'}耗时${operators[rule.op]} ${rule.valueMs} 毫秒`
  if (rule.kind === 'context') return `运行数据 ${rule.key}${rule.field ? `.${rule.field}` : ''}：${rule.expect.kind === 'non_empty' ? '非空' : rule.expect.kind === 'number_compare' ? `${operators[rule.expect.op]} ${rule.expect.value}` : rule.expect.kind === 'text_contains' ? `包含「${rule.expect.value}」` : `已记录的检查：${JSON.stringify(rule.expect)}`}`
  const expect = rule.expect
  const value = expect.kind === 'number_compare' ? `${operators[expect.op]} ${expect.value}` : expect.kind === 'aria_snapshot' ? `\n${expect.template}` : 'value' in expect ? `「${expect.value}」` : ''
  const tolerance = rule.tolerance ? [rule.tolerance.numberDelta === undefined ? '' : `数值容差 ${rule.tolerance.numberDelta}`, rule.tolerance.percentDelta === undefined ? '' : `百分比容差 ${rule.tolerance.percentDelta}`, rule.tolerance.windowMs === undefined ? '' : `时间窗口 ${rule.tolerance.windowMs} 毫秒`].filter(Boolean).join('，') : ''
  return `沿用录制规则：${expectKindLabel(expect.kind)}${value}${rule.target ? `；${locatorText(rule.target)}` : ''}${tolerance ? `；${tolerance}` : ''}`
}

function RecordingOutcomeConfirmation({ result, conversationId, turnId, onConfirmed }: RecordingProposalProps & { onConfirmed: (result: ConfirmRecordingOutcomeResult) => void }) {
  const actions = result.decisions.filter((item) => item.action === 'keep')
  const [mode, setMode] = useState('custom')
  const [afterItemId, setAfterItemId] = useState('')
  const [expectedOutcome, setExpectedOutcome] = useState('')
  const recorded = result.outcomeOptions?.find((option) => option.itemId === mode)
  const confirm = useMutation({ mutationFn: () => confirmRecordingOutcome(conversationId, turnId, {
    proposalDigest: result.candidateDigest!, outcome: recorded ? { kind: 'recorded', itemId: recorded.itemId }
      : { kind: 'custom', afterItemId, expectedOutcome: expectedOutcome.trim() },
  }), onSuccess: onConfirmed })
  return <div className='space-y-3 rounded-xl border border-border-default bg-surface-card p-3.5' data-testid='recording-outcome-confirmation'>
    <p className='text-small font-medium'>{result.proposalSummary}</p>
    <p className='text-caption text-text-muted'>录制动作不能证明业务成功。确认后会生成一份新提案，供你检查、选择和预览。</p>
    <fieldset disabled={confirm.isPending} className='min-w-0 space-y-3'>
      {(result.outcomeOptions?.length ?? 0) > 0 ? <label className='block space-y-1 text-small'>预期来源
        <Select value={mode} onValueChange={(value) => { setMode(value); confirm.reset() }}><SelectTrigger className='w-full' aria-label='预期来源'><SelectValue className='min-w-0 truncate' /></SelectTrigger><SelectContent className='w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width)'>
          <SelectItem value='custom'>填写业务预期</SelectItem>
          {result.outcomeOptions?.map((option) => <SelectItem key={option.itemId} value={option.itemId}>录制中已有：{option.meaning}</SelectItem>)}
        </SelectContent></Select>
      </label> : null}
      {recorded ? <div className='space-y-1 rounded-md bg-surface-subtle p-2 text-small'>
        <p>在「{actions.find((item) => item.itemId === recorded.afterItemId)?.label}」之后检查：{recorded.meaning}</p>
        <p className='whitespace-pre-wrap break-words text-caption text-text-muted'>{outcomeRuleText(recorded.rule)}</p>
      </div> : <>
        <label className='block space-y-1 text-small'>在哪个动作之后检查
          <Select value={afterItemId} onValueChange={(value) => { setAfterItemId(value); confirm.reset() }}><SelectTrigger className='w-full' aria-label='检查位置'><SelectValue className='min-w-0 truncate' placeholder='选择录制动作' /></SelectTrigger><SelectContent className='w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width)'>
            {actions.map((item, index) => <SelectItem key={item.itemId} value={item.itemId}>第 {index + 1} 项 · {item.label}</SelectItem>)}
          </SelectContent></Select>
        </label>
        <label className='block space-y-1 text-small'>应该看到什么结果
          <Textarea value={expectedOutcome} onChange={(event) => { setExpectedOutcome(event.target.value); confirm.reset() }} maxLength={512} placeholder='例如：页面出现“保存成功”，列表中显示刚新增的记录。' />
        </label>
        <p className='text-caption text-text-muted'>将用 AI 核对你填写的页面预期；请填写可观察的结果。提案中会标明这是用户补充的要求。</p>
      </>}
    </fieldset>
    <Button size='sm' disabled={confirm.isPending || !actions.length || (!recorded && (!afterItemId || expectedOutcome.trim().length < 3))} onClick={() => confirm.mutate()}>{confirm.isPending ? '正在生成…' : '确认预期并生成提案'}</Button>
    {!actions.length ? <p className='text-small text-text-muted'>没有可导入的动作，请先处理录制中的待处理项。</p> : null}
    {confirm.error ? <p role='alert' className='text-small text-destructive'>{confirm.error.message}</p> : null}
  </div>
}

export function RecordingProposal(props: RecordingProposalProps) {
  const client = useQueryClient()
  const confirmationKey = ['recording-outcome-confirmation', props.conversationId, props.turnId]
  const [confirmed, setConfirmed] = useState(() => client.getQueryData<ConfirmRecordingOutcomeResult>(confirmationKey))
  const receipts = useQuery({ queryKey: ['recording-adoptions', props.result.recordingId], queryFn: () => fetchRecordingAdoptions(props.result.recordingId) })
  if (props.result.needsOutcomeConfirmation && !confirmed) {
    if (receipts.data?.some((receipt) => receipt.proposalFamilyId === props.result.proposalFamilyId)) return <RecordingAdoptionReceipts recordingId={props.result.recordingId} familyId={props.result.proposalFamilyId} go={props.go} />
    return <RecordingOutcomeConfirmation {...props} onConfirmed={(value) => { client.setQueryData(confirmationKey, value); setConfirmed(value) }} />
  }
  return <RecordingProposalContent {...props} key={confirmed?.turnId ?? props.turnId} result={confirmed?.proposal ?? props.result} turnId={confirmed?.turnId ?? props.turnId} />
}

function RecordingProposalContent({ result, conversationId, turnId, go }: RecordingProposalProps) {
  const client = useQueryClient()
  const [selected, setSelected] = useState(() => result.decisions.filter((d) => d.action !== 'exclude').map((d) => d.itemId))
  const [destinationId, setDestinationId] = useState('new')
  const [name, setName] = useState('录制整理草稿')
  const [anchor, setAnchor] = useState('end')
  const [preview, setPreview] = useState<{ value: RecordingPreviewResult; turnId: string; proposalDigest: string; key: string }>()
  const scenarios = useQuery({ queryKey: ['scenarios', 'assistant-recording', result.targetId], queryFn: () => fetchScenarios({ targetId: result.targetId, limit: 100 }) })
  const scenario = useQuery({ queryKey: ['scenario', destinationId], queryFn: () => fetchScenario(destinationId), enabled: destinationId !== 'new' })
  const receipts = useQuery({ queryKey: ['recording-adoptions', result.recordingId], queryFn: () => fetchRecordingAdoptions(result.recordingId) })
  const adopted = receipts.data?.some((r) => r.proposalFamilyId === result.proposalFamilyId)
  const insertAnchor: RecordingInsertAnchor | undefined = anchor === 'end' ? undefined : anchor === 'start' ? { kind: 'start' } : { kind: 'after', stepId: anchor }
  const destinationScenarioId = destinationId === 'new' ? undefined : destinationId
  const previewMutation = useMutation({ mutationFn: async () => {
    setPreview(undefined)
    const selection = await selectRecordingProposal(conversationId, turnId, { proposalDigest: result.candidateDigest!, selectedItemIds: selected })
    const value = await previewRecordingProposal(conversationId, selection.turnId, { destinationScenarioId, insertAnchor: insertAnchor ? JSON.stringify(insertAnchor) : undefined })
    return { value, turnId: selection.turnId, proposalDigest: selection.proposalDigest, key: newUuid() }
  }, onSuccess: setPreview })
  const adoption = useMutation({ mutationFn: async () => {
    if (!preview) throw new Error('请先预览')
    return adoptRecordingProposal(conversationId, preview.turnId, { proposalDigest: preview.proposalDigest, candidateDigest: preview.value.candidateDigest,
      idempotencyKey: preview.key, destinationScenarioId, newScenarioName: destinationScenarioId ? undefined : name.trim(), insertAnchor,
      expectedRevision: preview.value.baseRevision, expectedDigest: preview.value.baseDigest })
  }, onSuccess: () => { setPreview(undefined); void client.invalidateQueries({ queryKey: ['recording-adoptions', result.recordingId] }); void client.invalidateQueries({ queryKey: ['scenarios'] }) } })
  const busy = previewMutation.isPending || adoption.isPending
  const nodes = scenario.data?.draft ? normalizeAuthoringDocument(scenario.data.draft.document).nodes : []
  const blocked = preview?.value.diagnostics.some((d) => d.severity === 'error')
  const selectionError = assistantRecordingSelectionError(result.decisions, selected)
  return <div className='space-y-3 rounded-xl border border-border-default bg-surface-card p-3.5' data-testid='recording-proposal-card'>
    <p className='text-small font-medium'>{result.proposalSummary}</p>
    <p className='text-caption text-text-muted'>采纳会保存草稿。可以打开场景检查、编辑，再自行发布或运行。</p>
    {!adopted ? <>
      <fieldset disabled={busy} className='min-w-0 space-y-2'>
        <legend className='mb-2 text-small font-medium'>选择导入内容（已选 {selected.length} 项）</legend>
        {result.decisions.map((item, index) => <label key={item.itemId} className='flex items-start gap-2 rounded-md bg-surface-subtle p-2 text-small'>
          <Checkbox aria-label={`导入第 ${index + 1} 项`} checked={selected.includes(item.itemId)} disabled={item.action === 'exclude' || busy} onCheckedChange={(checked) => { setSelected((ids) => checked ? [...ids, item.itemId] : ids.filter((id) => id !== item.itemId)); setPreview(undefined) }} />
          <span className='min-w-0 break-words'>{item.label ?? `录制动作 ${index + 1}`}<span className='block text-caption text-text-muted'>{item.reason}</span>
            {item.change?.kind === 'locator' ? <span className='mt-1 block space-y-1 text-caption'>
              <span className='block'>修改前：{locatorText(item.change.before)}</span><span className='block'>修改后：{locatorText(item.change.after)}</span>
              <span className='block text-text-muted'>来源：本录制「{result.decisions.find((source) => source.itemId === item.change?.sourceItemId)?.label}」的定位观察</span>
            </span> : item.change?.kind === 'outcome' ? <span className='mt-1 block space-y-1 text-caption'><span className='block whitespace-pre-wrap'>{outcomeRuleText(item.change.rule)}</span><span className='block'>预期来源：{item.change.recordedItemId ? '用户确认的录制断言' : '用户补充并确认'} · 必须满足，失败时停止</span></span> : null}
          </span>
        </label>)}
        <label className='block space-y-1 text-small'>目标场景
          <Select value={destinationId} onValueChange={(value) => { setDestinationId(value); setAnchor('end'); setPreview(undefined) }} disabled={busy}>
            <SelectTrigger className='w-full' aria-label='目标场景'><SelectValue className='min-w-0 truncate' /></SelectTrigger><SelectContent className='w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width)'>
              <SelectItem value='new'>新建场景草稿</SelectItem>
              {scenarios.data?.items.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {destinationId === 'new' ? <label className='block space-y-1 text-small'>草稿名称<Input value={name} maxLength={128} onChange={(e) => { setName(e.target.value); setPreview(undefined) }} /></label> : <label className='block space-y-1 text-small'>插入位置
          <Select value={anchor} onValueChange={(value) => { setAnchor(value); setPreview(undefined) }} disabled={busy || scenario.isPending}>
            <SelectTrigger className='w-full' aria-label='插入位置'><SelectValue className='min-w-0 truncate' /></SelectTrigger><SelectContent className='w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width)'>
              <SelectItem value='end'>场景末尾</SelectItem><SelectItem value='start'>场景开头</SelectItem>
              {nodes.map((node, index) => <SelectItem key={authoringNodeId(node)} value={authoringNodeId(node)}>第 {index + 1} 项之后 · {node.kind === 'step' ? node.step.name : node.kind === 'module' ? node.name : node.name ?? '控制块'}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>}
      </fieldset>
      {scenarios.error || scenario.error ? <p role='alert' className='text-small text-destructive'>场景读取失败，请重试。</p> : null}
      {result.missingConfirmations.map((text) => <p key={text} className='text-caption text-text-muted'>{text}</p>)}
      {selectionError ? <p role='alert' className='text-small text-destructive'>{selectionError}</p> : null}
      <Button size='sm' variant='outline' disabled={busy || Boolean(selectionError) || !result.applicable || !result.candidateDigest || (destinationId === 'new' && !name.trim())} onClick={() => previewMutation.mutate()}>{previewMutation.isPending ? '正在预览…' : '预览所选内容'}</Button>
      {preview ? <div className='space-y-2 rounded-md border border-border-default p-3'>
        <p className='text-small font-medium'>{preview.value.changesSummary}</p>
        <ol className='list-inside list-decimal space-y-1 text-small'>{preview.value.proposedSteps.map((step, i) => <li key={i}>{step.name} · {stepTypeLabel(step.type)}</li>)}</ol>
        {preview.value.proposedChanges?.map((change, index) => <div key={index} className='text-small'><p className='font-medium'>{change.label}</p><p className='text-caption text-text-muted'>{change.detail}</p></div>)}
        {preview.value.diagnostics.map((d, i) => <p key={i} className='text-small text-text-muted'>{String(d.message ?? '需要检查配置')}</p>)}
        <Button size='sm' disabled={busy || blocked || !preview.value.proposedStepCount} onClick={() => adoption.mutate()}>{adoption.isPending ? '正在写入…' : '确认采纳到草稿'}</Button>
      </div> : null}
      {previewMutation.error || adoption.error ? <p role='alert' className='text-small text-destructive'>{(previewMutation.error ?? adoption.error)?.message}</p> : null}
    </> : null}
    <RecordingAdoptionReceipts recordingId={result.recordingId} familyId={result.proposalFamilyId} go={go} />
  </div>
}
