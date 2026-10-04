export type QaOption = { label: string; description: string; preview?: string }

/** ModelUsage's four fields, kept local for the self-contained state contract. */
export type QaUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type QaCostTotal = {
  usd: number
  hasPricedUsage: boolean
  hasUnpricedUsage: boolean
  /** Tokens covered by this total; older token-only state remains unpriced. */
  tokens: number
}

export type QaQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  options: QaOption[]
}

export type QaEntry = {
  id: string
  lang: 'en' | 'ja'
  askedAt: number
  userPrompts: string[]
  lead: string
  questions: QaQuestion[]
  explainMode: 'compact' | 'full'
  explainState: 'pending' | 'done' | 'error' | 'off'
  explanation: string
  /** Measured tokens for the latest explanation run, including failed calls. */
  usage?: QaUsage
  usageModel?: 'haiku' | 'session'
  /** Model id captured for the request, or Haiku 4.5 for compact/fallback. */
  usageModelId?: string
  /** API-price estimate for priced calls in the latest explanation run. */
  costUsd?: number
  costIncomplete?: boolean
  status: 'open' | 'answered' | 'cancelled'
  answers: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'qa-guide': {
      entries: QaEntry[]
      prompts: string[]
      isAiOn: boolean
      showHistory: boolean
      /** Session spend across all four token fields, including superseded runs. */
      usageTotal: number
      /** API-price estimates across all runs, including superseded requests. */
      costTotal: QaCostTotal
      /** Index counted from the newest entry; 0 selects the latest question. */
      cursor: number
    }
  }
}
