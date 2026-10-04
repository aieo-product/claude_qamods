export type QaOption = { label: string; description: string; preview?: string }

/** ModelUsage's four fields, kept local for the self-contained state contract. */
export type QaUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
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
      /** Index counted from the newest entry; 0 selects the latest question. */
      cursor: number
    }
  }
}
