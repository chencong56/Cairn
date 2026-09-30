import {
  TARGET_CONFIG_FORM_ID,
  normalizeAssistantPageContext,
  type AssistantCapabilitiesResponse,
  type AssistantCapabilityId,
  type AssistantPageContext,
} from '@cairn/shared'
import type { AssistantBoundContext } from '@/stores/assistant-store'

export interface AssistantRecommendationChip {
  id: string
  label: string
  question: string
  capabilityHint?: AssistantCapabilityId
  badge?: string
  priority: number
}

function hasNonPaginationFilters(filters: Record<string, unknown> | undefined): boolean {
  // An empty filter is the explicitly bound “all accessible objects” collection.
  return filters !== undefined
}

export function resolveContextRecommendations(params: {
  boundContext: AssistantBoundContext | null
  pageContext: AssistantPageContext | null
  capabilities: AssistantCapabilitiesResponse | null
  permissions: {
    canAssist: boolean
    canWrite: boolean
    canWriteTarget?: boolean
    canReadTarget: boolean
    canReadSession?: boolean
    canReadSchedule?: boolean
    canReadRun?: boolean
  }
}): AssistantRecommendationChip[] {
  // 1. 若全局未启用 AI 助手能力或缺少 ai:assist 权限，返回空列表
  if (!params.capabilities?.modelEnabled || !params.permissions.canAssist) {
    return []
  }

  const availableIds = new Set(
    params.capabilities.items.filter((item) => item.available).map((item) => item.id),
  )

  const bound = params.boundContext
  const pageContext = normalizeAssistantPageContext(params.pageContext)
  const page = bound?.page ?? pageContext?.page
  const selectedStepId = bound?.selectedStepId ?? pageContext?.stepId
  const runId =
    bound?.runId ??
    pageContext?.runId ??
    (bound?.page === 'run' ? bound?.entityId : undefined)
  const targetId =
    bound?.targetId ??
    bound?.entityId ??
    pageContext?.targetId
  const scheduleId =
    (bound?.page === 'schedule' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'schedule' ? pageContext.primaryRef.id : undefined)
  const suiteId =
    (bound?.page === 'suite' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'suite' ? pageContext.primaryRef.id : undefined)
  const actionModuleId =
    (bound?.page === 'action-module' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'actionModule' ? pageContext.primaryRef.id : undefined)
  const recordingId =
    (bound?.page === 'recording' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'recording' ? pageContext.primaryRef.id : undefined)
  const batchId =
    (bound?.page === 'batch' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'batch' ? pageContext.primaryRef.id : undefined)
  const rawChips: AssistantRecommendationChip[] = []

  // 2. 根据 boundContext / pageContext 匹配当前场景规则
  if (bound?.activeForm?.formId === TARGET_CONFIG_FORM_ID) {
    const hasTargetWrite = params.permissions.canWriteTarget ?? params.permissions.canWrite
    if (hasTargetWrite) {
      rawChips.push({
        id: 'target-form-timeout-propose',
        label: '⏱️ 将登录等待设为30秒',
        question: '帮我把这个目标系统的提交后等待离开登录页超时改成30秒。',
        capabilityHint: 'target.propose-form',
        priority: 110,
      })
      rawChips.push({
        id: 'target-form-settle-propose',
        label: '🧹 开启自动整理欢迎层',
        question: '帮我将登录后整理模式设为按平台整理，并将整理预算设为15秒。',
        capabilityHint: 'target.propose-form',
        priority: 108,
      })
    }
    rawChips.push({
      id: 'target-form-timeout-help',
      label: '⏱️ 登录超时不填会怎样',
      question: '登录页停留超时不填会怎样？',
      capabilityHint: 'knowledge.answer',
      priority: 105,
    })
    rawChips.push({
      id: 'target-form-settle-help',
      label: '🧹 登录后整理规则',
      question: '目标配置里的「登录后整理」和「整理预算」是什么作用？',
      capabilityHint: 'knowledge.answer',
      priority: 95,
    })
    rawChips.push({
      id: 'target-form-rules-help',
      label: '📝 目标编码与命名规则',
      question: '目标系统的系统名称与系统编码命名有什么格式要求？',
      capabilityHint: 'knowledge.answer',
      priority: 90,
    })
  } else if (page === 'studio') {
    if (selectedStepId) {
      // 场景单步聚焦 (Studio Step Focused) - 4 项规则
      rawChips.push({
        id: 'studio-step-propose-insert',
        label: '在此步骤后新增步骤',
        question: '在此步骤后新增步骤',
        capabilityHint: 'scenario.propose-step',
        priority: 110,
      })
      rawChips.push({
        id: 'studio-step-propose-optimize',
        label: '优化当前步骤配置',
        question: '优化当前步骤配置',
        capabilityHint: 'scenario.propose-step',
        priority: 105,
      })
      rawChips.push({
        id: 'studio-step-explain-deps',
        label: '检查全流程结构与依赖',
        question: '检查全流程结构与依赖',
        capabilityHint: 'scenario.explain',
        priority: 100,
      })
      rawChips.push({
        id: 'studio-step-acceptance',
        label: '补全当前步骤验收条件',
        question: '补全当前步骤验收条件',
        capabilityHint: 'scenario.propose-acceptance',
        priority: 95,
      })
    } else {
      // 场景全局 (Studio Global) - 4 项规则
      rawChips.push({
        id: 'studio-scenario-explain',
        label: '解释场景全貌与依赖',
        question: '解释场景全貌与依赖',
        capabilityHint: 'scenario.explain',
        priority: 110,
      })
      rawChips.push({
        id: 'studio-scenario-inspect',
        label: '检查潜在逻辑缺漏',
        question: '检查潜在逻辑缺漏',
        capabilityHint: 'scenario.explain',
        priority: 105,
      })
      rawChips.push({
        id: 'studio-scenario-acceptance',
        label: '补全全场景验收条件',
        question: '补全全场景验收条件',
        capabilityHint: 'scenario.propose-acceptance',
        priority: 100,
      })
      rawChips.push({
        id: 'studio-scenario-propose-append',
        label: '为场景追加末尾步骤',
        question: '为场景追加末尾步骤',
        capabilityHint: 'scenario.propose-step',
        priority: 95,
      })
    }
  } else if (page === 'run' && runId) {
    const isError = bound?.statusTone === 'error'

    if (isError) {
      // 运行失败复盘
      if (selectedStepId && bound?.selectedStepFailed) {
        rawChips.push({
          id: 'run-step-diagnose',
          label: '🔎 排查当前步骤报错',
          question: '当前步骤记录了什么错误？我应该先核对哪份运行证据？',
          capabilityHint: 'run.diagnose',
          priority: 115,
        })
      }
      rawChips.push({
        id: 'run-diagnose-rca',
        label: '🚨 排查本次失败',
        question: '这次运行哪里失败？请根据已记录的步骤和错误信息说明先核对什么；证据不足时请指出缺口。',
        capabilityHint: 'run.diagnose',
        priority: 110,
      })
      rawChips.push({
        id: 'run-compare',
        label: '🔄 对比上一次运行',
        question: '这次运行和上一次相比有什么变化？',
        capabilityHint: 'run.compare',
        priority: 90,
      })
    } else {
      // 运行成功 / 正常状态
      rawChips.push({
        id: 'run-perf-bottleneck',
        label: '⏱️ 分析耗时瓶颈',
        question: '请分析本次运行各步骤的耗时分布，并指出性能瓶颈。',
        capabilityHint: 'run.diagnose',
        priority: 80,
      })
    }
  } else if (page === 'run' && !runId && params.permissions.canReadRun) {
    // 运行列表页排查
    const filters = bound?.filters ?? pageContext?.view?.filters
    const status = filters?.status
    const showsFailures = status ? status === 'FAILED' : Boolean(bound?.listHasFailures)
    if (showsFailures) {
      rawChips.push({
        id: 'run-list-failure-digest',
        label: '🧩 这些失败是同一个原因吗',
        question: '请帮我分析当前筛选出的这些失败运行，它们是同一个原因导致的吗？',
        capabilityHint: 'knowledge.answer',
        priority: 85,
      })
    }
  } else if (page === 'session' && targetId && params.permissions.canReadTarget) {
    // 账号会话页面排查
    rawChips.push({
      id: 'session-auth-failure-reason',
      label: '🔑 为什么登录失效',
      question: '请帮我分析当前账号为什么登录失效，最近一次认证失败的原因是什么？',
      capabilityHint: 'knowledge.answer',
      priority: 92,
    })
    rawChips.push({
      id: 'session-occupied-by-whom',
      label: '🔒 会话被谁占用',
      question: '请检查当前会话被哪次运行或 Worker 占用，已经占用了多久？',
      capabilityHint: 'knowledge.answer',
      priority: 88,
    })
    rawChips.push({
      id: 'session-queue-waiting-reason',
      label: '⌛ 为什么开跑一直在等会话',
      question: '请分析为什么当前账号的运行在等待会话，是否存在租约占用、并发超限或等待认证？',
      capabilityHint: 'knowledge.answer',
      priority: 82,
    })
  } else if (page === 'target' && targetId && params.permissions.canReadTarget) {
    // 目标系统与凭据
    if (params.permissions.canReadSession) {
      rawChips.push({
        id: 'target-account-health',
        label: '🔑 检查账号健康度',
        question: '请检查该目标系统关联账号的认证健康状态与会话租约情况。',
        capabilityHint: 'knowledge.answer',
        priority: 90,
      })
    }
    rawChips.push({
      id: 'target-menu-map',
      label: '🗺️ 目标菜单地图覆盖',
      question: '请解释当前目标系统的一级菜单授权与只读地图覆盖情况。',
      capabilityHint: 'knowledge.answer',
      priority: 80,
    })
  } else if (page === 'schedule') {
    if (scheduleId && params.permissions.canReadSchedule) {
      rawChips.push({ id: 'schedule-resource-contention', label: '检查账号资源竞争', question: '请检查当前计划的账号容量与租约竞争。', capabilityHint: 'knowledge.answer', priority: 90 })
      rawChips.push({
        id: 'schedule-why-not-run',
        label: '⏱️ 为什么没按时运行',
        question: '请分析当前调度最近为什么没有按时运行，排查跳过原因与处理建议。',
        capabilityHint: 'knowledge.answer',
        priority: 90,
      })
      rawChips.push({
        id: 'schedule-recent-summary',
        label: '📋 最近触发情况汇总',
        question: '请汇总当前调度最近的触发记录、准入状态与跳过原因分布。',
        capabilityHint: 'knowledge.answer',
        priority: 80,
      })
    } else if (params.permissions.canReadSchedule) {
      const filters = bound?.filters ?? pageContext?.view?.filters
      const hasBusinessFilters = hasNonPaginationFilters(filters as Record<string, unknown> | undefined)
      if (hasBusinessFilters) {
        rawChips.push({
          id: 'schedule-window-overlap',
          label: '检查触发集中与窗口重叠',
          question: '请检查当前筛选内调度未来24小时的触发集中与可准入窗口重叠情况。',
          capabilityHint: 'knowledge.answer',
          priority: 110,
        })
        rawChips.push({
          id: 'schedule-skip-summary',
          label: '汇总近期跳过原因',
          question: '请汇总当前筛选内调度最近7天的触发状态与跳过原因。',
          capabilityHint: 'knowledge.answer',
          priority: 105,
        })
      }
    }
  } else if (page === 'suite') {
    if (suiteId) {
      rawChips.push({
        id: 'suite-dependencies',
        label: '分析场景依赖顺序',
        question: '请分析当前场景集固定成员版本的输入输出与阶段依赖。',
        capabilityHint: 'knowledge.answer',
        priority: 110,
      })
      rawChips.push({
        id: 'suite-resource-groups',
        label: '检查并发资源约束',
        question: '请检查当前场景集依赖与账号约束下的候选分组与未知项。',
        capabilityHint: 'knowledge.answer',
        priority: 105,
      })
      rawChips.push({
        id: 'suite-duration',
        label: '查看历史耗时参考',
        question: '请查看当前场景集同定义同策略的历史执行统计与耗时参考区间。',
        capabilityHint: 'knowledge.answer',
        priority: 90,
      })
    } else {
      const filters = bound?.filters ?? pageContext?.view?.filters
      const hasBusinessFilters = hasNonPaginationFilters(filters as Record<string, unknown> | undefined)
      if (hasBusinessFilters) {
        rawChips.push({
          id: 'suite-list-summary',
          label: '概览筛选内场景集',
          question: '请分析当前筛选中可访问场景集的成员与执行配置。',
          capabilityHint: 'knowledge.answer',
          priority: 95,
        })
      }
    }
  } else if (page === 'action-module') {
    if (actionModuleId) {
      rawChips.push({
        id: 'module-input-contract',
        label: '检查模块入参',
        question: '请检查当前模块指定修订的参数与默认值校验规则。',
        capabilityHint: 'knowledge.answer',
        priority: 110,
      })
      rawChips.push({
        id: 'module-references',
        label: '查看版本引用范围',
        question: '请查看当前模块版本的引用范围与升级影响。',
        capabilityHint: 'knowledge.answer',
        priority: 105,
      })
    } else {
      const filters = bound?.filters ?? pageContext?.view?.filters
      const hasBusinessFilters = hasNonPaginationFilters(filters as Record<string, unknown> | undefined)
      if (hasBusinessFilters) {
        rawChips.push({
          id: 'module-repeated-fragments',
          label: '查找重复步骤候选',
          question: '请在当前目标与筛选范围内查找可复用的重复步骤片段及出处。',
          capabilityHint: 'knowledge.answer',
          priority: 95,
        })
      }
    }
  } else if (page === 'recording') {
    if (recordingId) {
      rawChips.push({
        id: 'recording-propose-scenario',
        label: '清洗并生成场景草稿提案',
        question: '请对当前录制进行清洗并生成场景草稿提案。',
        capabilityHint: 'recording.propose-scenario',
        priority: 110,
      })
      rawChips.push({
        id: 'recording-locator', label: '提议改进定位器',
        question: '请基于当前录制实际记录的定位候选，生成可检查和采纳的定位器改进提案。',
        capabilityHint: 'recording.propose-scenario', priority: 109,
      })
      rawChips.push({
        id: 'recording-outcome', label: '提议补充操作后断言',
        question: '请先帮我确认业务预期，再生成当前录制的操作后成功条件提案。',
        capabilityHint: 'recording.propose-scenario', priority: 108,
      })
      rawChips.push({
        id: 'recording-quality',
        label: '检查录制质量与缺口',
        question: '请检查当前录制的质量、定位线索与断言缺口，区分记录事实和待验证的内容。',
        capabilityHint: 'knowledge.answer',
        priority: 105,
      })
    } else {
      const filters = bound?.filters ?? pageContext?.view?.filters
      const hasBusinessFilters = hasNonPaginationFilters(filters as Record<string, unknown> | undefined)
      if (hasBusinessFilters) {
        rawChips.push({
          id: 'recording-list-summary',
          label: '汇总待处理录制',
          question: '请汇总当前筛选内本人录制的待处理情况。',
          capabilityHint: 'knowledge.answer',
          priority: 95,
        })
      }
    }
  } else if (page === 'batch') {
    if (batchId) {
      rawChips.push({
        id: 'batch-input-mapping',
        label: '检查数据集参数映射',
        question: '请检查当前批量的固定场景版本、实际数据绑定与数据集列映射。',
        capabilityHint: 'knowledge.answer',
        priority: 110,
      })
      rawChips.push({
        id: 'batch-resource-limits',
        label: '检查并发与节奏配置',
        question: '请检查当前批量的有效并发上限、节奏控制与账号容量。',
        capabilityHint: 'knowledge.answer',
        priority: 105,
      })
    } else {
      const filters = bound?.filters ?? pageContext?.view?.filters
      const hasBusinessFilters = hasNonPaginationFilters(filters as Record<string, unknown> | undefined)
      if (hasBusinessFilters) {
        rawChips.push({
          id: 'batch-list-summary',
          label: '汇总批量进度',
          question: '请汇总当前筛选中的批量任务状态和进度计数。',
          capabilityHint: 'knowledge.answer',
          priority: 95,
        })
      }
    }
  }

  // 3. 过滤不可用能力、校验权限闸门，按优先级去重并裁剪（Studio 4 项，其他页面 3 项）
  const maxChips = page === 'studio' ? 4 : 3
  const seenQuestions = new Set<string>()

  return rawChips
    .filter((chip) => {
      const intentByChip: Record<string, string> = {
        'suite-list-summary': 'suite.collection-summary', 'suite-dependencies': 'suite.dependencies',
        'suite-resource-groups': 'suite.resource-groups', 'suite-duration': 'suite.duration',
        'module-repeated-fragments': 'module.repeated-fragments', 'module-input-contract': 'module.input-contract',
        'module-references': 'module.references', 'recording-list-summary': 'recording.collection-summary',
        'recording-quality': 'recording.quality',
        'schedule-resource-contention': 'schedule.resource-contention', 'schedule-window-overlap': 'schedule.window-overlap', 'schedule-skip-summary': 'schedule.skip-summary',
        'batch-list-summary': 'batch.collection-summary', 'batch-input-mapping': 'batch.input-mapping',
        'batch-resource-limits': 'batch.resource-limits',
      }
      const intent = intentByChip[chip.id]
      if (page === 'recording' && !params.permissions.canWrite) return false
      if (intent && params.capabilities?.contextFeatures &&
        !params.capabilities.contextFeatures.some((feature) => feature.id === intent && feature.available)) return false
      // 校验能力是否在可用集合中
      if (chip.capabilityHint && !availableIds.has(chip.capabilityHint)) {
        return false
      }
      // 权限闸门：编排与配置提议类能力严格需要对应写权限
      if (
        (chip.capabilityHint === 'scenario.propose-step' || chip.capabilityHint === 'recording.propose-scenario') &&
        !params.permissions.canWrite
      ) {
        return false
      }
      if (
        chip.capabilityHint === 'target.propose-form' &&
        !(params.permissions.canWriteTarget ?? params.permissions.canWrite)
      ) {
        return false
      }
      return true
    })
    .sort((a, b) => b.priority - a.priority)
    .filter((chip) => {
      const normalizedQ = chip.question.trim().toLowerCase()
      if (seenQuestions.has(normalizedQ)) return false
      seenQuestions.add(normalizedQ)
      return true
    })
    .slice(0, maxChips)
}
