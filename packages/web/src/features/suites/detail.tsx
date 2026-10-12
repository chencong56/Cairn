import { useEffect, useMemo, useState, useCallback } from 'react'
import { newUuid } from '@/lib/uuid'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  EMPTY_SUITE_DOCUMENT,
  canExecuteRun,
  hasPermission,
  allSuiteMembers,
  type ScenarioDto,
  type SuiteDocument,
  type SuiteMember,
  type SuiteStage,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createSuiteRun,
  previewSuiteRun,
  publishSuite,
  saveSuiteDraft,
  updateSuiteEnabled,
  validateSuite,
  fetchSuite,
} from '@/lib/suites-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Main } from '@/components/layout/main'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { suiteIssueMessage } from './labels'
import { MemberInputDialog } from './member-input-dialog'
import { SuiteHeader } from './components/suite-header'
import { PipelineWorkspace } from './components/pipeline-workspace'
import { SuiteInspector } from './components/suite-inspector'

function allocateMemberId(used: Set<string>) {
  let index = used.size + 1
  while (used.has(`m${index}`)) index += 1
  const id = `m${index}`
  used.add(id)
  return id
}

const SUITE_SCENARIO_PAGE_LIMIT = 100
const SUITE_SCENARIO_MAX_PAGES = 10

async function fetchActiveScenariosForSuite(targetId: string): Promise<{ items: ScenarioDto[] }> {
  const items: ScenarioDto[] = []
  let cursor: string | undefined
  for (let page = 0; page < SUITE_SCENARIO_MAX_PAGES; page += 1) {
    const result = await fetchScenarios({
      targetId,
      status: 'active',
      limit: SUITE_SCENARIO_PAGE_LIMIT,
      cursor,
    })
    items.push(...result.items)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return { items }
}

function buildSuiteMembers(
  scenarioIds: string[],
  catalog: ScenarioDto[] | undefined,
  existing: SuiteMember[],
  startOrdinal: number,
): SuiteMember[] {
  const used = new Set(existing.map((item) => item.memberId))
  const created: SuiteMember[] = []
  let ordinal = startOrdinal
  for (const scenarioId of scenarioIds) {
    const scenario = catalog?.find((item) => item.id === scenarioId)
    if (!scenario?.latestVersionId) continue
    created.push({
      memberId: allocateMemberId(used),
      ordinal,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      displayName: undefined,
      input: {},
    })
    ordinal += 1
  }
  return created
}

function newIdempotencyKey() {
  return `suite-${newUuid()}`
}

const EMPTY_PERMISSIONS: string[] = []

export type SelectedEntity =
  | { type: 'suite' }
  | { type: 'stage'; stageIndex: number }
  | { type: 'member'; memberId: string; stageIndex?: number }

export function SuiteDetailPage() {
  const { suiteId } = useParams({ from: '/_authenticated/suites/$suiteId/' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canWrite = useCan('suite:write')
  const permissions = useAuthStore((state) => state.auth.user?.permissions ?? EMPTY_PERMISSIONS)
  const canExecute = canExecuteRun(permissions) && hasPermission(permissions, 'suite:read')
  const query = useQuery({ queryKey: ['suite', suiteId], queryFn: () => fetchSuite(suiteId) })
  const target = useQuery({
    queryKey: ['target', query.data?.targetId],
    queryFn: () => fetchTarget(query.data!.targetId),
    enabled: Boolean(query.data?.targetId),
  })
  const scenarios = useQuery({
    queryKey: ['scenarios', { targetId: query.data?.targetId, scope: 'suite-picker' }],
    queryFn: () => fetchActiveScenariosForSuite(query.data!.targetId),
    enabled: Boolean(query.data?.targetId),
  })
  const targetAccounts = useQuery({
    queryKey: ['target-accounts', query.data?.targetId],
    queryFn: () => fetchTargetAccounts(query.data!.targetId, { limit: 100 }),
    enabled: Boolean(query.data?.targetId),
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [document, setDocument] = useState<SuiteDocument>(EMPTY_SUITE_DOCUMENT)
  const [editingMember, setEditingMember] = useState<SuiteMember | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>({ type: 'suite' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!query.data) return
    setName(query.data.name)
    setDescription(query.data.description ?? '')
    setDocument(query.data.draft.document)
  }, [query.data])

  const scenarioNames = useMemo(
    () => new Map((scenarios.data?.items ?? []).map((item) => [item.id, item.name])),
    [scenarios.data],
  )

  const isDirty = useMemo(() => {
    if (!query.data) return false
    if (name !== query.data.name) return true
    if ((description || null) !== (query.data.description || null)) return true
    return JSON.stringify(document) !== JSON.stringify(query.data.draft.document)
  }, [name, description, document, query.data])

  const save = useCallback(async () => {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      await queryClient.setQueryData(['suite', suiteId], saved)
      toast.success('草稿已保存')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }, [query.data, suiteId, name, description, document, queryClient])

  // Desktop keyboard shortcuts: Cmd+S to save draft, Esc to deselect to suite
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape') {
        setSelectedEntity({ type: 'suite' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [save])

  async function publish() {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      const checked = await validateSuite(suiteId)
      if (!checked.ok) {
        const blockingIssue = checked.issues.find((item) => item.severity === 'error')
        toast.error(blockingIssue ? suiteIssueMessage(blockingIssue) : '校验未通过')
        await queryClient.setQueryData(['suite', suiteId], saved)
        return
      }
      const published = await publishSuite(suiteId, {
        expectedRevision: saved.draft.revision,
        idempotencyKey: newIdempotencyKey(),
      })
      await queryClient.setQueryData(['suite', suiteId], published)
      toast.success(`已发布 v${published.published?.versionNo ?? ''}`)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
    } finally {
      setBusy(false)
    }
  }

  async function startRun() {
    if (!query.data?.published) {
      toast.error('发布后才能启动')
      return
    }
    setBusy(true)
    try {
      const preview = await previewSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      const blocking = preview.issues.filter((item) => item.severity === 'error')
      if (blocking.length) {
        toast.error(suiteIssueMessage(blocking[0]!))
        return
      }
      const created = await createSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      toast.success('已启动场景集运行')
      void navigate({ to: '/suite-runs/$suiteRunId', params: { suiteRunId: created.observation.id } })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '启动失败')
    } finally {
      setBusy(false)
    }
  }

  const isStageMode = Boolean(document.stages && document.stages.length > 0)

  // Find currently selected member and stage for the Inspector
  const selectedMember = useMemo(() => {
    if (selectedEntity.type !== 'member') return null
    if (isStageMode && document.stages) {
      for (const stage of document.stages) {
        const found = stage.members.find((m) => m.memberId === selectedEntity.memberId)
        if (found) return found
      }
    }
    return document.members.find((m) => m.memberId === selectedEntity.memberId) ?? null
  }, [selectedEntity, isStageMode, document])

  const selectedStage = useMemo(() => {
    if (selectedEntity.type !== 'stage' || !document.stages) return null
    return document.stages[selectedEntity.stageIndex] ?? null
  }, [selectedEntity, document.stages])

  // Flat mode member handlers
  function addMembersFlat(scenarioIds: string[]) {
    const created = buildSuiteMembers(
      scenarioIds,
      scenarios.data?.items,
      allSuiteMembers(document),
      document.members.length,
    )
    if (created.length === 0) return
    setDocument({ ...document, members: [...document.members, ...created] })
    setSelectedEntity({ type: 'member', memberId: created[0]!.memberId })
  }

  function addMemberFlat(scenarioId: string) {
    addMembersFlat([scenarioId])
  }

  function moveMemberFlat(index: number, delta: number) {
    const next = [...document.members]
    const targetIdx = index + delta
    if (targetIdx < 0 || targetIdx >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(targetIdx, 0, item!)
    setDocument({ ...document, members: next.map((member, ordinal) => ({ ...member, ordinal })) })
  }

  function removeMemberFlat(index: number) {
    const removing = document.members[index]
    if (selectedEntity.type === 'member' && selectedEntity.memberId === removing?.memberId) {
      setSelectedEntity({ type: 'suite' })
    }
    setDocument({
      ...document,
      members: document.members
        .filter((_, idx) => idx !== index)
        .map((item, ordinal) => ({ ...item, ordinal })),
    })
  }

  function updateMemberFlat(index: number, updater: (m: SuiteMember) => SuiteMember) {
    setDocument({
      ...document,
      members: document.members.map((item, idx) => (idx === index ? updater(item) : item)),
    })
  }

  // Stage mode handlers
  function addMembersToStage(stageIndex: number, scenarioIds: string[]) {
    if (!document.stages) return
    const stage = document.stages[stageIndex]
    if (!stage) return
    const created = buildSuiteMembers(
      scenarioIds,
      scenarios.data?.items,
      allSuiteMembers(document),
      stage.members.length,
    )
    if (created.length === 0) return
    const nextStages = document.stages.map((item, idx) =>
      idx === stageIndex ? { ...item, members: [...item.members, ...created] } : item,
    )
    setDocument({ ...document, stages: nextStages })
    setSelectedEntity({ type: 'member', memberId: created[0]!.memberId, stageIndex })
  }

  function addMemberToStage(stageIndex: number, scenarioId: string) {
    addMembersToStage(stageIndex, [scenarioId])
  }

  function moveMemberInStage(stageIndex: number, memberIndex: number, delta: number) {
    if (!document.stages) return
    const stage = document.stages[stageIndex]
    if (!stage) return
    const nextMembers = [...stage.members]
    const targetIdx = memberIndex + delta
    if (targetIdx < 0 || targetIdx >= nextMembers.length) return
    const [item] = nextMembers.splice(memberIndex, 1)
    nextMembers.splice(targetIdx, 0, item!)
    const nextStages = document.stages.map((s, idx) =>
      idx === stageIndex
        ? { ...s, members: nextMembers.map((m, ordinal) => ({ ...m, ordinal })) }
        : s,
    )
    setDocument({ ...document, stages: nextStages })
  }

  function removeMemberFromStage(stageIndex: number, memberIndex: number) {
    if (!document.stages) return
    const stage = document.stages[stageIndex]
    if (!stage) return
    const removing = stage.members[memberIndex]
    if (selectedEntity.type === 'member' && selectedEntity.memberId === removing?.memberId) {
      setSelectedEntity({ type: 'stage', stageIndex })
    }
    const nextMembers = stage.members
      .filter((_, idx) => idx !== memberIndex)
      .map((m, ordinal) => ({ ...m, ordinal }))
    const nextStages = document.stages.map((s, idx) =>
      idx === stageIndex ? { ...s, members: nextMembers } : s,
    )
    setDocument({ ...document, stages: nextStages })
  }

  function updateMemberInStage(
    stageIndex: number,
    memberIndex: number,
    updater: (m: SuiteMember) => SuiteMember,
  ) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, sIdx) => {
      if (sIdx !== stageIndex) return s
      const nextMembers = s.members.map((m, mIdx) => (mIdx === memberIndex ? updater(m) : m))
      return { ...s, members: nextMembers }
    })
    setDocument({ ...document, stages: nextStages })
  }

  function updateSelectedMember(updater: (m: SuiteMember) => SuiteMember) {
    if (selectedEntity.type !== 'member') return
    const memberId = selectedEntity.memberId
    if (isStageMode && document.stages) {
      const nextStages = document.stages.map((stage) => ({
        ...stage,
        members: stage.members.map((m) => (m.memberId === memberId ? updater(m) : m)),
      }))
      setDocument({ ...document, stages: nextStages })
    } else {
      const nextMembers = document.members.map((m) => (m.memberId === memberId ? updater(m) : m))
      setDocument({ ...document, members: nextMembers })
    }
  }

  function updateSelectedStage(updater: (s: SuiteStage) => SuiteStage) {
    if (selectedEntity.type !== 'stage' || !document.stages) return
    const stageIndex = selectedEntity.stageIndex
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? updater(s) : s))
    setDocument({ ...document, stages: nextStages })
  }

  function addStage() {
    const currentStages = document.stages ?? []
    const newOrdinal = currentStages.length
    const stageId = `stage-${newOrdinal + 1}`
    const newStage: SuiteStage = {
      id: stageId,
      name: `阶段 ${newOrdinal + 1}`,
      ordinal: newOrdinal,
      executionMode: 'parallel',
      maxConcurrency: 3,
      failurePolicy: 'continue',
      members: [],
    }
    setDocument({ ...document, stages: [...currentStages, newStage] })
    setSelectedEntity({ type: 'stage', stageIndex: newOrdinal })
  }

  function removeStage(stageIndex: number) {
    if (!document.stages) return
    if (selectedEntity.type === 'stage' && selectedEntity.stageIndex === stageIndex) {
      setSelectedEntity({ type: 'suite' })
    }
    const nextStages = document.stages
      .filter((_, idx) => idx !== stageIndex)
      .map((s, ordinal) => ({ ...s, ordinal }))
    setDocument({ ...document, stages: nextStages })
  }

  function moveStage(index: number, delta: number) {
    if (!document.stages) return
    const next = [...document.stages]
    const targetIdx = index + delta
    if (targetIdx < 0 || targetIdx >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(targetIdx, 0, item!)
    setDocument({ ...document, stages: next.map((stage, ordinal) => ({ ...stage, ordinal })) })
  }

  function updateStageName(stageIndex: number, newName: string) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, name: newName } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageMode(stageIndex: number, mode: 'parallel' | 'sequential') {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, executionMode: mode } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageConcurrency(stageIndex: number, val: number) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, maxConcurrency: val } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageFailurePolicy(stageIndex: number, policy: 'continue' | 'stop') {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, failurePolicy: policy } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function toggleStageMode() {
    if (isStageMode) {
      const flat = allSuiteMembers(document).map((m, ordinal) => ({ ...m, ordinal }))
      setDocument({ ...document, stages: [], members: flat })
      setSelectedEntity({ type: 'suite' })
      toast.info('已转换为平铺模式')
    } else {
      const initialStage: SuiteStage = {
        id: 'stage-1',
        name: '阶段 1 (准备与核心)',
        ordinal: 0,
        executionMode: document.executionMode ?? 'parallel',
        maxConcurrency: document.maxConcurrency ?? 3,
        failurePolicy: document.failurePolicy ?? 'continue',
        members: [...document.members],
      }
      setDocument({ ...document, stages: [initialStage], members: [] })
      setSelectedEntity({ type: 'stage', stageIndex: 0 })
      toast.success('已开启多阶段依赖编排模式')
    }
  }

  if (query.isPending) {
    return (
      <Main>
        <PageSkeleton />
      </Main>
    )
  }
  if (query.isError || !query.data) {
    return (
      <Main>
        <QueryErrorState title='无法加载场景集' onRetry={() => void query.refetch()} />
      </Main>
    )
  }

  const suite = query.data

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      {/* Top Header */}
      <SuiteHeader
        suite={suite}
        targetName={target.data?.name}
        canExecute={Boolean(canExecute)}
        busy={busy}
        isDirty={isDirty}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onStartRun={() => void startRun()}
        onToggleStatus={() => {
          void updateSuiteEnabled(suiteId, { status: suite.status === 'active' ? 'disabled' : 'active' })
            .then((next) => {
              queryClient.setQueryData(['suite', suiteId], next)
              toast.success(next.status === 'active' ? '已启用' : '已停用')
            })
            .catch((error) => toast.error(error instanceof ApiRequestError ? error.message : '更新失败'))
        }}
      />

      {/* Split Workspace Layout */}
      <div className='grid grid-cols-1 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] gap-6 items-start'>
        {/* Left: Pipeline Workspace (Primary) */}
        <div className='min-w-0'>
          <PipelineWorkspace
            document={document}
            isStageMode={isStageMode}
            canWrite={canWrite}
            scenarioNames={scenarioNames}
            availableScenarios={(scenarios.data?.items ?? [])
              .filter((item) => item.latestVersionId)
              .map((item) => ({
                id: item.id,
                name: item.name,
                latestVersionId: item.latestVersionId ?? undefined,
                latestVersionNo: item.latestVersionNo,
              }))}
            targetAccounts={targetAccounts.data?.items ?? []}
            targetId={suite.targetId}
            selectedMemberId={selectedEntity.type === 'member' ? selectedEntity.memberId : null}
            selectedStageIndex={selectedEntity.type === 'stage' ? selectedEntity.stageIndex : null}
            onSelectMember={(memberId, stageIndex) => {
              if (memberId) {
                setSelectedEntity({ type: 'member', memberId, stageIndex })
              } else {
                setSelectedEntity({ type: 'suite' })
              }
            }}
            onSelectStage={(stageIndex) => {
              if (stageIndex !== null) {
                setSelectedEntity({ type: 'stage', stageIndex })
              } else {
                setSelectedEntity({ type: 'suite' })
              }
            }}
            onToggleStageMode={toggleStageMode}
            onAddStage={addStage}
            onMoveStage={moveStage}
            onRemoveStage={removeStage}
            onUpdateStageName={updateStageName}
            onUpdateStageMode={updateStageMode}
            onUpdateStageConcurrency={updateStageConcurrency}
            onUpdateStageFailurePolicy={updateStageFailurePolicy}
            onAddMemberToStage={addMemberToStage}
            onAddMembersToStage={addMembersToStage}
            onUpdateMemberInStage={updateMemberInStage}
            onMoveMemberInStage={moveMemberInStage}
            onRemoveMemberFromStage={removeMemberFromStage}
            onAddMemberFlat={addMemberFlat}
            onAddMembersFlat={addMembersFlat}
            onUpdateMemberFlat={updateMemberFlat}
            onMoveMemberFlat={moveMemberFlat}
            onRemoveMemberFlat={removeMemberFlat}
            onOpenInputEditor={(member) => {
              setSelectedEntity({ type: 'member', memberId: member.memberId })
            }}
          />
        </div>

        {/* Right: Context-Sensitive Inspector (Suite / Stage / Member) */}
        <div className='min-w-0 lg:sticky lg:top-6'>
          <SuiteInspector
            name={name}
            description={description}
            document={document}
            isStageMode={isStageMode}
            canWrite={canWrite}
            targetAccounts={targetAccounts.data?.items ?? []}
            targetId={suite.targetId}
            selectedMember={selectedMember}
            selectedStage={selectedStage}
            scenarioNames={scenarioNames}
            onClearSelection={() => setSelectedEntity({ type: 'suite' })}
            onUpdateName={setName}
            onUpdateDescription={setDescription}
            onUpdateDocument={(updater) => setDocument(updater(document))}
            onUpdateMember={updateSelectedMember}
            onUpdateStage={updateSelectedStage}
            onOpenInputDialog={(member) => setEditingMember(member)}
          />
        </div>
      </div>

      {/* Member Input Override Dialog (Escape hatch for JSON mode) */}
      <MemberInputDialog
        open={editingMember !== null}
        document={document}
        onOpenChange={(open) => {
          if (!open) setEditingMember(null)
        }}
        member={editingMember}
        scenarioName={editingMember ? scenarioNames.get(editingMember.scenarioId) : undefined}
        disabled={!canWrite}
        onSave={(memberId, input) => {
          if (isStageMode && document.stages) {
            const nextStages = document.stages.map((stage) => ({
              ...stage,
              members: stage.members.map((item) =>
                item.memberId === memberId ? { ...item, input } : item,
              ),
            }))
            setDocument({ ...document, stages: nextStages })
          } else {
            const members = document.members.map((item) =>
              item.memberId === memberId ? { ...item, input } : item,
            )
            setDocument({ ...document, members })
          }
        }}
      />
    </Main>
  )
}
