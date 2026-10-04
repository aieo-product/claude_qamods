export type QaOption = { label: string; description: string; preview?: string }

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
  explainState: 'pending' | 'done' | 'error' | 'off'
  explanation: string
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
      /** Index counted from the newest entry; 0 selects the latest question. */
      cursor: number
    }
  }
}
