import type { OutcomeContract, OutcomePageRequestRule } from '@cairn/shared'

export function isPageRequestContract(contract: OutcomeContract): boolean {
  return contract.rule.kind === 'page_request'
}

export function pageRequestRuleOf(contract: OutcomeContract): OutcomePageRequestRule | null {
  return contract.rule.kind === 'page_request' ? contract.rule : null
}
