import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ConfigRow, ModelCompleteRequest, ModelCompleteResult, ModelForkResult, ModelUsage, On, PaneOpenArgs, PromptOrigin, PromptSubmitInput, RenderPropsOf, SessionMessage, ToolCallResult, TurnCompleteInput, UiScrollArgs } from 'claude-code'

import { buildCompactContext, detectWaiting, openQuestionPane } from './register'
import { estimateCost, formatCost, resolvePrice } from './pricing'
import type { QaEntry, QaWaiting } from '../types'

const SURFACES = ['terminal', 'desktop'] as const

// Word-wrapped rows drop the space at the break; rejoin Latin breaks with one.
const joinRows = (rows: string[]) => rows.reduce((acc, row) =>
  !acc ? row : /[\x21-\x7e]$/.test(acc) && /^[\x21-\x7e]/.test(row) ? `${acc} ${row}` : acc + row, '')

const languageRow = (value: ConfigRow['value'], key = 'language'): ConfigRow => ({
  key, label: 'Language', kind: 'text', value,
  provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
})

const DETECTION_CASES = [
  { name: 'English', question: 'Which database?', labels: ['SQLite', 'PostgreSQL'], lang: 'en' },
  { name: 'hiragana question', question: 'どれを選びますか？', labels: ['SQLite', 'PostgreSQL'], lang: 'ja' },
  { name: 'katakana question', question: 'データベース?', labels: ['SQLite', 'PostgreSQL'], lang: 'ja' },
  { name: 'hiragana option', question: 'Proceed?', labels: ['はい', 'No'], lang: 'ja' },
  { name: 'katakana option', question: 'Which drawing?', labels: ['キャンバス', 'DOM'], lang: 'ja' },
  { name: 'half-width kana outside the specified detection range', question: 'Which label?', labels: ['ｶﾀｶﾅ', 'ASCII'], lang: 'en' },
  { name: 'Chinese without kana', question: '请选择数据库', labels: ['本地存储', '云存储'], lang: 'en' },
  { name: 'kanji without kana', question: '選択肢', labels: ['保存', '取消'], lang: 'en' },
] as const

for (const { name, question, labels, lang } of DETECTION_CASES) {
  test(`automatic language stores ${name} question language`, { options: { language: 'auto' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { env: { LC_ALL: lang === 'en' ? 'ja_JP.UTF-8' : 'en_US.UTF-8' } })
    const questions: Questions = [{ question, header: 'Demo', multiSelect: false, options: labels.map(label => ({ label, description: '' })) }]
    await ask($, questions)
    await calls.clock.settle()
    expect(calls.savedEntries[0]).toHaveProperty('lang', lang)
    expect(calls.opened).toEqual([{ id: 'qa-guide', title: lang === 'ja' ? '質問ガイド' : 'Question guide' }])
    expect(calls.languageLookups).toEqual([])
    expect(calls.completePrompts[0]).toContain(lang === 'ja' ? '### いまの指示（概要）' : '### Current instructions')
  })
}

test('automatic language ignores kana in headers, descriptions, previews and conversation context', { options: { language: 'auto' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { messages: [
    { role: 'user', text: 'デモを作ってください。', toolUses: [] },
    { role: 'assistant', text: 'データベースを選びます。', toolUses: [] },
  ] })
  await ask($, [{ ...QUESTIONS[0]!, header: 'データベース', options: [{ label: 'SQLite', description: 'かんたん', preview: 'プレビュー' }, QUESTIONS[0]!.options[1]!] }])
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'en')
  expect(calls.completePrompts[0]).toContain('### Current instructions')
  expect(calls.languageLookups).toEqual([])
})

type Questions = Array<{
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string; preview?: string }>
}>

const QUESTIONS: Questions = [
  {
    question: 'Which database should the demo app use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'SQLite', description: 'Single file, zero setup' },
      { label: 'PostgreSQL', description: 'Closer to production' },
    ],
  },
]

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: '質問ガイド',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type Calls = {
  fork: number
  forkPrompts: string[]
  complete: number
  completePrompts: string[]
  completeRequests: ModelCompleteRequest[]
  submitted: PromptSubmitInput[]
  savedPrompts: string[]
  savedEntries: QaEntry[]
  savedWaiting?: QaWaiting | null
  waitingWrites: number
  savedUsageTotal?: number
  savedCostTotal?: { usd: number; hasPricedUsage: boolean; hasUnpricedUsage: boolean; tokens: number }
  sessionModelLookups: number
  savedCursor?: number
  toast: string[]
  opened: PaneOpenArgs[]
  registered: string[]
  registeredDescriptions: string[]
  languageLookups: string[]
  order: string[]
  clock: MockClock
}

type EngineOptions = {
  isPlaced?: boolean
  completeDelay?: number
  toolDelay?: number
  completeReply?: ModelCompleteResult
  completeThrows?: boolean
  forkReply?: ModelForkResult
  forkDelay?: number
  forkReplies?: ModelForkResult[]
  forkDelays?: number[]
  toolError?: boolean
  toolThrows?: boolean
  agentMessages?: SessionMessage[]
  response?: string
  messages?: SessionMessage[]
  messagesDelay?: number
  cursor?: number
  configRows?: ConfigRow[]
  configThrows?: boolean
  env?: Record<string, string | undefined>
  envThrows?: string[]
  sessionModel?: string
  modelThrows?: boolean
}

const EXPLANATION = {
  isAnswered: true,
  text: '### なぜ聞いているか\nDB choice.\n### 選択肢ごとの影響\nSQLite has no setup; PostgreSQL matches production.\n### おすすめ\nUse SQLite for this demo.',
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
} satisfies ModelCompleteResult

const MEASURED_USAGE: ModelUsage = {
  input_tokens: 2140,
  output_tokens: 612,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const SESSION_USAGE: ModelUsage = {
  input_tokens: 520,
  output_tokens: 80,
  cache_creation_input_tokens: 1048,
  cache_read_input_tokens: 14000,
}

const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const USAGE_LINE = {
  en: 'tokens · in 2,140 · cache read 0 · cache write 0 · out 612 · ',
  ja: 'トークン ・ 入力 2,140 ・ キャッシュ読込 0 ・ キャッシュ書込 0 ・ 出力 612 ・ ',
}

const SESSION_USAGE_LINE = {
  en: 'tokens · in 520 · cache read 14,000 · cache write 1,048 · out 80 · session',
  ja: 'トークン ・ 入力 520 ・ キャッシュ読込 14,000 ・ キャッシュ書込 1,048 ・ 出力 80 ・ session',
}

const USAGE_PATTERN = /^(tokens ·|トークン ・)/

function engineBeneath(on: On, answers: Record<string, string> | 'deny', options: EngineOptions = {}): Calls {
  const calls: Calls = {
    fork: 0,
    forkPrompts: [],
    complete: 0,
    completePrompts: [],
    completeRequests: [],
    submitted: [],
    savedPrompts: [],
    savedEntries: [],
    waitingWrites: 0,
    toast: [],
    opened: [],
    registered: [],
    registeredDescriptions: [],
    languageLookups: [],
    sessionModelLookups: 0,
    order: [],
    clock: mock.clock(on, { now: 1000 }),
  }
  // The test driver's nouns omit state at runtime; observe writes through
  // the same typed hooks that the plugin's state adapter dispatches.
  on('state.set', { plugin: 'qa-guide' }, async (_$, e, next) => {
    const ran = await next(e)
    if (ran.value?.isSet) {
      if (e.key === 'prompts') calls.savedPrompts = e.value
      if (e.key === 'entries') calls.savedEntries = e.value
      if (e.key === 'usageTotal') calls.savedUsageTotal = e.value
      if (e.key === 'costTotal') calls.savedCostTotal = e.value
      if (e.key === 'cursor') calls.savedCursor = e.value
      if (e.key === 'waiting') {
        calls.savedWaiting = e.value
        calls.waitingWrites += 1
      }
    }
    return ran
  })
  on('state.get', { plugin: 'qa-guide', key: 'cursor' }, (_$, e, next) =>
    options.cursor !== undefined
      ? { value: { value: options.cursor, version: 1 } } as never
      : next(e),
  )
  on('config.list', () => {
    calls.languageLookups.push('config')
    if (options.configThrows) throw new Error('Demo configuration is unavailable.')
    return { value: options.configRows ?? [] }
  })
  on('env.get', (_$, e) => {
    calls.languageLookups.push(e.name)
    if (options.envThrows?.includes(e.name)) throw new Error('Demo locale is unavailable.')
    return { value: options.env?.[e.name] }
  })
  on('session.messages', async (_$, e) => {
    if (options.messagesDelay) await calls.clock.sleep(options.messagesDelay)
    return { value: e.agentId && options.agentMessages ? options.agentMessages : options.messages ?? [
      { role: 'user', text: 'Build a demo todo app', toolUses: [] },
      { role: 'assistant', text: 'I scaffolded the app. Next I need a database.', toolUses: [] },
    ] }
  })
  on('session.model', () => {
    calls.sessionModelLookups += 1
    if (options.modelThrows) throw new Error('Demo session model is unavailable.')
    return { value: options.sessionModel ?? 'demo-unpriced-model' }
  })
  on('ui.open', (_$, e) => {
    calls.opened.push(e)
    return { value: options.isPlaced === false
      ? { isPlaced: false, reason: 'Terminal is narrower than 144 columns.' }
      : { isPlaced: true } }
  })
  on('ui.toast', (_$, e) => {
    calls.toast.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    calls.registered.push(e.name)
    calls.registeredDescriptions.push(e.description ?? '')
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    calls.submitted.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('model.complete', async (_$, e) => {
    calls.complete += 1
    calls.completePrompts.push(e.prompt)
    calls.completeRequests.push(e)
    calls.order.push('complete')
    if (options.completeDelay) await calls.clock.sleep(options.completeDelay)
    if (options.completeThrows) throw new Error('Demo completion refused.')
    return { value: options.completeReply ?? EXPLANATION }
  })
  on('model.fork', async (_$, e) => {
    calls.fork += 1
    calls.forkPrompts.push(e.prompt)
    calls.order.push('fork')
    const delay = options.forkDelays?.[calls.fork - 1] ?? options.forkDelay
    const reply = options.forkReplies?.[calls.fork - 1] ?? options.forkReply ?? EXPLANATION
    if (delay) await calls.clock.sleep(delay)
    return { value: reply }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e): Promise<ToolCallResult<'AskUserQuestion'>> => {
    calls.order.push('tool')
    if (options.toolDelay) await calls.clock.sleep(options.toolDelay)
    if (answers === 'deny') return { deny: 'The user dismissed the question.' }
    if (options.toolThrows) throw new Error('The turn was interrupted.')
    if (options.toolError) return { result: undefined, text: 'Question interrupted.', isError: true, ref: 7 }
    return {
      result: { questions: e.questions, answers, ...(options.response ? { response: options.response } : {}) },
      ref: 7,
      text: JSON.stringify(answers),
      isReadOnly: true,
    }
  })

  return calls
}

const ask = ($: Engine, questions: Questions = QUESTIONS, id = 'toolu_1') =>
  $.tool.call({ tool: 'AskUserQuestion', tool_use_id: id, questions })

test('compact context is the default and calls only a bounded Haiku completion', async ($, on) => {
  const calls = engineBeneath(on, {})
  const requests = calls.completeRequests
  await ask($)
  await calls.clock.settle()
  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('haiku')
  expect(requests[0]?.maxTokens).toBe(1500)
  expect(requests[0]!.prompt.length).toBeLessThanOrEqual(12000)
  expect(calls.fork).toBe(0)
  expect(calls.savedEntries[0]).toHaveProperty('explainMode', 'compact')
})

const submit = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.prompt.submit({ text, origin, wait: false })

const mountPane = ($: Engine, surface: (typeof SURFACES)[number], props = PANE_PROPS) =>
  $.ui.mount({
    plugin: 'qa-guide',
    surface,
    component: 'Pane',
    requestId: 'qa-guide',
    props,
  })

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
}

function mountBand($: Engine, surface: (typeof SURFACES)[number], props = BAND_PROPS) {
  return $.ui.mount({ plugin: 'qa-guide', surface, component: 'AbovePrompt', props })
}

function finishTurn($: Engine, answer: string, fields: Partial<TurnCompleteInput> = {}) {
  return $.turn.complete({ turnId: 'demo-chat', answer, durationMs: 10, isAborted: false, reason: 'answer', ...fields } as TurnCompleteInput)
}

const COMPACT_QUESTIONS: Questions = Array.from({ length: 3 }, (_, qi) => ({
  question: `Question ${qi + 1}: ${'Explain the preferred approach and its tradeoffs. '.repeat(4)}`,
  header: `Card${qi + 1}`,
  multiSelect: qi === 1,
  options: Array.from({ length: 4 }, (_, oi) => ({
    label: `Choice${qi + 1}${oi + 1}`,
    description: `Description ${'with a long detail about how this option affects the next steps. '.repeat(4)}`,
    preview: `PREVIEW_${qi + 1}_${oi + 1}\n${'Preview body. '.repeat(20)}`,
  })),
}))

const LONG_LEAD = [
  'LEAD_HEAD: the original setup should not fill the compact pane.',
  ...Array.from({ length: 18 }, (_, i) => `Earlier explanation ${i + 1}: ${'background details '.repeat(4)}`),
  'LEAD_TAIL: decide the next step now.',
].join('\n')

const LONG_EXPLANATION: ModelCompleteResult = {
  ...EXPLANATION,
  text: [
    'AI_ORIGIN: why this decision matters.',
    ...Array.from({ length: 24 }, (_, i) => `AI detail ${i + 1}: ${'impact and recommended next step '.repeat(3)}`),
    'AI_END: full explanation ending.',
  ].join('\n'),
}

const COMPACT_PROPS: RenderPropsOf['Pane'] = {
  ...PANE_PROPS,
  scroll: { offset: 15, bodyRows: 20 },
}

const NUMBERED_QUESTIONS: Questions = [
  ...QUESTIONS,
  {
    question: 'How should the demo draw its board?',
    header: 'Drawing',
    multiSelect: false,
    options: [
      { label: 'DOM', description: 'Native controls' },
      { label: 'Canvas', description: 'Flexible drawing' },
    ],
  },
]

const NUMBERED_EXPLANATION: ModelCompleteResult = {
  ...EXPLANATION,
  text: [
    '### いまの指示（概要）',
    'Build a small demo task board.',
    'Keep setup simple and explain the choices.',
    '### なぜ聞いているか',
    'Choose storage and drawing before implementing the board.',
    '### 選択肢ごとの影響',
    '#### Q1. Database',
    '1. **SQLite**: Keeps demo setup simple.',
    '2) **PostgreSQL**：Matches production storage.',
    '#### Q2. Drawing',
    '1. DOM: Uses native controls.',
    '2. Canvas: Allows flexible drawing.',
    '### おすすめ',
    '→ Q1: 1. SQLite: Simple demo setup.',
    '→ Q2: 2. Canvas: Clear drawing.',
  ].join('\n'),
}

// The kit exposes the tree passed to each surface, rather than painted rows.
// A column of single-line Text nodes with no vertical spacing fits its row count.
function compactTextRows(tree: unknown): Array<{ props: Record<string, unknown>; text: string }> {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as { type: string; props?: Record<string, unknown>; children?: unknown[] }
  if (node.type === 'Button') {
    expect(node.props?.key).toBe('deep')
    expect(node.props?.plain).toBe(true)
    return [{ props: node.props ?? {}, text: String(node.props?.label ?? '') }]
  }
  if (node.type === 'Text') {
    const textOf = (value: unknown): string => {
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      if (Array.isArray(value)) return value.map(textOf).join('')
      if (value && typeof value === 'object') return textOf((value as { children?: unknown[] }).children)
      return ''
    }
    return [{ props: node.props ?? {}, text: textOf(node.children) }]
  }
  expect(node.type).toBe('Box')
  const props = node.props ?? {}
  expect(props.flexDirection ?? 'column').toBe('column')
  expect(props.borderStyle).toBeUndefined()
  for (const name of ['padding', 'paddingY', 'paddingTop', 'paddingBottom', 'margin', 'marginY', 'marginTop', 'marginBottom', 'gap', 'rowGap']) {
    expect(props[name] ?? 0).toBe(0)
  }
  return (node.children ?? []).flatMap(compactTextRows)
}

const toolSummaryMessages = (): SessionMessage[] => [
  { role: 'user', text: 'OLD_REQUEST: use a temporary demo.', toolUses: [] },
  { role: 'assistant', text: 'OLD_TRANSCRIPT: background', toolUses: [
    { tool_use_id: 'demo_old', tool: 'Read', input: { file_path: 'old-demo.ts' } },
  ] },
  { role: 'user', text: 'CURRENT_REQUEST: build a demo board.', toolUses: [] },
  { role: 'assistant', text: 'LEAD_HEAD: ' + 'background '.repeat(100000) + ' LEAD_TAIL: choose storage.', toolUses:
    Array.from({ length: 16 }, (_, i) => ({
      tool_use_id: `demo_tool_${i}`,
      tool: i === 15 ? 'Read' : 'Bash',
      input: { limit: 10, command: `DEMO_COMMAND_${i}: ${'detail '.repeat(40)}`, ignored: 'SECOND_FIELD_MUST_NOT_APPEAR' },
      text: 'TOOL_OUTPUT_MUST_NOT_APPEAR',
      result: { stdout: 'TOOL_RESULT_MUST_NOT_APPEAR' },
    })),
  },
  { role: 'user', text: 'TOOL_RESULT_ROW_MUST_NOT_RESET_CONTEXT', toolUses: [], toolResults: [
    { tool_use_id: 'demo_tool_15', text: 'tool output', isError: false },
  ] },
  { role: 'user', text: '<task-notification>DEMO_NOTIFICATION</task-notification>', toolUses: [] },
]

test('buildCompactContext is pure and bounds prompts, lead, tools and the total prompt', () => {
  const messages = toolSummaryMessages()
  const prompts = ['OLD_PROMPT', 'FIRST_RECENT', 'SECOND_RECENT', 'LATEST_RECENT ' + 'p'.repeat(900)]
  const lead = messages[3]!.text
  const before = JSON.stringify({ messages, prompts, lead, questions: QUESTIONS })
  const prompt = buildCompactContext(messages, prompts, lead, QUESTIONS, 'en')
  expect(prompt.length).toBeLessThanOrEqual(12000)
  expect(prompt).toContain('### Current instructions')
  expect(prompt).toContain('FIRST_RECENT')
  expect(prompt).toContain('SECOND_RECENT')
  expect(prompt).toContain(prompts[3]!.slice(0, 600))
  expect(prompt).not.toContain(prompts[3]!.slice(0, 601))
  expect(prompt).not.toContain('OLD_PROMPT')
  expect(prompt).toContain('LEAD_TAIL: choose storage.')
  expect(prompt).not.toContain('LEAD_HEAD')
  expect(prompt).not.toContain('OLD_TRANSCRIPT')
  expect(prompt).not.toContain('old-demo.ts')
  expect(prompt).not.toContain('DEMO_COMMAND_3:')
  for (let i = 4; i < 16; i++) expect(prompt).toContain(`DEMO_COMMAND_${i}:`)
  const summaries = prompt.split('\n').filter(line => /^(Bash|Read):/.test(line))
  expect(summaries).toHaveLength(12)
  for (const summary of summaries) expect(summary.length).toBeLessThanOrEqual(120)
  expect(summaries[0]).toContain('Bash: DEMO_COMMAND_4:')
  expect(summaries[11]).toContain('Read: DEMO_COMMAND_15:')
  expect(prompt).not.toContain('SECOND_FIELD_MUST_NOT_APPEAR')
  expect(prompt).not.toContain('TOOL_OUTPUT_MUST_NOT_APPEAR')
  expect(prompt).not.toContain('TOOL_RESULT_MUST_NOT_APPEAR')
  expect(prompt).toContain(JSON.stringify(QUESTIONS, null, 1))
  expect(prompt.indexOf('DEMO_COMMAND_15:')).toBeLessThan(prompt.indexOf(JSON.stringify(QUESTIONS, null, 1)))
  expect(JSON.stringify({ messages, prompts, lead, questions: QUESTIONS })).toBe(before)
})

test('buildCompactContext caps oversized questions and tool names as well as transcript data', () => {
  const messages: SessionMessage[] = [{ role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'demo_large', tool: 'DemoTool'.repeat(200), input: { data: 'a'.repeat(10000) } },
  ] }]
  const questions = [{ ...QUESTIONS[0]!, question: 'Large demo question ' + 'q'.repeat(40000) }]
  const prompt = buildCompactContext(messages, ['Demo prompt ' + 'p'.repeat(10000)], 'Demo lead ' + 'l'.repeat(10000), questions)
  expect(prompt.length).toBeLessThanOrEqual(12000)
  expect(prompt).toContain('Demo prompt')
  expect(prompt).toContain('Large demo question')
})

test('compact completion includes bounded context from a one megabyte transcript', async ($, on) => {
  const calls = engineBeneath(on, {}, { messages: toolSummaryMessages() })
  for (const prompt of ['RECORDED_FIRST', 'RECORDED_SECOND', 'RECORDED_LATEST']) await submit($, prompt)
  await ask($)
  await calls.clock.settle()
  expect(calls.fork).toBe(0)
  expect(calls.completeRequests).toHaveLength(1)
  const request = calls.completeRequests[0]!
  expect(request.model).toBe('haiku')
  expect(request.maxTokens).toBe(1500)
  expect(request.prompt.length).toBeLessThanOrEqual(12000)
  for (const text of ['RECORDED_FIRST', 'RECORDED_SECOND', 'RECORDED_LATEST', 'LEAD_TAIL', 'Bash: DEMO_COMMAND_4:', 'Read: DEMO_COMMAND_15:', QUESTIONS[0]!.question]) {
    expect(request.prompt).toContain(text)
  }
  expect(request.prompt).not.toContain('OLD_TRANSCRIPT')
})

for (const lang of ['en', 'ja'] as const) {
  for (const surface of SURFACES) {
    test(`a narrow completed ${lang} compact pane retains its dim context tag on ${surface}`, { options: { language: lang } }, async ($, on) => {
      const calls = engineBeneath(on, {}, {
        toolDelay: 1000, messages: [],
        completeReply: { ...EXPLANATION, text: lang === 'en' ? '### Current instructions\nDemo guidance.' : '### いまの指示（概要）\nデモの解説。' },
      })
      const asked = ask($)
      await calls.clock.settle()
      const props = { ...COMPACT_PROPS, bodyColumns: 40 }
      const ui = await mountPane($, surface, props)
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^compact context$/ : /^要点のみ$/ }))?.props.dimColor).toBe(true)
      const rows = compactTextRows(await ui.drawn())
      expect(rows.length).toBeLessThanOrEqual(props.scroll!.bodyRows)
      for (const row of compactTextRows(await ui.find({ key: 'compact-ai' }))) {
        expect([...row.text].length).toBeLessThanOrEqual(40)
      }
      await ui.unmount()
      await calls.clock.advance(1000)
      await asked
    })
  }

  for (const status of ['open', 'answered'] as const) {
    test(`legacy ${status} entries default to the ${lang} full context tag`, async ($, on) => {
      engineBeneath(on, {})
      const legacy: Omit<QaEntry, 'explainMode'> = {
        id: 'demo_legacy', lang, askedAt: 1, userPrompts: [], lead: '', questions: QUESTIONS,
        explainState: 'done', explanation: '### Demo\nLegacy guidance.', status, answers: {},
      }
      on('state.get', { plugin: 'qa-guide', key: 'entries' }, () => ({ value: { value: [legacy], version: 1 } }) as never)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^full context$/ : /^全文脈$/ }))?.props.dimColor).toBe(true)
        await ui.unmount()
      }
    })
  }

  test(`full context option forks and renders the ${lang} tag on each surface`, { options: { context: 'full', language: lang } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    await ask($)
    await calls.clock.settle()
    expect(calls.fork).toBe(1)
    expect(calls.complete).toBe(0)
    expect(calls.savedEntries[0]).toHaveProperty('explainMode', 'full')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^full context$/ : /^全文脈$/ }))?.props.dimColor).toBe(true)
      await ui.unmount()
    }
  })

  test(`Full context replaces the selected entry and ${lang} compact tag on each surface`, { options: { language: lang } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { forkReply: { ...EXPLANATION, text: 'FULL_DEMO: use the whole session.' } })
    await ask($, QUESTIONS, 'demo_first')
    await ask($, QUESTIONS, 'demo_latest')
    await calls.clock.settle()
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      // Choose a different compact entry on each surface to check selection.
      if (surface === 'terminal') await ui.press({ key: 'prev' })
      else await ui.press({ key: 'latest' })
      const id = surface === 'terminal' ? 'demo_first' : 'demo_latest'
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^compact context$/ : /^要点のみ$/ }))?.props.dimColor).toBe(true)
      const button = await ui.find({ key: 'deep' })
      expect(button?.type).toBe('Button')
      expect(button?.props.hotkey).toBe('f')
      expect(button?.props.label).toBe(lang === 'en' ? 'Full context' : '全文脈で解説')
      await ui.press({ key: 'deep' })
      expect(calls.savedEntries.find(entry => entry.id === id)).toMatchObject({ explainMode: 'full', explainState: 'done', explanation: 'FULL_DEMO: use the whole session.' })
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^full context$/ : /^全文脈$/ }))?.props.dimColor).toBe(true)
      expect(await ui.find({ type: 'Markdown', text: /FULL_DEMO/ })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: /DB choice/ })).toBeUndefined()
      await ui.unmount()
    }
    expect(calls.fork).toBe(2)
    expect(calls.complete).toBe(2)
  })

  for (const surface of SURFACES) {
    test(`compact ${lang} pane offers Full context only in spare rows on ${surface}`, { options: { language: lang } }, async ($, on) => {
      const calls = engineBeneath(on, {}, { toolDelay: 1000, messages: [], completeReply: { ...EXPLANATION, text: '### Demo\nCOMPACT_DEMO' }, forkReply: { ...EXPLANATION, text: '### Demo\nFULL_DEMO' } })
      const asked = ask($)
      await calls.clock.settle()
      const ui = await mountPane($, surface, COMPACT_PROPS)
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^compact context$/ : /^要点のみ$/ }))?.props.dimColor).toBe(true)
      expect((await ui.find({ key: 'deep' }))?.props.hotkey).toBe('f')
      const drawn = await ui.drawn()
      expect(compactTextRows(drawn).length).toBeLessThanOrEqual(COMPACT_PROPS.scroll!.bodyRows)
      const keys = (drawn.type === 'Box' ? drawn.children ?? [] : []).map(node =>
        typeof node === 'object' && (node.type === 'Box' || node.type === 'Button') ? node.props?.key : undefined)
      expect(keys.indexOf('deep')).toBeGreaterThan(keys.indexOf('compact-ai'))
      await ui.press({ key: 'deep' })
      expect(calls.fork).toBe(1)
      expect(calls.savedEntries[0]).toMatchObject({ explainMode: 'full', explanation: '### Demo\nFULL_DEMO' })
      expect((await ui.find({ type: 'Text', text: lang === 'en' ? /^full context$/ : /^全文脈$/ }))?.props.dimColor).toBe(true)
      expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(COMPACT_PROPS.scroll!.bodyRows)
      await ui.unmount()
      await calls.clock.advance(1000)
      await asked
    })

    for (const outcome of ['answered', 'failure', 'rejection'] as const) {
      test(`superseded ${lang} compact ${outcome} cannot replace Full context on ${surface}`, { options: { language: lang } }, async ($, on) => {
        const calls = engineBeneath(on, {}, {
          toolDelay: 100, completeDelay: 1000, completeThrows: outcome === 'rejection',
          forkReply: { ...EXPLANATION, text: 'WINNING_FULL_DEMO', usage: SESSION_USAGE },
          completeReply: outcome === 'answered' ? { ...EXPLANATION, text: 'STALE_COMPACT_DEMO', usage: MEASURED_USAGE } : { isAnswered: false, reason: 'empty-reply', usage: MEASURED_USAGE },
        })
        const asked = ask($)
        await calls.clock.settle()
        await calls.clock.advance(100)
        await asked
        const ui = await mountPane($, surface)
        await ui.press({ key: 'deep' })
        await calls.clock.advance(900)
        expect(calls.savedEntries[0]).toMatchObject({ explainMode: 'full', explainState: 'done', explanation: 'WINNING_FULL_DEMO' })
        expect(calls.savedEntries[0]).toMatchObject({ usage: SESSION_USAGE, usageModel: 'session' })
        expect(calls.savedUsageTotal).toBe(outcome === 'rejection' ? 15648 : 18400)
        expect((await ui.find({ type: 'Text', text: SESSION_USAGE_LINE[lang] }))?.props.dimColor).toBe(true)
        expect(await ui.find({ type: 'Markdown', text: /^WINNING_FULL_DEMO$/ })).toBeDefined()
        expect(await ui.find({ text: /STALE_COMPACT_DEMO|empty-reply/ })).toBeUndefined()
        await ui.unmount()
      })
    }

    test(`a later ${lang} full run supersedes an earlier full run on ${surface}`, { options: { language: lang } }, async ($, on) => {
      const calls = engineBeneath(on, {}, {
        forkDelays: [1000, 0],
        forkReplies: [{ ...EXPLANATION, text: 'STALE_FULL_DEMO', usage: MEASURED_USAGE }, { ...EXPLANATION, text: 'LATEST_FULL_DEMO', usage: SESSION_USAGE }],
      })
      await ask($)
      const ui = await mountPane($, surface)
      const earlier = ui.press({ key: 'deep' })
      await calls.clock.settle()
      const later = ui.press({ key: 'deep' })
      await calls.clock.settle()
      await calls.clock.advance(1000)
      await Promise.all([earlier, later])
      expect(calls.fork).toBe(2)
      expect(calls.savedEntries[0]).toMatchObject({ explainMode: 'full', explainState: 'done', explanation: 'LATEST_FULL_DEMO' })
      expect(calls.savedEntries[0]).toMatchObject({ usage: SESSION_USAGE, usageModel: 'session' })
      expect(calls.savedUsageTotal).toBe(18402)
      expect(await ui.find({ text: /STALE_FULL_DEMO/ })).toBeUndefined()
      await ui.unmount()
    })
  }
}

for (const lang of ['en', 'ja'] as const) {
  for (const context of ['compact', 'full'] as const) {
    test(`${lang} ${context} measured usage renders on both surfaces in compact and full panes`, { options: { language: lang, context, showCost: 'off' } }, async ($, on) => {
      const reply = { ...EXPLANATION, text: 'Demo guidance.', usage: MEASURED_USAGE }
      const calls = engineBeneath(on, {}, { toolDelay: 1000, messages: [], completeReply: reply, forkReply: reply })
      const asked = ask($)
      await calls.clock.settle()
      const model = context === 'compact' ? 'haiku' : 'session'
      expect(calls.savedEntries[0]).toMatchObject({ usage: MEASURED_USAGE, usageModel: model })
      expect(calls.savedUsageTotal).toBe(2752)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface, { ...COMPACT_PROPS, bodyColumns: 160 })
        const usage = await ui.find({ type: 'Text', text: USAGE_LINE[lang] + model })
        expect(usage?.props.dimColor).toBe(true)
        expect(usage?.props.wrap).toBe('truncate-end')
        const rows = compactTextRows(await ui.drawn())
        const heading = rows.findIndex(row => row.text.includes(lang === 'en' ? 'AI explanation' : 'AI解説'))
        const measured = rows.findIndex(row => row.text === USAGE_LINE[lang] + model)
        expect(measured).toBe(heading + 1)
        expect(rows.length).toBeLessThanOrEqual(COMPACT_PROPS.scroll!.bodyRows)
        expect(await ui.find({ key: 'deep' })).toBeDefined()
        await ui.unmount()
      }
      await calls.clock.advance(1000)
      await asked
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect((await ui.find({ type: 'Text', text: USAGE_LINE[lang] + model }))?.props.dimColor).toBe(true)
        await ui.unmount()
      }
    })
  }

  test(`${lang} reruns replace entry usage while every request adds all four counts to the session`, { options: { language: lang, showCost: 'off' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      completeReply: { ...EXPLANATION, usage: MEASURED_USAGE },
      forkReply: { ...EXPLANATION, usage: SESSION_USAGE },
    })
    await ask($, QUESTIONS, 'demo_usage_first')
    await calls.clock.settle()
    const first = await mountPane($, 'terminal')
    await first.press({ key: 'deep' })
    await calls.clock.settle()
    expect(calls.savedEntries[0]).toMatchObject({ usage: SESSION_USAGE, usageModel: 'session' })
    expect(calls.savedUsageTotal).toBe(18400)
    await first.unmount()
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: SESSION_USAGE_LINE[lang] }))?.props.dimColor).toBe(true)
      const total = lang === 'en' ? 'AI tokens this session: 18.4k' : 'このセッションのAIトークン: 18.4k'
      expect((await ui.find({ type: 'Text', text: total }))?.props.dimColor).toBe(true)
      await ui.unmount()
    }
    const rerun = await mountPane($, 'desktop')
    await rerun.press({ key: 'deep' })
    await calls.clock.settle()
    expect(calls.savedEntries[0]).toMatchObject({ usage: SESSION_USAGE, usageModel: 'session' })
    expect(calls.savedUsageTotal).toBe(34048)
    await rerun.unmount()
    await ask($, QUESTIONS, 'demo_usage_latest')
    await calls.clock.settle()
    expect(calls.savedUsageTotal).toBe(36800)
    expect(calls.savedEntries[1]).toMatchObject({ usage: MEASURED_USAGE, usageModel: 'haiku' })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      if (await ui.find({ key: 'latest' })) await ui.press({ key: 'latest' })
      expect(await ui.find({ type: 'Text', text: USAGE_LINE[lang] + 'haiku' })).toBeDefined()
      await ui.press({ key: 'prev' })
      expect(await ui.find({ type: 'Text', text: SESSION_USAGE_LINE[lang] })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: USAGE_LINE[lang] + 'haiku' })).toBeUndefined()
      expect(calls.savedUsageTotal).toBe(36800)
      await ui.unmount()
    }
  })

  test(`${lang} old entries without usage and AI-off entries hide the usage line on both surfaces`, { options: { language: lang } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    let storedEntries: QaEntry[] | undefined
    on('state.get', { plugin: 'qa-guide', key: 'entries' }, (_$, e, next) =>
      storedEntries ? { value: { value: storedEntries, version: 1 } } as never : next(e))
    const empty = await mountPane($, 'terminal')
    await empty.press({ key: 'ai' })
    await empty.unmount()
    await ask($)
    await calls.clock.settle()
    expect(calls.complete).toBe(0)
    expect(calls.fork).toBe(0)
    expect(calls.savedEntries[0]).toHaveProperty('explainState', 'off')
    expect(calls.savedEntries[0]).not.toHaveProperty('usage')
    expect(calls.savedUsageTotal ?? 0).toBe(0)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
      await ui.unmount()
    }
    const legacy: QaEntry = {
      id: 'demo_legacy_usage', lang, askedAt: 1, userPrompts: [], lead: '', questions: QUESTIONS,
      explainMode: 'compact', explainState: 'done', explanation: 'Demo guidance.', status: 'answered', answers: {},
    }
    storedEntries = [legacy]
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
      await ui.unmount()
    }
    legacy.status = 'open'
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, COMPACT_PROPS)
      expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
      expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(COMPACT_PROPS.scroll!.bodyRows)
      await ui.unmount()
    }
  })
}

for (const context of ['compact', 'full'] as const) {
  for (const reason of ['api-error', 'aborted', 'empty-reply'] as const) {
    test(`${context} ${reason} results retain measured usage even without an explanation`, { options: { language: 'en', context, showCost: 'off' } }, async ($, on) => {
      const usage = context === 'full' ? SESSION_USAGE : reason === 'empty-reply' ? MEASURED_USAGE : ZERO_USAGE
      const reply: ModelCompleteResult = reason === 'api-error'
        ? { isAnswered: false, reason, status: 429, error: 'rate_limit', usage }
        : { isAnswered: false, reason, usage }
      const calls = engineBeneath(on, {}, { completeReply: reply, forkReply: reply })
      await ask($)
      await calls.clock.settle()
      const model = context === 'compact' ? 'haiku' : 'session'
      expect(calls.savedEntries[0]).toMatchObject({ explainState: 'error', explanation: reason, usage, usageModel: model })
      expect(calls.savedUsageTotal ?? 0).toBe(context === 'full' ? 15648 : usage === ZERO_USAGE ? 0 : 2752)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        const line = context === 'full' ? SESSION_USAGE_LINE.en : usage === ZERO_USAGE ? `tokens · in 0 · cache read 0 · cache write 0 · out 0 · ${model}` : USAGE_LINE.en + model
        expect((await ui.find({ type: 'Text', text: line }))?.props.dimColor).toBe(true)
        expect(await ui.find({ type: 'Text', text: new RegExp(reason) })).toBeDefined()
        await ui.unmount()
      }
    })
  }
}

test('a completion rejection has no measured usage or session spend', async ($, on) => {
  const calls = engineBeneath(on, {}, { completeThrows: true })
  await ask($)
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('explainState', 'error')
  expect(calls.savedEntries[0]).not.toHaveProperty('usage')
  expect(calls.savedEntries[0]).not.toHaveProperty('costUsd')
  expect(calls.savedUsageTotal ?? 0).toBe(0)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
    await ui.unmount()
  }
})

test('a pending rerun hides the previous result usage until its measured result arrives', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    completeReply: { ...EXPLANATION, usage: MEASURED_USAGE },
    forkReply: { ...EXPLANATION, usage: SESSION_USAGE },
    forkDelay: 1000,
  })
  await ask($)
  await calls.clock.settle()
  const first = await mountPane($, 'terminal')
  const rerun = first.press({ key: 'deep' })
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('explainState', 'pending')
  expect(calls.savedEntries[0]).not.toHaveProperty('usage')
  expect(calls.savedEntries[0]).not.toHaveProperty('usageModel')
  expect(calls.savedUsageTotal).toBe(2752)
  for (const surface of SURFACES) {
    const ui = surface === 'terminal' ? first : await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
    if (surface !== 'terminal') await ui.unmount()
  }
  await calls.clock.advance(1000)
  await rerun
  expect(calls.savedEntries[0]).toMatchObject({ usage: SESSION_USAGE, usageModel: 'session' })
  expect(calls.savedUsageTotal).toBe(18400)
  await first.unmount()
})

test('concurrent question completions each add measured usage to the session total', async ($, on) => {
  const calls = engineBeneath(on, {}, { completeDelay: 1000, completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
  await ask($, QUESTIONS, 'demo_concurrent_first')
  await ask($, QUESTIONS, 'demo_concurrent_second')
  await calls.clock.settle()
  await calls.clock.advance(1000)
  expect(calls.savedEntries).toHaveLength(2)
  for (const entry of calls.savedEntries) expect(entry).toMatchObject({ explainState: 'done', usage: MEASURED_USAGE, usageModel: 'haiku' })
  expect(calls.savedUsageTotal).toBe(5504)
})

for (const carriesUsage of [false, true]) {
  test(`nothing-to-fork fallback records Haiku usage${carriesUsage ? ' and any carried fork usage' : ''}`, { options: { context: 'full', showCost: 'off' } }, async ($, on) => {
    const forkReply: ModelForkResult = carriesUsage
      ? { isAnswered: false, reason: 'nothing-to-fork', usage: SESSION_USAGE } as ModelForkResult
      : { isAnswered: false, reason: 'nothing-to-fork' }
    const calls = engineBeneath(on, {}, { forkReply, completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
    await ask($)
    await calls.clock.settle()
    expect(calls.fork).toBe(1)
    expect(calls.complete).toBe(1)
    const usage: ModelUsage = carriesUsage
      ? { input_tokens: 2660, output_tokens: 692, cache_creation_input_tokens: 1048, cache_read_input_tokens: 14000 }
      : MEASURED_USAGE
    expect(calls.savedEntries[0]).toMatchObject({ explainMode: 'full', explainState: 'done', usage, usageModel: 'haiku' })
    expect(calls.savedUsageTotal).toBe(carriesUsage ? 18400 : 2752)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const line = carriesUsage
        ? 'tokens · in 2,660 · cache read 14,000 · cache write 1,048 · out 692 · haiku'
        : USAGE_LINE.en + 'haiku'
      expect((await ui.find({ type: 'Text', text: line }))?.props.dimColor).toBe(true)
      expect(await ui.find({ text: /nothing-to-fork/ })).toBeUndefined()
      await ui.unmount()
    }
  })
}

for (const surface of SURFACES) {
  test(`a spent stale nothing-to-fork result adds session tokens without starting fallback on ${surface}`, { options: { context: 'full' } }, async ($, on) => {
    const spentFork = { isAnswered: false, reason: 'nothing-to-fork', usage: MEASURED_USAGE } as ModelForkResult
    const calls = engineBeneath(on, {}, {
      forkDelays: [1000, 0],
      forkReplies: [spentFork, { ...EXPLANATION, text: 'LATEST_FULL_DEMO', usage: SESSION_USAGE }],
    })
    await ask($)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'deep' })
    await calls.clock.settle()
    expect(calls.savedUsageTotal).toBe(15648)
    await calls.clock.advance(1000)
    expect(calls.fork).toBe(2)
    expect(calls.complete).toBe(0)
    expect(calls.savedEntries[0]).toMatchObject({ explainState: 'done', explanation: 'LATEST_FULL_DEMO', usage: SESSION_USAGE, usageModel: 'session' })
    expect(calls.savedUsageTotal).toBe(18400)
    expect(await ui.find({ type: 'Text', text: SESSION_USAGE_LINE.en })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'AI tokens this session: 18.4k' })).toBeDefined()
    await ui.unmount()
  })
}

test('measured compact usage never steals content or the Full context button from the row budget', { options: { showCost: 'off' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000, messages: [], completeReply: { ...EXPLANATION, text: 'Demo guidance.', usage: MEASURED_USAGE },
  })
  const asked = ask($)
  await calls.clock.settle()
  for (const bodyRows of [0, 1, 2, 3, 4, 20]) {
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 160, scroll: { offset: 0, bodyRows } })
      const rows = compactTextRows(await ui.drawn())
      expect(rows.length).toBeLessThanOrEqual(bodyRows)
      expect(rows.some(row => row.text.includes('Demo guidance.'))).toBe(bodyRows >= 2)
      if (bodyRows === 2 || bodyRows === 3) expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
      if (bodyRows === 3) expect(await ui.find({ key: 'deep' })).toBeDefined()
      if (bodyRows >= 4) {
        expect(await ui.find({ type: 'Text', text: USAGE_LINE.en + 'haiku' })).toBeDefined()
        expect(await ui.find({ key: 'deep' })).toBeDefined()
      }
      for (const row of rows) {
        if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
        expect(row.text).not.toContain('\n')
      }
      await ui.unmount()
    }
  }
  await calls.clock.advance(1000)
  await asked
})

const COST_SUFFIX = {
  en: (amount: string) => ` · ≈ ${amount} (API price)`,
  ja: (amount: string) => ` ・ ≈ ${amount}（API料金換算）`,
}

const sessionTokenLine = (lang: 'en' | 'ja', total: string) =>
  lang === 'en' ? `AI tokens this session: ${total}` : `このセッションのAIトークン: ${total}`

const expectCost = (actual: number | undefined, expected: number) => {
  expect(actual).toBeDefined()
  expect(Number(actual?.toFixed(8))).toBe(expected)
}

test('API prices resolve the Haiku alias and every supported model prefix with September 2026 rates', () => {
  expect(resolvePrice('haiku')).toEqual({ modelId: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.10 })
  const rates = [
    ['claude-haiku-4-5', 1, 5, 0.10],
    ['claude-sonnet-5-5', 2, 10, 0.20],
    ['claude-sonnet-5', 2, 10, 0.20],
    ['claude-opus-5-5', 4, 20, 0.20],
    ['claude-opus-5', 5, 25, 0.50],
    ['claude-opus-4-8', 5, 25, 0.50],
    ['claude-opus-4-7', 5, 25, 0.50],
    ['claude-opus-4-6', 5, 25, 0.50],
  ] as const
  for (const [modelId, input, output, cacheRead] of rates) {
    for (const suffix of ['', '[1m]', '-demo-suffix']) {
      expect(resolvePrice(modelId + suffix)).toEqual({ modelId, input, output, cacheRead })
    }
  }
  expect(resolvePrice(undefined)).toBeUndefined()
  expect(resolvePrice('demo-unpriced-model')).toBeUndefined()
  expect(estimateCost(MEASURED_USAGE, 'demo-unpriced-model')).toBeUndefined()
})

test('API estimates price all four token fields and cache writes at 1.25 times input', () => {
  expectCost(estimateCost(MEASURED_USAGE, 'haiku'), 0.0052)
  expectCost(estimateCost(SESSION_USAGE, 'haiku'), 0.00363)
  expectCost(estimateCost(SESSION_USAGE, 'claude-sonnet-5-5[1m]'), 0.00726)
  expectCost(estimateCost(SESSION_USAGE, 'claude-opus-5-5[1m]'), 0.01172)
  expectCost(estimateCost(SESSION_USAGE, 'claude-opus-5'), 0.01815)
  expectCost(estimateCost(ZERO_USAGE, 'haiku'), 0)
})

test('API estimates keep four decimal places below one cent and fewer for larger amounts', () => {
  for (const [amount, formatted] of [
    [0, '$0.0000'], [0.000006, '$0.0000'], [0.0052, '$0.0052'],
    [0.01, '$0.010'], [0.0312, '$0.031'], [0.999, '$0.999'],
    [1, '$1.00'], [12.345, '$12.35'],
  ] as const) expect(formatCost(amount)).toBe(formatted)
})

for (const lang of ['en', 'ja'] as const) {
  for (const context of ['compact', 'full'] as const) {
    test(`${lang} ${context} API estimate is on by default in compact and full panes on both surfaces`, { options: { language: lang, context } }, async ($, on) => {
      const reply = { ...EXPLANATION, text: 'Demo guidance.', usage: MEASURED_USAGE }
      const calls = engineBeneath(on, {}, {
        toolDelay: 1000, messages: [], completeReply: reply, forkReply: reply,
        sessionModel: 'claude-opus-5-5[1m]',
      })
      const asked = ask($)
      await calls.clock.settle()
      const model = context === 'compact' ? 'haiku' : 'session'
      const modelId = context === 'compact' ? 'claude-haiku-4-5' : 'claude-opus-5-5[1m]'
      const cost = context === 'compact' ? 0.0052 : 0.0208
      const amount = context === 'compact' ? '$0.0052' : '$0.021'
      const line = USAGE_LINE[lang] + model + COST_SUFFIX[lang](amount)
      expect(calls.savedEntries[0]).toMatchObject({ usage: MEASURED_USAGE, usageModel: model, usageModelId: modelId })
      expectCost(calls.savedEntries[0]?.costUsd, cost)
      expectCost(calls.savedCostTotal?.usd, cost)
      expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: false, tokens: 2752 })
      expect(calls.sessionModelLookups).toBe(context === 'compact' ? 0 : 1)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface, { ...COMPACT_PROPS, bodyColumns: 200 })
        expect((await ui.find({ type: 'Text', text: line }))?.props.dimColor).toBe(true)
        expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(COMPACT_PROPS.scroll!.bodyRows)
        expect(await ui.find({ key: 'deep' })).toBeDefined()
        await ui.unmount()
      }
      await calls.clock.advance(1000)
      await asked
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 200 })
        expect((await ui.find({ type: 'Text', text: line }))?.props.dimColor).toBe(true)
        expect((await ui.find({ type: 'Text', text: sessionTokenLine(lang, '2.8k') + COST_SUFFIX[lang](amount) }))?.props.dimColor).toBe(true)
        await ui.unmount()
      }
    })

    test(`${lang} showCost off keeps ${context} usage and session totals token-only on both surfaces`, { options: { language: lang, context, showCost: 'off' } }, async ($, on) => {
      const reply = { ...EXPLANATION, usage: MEASURED_USAGE }
      const calls = engineBeneath(on, {}, { completeReply: reply, forkReply: reply, sessionModel: 'claude-opus-5-5' })
      await ask($)
      await calls.clock.settle()
      const model = context === 'compact' ? 'haiku' : 'session'
      expectCost(calls.savedEntries[0]?.costUsd, context === 'compact' ? 0.0052 : 0.0208)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await ui.find({ type: 'Text', text: USAGE_LINE[lang] + model })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: sessionTokenLine(lang, '2.8k') })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
        await ui.unmount()
      }
    })
  }

  for (const carriesUsage of [false, true]) {
    test(`${lang} fallback estimate prices the fork with its session model and completion with Haiku on both surfaces${carriesUsage ? ' including fork spend' : ''}`, { options: { language: lang, context: 'full' } }, async ($, on) => {
      const forkReply: ModelForkResult = carriesUsage
        ? { isAnswered: false, reason: 'nothing-to-fork', usage: SESSION_USAGE } as ModelForkResult
        : { isAnswered: false, reason: 'nothing-to-fork' }
      const calls = engineBeneath(on, {}, { sessionModel: 'claude-opus-5-5', forkReply, completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
      await ask($)
      await calls.clock.settle()
      expect(calls.savedEntries[0]).toMatchObject({ usageModel: 'haiku', usageModelId: 'claude-haiku-4-5' })
      expectCost(calls.savedEntries[0]?.costUsd, carriesUsage ? 0.01692 : 0.0052)
      expectCost(calls.savedCostTotal?.usd, carriesUsage ? 0.01692 : 0.0052)
      expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: false, tokens: carriesUsage ? 18400 : 2752 })
      const tokenLine = carriesUsage
        ? lang === 'en'
          ? 'tokens · in 2,660 · cache read 14,000 · cache write 1,048 · out 692 · haiku'
          : 'トークン ・ 入力 2,660 ・ キャッシュ読込 14,000 ・ キャッシュ書込 1,048 ・ 出力 692 ・ haiku'
        : USAGE_LINE[lang] + 'haiku'
      const amount = carriesUsage ? '$0.017' : '$0.0052'
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await ui.find({ type: 'Text', text: tokenLine + COST_SUFFIX[lang](amount) })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: sessionTokenLine(lang, carriesUsage ? '18.4k' : '2.8k') + COST_SUFFIX[lang](amount) })).toBeDefined()
        await ui.unmount()
      }
    })
  }

  for (const modelThrows of [false, true]) {
    test(`${lang} ${modelThrows ? 'unavailable' : 'unknown'} session model shows full tokens without a dollar estimate on both surfaces`, { options: { language: lang, context: 'full' } }, async ($, on) => {
      const calls = engineBeneath(on, {}, { modelThrows, forkReply: { ...EXPLANATION, usage: SESSION_USAGE } })
      await ask($)
      await calls.clock.settle()
      expect(calls.fork).toBe(1)
      expect(calls.savedEntries[0]).toMatchObject({ explainState: 'done', usage: SESSION_USAGE, usageModel: 'session' })
      expect(calls.savedEntries[0]?.costUsd).toBeUndefined()
      expect(calls.savedCostTotal).toMatchObject({ usd: 0, hasPricedUsage: false, hasUnpricedUsage: true, tokens: 15648 })
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await ui.find({ type: 'Text', text: SESSION_USAGE_LINE[lang] })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: sessionTokenLine(lang, '15.6k') })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
        await ui.unmount()
      }
    })
  }

  test(`${lang} session estimate sums priced requests and appends plus for an unknown rerun on both surfaces`, { options: { language: lang } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { completeReply: { ...EXPLANATION, usage: MEASURED_USAGE }, forkReply: { ...EXPLANATION, usage: SESSION_USAGE } })
    await ask($)
    await calls.clock.settle()
    const rerun = await mountPane($, 'desktop')
    await rerun.press({ key: 'deep' })
    await calls.clock.settle()
    await rerun.unmount()
    expect(calls.savedEntries[0]?.costUsd).toBeUndefined()
    expectCost(calls.savedCostTotal?.usd, 0.0052)
    expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: true, tokens: 18400 })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: SESSION_USAGE_LINE[lang] })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: sessionTokenLine(lang, '18.4k') + COST_SUFFIX[lang]('$0.0052+') })).toBeDefined()
      await ui.unmount()
    }
  })
}

test('a fallback with unknown fork spend keeps only the Haiku estimate and marks both estimates partial', { options: { context: 'full', language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    forkReply: { isAnswered: false, reason: 'nothing-to-fork', usage: SESSION_USAGE } as ModelForkResult,
    completeReply: { ...EXPLANATION, usage: MEASURED_USAGE },
  })
  await ask($)
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toMatchObject({ usageModelId: 'claude-haiku-4-5', costIncomplete: true })
  expectCost(calls.savedEntries[0]?.costUsd, 0.0052)
  expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: true, tokens: 18400 })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'tokens · in 2,660 · cache read 14,000 · cache write 1,048 · out 692 · haiku' + COST_SUFFIX.en('$0.0052+') })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: sessionTokenLine('en', '18.4k') + COST_SUFFIX.en('$0.0052+') })).toBeDefined()
    await ui.unmount()
  }
})

test('full requests capture the current session model before completion and sum model changes', { options: { context: 'full', language: 'en' } }, async ($, on) => {
  const options: EngineOptions = { sessionModel: 'claude-opus-5-5[1m]', forkDelay: 1000, forkReply: { ...EXPLANATION, usage: MEASURED_USAGE } }
  const calls = engineBeneath(on, {}, options)
  await ask($, QUESTIONS, 'demo_priced_opus')
  await calls.clock.settle()
  options.sessionModel = 'claude-sonnet-5-5[1m]'
  await calls.clock.advance(1000)
  expect(calls.savedEntries[0]).toHaveProperty('usageModelId', 'claude-opus-5-5[1m]')
  expectCost(calls.savedEntries[0]?.costUsd, 0.0208)
  await ask($, QUESTIONS, 'demo_priced_sonnet')
  await calls.clock.settle()
  await calls.clock.advance(1000)
  expect(calls.savedEntries[1]).toHaveProperty('usageModelId', 'claude-sonnet-5-5[1m]')
  expectCost(calls.savedEntries[1]?.costUsd, 0.0104)
  expectCost(calls.savedCostTotal?.usd, 0.0312)
  expect(calls.sessionModelLookups).toBe(2)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: sessionTokenLine('en', '5.5k') + COST_SUFFIX.en('$0.031') })).toBeDefined()
    await ui.unmount()
  }
})

test('priced reruns replace entry cost while the session keeps every request', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    sessionModel: 'claude-opus-5-5', completeReply: { ...EXPLANATION, usage: MEASURED_USAGE }, forkReply: { ...EXPLANATION, usage: SESSION_USAGE },
  })
  await ask($)
  await calls.clock.settle()
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'deep' })
  expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
  expectCost(calls.savedCostTotal?.usd, 0.01692)
  await ui.press({ key: 'deep' })
  expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
  expectCost(calls.savedCostTotal?.usd, 0.02864)
  expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: false, tokens: 34048 })
  await ui.unmount()
})

test('a pending priced rerun clears the selected cost while keeping prior session spend on both surfaces', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    sessionModel: 'claude-opus-5-5', forkDelay: 1000,
    completeReply: { ...EXPLANATION, usage: MEASURED_USAGE }, forkReply: { ...EXPLANATION, usage: SESSION_USAGE },
  })
  await ask($)
  await calls.clock.settle()
  const first = await mountPane($, 'terminal')
  const rerun = first.press({ key: 'deep' })
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('explainState', 'pending')
  expect(calls.savedEntries[0]).not.toHaveProperty('costUsd')
  expect(calls.savedEntries[0]).not.toHaveProperty('costIncomplete')
  expectCost(calls.savedCostTotal?.usd, 0.0052)
  for (const surface of SURFACES) {
    const ui = surface === 'terminal' ? first : await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: sessionTokenLine('en', '2.8k') + COST_SUFFIX.en('$0.0052') })).toBeDefined()
    if (surface !== 'terminal') await ui.unmount()
  }
  await calls.clock.advance(1000)
  await rerun
  expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
  expectCost(calls.savedCostTotal?.usd, 0.01692)
  await first.unmount()
})

test('session tokens saved before pricing are marked as uncovered after a priced request on both surfaces', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
  on('state.get', { plugin: 'qa-guide', key: 'usageTotal' }, async (_$, e, next) => {
    const ran = await next(e)
    return calls.savedUsageTotal === undefined && ran.value
      ? { ...ran, value: { ...ran.value, value: 1000 } } as never
      : ran
  })
  await ask($)
  await calls.clock.settle()
  expect(calls.savedUsageTotal).toBe(3752)
  expectCost(calls.savedCostTotal?.usd, 0.0052)
  expect(calls.savedCostTotal?.tokens).toBe(2752)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: sessionTokenLine('en', '3.8k') + COST_SUFFIX.en('$0.0052+') })).toBeDefined()
    await ui.unmount()
  }
})

test('concurrent priced completions each contribute once to the session estimate', async ($, on) => {
  const calls = engineBeneath(on, {}, { completeDelay: 1000, completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
  await ask($, QUESTIONS, 'demo_priced_concurrent_first')
  await ask($, QUESTIONS, 'demo_priced_concurrent_second')
  await calls.clock.settle()
  await calls.clock.advance(1000)
  for (const entry of calls.savedEntries) expectCost(entry.costUsd, 0.0052)
  expectCost(calls.savedCostTotal?.usd, 0.0104)
  expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: false, tokens: 5504 })
})

for (const surface of SURFACES) {
  test(`superseded priced compact usage is retained in the session without overwriting the full estimate on ${surface}`, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      sessionModel: 'claude-opus-5-5', toolDelay: 100, completeDelay: 1000,
      forkReply: { ...EXPLANATION, text: 'CURRENT_FULL_DEMO', usage: SESSION_USAGE },
      completeReply: { isAnswered: false, reason: 'empty-reply', usage: MEASURED_USAGE },
    })
    const asked = ask($)
    await calls.clock.settle()
    await calls.clock.advance(100)
    await asked
    const ui = await mountPane($, surface)
    await ui.press({ key: 'deep' })
    expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
    expectCost(calls.savedCostTotal?.usd, 0.01172)
    await calls.clock.advance(900)
    expect(calls.savedEntries[0]).toMatchObject({ explainState: 'done', explanation: 'CURRENT_FULL_DEMO', usageModelId: 'claude-opus-5-5' })
    expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
    expectCost(calls.savedCostTotal?.usd, 0.01692)
    expect(calls.savedCostTotal).toMatchObject({ hasPricedUsage: true, hasUnpricedUsage: false, tokens: 18400 })
    await ui.unmount()
  })
}

test('prompt submission records only the person origins and forwards every original input unchanged', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  const excludedOrigins: PromptOrigin[] = [
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'projects-relay' },
    { kind: 'channel', server: 'demo-channel' },
    { kind: 'coordinator' },
    { kind: 'observer' },
    { kind: 'observer-activity' },
    { kind: 'auto-continuation' },
    { kind: 'unclassified' },
    { kind: 'slack-ping' },
    { kind: 'plugin', name: 'demo-plugin' },
    { kind: 'plugin', name: 'demo-plugin', asUser: true },
  ]
  for (const origin of excludedOrigins) {
    const text = origin.kind === 'task-notification'
      ? '<task-notification>Background demo task finished.</task-notification>'
      : `Injected message from ${origin.kind}.`
    await submit($, text, origin)
  }
  expect(calls.savedPrompts).toEqual([])

  const inputs: PromptSubmitInput[] = ['composer', 'bridge', 'sdk'].map(kind => ({
    text: `Continue the demo from ${kind}.`,
    origin: { kind } as PromptOrigin,
    wait: true,
    turnId: 'demo-turn',
    context: ['Demo context supplied by the engine.'],
    attachments: [{ type: 'image', mediaType: 'image/png', filename: 'demo.png' }],
  }))
  for (const input of inputs) {
    expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
  }
  expect(calls.submitted.slice(-3)).toEqual(inputs)
  expect(calls.savedPrompts).toEqual(inputs.map(input => input.text))
})

test('recorded prompts retain the last five and cap each at 600 characters without changing the submission', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  const texts = Array.from({ length: 7 }, (_, i) => `Demo instruction ${i + 1}: ${'x'.repeat(650)}`)
  for (const text of texts) await submit($, text)
  await submit($, ' \n\t ')

  const saved = calls.savedPrompts
  expect(saved).toEqual(texts.slice(-5).map(text => text.slice(0, 600)))
  expect(calls.submitted.map(input => input.text)).toEqual([...texts, ' \n\t '])
  for (const text of saved) expect(text.length).toBeLessThanOrEqual(600)
})

test('a failed prompt history write still forwards the person prompt unchanged', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  let failedWrites = 0
  on('state.set', { plugin: 'qa-guide', key: 'prompts' }, () => {
    failedWrites += 1
    throw new Error('Demo state storage is unavailable.')
  })
  const input: PromptSubmitInput = {
    text: 'Keep working on the demo even when guide storage is unavailable.',
    origin: { kind: 'composer' },
    wait: false,
    context: ['Preserve this demo context.'],
  }
  expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
  expect(calls.submitted).toEqual([input])
  expect(failedWrites).toBe(1)
})

test('questions snapshot the latest three recorded prompts in order and include them as quoted compact data', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { messages: [
    { role: 'user', text: '<task-notification>Background demo task finished.</task-notification>', toolUses: [] },
    { role: 'assistant', text: 'Now choose demo storage.', toolUses: [] },
  ] })
  const prompts = [
    'Start with a demo task board.',
    'Keep the interface minimal.',
    'Use local storage for the demo.',
    'Explain any storage tradeoffs before proceeding.',
  ]
  for (const prompt of prompts) await submit($, prompt)
  await submit($, '<task-notification>Background demo task finished.</task-notification>', { kind: 'task-notification' })
  await ask($)

  expect(calls.savedEntries[0]?.userPrompts).toEqual(prompts.slice(-3))
  const forkPrompt = calls.completePrompts[0] ?? ''
  expect(forkPrompt).toContain('### いまの指示（概要）')
  expect(forkPrompt.indexOf('### いまの指示（概要）')).toBeLessThan(forkPrompt.indexOf('### なぜ聞いているか'))
  for (const prompt of prompts.slice(-3)) {
    expect(forkPrompt).toContain(prompt)
    expect(forkPrompt.includes(JSON.stringify(prompt)) || forkPrompt.includes(`> ${prompt}`)).toBe(true)
  }
  expect(forkPrompt).not.toContain(prompts[0]!)
  expect(forkPrompt).not.toContain('<task-notification>')
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /あなたの最近の指示/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /^• / })
    expect(rows.map(row => row.text)).toEqual(prompts.slice(-3).map(prompt => `• ${prompt}`))
    expect(await ui.find({ text: /<task-notification>/ })).toBeUndefined()
    await ui.unmount()
  }

  await submit($, 'Add a demo search field next.')
  await ask($, QUESTIONS, 'toolu_2')
  expect(calls.savedEntries[0]?.userPrompts).toEqual(prompts.slice(-3))
  expect(calls.savedEntries[1]?.userPrompts).toEqual([...prompts.slice(-2), 'Add a demo search field next.'])
  await calls.clock.settle()
})

test('the compact prompt requires short numbered guidance in dialog order for each question', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  const prompt = calls.completePrompts[0] ?? ''
  const headings = ['### いまの指示（概要）', '### なぜ聞いているか', '### 選択肢ごとの影響', '### おすすめ']
  for (const [i, heading] of headings.entries()) {
    expect(prompt).toContain(heading)
    if (i > 0) expect(prompt.indexOf(headings[i - 1]!)).toBeLessThan(prompt.indexOf(heading))
  }
  const sections = headings.map((heading, i) => prompt.slice(prompt.indexOf(heading), i + 1 < headings.length ? prompt.indexOf(headings[i + 1]!) : undefined))
  expect(/2\s*[〜～-]\s*3\s*行/.test(sections[0]!)).toBe(true)
  expect(/1\s*[〜～-]\s*2\s*行/.test(sections[1]!)).toBe(true)
  expect(sections[2]).toContain('1. <label>:')
  expect(/ダイアログ.*選択肢.*順|選択肢.*ダイアログ.*順/.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('番号')
  expect(/1\s*行/.test(sections[2]!)).toBe(true)
  expect(/1\s*文/.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('#### Q<n>.')
  expect(/1.*(?:再開|始め|戻)|(?:再開|始め|戻).*1/.test(sections[2]!)).toBe(true)
  expect(/Other.*(?:ない|不要|禁止)/.test(sections[2]!)).toBe(true)
  expect(sections[3]).toContain('→ 2. <label>:')
  expect(sections[3]).toContain('→ Q1: 2. <label>')
  expect(/1\s*行/.test(sections[3]!)).toBe(true)
  for (const forbidden of ['長い段落', '表', 'コードブロック']) expect(prompt).toContain(forbidden)
  expect(prompt).toContain(JSON.stringify(NUMBERED_QUESTIONS, null, 1))
})

test('session fallback keeps the latest three person rows and skips XML, empty and tool result rows', { options: { language: 'ja' } }, async ($, on) => {
  const humanTexts = ['Earlier demo task.', 'Build a demo task board.', 'Keep the interface minimal.', 'Use SQLite for the demo.']
  const calls = engineBeneath(on, {}, { messages: [
    { role: 'user', text: humanTexts[0]!, toolUses: [] },
    { role: 'user', text: humanTexts[1]!, toolUses: [] },
    { role: 'user', text: '  <command-message>demo command</command-message>', toolUses: [] },
    { role: 'user', text: humanTexts[2]!, toolUses: [] },
    { role: 'user', text: '\n<system-reminder>Demo reminder.</system-reminder>', toolUses: [] },
    { role: 'user', text: 'Tool result is not a person instruction.', toolUses: [], toolResults: [
      { tool_use_id: 'toolu_demo', text: 'Demo scaffold finished.', isError: false },
    ] },
    { role: 'user', text: `  ${humanTexts[3]}  `, toolUses: [] },
    { role: 'user', text: ' \n ', toolUses: [] },
    { role: 'user', text: '\t<task-notification>Demo task finished.</task-notification>', toolUses: [] },
    { role: 'assistant', text: 'Choose the demo database.', toolUses: [] },
  ] })
  await ask($)

  expect(calls.savedEntries[0]?.userPrompts).toEqual(humanTexts.slice(-3))
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /あなたの最近の指示/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^• / })).map(row => row.text))
      .toEqual(humanTexts.slice(-3).map(text => `• ${text}`))
    expect(await ui.find({ text: /<task-notification>|<system-reminder>|<command-message>|Tool result is not/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an open pane shows only the newest composer instruction on at most two compact lines', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 10, messages: [
    { role: 'user', text: '<task-notification>Demo task finished.</task-notification>', toolUses: [] },
  ] })
  await submit($, 'OLDER_DEMO: build a task board.')
  await submit($, 'MIDDLE_DEMO: keep storage local.')
  await submit($, 'NEWEST_DEMO: explain the database tradeoffs.\nKeep the answer concise.')
  const pending = ask($)
  await calls.clock.settle()
  await calls.clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, COMPACT_PROPS)
    const rows = compactTextRows(await ui.drawn())
    const instructionIndex = rows.findIndex(row => row.text.includes('▍あなたの最近の指示'))
    expect(instructionIndex).toBeGreaterThanOrEqual(0)
    const instructions = rows.slice(instructionIndex + 1)
    expect(instructions).toHaveLength(2)
    expect(joinRows(instructions.map(row => row.text))).toContain('NEWEST_DEMO: explain the database tradeoffs.')
    expect(joinRows(instructions.map(row => row.text))).toContain('Keep the answer concise.')
    for (const row of instructions) {
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    expect(await ui.find({ text: /OLDER_DEMO|MIDDLE_DEMO|<task-notification>/ })).toBeUndefined()
    expect(rows.length).toBeLessThanOrEqual(20)
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('compact AI guidance strips Markdown markers, styles headings and keeps readable bullets', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: { ...EXPLANATION, text: [
      '### いまの指示（概要）',
      '**Build a demo task board.**',
      'Keep storage local and explain tradeoffs.',
      '### なぜ聞いているか',
      'Choose a database before saving demo tasks.',
      '### 選択肢ごとの影響',
      '- **SQLite** keeps setup simple.',
      '### おすすめ',
      '**Use SQLite.**',
    ].join('\n') },
  })
  const pending = ask($)
  await calls.clock.settle()
  await calls.clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const rows = compactTextRows(await ui.find({ key: 'compact-ai' }))
    expect(rows[0]?.text).toContain('いまの指示（概要）')
    for (const heading of ['いまの指示（概要）', 'なぜ聞いているか', '選択肢ごとの影響', 'おすすめ']) {
      const row = rows.find(row => row.text.includes(heading))
      expect(row).toBeDefined()
      expect(row?.props.bold).toBe(true)
      expect(row?.props.color).toBe('magenta')
    }
    expect(rows.some(row => /^・\s*SQLite keeps setup simple\.$/.test(row.text))).toBe(true)
    expect(rows.some(row => row.text.includes('Build a demo task board.'))).toBe(true)
    for (const row of rows) {
      expect(row.text).not.toContain('###')
      expect(row.text).not.toContain('**')
      expect(row.text.startsWith('- ')).toBe(false)
    }
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('compact numbered guidance has cyan number chips, bold labels and green recommendations on each surface', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 10, completeReply: NUMBERED_EXPLANATION })
  const pending = ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  await calls.clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const chips = await ui.findAll({ type: 'Text', text: /^\s*[12]\s*$/ })
    expect(chips.map(chip => chip.text.trim())).toEqual(['1', '2', '1', '2'])
    for (const chip of chips) {
      expect(chip.props.bold).toBe(true)
      expect(chip.props.color).toBe('cyan')
    }
    for (const label of ['SQLite', 'PostgreSQL', 'DOM', 'Canvas']) {
      const node = await ui.find({ type: 'Text', text: new RegExp(`^\\s*${label}[:：]?\\s*$`) })
      expect(node).toBeDefined()
      expect(node?.props.bold).toBe(true)
    }
    const aiRows = compactTextRows(await ui.find({ key: 'compact-ai' }))
    for (const effect of ['Keeps demo setup simple.', 'Matches production storage.', 'Uses native controls.', 'Allows flexible drawing.']) {
      const row = aiRows.find(row => row.text.includes(effect))
      expect(row).toBeDefined()
      expect(row?.props.bold ?? false).toBe(false)
    }
    for (const recommendation of ['→ Q1: 1. SQLite: Simple demo setup.', '→ Q2: 2. Canvas: Clear drawing.']) {
      const node = await ui.find({ type: 'Text', text: new RegExp(`^${recommendation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
      expect(node).toBeDefined()
      expect(node?.props.bold).toBe(true)
      expect(node?.props.color).toBe('green')
    }
    for (const heading of ['いまの指示（概要）', 'なぜ聞いているか', '選択肢ごとの影響', 'Q1. Database', 'Q2. Drawing', 'おすすめ']) {
      const index = aiRows.findIndex(row => row.text.includes(heading))
      expect(index).toBeGreaterThanOrEqual(0)
      expect(aiRows[index]?.props.bold).toBe(true)
      expect(aiRows[index]?.props.color).toBe('magenta')
      if (index === 0) continue
      expect(aiRows[index - 1]?.text.trim()).toBe('')
      if (index > 1) expect(aiRows[index - 2]?.text.trim()).not.toBe('')
    }
    expect(aiRows[0]?.text.trim()).not.toBe('')
    for (const row of aiRows) {
      expect(row.text).not.toContain('###')
      expect(row.text).not.toContain('**')
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
    }
    const rows = compactTextRows(await ui.drawn())
    for (const heading of ['▍あなたの最近の指示', '▍直前の Claude の説明']) {
      const index = rows.findIndex(row => row.text.includes(heading))
      expect(index).toBeGreaterThan(0)
      expect(rows[index - 1]?.text.trim()).toBe('')
      expect(rows[index - 2]?.text.trim()).not.toBe('')
    }
    expect(rows.length).toBeLessThanOrEqual(PANE_PROPS.scroll!.bodyRows)
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('compact spacers never displace numbered AI content when the row budget is short', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: NUMBERED_EXPLANATION,
    messages: [
      { role: 'user', text: `CURRENT_DEMO: ${'Build a local task board. '.repeat(10)}`, toolUses: [] },
      { role: 'assistant', text: LONG_LEAD, toolUses: [] },
    ],
  })
  const pending = ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  await calls.clock.advance(10)
  for (const bodyRows of [8, 20]) {
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { ...PANE_PROPS, scroll: { offset: 0, bodyRows } })
      const rows = compactTextRows(await ui.drawn())
      const aiRows = compactTextRows(await ui.find({ key: 'compact-ai' }))
      expect(rows.length).toBeLessThanOrEqual(bodyRows)
      expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
      expect(rows.some(row => !row.text.trim())).toBe(false)
      expect(aiRows[0]?.text).toContain('いまの指示（概要）')
      expect(aiRows[aiRows.length - 1]?.text).toBe('…')
      if (bodyRows === 20) {
        expect(aiRows).toHaveLength(13)
        const chips = await ui.findAll({ type: 'Text', text: /^\s*[12]\s*$/ })
        expect(chips.map(chip => chip.text.trim())).toEqual(['1', '2', '1', '2'])
        expect(aiRows[aiRows.length - 2]?.text).toContain('Canvas')
        expect(await ui.find({ type: 'Text', text: /LEAD_TAIL/ })).toBeDefined()
      }
      await ui.unmount()
    }
  }
  await calls.clock.advance(990)
  await pending
})

test('wrapped numbered option continuations align after the chip in a narrow compact pane', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: { ...EXPLANATION, text: [
      '### Options',
      `1. SQLite: ${'a'.repeat(48)}`,
      '2) PostgreSQL：Uses production storage.',
      '### おすすめ',
      '→ 1. SQLite: Fits the demo.',
    ].join('\n') },
  })
  const pending = ask($)
  await calls.clock.settle()
  await calls.clock.advance(10)
  for (const surface of SURFACES) {
    const props: RenderPropsOf['Pane'] = { ...PANE_PROPS, bodyColumns: 20 }
    const ui = await mountPane($, surface, props)
    const aiRows = compactTextRows(await ui.find({ key: 'compact-ai' }))
    const firstIndex = aiRows.findIndex(row => row.text.includes('SQLite') && !row.text.startsWith('→'))
    const nextIndex = aiRows.findIndex(row => row.text.includes('PostgreSQL'))
    expect(firstIndex).toBeGreaterThanOrEqual(0)
    expect(nextIndex - firstIndex).toBeGreaterThan(2)
    const indent = aiRows[firstIndex]!.text.indexOf('SQLite')
    expect(indent).toBeGreaterThan(0)
    const continuations = aiRows.slice(firstIndex + 1, nextIndex)
    for (const row of continuations) {
      expect(row.text.slice(0, indent)).toBe(' '.repeat(indent))
      expect(row.text.trim()).toContain('a')
      expect(row.text.length).toBeLessThanOrEqual(20)
      expect(row.props.bold ?? false).toBe(false)
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
    }
    const chips = await ui.findAll({ type: 'Text', text: /^\s*[12]\s*$/ })
    expect(chips.map(chip => chip.text.trim())).toEqual(['1', '2'])
    expect(await ui.find({ type: 'Text', text: /^\s*SQLite[:：]?\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*PostgreSQL[:：]?\s*$/ })).toBeDefined()
    const rows = compactTextRows(await ui.drawn())
    expect(rows.length).toBeLessThanOrEqual(props.scroll!.bodyRows)
    for (const row of rows) {
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('an open question fits 20 background-only rows with AI, the newest instruction and lead tail on each surface', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: LONG_EXPLANATION,
    messages: [
      { role: 'user', text: 'OLDER_REQUEST: build the initial demo.', toolUses: [] },
      { role: 'user', text: `REQUEST_START ${'Build a demo with many useful details. '.repeat(20)}`, toolUses: [] },
      { role: 'assistant', text: LONG_LEAD, toolUses: [] },
    ],
  })
  const pending = ask($, COMPACT_QUESTIONS)
  await calls.clock.settle()
  await calls.clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, COMPACT_PROPS)
    expect(await ui.find({ type: 'Text', text: /回答待ち/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /質問の背景/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\(回答後に p\/n で過去の質問\)$/ }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: /AI_ORIGIN/ })).toBeDefined()
    expect(await ui.find({ text: /AI_END/ })).toBeUndefined()
    const aiRows = compactTextRows(await ui.find({ key: 'compact-ai' }))
    expect(aiRows.length).toBeGreaterThan(8)
    expect(aiRows.length).toBeLessThanOrEqual(13)
    expect(aiRows[aiRows.length - 1]?.text).toBe('…')
    for (const question of COMPACT_QUESTIONS) {
      expect(await ui.find({ text: new RegExp(question.header) })).toBeUndefined()
      expect(await ui.find({ text: /Question \d+:|Explain the preferred approach/ })).toBeUndefined()
      for (const option of question.options) {
        expect(await ui.find({ text: new RegExp(option.label) })).toBeUndefined()
      }
    }
    expect(await ui.find({ text: /Description with a long detail|PREVIEW_/ })).toBeUndefined()
    expect(await ui.find({ text: /Claude からの質問/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    const rows = compactTextRows(await ui.drawn())
    const instructionIndex = rows.findIndex(row => row.text.includes('▍あなたの最近の指示'))
    const leadIndex = rows.findIndex(row => row.text.includes('▍直前の Claude の説明'))
    expect(instructionIndex).toBeGreaterThan(0)
    expect(leadIndex - instructionIndex - 1).toBe(2)
    expect(rows[instructionIndex + 1]?.text).toContain('REQUEST_START')
    expect(await ui.find({ text: /OLDER_REQUEST/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /LEAD_TAIL/ })).toBeDefined()
    expect(await ui.find({ text: /LEAD_HEAD/ })).toBeUndefined()
    expect(rows.length).toBeLessThanOrEqual(20)
    expect(rows.length).toBe(20)
    expect(await ui.find({ type: 'Text', text: USAGE_PATTERN })).toBeUndefined()
    for (const row of rows) {
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    expect((await ui.find({ type: 'Box' }))?.props.width).toBe(60)
    await ui.unmount()
  }

  await calls.clock.advance(990)
  await pending
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, COMPACT_PROPS)
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /PREVIEW_1_1/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /AI_END/ })).toBeDefined()
    expect(await ui.find({ key: 'ai' })).toBeDefined()
    expect(await ui.find({ key: 'hist' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

for (const explainState of ['off', 'pending', 'error'] as const) {
  test(`compact ${explainState} AI guidance gives unused rows to instruction and lead context`, { options: { language: 'ja' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      toolDelay: 1000,
      completeDelay: explainState === 'pending' ? 2000 : 10,
      completeReply: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as ModelCompleteResult,
      messages: [
        { role: 'user', text: `NEWEST_CONTEXT: ${'Build the demo carefully. '.repeat(20)}`, toolUses: [] },
        { role: 'assistant', text: LONG_LEAD, toolUses: [] },
      ],
    })
    if (explainState === 'off') {
      const ui = await mountPane($, 'terminal')
      await ui.press({ key: 'ai' })
      await ui.unmount()
    }
    const pending = ask($, COMPACT_QUESTIONS)
    await calls.clock.settle()
    if (explainState === 'error') await calls.clock.advance(10)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, COMPACT_PROPS)
      expect(await ui.find({ type: 'Text', text: explainState === 'off' ? /OFF/ : explainState === 'pending' ? /生成中/ : /解説を生成できませんでした: empty-reply/ })).toBeDefined()
      const rows = compactTextRows(await ui.drawn())
      const instructionIndex = rows.findIndex(row => row.text.includes('▍あなたの最近の指示'))
      const leadIndex = rows.findIndex(row => row.text.includes('▍直前の Claude の説明'))
      expect(leadIndex - instructionIndex - 1).toBe(2)
      expect(rows[instructionIndex + 1]?.text).toContain('NEWEST_CONTEXT')
      expect(rows.length - leadIndex - 1).toBeGreaterThanOrEqual(12)
      expect(rows[rows.length - 1]?.text).toContain('LEAD_TAIL')
      expect(rows.length).toBe(20)
      expect(await ui.find({ text: /Choice\d+|Question \d+:|PREVIEW_/ })).toBeUndefined()
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
      await ui.unmount()
    }
    await calls.clock.advance(2000)
    await pending
    if (explainState === 'off') {
      expect(calls.fork).toBe(0)
      expect(calls.complete).toBe(0)
    }
  })
}

test('compact rows remain bounded with full-width text in a narrow pane', { options: { language: 'ja' } }, async ($, on) => {
  const questions: Questions = [{
    question: 'データベースの構成と移行方針をどのように決定しますか？'.repeat(4),
    header: '構成',
    multiSelect: false,
    options: [
      { label: '全角Ａ案', description: '移行しやすい構成を\n優先します。'.repeat(8), preview: 'NARROW_PREVIEW' },
      { label: '全角Ｂ案', description: '本番との互換性を優先します。'.repeat(8), preview: 'NARROW_PREVIEW' },
    ],
  }]
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: { ...EXPLANATION, text: `理由は全角文字でも行数を制限するためです。${'背景と影響を確認して選択します。'.repeat(40)}` },
    messages: [
      { role: 'user', text: '全角文字の幅を考慮して実装してください。'.repeat(10), toolUses: [] },
      { role: 'assistant', text: `${'説明の先頭です。'.repeat(40)}\n終端の判断理由です。`, toolUses: [] },
    ],
  })
  const pending = ask($, questions)
  await calls.clock.settle()
  await calls.clock.advance(10)
  const props: RenderPropsOf['Pane'] = { ...COMPACT_PROPS, bodyColumns: 18, scroll: { offset: 0, bodyRows: 20 } }
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, props)
    const rows = compactTextRows(await ui.drawn())
    expect(rows.length).toBeLessThanOrEqual(20)
    for (const row of rows) {
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    expect((await ui.find({ type: 'Box' }))?.props.width).toBe(18)
    expect(await ui.find({ type: 'Text', text: /^✦ AI解説… 要点のみ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /全角Ａ案|全角Ｂ案|構成と移行方針/ })).toBeUndefined()
    expect(await ui.find({ text: /NARROW_PREVIEW/ })).toBeUndefined()
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('a taller compact pane clamps AI guidance to 65 percent and marks omitted lines', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    completeDelay: 10,
    completeReply: LONG_EXPLANATION,
    messages: [
      { role: 'user', text: 'Build the current demo.', toolUses: [] },
      { role: 'assistant', text: LONG_LEAD, toolUses: [] },
    ],
  })
  const pending = ask($, COMPACT_QUESTIONS)
  await calls.clock.settle()
  await calls.clock.advance(10)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, PANE_PROPS)
    const aiBox = await ui.find({ key: 'compact-ai' })
    expect(aiBox?.type).toBe('Box')
    const aiRows = compactTextRows(aiBox)
    expect(aiRows.length).toBeGreaterThan(1)
    expect(aiRows.length).toBeGreaterThan(16)
    expect(aiRows.length).toBeLessThanOrEqual(26)
    expect(aiRows[0]?.text).toContain('AI_ORIGIN')
    expect(aiRows[aiRows.length - 1]?.text).toBe('…')
    expect(await ui.find({ text: /AI_END/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(40)
    for (const question of COMPACT_QUESTIONS) {
      for (const option of question.options) {
        expect(await ui.find({ type: 'Text', text: new RegExp(option.label) })).toBeUndefined()
      }
    }
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('zero, one and tiny pane row budgets drop content without overflowing', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 2000 })
  const pending = ask($, COMPACT_QUESTIONS)
  await calls.clock.settle()
  for (const bodyRows of [0, 1, 2, 5]) {
    for (const surface of SURFACES) {
      const props: RenderPropsOf['Pane'] = { ...PANE_PROPS, scroll: { offset: 0, bodyRows } }
      const ui = await mountPane($, surface, props)
      const rows = compactTextRows(await ui.drawn())
      expect(rows.length).toBeLessThanOrEqual(bodyRows)
      for (const row of rows) {
        if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
        expect(row.text).not.toContain('\n')
      }
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
      if (bodyRows === 0) {
        expect(await ui.find({ text: /回答待ち/ })).toBeUndefined()
      } else {
        expect(await ui.find({ type: 'Text', text: /回答待ち/ })).toBeDefined()
      }
      if (bodyRows >= 2) expect(await ui.find({ type: 'Text', text: /生成中/ })).toBeDefined()
      await ui.unmount()
    }
  }
  await calls.clock.advance(2000)
  await pending
})

test('cancelling the dialog restores full previews and toolbar', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, 'deny')
  await ask($, COMPACT_QUESTIONS)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, COMPACT_PROPS)
    expect(await ui.find({ type: 'Text', text: /キャンセル/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /PREVIEW_3_4/ })).toBeDefined()
    expect(await ui.find({ key: 'ai' })).toBeDefined()
    expect(await ui.find({ key: 'hist' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

// ui.mount exposes a drawing but does not register an engine scroll site.
// Verify the documented scroll request and failures at the shared UI boundary.
test('each question pane opens completely before requesting its scroll start', { options: { language: 'ja' } }, async () => {
  const order: string[] = []
  const opened: PaneOpenArgs[] = []
  const scrolled: UiScrollArgs[] = []
  const result = { isPlaced: true } as const
  const ui = {
    open: async (args: PaneOpenArgs) => {
      order.push('open')
      opened.push(args)
      await Promise.resolve()
      order.push('placed')
      return result
    },
    scroll: async (args: UiScrollArgs) => {
      order.push('scroll')
      scrolled.push(args)
      return {}
    },
  }
  expect(await openQuestionPane(ui)).toBe(result)
  expect(await openQuestionPane(ui)).toBe(result)
  expect(order).toEqual(['open', 'placed', 'scroll', 'open', 'placed', 'scroll'])
  expect(opened).toEqual([
    { id: 'qa-guide', title: '質問ガイド' },
    { id: 'qa-guide', title: '質問ガイド' },
  ])
  expect(scrolled).toEqual([
    { in: 'qa-guide', to: 'start' },
    { in: 'qa-guide', to: 'start' },
  ])
})

for (const failure of ['deny', 'throw'] as const) {
  test(`a ${failure} scroll failure preserves the opened question pane result`, { options: { language: 'ja' } }, async () => {
    const opened = { isPlaced: false, reason: 'The pane is not drawn.' } as const
    const order: string[] = []
    const scrolled: UiScrollArgs[] = []
    const ui = {
      open: async (args: PaneOpenArgs) => {
        expect(args).toEqual({ id: 'qa-guide', title: '質問ガイド' })
        order.push('open')
        return opened
      },
      scroll: async (args: UiScrollArgs) => {
        order.push('scroll')
        scrolled.push(args)
        if (failure === 'throw') throw new Error('The pane is no longer drawn.')
        return { deny: 'The pane cannot scroll.' }
      },
    }
    expect(await openQuestionPane(ui)).toBe(opened)
    expect(order).toEqual(['open', 'scroll'])
    expect(scrolled).toEqual([{ in: 'qa-guide', to: 'start' }])
  })
}

test('a question still answers when the engine has no drawn pane to scroll', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, { isPlaced: false })
  const ran = await ask($)
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: '質問ガイド' }])
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an answered question shows context, options and the chosen answer', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'PostgreSQL' })
  const ran = await ask($)

  expect(calls.complete).toBe(1)
  expect(ran).toEqual({
    result: { questions: QUESTIONS, answers: { 'Which database should the demo app use?': 'PostgreSQL' } },
    ref: 7,
    text: '{"Which database should the demo app use?":"PostgreSQL"}',
    isReadOnly: true,
  })
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /回答済み/ })).toBeDefined()
    expect(await ui.find({ text: /Build a demo todo app/ })).toBeDefined()
    expect(await ui.find({ text: /Next I need a database/ })).toBeDefined()
    expect(await ui.find({ text: /Database/ })).toBeDefined()
    expect(await ui.find({ text: /Closer to production/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. SQLite$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /✔ PostgreSQL/ }))?.props.color).toBe('green')
    expect(await ui.find({ text: /なぜ聞いているか/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /選択肢ごとの影響/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /おすすめ/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a dismissed question is marked cancelled', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, 'deny')
  await ask($)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /キャンセル/ })).toBeDefined()
    await ui.unmount()
  }
})

test('turning the AI explanation off skips the completion', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'ai' }))?.props.hotkey).toBe('a')
  await ui.press({ key: 'ai' })
  await ui.unmount()

  await ask($)

  expect(calls.fork).toBe(0)
  expect(calls.complete).toBe(0)
  const after = await mountPane($, 'terminal')
  expect(await after.find({ text: /AI解説: OFF/ })).toBeDefined()
  await after.press({ key: 'ai' })
  await after.unmount()

  await ask($, QUESTIONS, 'toolu_2')
  expect(calls.complete).toBe(1)
  const enabled = await mountPane($, 'terminal')
  expect(await enabled.find({ text: /AI解説: ON/ })).toBeDefined()
  expect(await enabled.find({ text: /なぜ聞いているか/ })).toBeDefined()
  await enabled.unmount()
})

const NAV_QUESTIONS: Questions[] = ['oldest', 'middle', 'newest'].map(name => [{
  question: `Which ${name} demo approach should we use?`,
  header: `${name} approach`,
  multiSelect: false,
  options: [
    { label: `${name} chosen`, description: `The selected ${name} approach.` },
    { label: `${name} alternate`, description: `The other ${name} approach.` },
  ],
}])

async function fillNavigationHistory($: Engine, options: EngineOptions) {
  for (const [index, questions] of NAV_QUESTIONS.entries()) {
    const name = ['oldest', 'middle', 'newest'][index]!
    await submit($, `${name.toUpperCase()}_INSTRUCTION: review this demo approach.`)
    options.messages = [{ role: 'assistant', text: `${name.toUpperCase()}_LEAD: here is the demo context.`, toolUses: [] }]
    options.completeReply = { ...EXPLANATION, text: `${name.toUpperCase()}_AI: this is why we ask.` }
    await ask($, questions, `toolu_navigation_${index}`)
  }
}

const NAV_ANSWERS = Object.fromEntries(NAV_QUESTIONS.map(questions => [questions[0]!.question, questions[0]!.options[0]!.label]))

async function expectNavigationUnavailable(ui: Awaited<ReturnType<typeof mountPane>>, key: string) {
  const button = await ui.find({ key })
  if (button) expect(button.props.disabled ?? button.props.isDisabled).toBe(true)
}

test('prev next and latest navigate selected question context and answers on each surface', { options: { language: 'ja' } }, async ($, on) => {
  const options: EngineOptions = {}
  const calls = engineBeneath(on, NAV_ANSWERS, options)
  await fillNavigationHistory($, options)

  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, { ...PANE_PROPS, isFocused: true })
    const selected = async (index: number) => {
      const question = NAV_QUESTIONS[index]![0]!
      const name = ['OLDEST', 'MIDDLE', 'NEWEST'][index]!
      expect(await ui.find({ type: 'Text', text: new RegExp(`^Q1\\. ${question.question.replace('?', '\\?')}$`) })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: new RegExp(`^✔ ${question.options[0]!.label}$`) }))?.props.color).toBe('green')
      expect(await ui.find({ type: 'Text', text: new RegExp(`${name}_INSTRUCTION`) })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: new RegExp(`${name}_LEAD`) })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: new RegExp(`${name}_AI`) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${3 - index}/3$`) })).toBeDefined()
      for (const [other, questions] of NAV_QUESTIONS.entries()) {
        if (other !== index) {
          expect(await ui.find({ type: 'Text', text: new RegExp(questions[0]!.question.replace('?', '\\?')) })).toBeUndefined()
          expect(await ui.find({ type: 'Text', text: new RegExp(`^✔ ${questions[0]!.options[0]!.label}$`) })).toBeUndefined()
        }
      }
    }
    await selected(2)
    expect((await ui.find({ key: 'prev' }))?.props).toHaveProperty('hotkey', 'p')
    expect((await ui.find({ key: 'prev' }))?.props).toHaveProperty('label', '◀ 前')
    await expectNavigationUnavailable(ui, 'next')
    await expectNavigationUnavailable(ui, 'latest')
    await ui.press({ key: 'prev' })
    expect(calls.savedCursor).toBe(1)
    await selected(1)
    expect((await ui.find({ key: 'next' }))?.props).toHaveProperty('hotkey', 'n')
    expect((await ui.find({ key: 'next' }))?.props).toHaveProperty('label', '次 ▶')
    expect((await ui.find({ key: 'latest' }))?.props).toHaveProperty('hotkey', 'l')
    expect((await ui.find({ key: 'latest' }))?.props).toHaveProperty('label', '最新')
    await ui.press({ key: 'prev' })
    expect(calls.savedCursor).toBe(2)
    await selected(0)
    await expectNavigationUnavailable(ui, 'prev')
    await ui.press({ key: 'next' })
    await selected(1)
    await ui.press({ key: 'next' })
    await selected(2)
    await expectNavigationUnavailable(ui, 'next')
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'latest' })
    expect(calls.savedCursor).toBe(0)
    await selected(2)
    await ui.unmount()
  }
})

for (const [cursor, index] of [[-9, 2], [99, 0]] as const) {
  test(`a stored cursor of ${cursor} clamps to the available entry range on every render`, { options: { language: 'ja' } }, async ($, on) => {
    const options: EngineOptions = {}
    engineBeneath(on, NAV_ANSWERS, options)
    await fillNavigationHistory($, options)
    options.cursor = cursor
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const question = NAV_QUESTIONS[index]![0]!
      expect(await ui.find({ type: 'Text', text: new RegExp(`^Q1\\. ${question.question.replace('?', '\\?')}$`) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`^✔ ${question.options[0]!.label}$`) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${3 - index}/3$`) })).toBeDefined()
      await expectNavigationUnavailable(ui, cursor < 0 ? 'next' : 'prev')
      await ui.unmount()
    }
  })
}

test('a historical open entry uses the full layout while the newest question is answered', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { cursor: 1 })
  const history: QaEntry[] = NAV_QUESTIONS.map((questions, index) => ({
    id: `toolu_retained_${index}`,
    lang: 'ja',
    askedAt: index + 1,
    userPrompts: [`RETAINED_INSTRUCTION_${index}: review the demo.`],
    lead: `RETAINED_LEAD_${index}: the decision background.`,
    questions,
    explainMode: 'full',
    explainState: 'off',
    explanation: '',
    status: index === 1 ? 'open' : 'answered',
    answers: index === 1 ? {} : { [questions[0]!.question]: questions[0]!.options[0]!.label },
  }))
  on('state.get', { plugin: 'qa-guide', key: 'entries' }, () => ({ value: { value: history, version: 1 } }))
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, COMPACT_PROPS)
    expect(await ui.find({ type: 'Text', text: /^Q1\. Which middle demo approach should we use\?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. middle chosen$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2\. middle alternate$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /RETAINED_LEAD_1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /RETAINED_INSTRUCTION_1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2\/3$/ })).toBeDefined()
    expect(await ui.find({ key: 'prev' })).toBeDefined()
    expect(await ui.find({ key: 'next' })).toBeDefined()
    expect(await ui.find({ key: 'latest' })).toBeDefined()
    expect(await ui.find({ key: 'ai' })).toBeDefined()
    expect(await ui.find({ key: 'hist' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    expect(await ui.find({ text: /質問の背景/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a new question resets history cursor and compact context always describes the newest open entry', { options: { language: 'ja' } }, async ($, on) => {
  const options: EngineOptions = {}
  const calls = engineBeneath(on, NAV_ANSWERS, options)
  await fillNavigationHistory($, options)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(calls.savedCursor).toBe(2)
  await ui.unmount()

  await submit($, 'ARRIVING_INSTRUCTION: review the fresh demo decision.')
  options.messages = [{ role: 'assistant', text: 'ARRIVING_LEAD: the fresh decision is next.', toolUses: [] }]
  options.completeReply = { ...EXPLANATION, text: 'ARRIVING_AI: the fresh decision needs background.' }
  options.toolDelay = 1000
  options.completeDelay = 10
  const pending = ask($, [{ ...QUESTIONS[0]!, question: 'Which fresh demo decision should we make?' }], 'toolu_arriving')
  await calls.clock.settle()
  await calls.clock.advance(10)
  expect(calls.savedCursor).toBe(0)
  options.cursor = 2
  for (const surface of SURFACES) {
    const compact = await mountPane($, surface, COMPACT_PROPS)
    expect(await compact.find({ type: 'Text', text: /ARRIVING_INSTRUCTION/ })).toBeDefined()
    expect(await compact.find({ type: 'Text', text: /ARRIVING_LEAD/ })).toBeDefined()
    expect(await compact.find({ type: 'Text', text: /ARRIVING_AI/ })).toBeDefined()
    expect(await compact.find({ text: /OLDEST_INSTRUCTION|OLDEST_LEAD|OLDEST_AI|Which fresh demo decision/ })).toBeUndefined()
    expect((await compact.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['deep'])
    await compact.unmount()
  }
  options.cursor = undefined
  await calls.clock.advance(990)
  await pending
  for (const surface of SURFACES) {
    const full = await mountPane($, surface)
    expect(await full.find({ type: 'Text', text: /^Q1\. Which fresh demo decision should we make\?$/ })).toBeDefined()
    expect(await full.find({ type: 'Text', text: /^1\/4$/ })).toBeDefined()
    await full.unmount()
  }
})

test('history open buttons jump to each entry and mark the selected question', { options: { language: 'ja' } }, async ($, on) => {
  const options: EngineOptions = {}
  const calls = engineBeneath(on, NAV_ANSWERS, options)
  await fillNavigationHistory($, options)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'hist' })
    expect((await ui.findAll({ type: 'Button' })).filter(button => /^open-\d+$/.test(button.key ?? ''))).toHaveLength(3)
    for (const cursor of [2, 1, 0]) {
      const button = await ui.find({ key: `open-${cursor}` })
      expect(button?.type).toBe('Button')
      expect(button?.props.plain).toBe(true)
      await ui.press({ key: `open-${cursor}` })
      expect(calls.savedCursor).toBe(cursor)
      expect((await ui.find({ key: `open-${cursor}` }))?.props.label).toContain('選択中')
      for (const other of [0, 1, 2]) {
        if (other !== cursor) expect((await ui.find({ key: `open-${other}` }))?.props.label).not.toContain('選択中')
      }
      const question = NAV_QUESTIONS[2 - cursor]![0]!
      expect(await ui.find({ type: 'Text', text: new RegExp(`^Q1\\. ${question.question.replace('?', '\\?')}$`) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`^✔ ${question.options[0]!.label}$`) })).toBeDefined()
    }
    await ui.press({ key: 'hist' })
    expect((await ui.findAll({ type: 'Button' })).filter(button => /^open-\d+$/.test(button.key ?? ''))).toHaveLength(0)
    await ui.unmount()
  }
})

test('history lists earlier questions with their answers', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' })
  await ask($)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_2', questions: QUESTIONS })

  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'hist' }))?.props.hotkey).toBe('h')
  expect(await ui.find({ text: /過去の質問と回答/ })).toBeUndefined()
  await ui.press({ key: 'hist' })
  expect(await ui.find({ text: /過去の質問と回答/ })).toBeDefined()
  expect(await ui.find({ text: /→ SQLite/ })).toBeDefined()
  await ui.press({ key: 'hist' })
  expect(await ui.find({ text: /過去の質問と回答/ })).toBeUndefined()
  await ui.unmount()
})

test('/qa-guide opens the pane', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(calls.registered).toEqual(['qa-guide'])
  const ran = await $.command.run({
    command: 'qa-guide',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 180 },
  })

  expect(JSON.stringify(ran)).toContain('質問ガイド')
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: '質問ガイド' }])
})

test('a single-select label containing a comma is highlighted in full', { options: { language: 'ja' } }, async ($, on) => {
  const questions: Questions = [{
    question: 'Which approach should the demo use?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Fast, simple', description: 'Start with a minimal version.' },
      { label: 'Feature rich', description: 'Include every feature now.' },
    ],
  }]
  engineBeneath(on, { 'Which approach should the demo use?': 'Fast, simple' })
  await ask($, questions)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^✔ Fast, simple$/ }))?.props.color).toBe('green')
    expect(await ui.find({ type: 'Text', text: /^2\. Feature rich$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a freeform response is shown on the current question', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { response: 'Use in-memory storage.' })
  await ask($)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /Use in-memory storage\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a freeform response remains visible in history', { options: { language: 'ja' } }, async ($, on) => {
  const options: EngineOptions = { response: 'Use in-memory storage.' }
  engineBeneath(on, {}, options)
  await ask($)
  options.response = undefined
  await ask($, QUESTIONS, 'toolu_2')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'hist' })
    expect(await ui.find({ type: 'Text', text: /Use in-memory storage\./ })).toBeDefined()
    await ui.press({ key: 'hist' })
    expect(await ui.find({ type: 'Text', text: /Use in-memory storage\./ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the AI completion starts before the question and never holds up the answer', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    completeDelay: 1000,
    toolDelay: 100,
  })
  const pending = ask($)
  await calls.clock.settle()
  expect(calls.order).toEqual(['complete', 'tool'])

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ 回答待ち $/ }))?.props.backgroundColor).toBe('yellow')
    expect(await ui.find({ type: 'Text', text: /生成中/ })).toBeDefined()
    await ui.unmount()
  }

  await calls.clock.advance(100)
  const ran = await pending
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /生成中/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /DB choice/ })).toBeUndefined()
    await ui.unmount()
  }

  await calls.clock.advance(900)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Markdown', text: /DB choice/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /生成中/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an unplaced pane offers the /qa-guide command in a toast', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, { isPlaced: false })
  const ran = await ask($)

  expect(calls.opened).toEqual([{ id: 'qa-guide', title: '質問ガイド' }])
  expect(calls.toast).toEqual(['質問ガイド: /qa-guide で背景と選択肢の詳細を表示できます'])
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })
  expect(calls.complete).toBe(1)
  await calls.clock.settle()
})

test('multi-select question cards show previews and highlight every chosen option', { options: { language: 'ja' } }, async ($, on) => {
  const questions: Questions = [{
    question: 'Which features should the demo enable?',
    header: 'Features',
    multiSelect: true,
    options: [
      { label: 'Search', description: 'Find tasks quickly.', preview: 'Search: [Find a task]' },
      { label: 'Tags', description: 'Organize tasks by category.', preview: '[Work] [Home]' },
      { label: 'Reminders', description: 'Notify before tasks are due.' },
    ],
  }]
  engineBeneath(on, { 'Which features should the demo enable?': 'Search, Tags' })
  await ask($, questions)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Features $/ }))?.props.backgroundColor).toBe('cyan')
    expect(await ui.find({ type: 'Text', text: /複数選択可/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Q1\. Which features should the demo enable\?$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^✔ Search$/ }))?.props.color).toBe('green')
    expect((await ui.find({ type: 'Text', text: /^✔ Tags$/ }))?.props.color).toBe('green')
    expect(await ui.find({ type: 'Text', text: /^3\. Reminders$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Find tasks quickly\./ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Search: \[Find a task\]/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /\[Work\] \[Home\]/ })).toBeDefined()
    await ui.unmount()
  }
})

test('history retains the latest 20 entries including the current question', { options: { language: 'ja' } }, async ($, on) => {
  const answers: Record<string, string> = {}
  for (let i = 1; i <= 22; i += 1) answers[`History question ${String(i).padStart(2, '0')}?`] = 'SQLite'
  engineBeneath(on, answers)

  for (let i = 1; i <= 22; i += 1) {
    const question = `History question ${String(i).padStart(2, '0')}?`
    await ask($, [{ ...QUESTIONS[0]!, question, header: 'Batch' }], `toolu_${i}`)
  }

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('履歴 (20)')
    await ui.press({ key: 'hist' })
    expect(await ui.find({ type: 'Text', text: /History question 01\?/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /History question 02\?/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /History question 03\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /History question 21\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Q1\. History question 22\?$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^\[Batch\] History question \d+\?$/ })).toHaveLength(20)
    await ui.press({ key: 'hist' })
    await ui.unmount()
  }
})

test('an engine tool error is relayed and marks the question cancelled', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { toolError: true })
  const ran = await ask($)
  expect(ran).toEqual({ result: undefined, text: 'Question interrupted.', isError: true, ref: 7 })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /キャンセル/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an unavailable AI explanation leaves the original answer intact', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    completeReply: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as ModelCompleteResult,
  })
  const ran = await ask($)
  expect(calls.complete).toBe(1)
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })

  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /解説を生成できませんでした: empty-reply/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✔ SQLite/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    await ui.unmount()
  }
})

test('context includes recent real user requests and the latest request following lead text', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { messages: [
    { role: 'user', text: 'An unrelated earlier task.', toolUses: [] },
    { role: 'assistant', text: 'The earlier task is done.', toolUses: [] },
    { role: 'user', text: 'Build the current demo.', toolUses: [] },
    { role: 'assistant', text: 'The new scaffold is ready.', toolUses: [] },
    {
      role: 'user', text: 'Tool output should not become the request.', toolUses: [],
      toolResults: [{ tool_use_id: 'toolu_scaffold', text: 'Scaffold created.', isError: false }],
    },
    { role: 'assistant', text: 'Now choose the database.', toolUses: [] },
  ] })
  await ask($)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^• Build the current demo\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /^The new scaffold is ready\.\n\nNow choose the database\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^• An unrelated earlier task\.$/ })).toBeDefined()
    expect(await ui.find({ text: /The earlier task is done/ })).toBeUndefined()
    expect(await ui.find({ text: /Tool output should not become the request/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a question with no context and no header still draws on every surface', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { messages: [] })
  await $.tool.call({
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_bare',
    questions: [
      {
        question: 'Proceed?',
        header: '',
        multiSelect: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /Q1\. Proceed\?/ })).toBeDefined()
    expect(await ui.find({ text: /あなたの最近の指示/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an entry stored before userPrompts existed still draws', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {})
  const legacy = {
    id: 'toolu_legacy',
    askedAt: 1,
    userPrompt: 'Legacy request',
    lead: '',
    questions: [{ question: 'Legacy question?', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
    explainState: 'off',
    explanation: '',
    status: 'answered',
    answers: { 'Legacy question?': 'Yes' },
  }
  on('state.get', (_$, e, next) =>
    e.plugin === 'qa-guide' && e.key === 'entries'
      ? { value: { value: [legacy], version: 1 } } as never
      : next(e),
  )

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /Legacy question\?/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a multi-line answer stays on one line in history', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, { 'Which database should the demo app use?': 'Make it readable\nand numbered' })
  await ask($)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_after', questions: QUESTIONS })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'hist' })
  expect(await ui.find({ type: 'Text', text: /→ Make it readable and numbered/ })).toBeDefined()
  await ui.unmount()
})

test('a question whose dispatch rejects is marked cancelled and the error propagates', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, { toolThrows: true })
  let rejected = false
  try {
    await ask($)
  } catch {
    rejected = true
  }

  expect(rejected).toBe(true)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /キャンセル/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答待ち/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('quoted multi-select answers containing commas are matched per label', { options: { language: 'ja' } }, async ($, on) => {
  const question = {
    question: 'What matters most?',
    header: 'Priorities',
    multiSelect: true,
    options: [
      { label: 'Fast, simple', description: '' },
      { label: 'Say "hi"', description: '' },
      { label: 'Cheap', description: '' },
    ],
  }
  engineBeneath(on, { 'What matters most?': '"Fast, simple", "Say ""hi"""' })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_multi', questions: [question] })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /✔ Fast, simple/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✔ Say "hi"/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✔ Cheap/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a subagent question reads the lead text from that agent\'s conversation', { options: { language: 'ja' } }, async ($, on) => {
  engineBeneath(on, {}, {
    agentMessages: [
      { role: 'user', text: 'Investigate the storage layer', toolUses: [] },
      { role: 'assistant', text: 'The subagent found two storage options.', toolUses: [] },
    ],
  })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_agent', agentId: 'agent_1', questions: QUESTIONS } as never)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /The subagent found two storage options/ })).toBeDefined()
  expect(await ui.find({ text: /Next I need a database/ })).toBeUndefined()
  await ui.unmount()
})

const JAPANESE_QUESTIONS: Questions = [{ ...QUESTIONS[0]!, question: 'デモのデータベースをどれにしますか？' }]

const ENGLISH_EXPLANATION: ModelCompleteResult = {
  ...EXPLANATION,
  text: [
    '### Current instructions',
    'Build a demo task board.',
    'Keep setup simple and explain the choices.',
    '### Why Claude is asking',
    'Choose storage and drawing before implementing the board.',
    '### Effect of each option',
    '#### Q1. Database',
    '1. **SQLite**: Keeps demo setup simple.',
    '2. **PostgreSQL**: Matches production storage.',
    '#### Q2. Drawing',
    '1. DOM: Uses native controls.',
    '2. Canvas: Allows flexible drawing.',
    '### Recommendation',
    '→ Q1: 1. SQLite: Simple demo setup.',
    '→ Q2: 2. Canvas: Clear drawing.',
  ].join('\n'),
}

test('language defaults to automatic detection when no option is supplied', async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($)
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'en')
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: 'Question guide' }])
})

test('automatic detection includes labels in later questions', { options: { language: 'auto' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($, [QUESTIONS[0]!, { ...NUMBERED_QUESTIONS[1]!, options: [{ label: 'キャンバス', description: '' }, { label: 'DOM', description: '' }] }])
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'ja')
})

for (const language of ['en', 'ja'] as const) {
  test(`the ${language} option overrides opposite question text and bypasses fallback reads`, { options: { language } }, async ($, on) => {
    const questions = language === 'en' ? JAPANESE_QUESTIONS : QUESTIONS
    const calls = engineBeneath(on, {}, { configThrows: true, envThrows: ['LC_ALL', 'LANG'] })
    await ask($, questions)
    await calls.clock.settle()
    expect(calls.savedEntries[0]).toHaveProperty('lang', language)
    expect(calls.languageLookups).toEqual([])
    expect(calls.completePrompts[0]).toContain(language === 'en' ? '### Current instructions' : '### いまの指示（概要）')
    expect(calls.completePrompts[0]).toContain(JSON.stringify(questions, null, 1))
  })

  test(`the ${language} option bypasses unavailable fallback sources for an empty pane and command`, { options: { language } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { configThrows: true, envThrows: ['LC_ALL', 'LANG'] })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'ai' }))?.props.label).toBe(language === 'en' ? 'AI explanation: ON' : 'AI解説: ON')
      expect((await ui.find({ key: 'hist' }))?.props.label).toBe(language === 'en' ? 'History (0)' : '履歴 (0)')
      expect((await ui.find({ key: 'close' }))?.props.label).toBe(language === 'en' ? 'Close' : '閉じる')
      expect(await ui.find({ type: 'Text', text: language === 'en' ? /No questions yet/ : /まだ質問はありません/ })).toBeDefined()
      await ui.unmount()
    }
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: 'qa-guide', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
    expect(calls.registered).toEqual(['qa-guide'])
    expect(language === 'en' ? /question guide/i.test(calls.registeredDescriptions[0] ?? '') : calls.registeredDescriptions[0]?.includes('質問ガイド')).toBe(true)
    expect(language === 'en' ? /question guide/i.test(JSON.stringify(ran)) : JSON.stringify(ran).includes('質問ガイド')).toBe(true)
    expect(calls.opened).toEqual([{ id: 'qa-guide', title: language === 'en' ? 'Question guide' : '質問ガイド' }])
    expect(calls.languageLookups).toEqual([])
  })
}

const FALLBACK_CASES: Array<{ name: string; options: EngineOptions; lang: 'en' | 'ja'; reads: string[] }> = [
  { name: 'config ja before English LC_ALL', options: { configRows: [languageRow('ja')], env: { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } }, lang: 'ja', reads: ['config'] },
  { name: 'config English before Japanese LC_ALL', options: { configRows: [languageRow('English')], env: { LC_ALL: 'ja_JP.UTF-8' } }, lang: 'en', reads: ['config'] },
  { name: 'config Japanese before English LC_ALL', options: { configRows: [languageRow('Japanese')], env: { LC_ALL: 'en_US.UTF-8' } }, lang: 'ja', reads: ['config'] },
  { name: 'config en before Japanese LANG', options: { configRows: [languageRow('en')], env: { LANG: 'ja_JP.UTF-8' } }, lang: 'en', reads: ['config'] },
  { name: 'only the exact config language key', options: { configRows: [languageRow('ja', 'qa-guide.language'), languageRow('ja', 'languagePreference')], env: { LC_ALL: 'en_US.UTF-8' } }, lang: 'en', reads: ['config', 'LC_ALL'] },
  { name: 'a non-string config row is ignored', options: { configRows: [languageRow(false)], env: { LC_ALL: 'ja_JP.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL'] },
  { name: 'Japanese LC_ALL before English LANG', options: { env: { LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL'] },
  { name: 'English LC_ALL before Japanese LANG', options: { env: { LC_ALL: 'en_US.UTF-8', LANG: 'ja_JP.UTF-8' } }, lang: 'en', reads: ['config', 'LC_ALL'] },
  { name: 'Japanese LANG when LC_ALL is absent', options: { env: { LANG: 'ja_JP.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL', 'LANG'] },
  { name: 'Japanese LANG when LC_ALL is empty', options: { env: { LC_ALL: '', LANG: 'ja_JP.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL', 'LANG'] },
  { name: 'English when no fallback value exists', options: {}, lang: 'en', reads: ['config', 'LC_ALL', 'LANG'] },
  { name: 'config errors fall through to LC_ALL', options: { configThrows: true, env: { LC_ALL: 'ja_JP.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL'] },
  { name: 'LC_ALL errors fall through to LANG', options: { envThrows: ['LC_ALL'], env: { LANG: 'ja_JP.UTF-8' } }, lang: 'ja', reads: ['config', 'LC_ALL', 'LANG'] },
  { name: 'all fallback errors use English', options: { configThrows: true, envThrows: ['LC_ALL', 'LANG'] }, lang: 'en', reads: ['config', 'LC_ALL', 'LANG'] },
]

for (const { name, options, lang, reads } of FALLBACK_CASES) {
  test(`no-question automatic language uses ${name}`, { options: { language: 'auto' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, options)
    for (const surface of SURFACES) {
      calls.languageLookups.length = 0
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'ai' }))?.props.label).toBe(lang === 'ja' ? 'AI解説: ON' : 'AI explanation: ON')
      expect(calls.languageLookups).toEqual(reads)
      await ui.unmount()
    }
    calls.languageLookups.length = 0
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    expect(lang === 'ja' ? calls.registeredDescriptions[0]?.includes('質問ガイド') : /question guide/i.test(calls.registeredDescriptions[0] ?? '')).toBe(true)
    expect(calls.languageLookups).toEqual(reads)
    calls.languageLookups.length = 0
    await $.command.run({ command: 'qa-guide', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
    expect(calls.opened).toEqual([{ id: 'qa-guide', title: lang === 'ja' ? '質問ガイド' : 'Question guide' }])
    expect(calls.languageLookups).toEqual(reads)
  })
}

test('an empty question list uses fallback and stores its language', { options: { language: 'auto' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { configRows: [languageRow('ja')] })
  await ask($, [])
  await calls.clock.settle()
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'ja')
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: '質問ガイド' }])
  expect(calls.languageLookups).toEqual(['config'])
})

test('English compact guidance preserves four ordered sections and dialog numbering for multiple questions', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  await submit($, 'Keep demo storage local.')
  await ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  const prompt = calls.completePrompts[0] ?? ''
  const headings = ['### Current instructions', '### Why Claude is asking', '### Effect of each option', '### Recommendation']
  for (const [i, heading] of headings.entries()) {
    expect(prompt).toContain(heading)
    if (i > 0) expect(prompt.indexOf(headings[i - 1]!)).toBeLessThan(prompt.indexOf(heading))
  }
  const sections = headings.map((heading, i) => prompt.slice(prompt.indexOf(heading), i + 1 < headings.length ? prompt.indexOf(headings[i + 1]!) : undefined))
  expect(/2\s*[-–]\s*3\s*lines/i.test(sections[0]!)).toBe(true)
  expect(/1\s*[-–]\s*2\s*(?:short\s*)?lines/i.test(sections[1]!)).toBe(true)
  expect(sections[2]).toContain('1. <label>: <effect>')
  expect(/dialog.*order|order.*dialog/i.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('#### Q<n>.')
  expect(/restart.*1|start.*1|1.*restart/i.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('one line')
  expect(sections[2]).toContain('one sentence')
  expect(/(?:not|never|no).*Other|Other.*(?:not|never|no)/i.test(sections[2]!)).toBe(true)
  expect(sections[3]).toContain('→ 2. <label>: <reason>')
  expect(sections[3]).toContain('→ Q1: 2. <label>')
  for (const forbidden of ['long paragraphs', 'tables', 'code blocks']) expect(prompt.toLowerCase()).toContain(forbidden)
  expect(prompt).toContain(JSON.stringify(NUMBERED_QUESTIONS, null, 1))
  expect(prompt).toContain(JSON.stringify(['Keep demo storage local.'], null, 1))
  expect(prompt).not.toContain('### いまの指示（概要）')
})

test('English compact guidance renders translated badges, context and numbered AI sections on every surface', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 10, completeReply: ENGLISH_EXPLANATION })
  const pending = ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  await calls.clock.advance(10)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Awaiting answer $/ }))?.props.backgroundColor).toBe('yellow')
    expect(await ui.find({ type: 'Text', text: /^ Question context $/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\(After answering, use p\/n for past questions\)$/ }))?.props.dimColor).toBe(true)
    for (const heading of ['▍Your recent instructions', "▍Claude's preceding explanation"]) {
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${heading}$`) }))?.props.color).toBe('blue')
    }
    const chips = await ui.findAll({ type: 'Text', text: /^\s*[12]\s*$/ })
    expect(chips.map(chip => chip.text.trim())).toEqual(['1', '2', '1', '2'])
    for (const chip of chips) {
      expect(chip.props.bold).toBe(true)
      expect(chip.props.color).toBe('cyan')
    }
    for (const label of ['SQLite', 'PostgreSQL', 'DOM', 'Canvas']) {
      expect((await ui.find({ type: 'Text', text: new RegExp(`^\\s*${label}:?\\s*$`) }))?.props.bold).toBe(true)
    }
    const rows = compactTextRows(await ui.find({ key: 'compact-ai' }))
    expect(rows[0]?.text).toBe('✦ AI explanation: Current instructions compact context')
    for (const heading of ['Current instructions', 'Why Claude is asking', 'Effect of each option', 'Q1. Database', 'Q2. Drawing', 'Recommendation']) {
      const row = rows.find(row => row.text.includes(heading))
      expect(row?.props.bold).toBe(true)
      expect(row?.props.color).toBe('magenta')
    }
    for (const recommendation of ['→ Q1: 1. SQLite: Simple demo setup.', '→ Q2: 2. Canvas: Clear drawing.']) {
      const row = rows.find(row => row.text === recommendation)
      expect(row?.props.bold).toBe(true)
      expect(row?.props.color).toBe('green')
    }
    for (const row of rows) {
      expect(row.text).not.toContain('###')
      expect(row.text).not.toContain('**')
      if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
    }
    expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(PANE_PROPS.scroll!.bodyRows)
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['deep'])
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    expect(await ui.find({ text: /回答待ち|質問の背景|あなたの最近の指示|直前の Claude の説明|AI解説/ })).toBeUndefined()
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'en')
})

test('English full guidance renders translated sections, answer badges and history toolbars on every surface', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'PostgreSQL', 'How should the demo draw its board?': 'Canvas' }, { completeReply: ENGLISH_EXPLANATION })
  await ask($, NUMBERED_QUESTIONS)
  await ask($, NUMBERED_QUESTIONS, 'toolu_english_second')
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Answered $/ }))?.props.backgroundColor).toBe('green')
    expect(await ui.find({ type: 'Text', text: /^Questions from Claude \(2\)$/ })).toBeDefined()
    for (const heading of ['▍Your recent instructions', "▍Claude's preceding explanation", '✦ AI explanation (instructions, context, effects, recommendation)']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })).toBeDefined()
    }
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('History (2)')
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('Close')
    expect((await ui.find({ key: 'prev' }))?.props.label).toBe('◀ Previous')
    expect(await ui.find({ type: 'Text', text: /^Q1\. Which database should the demo app use\?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Q2\. How should the demo draw its board\?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. SQLite$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. DOM$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^✔ PostgreSQL$/ }))?.props.color).toBe('green')
    expect((await ui.find({ type: 'Text', text: /^✔ Canvas$/ }))?.props.color).toBe('green')
    expect(await ui.find({ type: 'Markdown', text: /^### Current instructions/ })).toBeDefined()
    await ui.press({ key: 'prev' })
    expect((await ui.find({ key: 'next' }))?.props.label).toBe('Next ▶')
    expect((await ui.find({ key: 'latest' }))?.props.label).toBe('Latest')
    await ui.press({ key: 'latest' })
    await ui.press({ key: 'hist' })
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('Hide history')
    expect(await ui.find({ type: 'Text', text: /^Past questions and answers$/ })).toBeDefined()
    expect((await ui.find({ key: 'open-0' }))?.props.label).toBe('1/2 ▶ Selected')
    expect((await ui.find({ key: 'open-1' }))?.props.label).toBe('2/2 Open')
    expect(await ui.find({ text: /回答済み|Claude からの質問|AI解説|過去の質問と回答|選択中|あなたの最近の指示/ })).toBeUndefined()
    await ui.press({ key: 'hist' })
    await ui.unmount()
  }
})

test('English cancellation and unavailable AI explanation keep translated status and errors', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, 'deny', { completeReply: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as ModelCompleteResult })
  await ask($)
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Cancelled $/ }))?.props.backgroundColor).toBe('gray')
    expect(await ui.find({ type: 'Text', text: /^Could not generate an explanation: empty-reply$/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
    expect(await ui.find({ text: /キャンセル|解説を生成できませんでした/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('English placement toast uses the question language instead of Japanese fallback settings', { options: { language: 'auto' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { isPlaced: false, configRows: [languageRow('ja')], env: { LANG: 'ja_JP.UTF-8' } })
  await ask($)
  await calls.clock.settle()
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: 'Question guide' }])
  expect(calls.toast).toEqual(['Question guide: use /qa-guide to view context and option details'])
  expect(calls.languageLookups).toEqual([])
})

test('legacy entries without lang retain Japanese UI even under an English override', { options: { language: 'en' } }, async ($, on) => {
  engineBeneath(on, {})
  const legacy = {
    id: 'toolu_legacy_language', askedAt: 1, userPrompts: ['Legacy demo request.'], lead: 'Legacy background.',
    questions: QUESTIONS, explainState: 'off', explanation: '', status: 'answered',
    answers: { 'Which database should the demo app use?': 'SQLite' },
  }
  on('state.get', { plugin: 'qa-guide', key: 'entries' }, () => ({ value: { value: [legacy], version: 1 } }) as never)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^ 回答済み $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍あなたの最近の指示$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍直前の Claude の説明$/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI解説: ON')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('履歴 (1)')
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('閉じる')
    expect(await ui.find({ type: 'Text', text: /^ Answered $/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('bilingual history retains each entry language after explanation updates and fallback settings change', { options: { language: 'auto' } }, async ($, on) => {
  const options: EngineOptions = { completeReply: { ...EXPLANATION, text: 'Japanese guidance.' }, completeDelay: 10 }
  const calls = engineBeneath(on, 'deny', options)
  await ask($, JAPANESE_QUESTIONS, 'toolu_bilingual_ja')
  options.completeReply = ENGLISH_EXPLANATION
  await ask($, QUESTIONS, 'toolu_bilingual_en')
  await calls.clock.advance(10)
  expect(calls.savedEntries[0]).toHaveProperty('lang', 'ja')
  expect(calls.savedEntries[1]).toHaveProperty('lang', 'en')
  expect(calls.savedEntries.map(entry => entry.explainState)).toEqual(['done', 'done'])
  options.configRows = [languageRow('ja')]
  options.env = { LC_ALL: 'ja_JP.UTF-8' }
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^ Cancelled $/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
    await ui.press({ key: 'hist' })
    expect((await ui.find({ key: 'open-0' }))?.props.label).toBe('1/2 ▶ Selected')
    expect((await ui.find({ key: 'open-1' }))?.props.label).toBe('2/2 開く')
    expect(await ui.find({ type: 'Text', text: /^  → Cancelled$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  → キャンセル$/ })).toBeDefined()
    await ui.press({ key: 'open-1' })
    expect(await ui.find({ type: 'Text', text: /^ キャンセル $/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI解説: ON')
    expect((await ui.find({ key: 'next' }))?.props.label).toBe('次 ▶')
    expect((await ui.find({ key: 'latest' }))?.props.label).toBe('最新')
    expect((await ui.find({ key: 'open-1' }))?.props.label).toBe('2/2 ▶ 選択中')
    expect((await ui.find({ key: 'open-0' }))?.props.label).toBe('1/2 Open')
    await ui.press({ key: 'latest' })
    expect(await ui.find({ type: 'Text', text: /^ Cancelled $/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
    await ui.press({ key: 'hist' })
    await ui.unmount()
  }
  expect(calls.languageLookups).toEqual([])
})

const SHORT_ENGLISH_EXPLANATION: ModelCompleteResult = {
  ...EXPLANATION,
  text: [
    '### Current instructions', 'Build a small demo board.',
    '### Why Claude is asking', 'Choose storage before saving tasks.',
    '### Effect of each option', '1. SQLite: Keeps setup simple.', '2. PostgreSQL: Matches production.',
    '### Recommendation', '→ 1. SQLite: Simple demo setup.',
  ].join('\n'),
}

for (const state of ['off', 'error'] as const) {
  test(`English ${state} guidance translates both compact and full state messages`, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      toolDelay: 1000, completeDelay: 10,
      completeReply: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as ModelCompleteResult,
    })
    if (state === 'off') {
      const ui = await mountPane($, 'terminal')
      await ui.press({ key: 'ai' })
      await ui.unmount()
    }
    const pending = ask($)
    await calls.clock.settle()
    await calls.clock.advance(10)
    const compactMessage = state === 'off'
      ? '✦ AI explanation: OFF (enable for the next question with [a] after answering)'
      : '✦ AI explanation: Could not generate an explanation: empty-reply'
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 100 })
      expect((await ui.findAll({ type: 'Text' })).some(node => node.text === compactMessage)).toBe(true)
      expect(await ui.find({ text: /解説を生成できませんでした|回答後に/ })).toBeUndefined()
      await ui.unmount()
    }
    await calls.clock.advance(990)
    await pending
    const fullMessage = state === 'off'
      ? 'OFF (enable for the next question with [a])'
      : 'Could not generate an explanation: empty-reply'
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.findAll({ type: 'Text' })).some(node => node.text === fullMessage)).toBe(true)
      expect((await ui.find({ key: 'ai' }))?.props.label).toBe(state === 'off' ? 'AI explanation: OFF' : 'AI explanation: ON')
      await ui.unmount()
    }
    expect(calls.complete).toBe(state === 'off' ? 0 : 1)
  })
}

for (const [name, questions, lang] of [
  ['English question', QUESTIONS, 'en'],
  ['hiragana in the question', [{ ...QUESTIONS[0]!, question: 'どちらを使いますか？' }], 'ja'],
  ['katakana in the question', [{ ...QUESTIONS[0]!, question: 'データベース?' }], 'ja'],
  ['hiragana in an option label', [{ ...QUESTIONS[0]!, options: [{ label: 'そのまま', description: 'Keep the demo simple.' }] }], 'ja'],
  ['katakana in an option label', [{ ...QUESTIONS[0]!, options: [{ label: 'ローカル', description: 'Keep the demo local.' }] }], 'ja'],
  ['half-width katakana outside the detection range', [{ ...QUESTIONS[0]!, options: [{ label: 'ﾛｰｶﾙ', description: 'Keep the demo local.' }] }], 'en'],
  ['Chinese question and option labels', [{ ...QUESTIONS[0]!, question: '演示应用应使用哪种数据库？', options: [{ label: '本地存储', description: '简单设置' }] }], 'en'],
  ['Japanese only in descriptions, previews, headers and conversation', [{ ...QUESTIONS[0]!, header: 'データベース', options: [{ label: 'SQLite', description: 'ローカルに保存します。', preview: 'デモ用プレビュー' }] }], 'en'],
] satisfies Array<[string, Questions, 'en' | 'ja']>) {
  test(`automatic language detection uses ${lang} for ${name}`, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      configRows: [languageRow(lang === 'en' ? 'ja' : 'en')],
      env: { LC_ALL: lang === 'en' ? 'ja_JP.UTF-8' : 'en_US.UTF-8' },
      messages: [{ role: 'user', text: 'デモを作ってください。', toolUses: [] }, { role: 'assistant', text: 'データベースを選びましょう。', toolUses: [] }],
    })
    await submit($, '最近の指示は日本語です。')
    await ask($, questions)
    await calls.clock.settle()
    expect(calls.savedEntries[0]?.lang).toBe(lang)
    expect(calls.opened).toEqual([{ id: 'qa-guide', title: lang === 'en' ? 'Question guide' : '質問ガイド' }])
    expect(calls.languageLookups).toEqual([])
    expect(calls.completePrompts[0]).toContain(lang === 'en' ? '### Current instructions' : '### いまの指示（概要）')
  })
}

test('the English user configuration overrides Japanese questions and all fallback sources', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { configRows: [languageRow('ja')], env: { LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' } })
  const empty = await mountPane($, 'terminal')
  expect((await empty.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
  await empty.unmount()
  await ask($, JAPANESE_QUESTIONS)
  await calls.clock.settle()
  expect(calls.savedEntries[0]?.lang).toBe('en')
  expect(calls.completePrompts[0]).toContain('### Current instructions')
  expect(calls.languageLookups).toEqual([])
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^ Answered $/ })).toBeDefined()
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('Close')
    await ui.unmount()
  }
})

test('the Japanese user configuration overrides English questions and all fallback sources', { options: { language: 'ja' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { configRows: [languageRow('en')], env: { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } })
  const empty = await mountPane($, 'terminal')
  expect((await empty.find({ key: 'ai' }))?.props.label).toBe('AI解説: ON')
  await empty.unmount()
  await ask($)
  await calls.clock.settle()
  expect(calls.savedEntries[0]?.lang).toBe('ja')
  expect(calls.completePrompts[0]).toContain('### いまの指示（概要）')
  expect(calls.languageLookups).toEqual([])
})

for (const [name, options, lang, reads] of [
  ['Japanese config before English locale', { configRows: [languageRow('ja')], env: { LC_ALL: 'en_US.UTF-8' } }, 'ja', ['config']],
  ['English config before Japanese locale', { configRows: [languageRow('en')], env: { LC_ALL: 'ja_JP.UTF-8' } }, 'en', ['config']],
  ['Japanese config name', { configRows: [languageRow('Japanese')], env: { LANG: 'en_US.UTF-8' } }, 'ja', ['config']],
  ['English config name', { configRows: [languageRow('English')], env: { LANG: 'ja_JP.UTF-8' } }, 'en', ['config']],
  ['Japanese config locale', { configRows: [languageRow('ja-JP')], env: { LANG: 'en_US.UTF-8' } }, 'ja', ['config']],
  ['English config locale', { configRows: [languageRow('en-US')], env: { LANG: 'ja_JP.UTF-8' } }, 'en', ['config']],
  ['Japanese LC_ALL before English LANG', { env: { LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' } }, 'ja', ['config', 'LC_ALL']],
  ['English LC_ALL before Japanese LANG', { env: { LC_ALL: 'en_US.UTF-8', LANG: 'ja_JP.UTF-8' } }, 'en', ['config', 'LC_ALL']],
  ['Japanese LANG without LC_ALL', { env: { LANG: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['Japanese LANG with empty LC_ALL', { env: { LC_ALL: '', LANG: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['case insensitive Japanese locale', { env: { LANG: 'JA_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['English default without language sources', {}, 'en', ['config', 'LC_ALL', 'LANG']],
  ['other concrete config languages select English before locale', { configRows: [languageRow('French')], env: { LANG: 'ja_JP.UTF-8' } }, 'en', ['config']],
  ['empty config language falls back to locale', { configRows: [languageRow('')], env: { LANG: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['automatic config language falls back to locale', { configRows: [languageRow('auto')], env: { LANG: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['non-string config value falls back to locale', { configRows: [languageRow(true)], env: { LC_ALL: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL']],
  ['only exact language keys match', { configRows: [{ ...languageRow('ja', 'theme'), label: 'language' }, languageRow('ja', 'qa-guide.language')], env: { LANG: 'en_US.UTF-8' } }, 'en', ['config', 'LC_ALL', 'LANG']],
  ['config errors are ignored', { configThrows: true, env: { LC_ALL: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL']],
  ['LC_ALL errors allow LANG fallback', { envThrows: ['LC_ALL'], env: { LANG: 'ja_JP.UTF-8' } }, 'ja', ['config', 'LC_ALL', 'LANG']],
  ['all locale errors use English', { configThrows: true, envThrows: ['LC_ALL', 'LANG'] }, 'en', ['config', 'LC_ALL', 'LANG']],
] satisfies Array<[string, EngineOptions, 'en' | 'ja', string[]]>) {
  test(`an empty pane resolves ${lang} from ${name}`, async ($, on) => {
    const calls = engineBeneath(on, {}, options)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'ai' }))?.props.label).toBe(lang === 'en' ? 'AI explanation: ON' : 'AI解説: ON')
      expect((await ui.find({ key: 'hist' }))?.props.label).toBe(lang === 'en' ? 'History (0)' : '履歴 (0)')
      expect((await ui.find({ key: 'close' }))?.props.label).toBe(lang === 'en' ? 'Close' : '閉じる')
      await ui.unmount()
    }
    expect(calls.languageLookups.slice(0, reads.length)).toEqual(reads)
    if (!reads.includes('LC_ALL')) expect(calls.languageLookups).not.toContain('LC_ALL')
    if (!reads.includes('LANG')) expect(calls.languageLookups).not.toContain('LANG')
  })
}

test('command descriptions and empty command results use the no-question language fallback', async ($, on) => {
  const calls = engineBeneath(on, {}, { configRows: [languageRow('en')], env: { LANG: 'ja_JP.UTF-8' } })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(calls.registeredDescriptions).toEqual(["Open the question guide pane (context, options, and AI explanation for Claude's questions)"])
  const ran = await $.command.run({ command: 'qa-guide', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
  expect(ran).toEqual({ text: 'Opened the question guide.' })
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: 'Question guide' }])
  expect(calls.languageLookups).not.toContain('LANG')
})

test('command descriptions honor Japanese locale fallback before any entry exists', async ($, on) => {
  const calls = engineBeneath(on, {}, { env: { LANG: 'ja_JP.UTF-8' } })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(calls.registeredDescriptions).toEqual(['質問ガイドペインを開く（Claudeの質問の背景・選択肢・AI解説）'])
})

test('legacy entries without lang render Japanese labels even with an English override', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { env: { LANG: 'en_US.UTF-8' } })
  const legacy = { id: 'toolu_legacy_language', askedAt: 1, userPrompts: ['Build a demo board.'], lead: 'Choose the storage next.', questions: QUESTIONS, explainState: 'off', explanation: '', status: 'answered', answers: {} }
  on('state.get', { plugin: 'qa-guide', key: 'entries' }, () => ({ value: { value: [legacy], version: 1 } }) as never)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^ 回答済み $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude からの質問 \(1件\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍あなたの最近の指示$/ })).toBeDefined()
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI解説: ON')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('履歴 (1)')
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('閉じる')
    expect(await ui.find({ text: /^ Answered $/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(calls.languageLookups).toEqual([])
})

test('mixed-language entries retain their original language while browsing on both surfaces', async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($, JAPANESE_QUESTIONS, 'toolu_language_ja')
  await ask($, QUESTIONS, 'toolu_language_en')
  await calls.clock.settle()
  expect(calls.savedEntries.map(entry => entry.lang)).toEqual(['ja', 'en'])
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^ Answered $/ })).toBeDefined()
    expect((await ui.find({ key: 'prev' }))?.props.label).toBe('◀ Previous')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('History (2)')
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /^ 回答済み $/ })).toBeDefined()
    expect((await ui.find({ key: 'next' }))?.props.label).toBe('次 ▶')
    expect((await ui.find({ key: 'latest' }))?.props.label).toBe('最新')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('履歴 (2)')
    await ui.press({ key: 'latest' })
    expect(await ui.find({ type: 'Text', text: /^ Answered $/ })).toBeDefined()
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('Close')
    await ui.unmount()
  }
  expect(calls.savedEntries.map(entry => entry.lang)).toEqual(['ja', 'en'])
})

test('English compact panes show translated badges, context titles, hints and AI headings on both surfaces', async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 10, completeReply: SHORT_ENGLISH_EXPLANATION })
  const pending = ask($)
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 80 })
    expect((await ui.find({ type: 'Text', text: /^ Awaiting answer $/ }))?.props.backgroundColor).toBe('yellow')
    expect(await ui.find({ type: 'Text', text: /Question context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /After answering, use p\/n for past questions/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✦ AI explanation: Generating… \(you can keep answering\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍Your recent instructions$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍Claude's preceding explanation$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  }
  await calls.clock.advance(10)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 80 })
    for (const heading of ['✦ AI explanation: Current instructions', 'Why Claude is asking', 'Effect of each option', 'Recommendation']) {
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${heading}$`) }))?.props.bold).toBe(true)
    }
    expect(await ui.find({ type: 'Text', text: /^ 1 SQLite: Keeps setup simple\.$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^→ 1\. SQLite: Simple demo setup\.$/ }))?.props.color).toBe('green')
    expect(await ui.find({ text: /回答待ち|質問の背景|あなたの最近の指示|生成中/ })).toBeUndefined()
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('English pending guidance retains its complete text when wrapping in narrow compact panes', { options: { language: 'en' } }, async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeDelay: 2000 })
  const pending = ask($)
  await calls.clock.settle()
  for (const bodyColumns of [40, 60]) {
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { ...COMPACT_PROPS, bodyColumns })
      const aiRows = compactTextRows(await ui.find({ key: 'compact-ai' }))
      expect(joinRows(aiRows.map(row => row.text))).toBe('✦ AI explanation: Generating… (you can keep answering)')
      if (bodyColumns === 40) expect(aiRows).toHaveLength(2)
      for (const row of aiRows) expect([...row.text].length).toBeLessThanOrEqual(bodyColumns)
      for (const row of compactTextRows(await ui.drawn())) {
        if (row.props.key !== 'deep') expect(row.props.wrap).toBe('truncate-end')
        expect(row.text).not.toContain('\n')
      }
      expect(compactTextRows(await ui.drawn()).length).toBeLessThanOrEqual(20)
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
      await ui.unmount()
    }
  }
  await calls.clock.advance(2000)
  await pending
})

test('English full panes translate section titles, all toolbar labels and history on both surfaces', async ($, on) => {
  const calls = engineBeneath(on, {}, { completeReply: SHORT_ENGLISH_EXPLANATION })
  for (let i = 0; i < 3; i++) await ask($, QUESTIONS, `toolu_english_full_${i}`)
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Answered $/ }))?.props.backgroundColor).toBe('green')
    expect(await ui.find({ type: 'Text', text: /^Questions from Claude \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍Your recent instructions$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▍Claude's preceding explanation$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✦ AI explanation \(instructions, context, effects, recommendation\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /### Current instructions/ })).toBeDefined()
    expect((await ui.find({ key: 'prev' }))?.props.label).toBe('◀ Previous')
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: ON')
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('History (3)')
    expect((await ui.find({ key: 'close' }))?.props.label).toBe('Close')
    await ui.press({ key: 'prev' })
    expect((await ui.find({ key: 'next' }))?.props.label).toBe('Next ▶')
    expect((await ui.find({ key: 'latest' }))?.props.label).toBe('Latest')
    await ui.press({ key: 'ai' })
    expect((await ui.find({ key: 'ai' }))?.props.label).toBe('AI explanation: OFF')
    await ui.press({ key: 'ai' })
    await ui.press({ key: 'hist' })
    expect((await ui.find({ key: 'hist' }))?.props.label).toBe('Hide history')
    expect(await ui.find({ type: 'Text', text: /^Past questions and answers$/ })).toBeDefined()
    expect((await ui.find({ key: 'open-1' }))?.props.label).toBe('2/3 ▶ Selected')
    expect((await ui.find({ key: 'open-0' }))?.props.label).toBe('1/3 Open')
    expect(await ui.find({ type: 'Text', text: /Unanswered/ })).toBeDefined()
    await ui.press({ key: 'hist' })
    await ui.press({ key: 'latest' })
    expect(await ui.find({ text: /回答済み|あなたの最近の指示|過去の質問と回答/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('English cancelled badges and freeform answer labels render on both surfaces', async ($, on) => {
  const options: EngineOptions = { response: 'Use temporary storage.' }
  const calls = engineBeneath(on, { [QUESTIONS[0]!.question]: 'Choose a custom approach.' }, options)
  await ask($)
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^→ Answer: Choose a custom approach\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Freeform answer$/ })).toBeDefined()
    await ui.unmount()
  }
  options.toolError = true
  options.response = undefined
  await ask($, QUESTIONS, 'toolu_english_cancelled')
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^ Cancelled $/ }))?.props.backgroundColor).toBe('gray')
    await ui.press({ key: 'hist' })
    expect(await ui.find({ type: 'Text', text: /Freeform: Use temporary storage\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  → Cancelled$/ })).toBeDefined()
    await ui.press({ key: 'hist' })
    await ui.unmount()
  }
})

test('English multi-select labels render on both surfaces', async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($, [{ ...QUESTIONS[0]!, multiSelect: true }])
  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^\[Multiple selections allowed\]$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an unplaced English pane uses an English toast and title without altering the answer', async ($, on) => {
  const answers = { [QUESTIONS[0]!.question]: 'SQLite' }
  const calls = engineBeneath(on, answers, { isPlaced: false })
  const ran = await ask($)
  await calls.clock.settle()
  expect(calls.opened).toEqual([{ id: 'qa-guide', title: 'Question guide' }])
  expect(calls.toast).toEqual(['Question guide: use /qa-guide to view context and option details'])
  expect(ran).toHaveProperty('result.answers', answers)
})

test('the English compact prompt retains four sections, quoted context and exact dialog numbering rules', async ($, on) => {
  const calls = engineBeneath(on, {})
  await submit($, 'Build a small demo board.')
  await submit($, 'Keep setup simple and explain the choices.')
  await ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  const prompt = calls.completePrompts[0] ?? ''
  const headings = ['### Current instructions', '### Why Claude is asking', '### Effect of each option', '### Recommendation']
  for (const [i, heading] of headings.entries()) {
    expect(prompt).toContain(heading)
    if (i > 0) expect(prompt.indexOf(headings[i - 1]!)).toBeLessThan(prompt.indexOf(heading))
  }
  const sections = headings.map((heading, i) => prompt.slice(prompt.indexOf(heading), i + 1 < headings.length ? prompt.indexOf(headings[i + 1]!) : undefined))
  expect(/2\s*[-–]\s*3\s*lines/.test(sections[0]!)).toBe(true)
  expect(/1\s*[-–]\s*2\s*(?:short\s*)?lines/.test(sections[1]!)).toBe(true)
  expect(sections[2]).toContain('1. <label>:')
  expect(/same order|dialog order/i.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('number')
  expect(/one line|1 line/i.test(sections[2]!)).toBe(true)
  expect(/one sentence|1 sentence/i.test(sections[2]!)).toBe(true)
  expect(sections[2]).toContain('#### Q<n>.')
  expect(/restart.*1|start.*1.*again/i.test(sections[2]!)).toBe(true)
  expect(/(?:do not|never).*Other|Other.*(?:do not|never)/i.test(sections[2]!)).toBe(true)
  expect(sections[3]).toContain('→ 2. <label>:')
  expect(sections[3]).toContain('→ Q1: 2. <label>')
  expect(/one line|1 line/i.test(sections[3]!)).toBe(true)
  expect(prompt).toContain(JSON.stringify(['Build a small demo board.', 'Keep setup simple and explain the choices.'], null, 1))
  expect(prompt).toContain(JSON.stringify(NUMBERED_QUESTIONS, null, 1))
  expect(prompt).not.toContain('### いまの指示（概要）')
  expect(prompt).not.toContain('### おすすめ')
})

test('a question asked before the first response falls back to a stand-alone completion', { options: { context: 'full' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    forkReply: { isAnswered: false, reason: 'nothing-to-fork' },
  })
  await ask($)
  await calls.clock.settle()
  const prompts = calls.completeRequests
  expect(calls.fork).toBe(1)
  expect(prompts.length).toBe(1)
  expect(prompts[0]!.model).toBe('haiku')
  expect(prompts[0]!.maxTokens).toBe(1500)
  expect(prompts[0]!.prompt).toContain('Which database should the demo app use?')
  expect(prompts[0]!.prompt).toContain('Next I need a database.')
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /なぜ聞いているか/ })).toBeDefined()
    expect(await ui.find({ text: /nothing-to-fork/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('other fork failures are shown without a fallback call', { options: { context: 'full' } }, async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    forkReply: { isAnswered: false, reason: 'empty-reply', usage: EXPLANATION.usage },
  })
  await ask($)
  await calls.clock.settle()
  expect(calls.fork).toBe(1)
  expect(calls.complete).toBe(0)
})

test('English explanation lines wrap at spaces, not inside words', async ($, on) => {
  const sentence = 'We need to choose a storage backend that fits the scope and complexity of the app before building persistence.'
  const calls = engineBeneath(on, {}, { toolDelay: 1000, completeReply: { ...EXPLANATION, text: `### Why Claude is asking\n${sentence}` } })
  const asked = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_wrap', questions: [{ question: 'Where should data live?', header: 'Storage', multiSelect: false, options: [{ label: 'JSON file', description: '' }, { label: 'SQLite', description: '' }] }] })
  await calls.clock.settle()

  for (const columns of [36, 52]) {
    const ui = await mountPane($, 'terminal', { ...PANE_PROPS, bodyColumns: columns })
    const rows = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    const start = rows.findIndex(r => r.startsWith('We need'))
    expect(start).toBeGreaterThan(-1)
    const body: string[] = []
    for (let i = start; i < rows.length && body.join(' ').length < sentence.length; i++) body.push(rows[i]!)
    expect(body.length).toBeGreaterThan(1)
    expect(body.join(' ')).toBe(sentence)
    await ui.unmount()
  }
  await calls.clock.advance(1000)
  await asked
})

test('compact context keeps every question and option label when previews are huge', async () => {
  const big = 'x'.repeat(20000)
  const questions = [
    { question: 'Pick a layout?', header: 'Layout', multiSelect: false, options: [
      { label: 'Grid', description: 'd'.repeat(5000), preview: big },
      { label: 'List', description: 'Simple list', preview: big },
      { label: 'Board', description: 'Kanban board' },
    ] },
    { question: 'Pick a theme?', header: 'Theme', multiSelect: false, options: [
      { label: 'Dark', description: '', preview: big },
      { label: 'Light', description: '' },
    ] },
  ]
  const prompt = buildCompactContext([], ['Build a board app'], 'lead text', questions, 'en')

  expect(prompt.length).toBeLessThan(12001)
  for (const text of ['Pick a layout?', 'Grid', 'List', 'Board', 'Pick a theme?', 'Dark', 'Light', 'Simple list', 'Kanban board']) {
    expect(prompt).toContain(text)
  }
})

for (const question of ['どちらにしますか？', '進めてもよろしいですか', 'Should I proceed?', 'Which approach do you prefer?']) {
  test(`detectWaiting recognizes the final question: ${question}`, () => {
    expect(detectWaiting(`I have finished the preparation.\n${question}`)).toEqual({ question, options: [] })
  })
}

test('detectWaiting extracts numbered and bulleted options without bold markers', () => {
  expect(detectWaiting('Which database do you prefer?\n1. **SQLite**: simple\n2. PostgreSQL: production-ready')).toEqual({
    question: 'Which database do you prefer?',
    options: [{ label: 'SQLite', description: 'simple' }, { label: 'PostgreSQL', description: 'production-ready' }],
  })
  expect(detectWaiting('Which approach do you prefer?\n- **A** — fast\n- **B** — thorough')).toEqual({
    question: 'Which approach do you prefer?',
    options: [{ label: 'A', description: 'fast' }, { label: 'B', description: 'thorough' }],
  })
})

for (const text of ['', 'The implementation is complete.', '他に何かあればお気軽にどうぞ。', 'Let me know if you need anything else!', 'Anything else?']) {
  test(`detectWaiting ignores empty, declarative and courtesy text: ${text || '(empty)'}`, () => {
    expect(detectWaiting(text)).toBeNull()
  })
}

test('detectWaiting ignores a question followed by more than twelve non-question lines', () => {
  expect(detectWaiting(['Which approach do you prefer?', ...Array.from({ length: 15 }, (_, i) => `Completed detail ${i + 1}.`)].join('\n'))).toBeNull()
})

const CHAT_QUESTIONS = {
  en: 'Which database do you prefer?\n1. SQLite: simple\n2. PostgreSQL: production-ready',
  ja: 'どちらにしますか？\n1. SQLite: 手軽\n2. PostgreSQL: 本番向け',
}

const CHAT_SECTIONS = {
  en: ['### Current instructions', '### Why Claude is asking', '### Options Claude offered', '### Recommendation'],
  ja: ['### いまの指示（概要）', '### なぜ聞いているか', '### Claude が示した選択肢', '### おすすめ'],
}

function expectChatInstructions(prompt: string, lang: 'en' | 'ja') {
  for (const section of CHAT_SECTIONS[lang]) expect(prompt).toContain(section)
  for (let i = 1; i < CHAT_SECTIONS[lang].length; i++) {
    expect(prompt.indexOf(CHAT_SECTIONS[lang][i - 1]!)).toBeLessThan(prompt.indexOf(CHAT_SECTIONS[lang][i]!))
  }
  expect(prompt).not.toContain('AskUserQuestion')
}

for (const surface of SURFACES) {
  test(`plain-text question band waits for an opted-in detected turn on ${surface}`, { options: { chatQuestions: 'on', language: 'en' } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    const before = await mountBand($, surface)
    expect(await before.find({ key: 'explain-waiting' })).toBeUndefined()
    await before.unmount()
    await finishTurn($, 'Which approach do you prefer?')
    expect(calls.savedWaiting).toMatchObject({ id: 'chat-demo-chat', question: 'Which approach do you prefer?', lang: 'en' })
    expect(calls.savedEntries).toEqual([])
    expect(calls.complete).toBe(0)
    expect(calls.fork).toBe(0)
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /Which approach do you prefer/ })).toBeDefined()
    expect((await ui.find({ key: 'explain-waiting' }))?.props).toMatchObject({ label: 'Explain', hotkey: 'e' })
    expect((await ui.find({ key: 'dismiss-waiting' }))?.props.label).toBe('×')
    await ui.unmount()
    await finishTurn($, 'The demo is ready.')
    expect(calls.savedWaiting).toBeNull()
    const cleared = await mountBand($, surface)
    expect(await cleared.find({ key: 'explain-waiting' })).toBeUndefined()
    await cleared.unmount()
  })

  for (const option of ['default', 'off'] as const) {
    test(`plain-text question ${option} option leaves waiting state untouched on ${surface}`, { options: option === 'off' ? { chatQuestions: 'off' } : {} }, async ($, on) => {
      const calls = engineBeneath(on, {})
      await finishTurn($, 'Should I proceed?')
      expect(calls.waitingWrites).toBe(0)
      expect(calls.savedWaiting).toBeUndefined()
      const ui = await mountBand($, surface)
      expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
      expect(await ui.find({ key: 'dismiss-waiting' })).toBeUndefined()
      expect(calls.complete).toBe(0)
      expect(calls.fork).toBe(0)
      await ui.unmount()
    })
  }

  test(`plain-text question band drops the ?? hint in a narrow row on ${surface}`, { options: { chatQuestions: 'on', language: 'en' } }, async ($, on) => {
    engineBeneath(on, {})
    await finishTurn($, 'Which approach do you prefer?')
    const wide = await mountBand($, surface)
    expect(await wide.find({ type: 'Text', text: 'or type ?? + Enter' })).toBeDefined()
    await wide.unmount()
    const narrow = await mountBand($, surface, { ...BAND_PROPS, bodyColumns: 90 })
    expect(await narrow.find({ type: 'Text', text: 'or type ?? + Enter' })).toBeUndefined()
    expect(await narrow.find({ key: 'explain-waiting' })).toBeDefined()
    expect(await narrow.find({ key: 'dismiss-waiting' })).toBeDefined()
    await narrow.unmount()
  })

  for (const prop of ['isWorking', 'hasSurvey'] as const) {
    test(`plain-text question band yields while ${prop} on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
      const calls = engineBeneath(on, {})
      await finishTurn($, 'Should I proceed?')
      const ui = await mountBand($, surface, { ...BAND_PROPS, [prop]: true })
      expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
      expect(await ui.find({ key: 'dismiss-waiting' })).toBeUndefined()
      expect(calls.savedWaiting?.question).toBe('Should I proceed?')
      await ui.unmount()
    })
  }

  for (const { name, fields } of [
    { name: 'subagent', fields: { agentId: 'demo-agent' } },
    { name: 'isAborted', fields: { isAborted: true } },
    { name: 'aborted', fields: { reason: 'aborted', isAborted: true } },
    { name: 'error', fields: { reason: 'error' } },
    { name: 'refusal', fields: { reason: 'refusal', refusal: { category: 'demo', explanation: 'Refused.' } } },
  ] as const) {
    test(`plain-text detection excludes ${name} turns on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
      const calls = engineBeneath(on, {})
      await finishTurn($, 'Should I proceed?', fields)
      expect(calls.waitingWrites).toBe(0)
      expect(calls.savedWaiting).toBeUndefined()
      const ui = await mountBand($, surface)
      expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
      expect(calls.complete).toBe(0)
      expect(calls.fork).toBe(0)
      await ui.unmount()
    })
  }

  for (const lang of ['en', 'ja'] as const) {
    for (const trigger of ['button', '??'] as const) {
      test(`${lang} plain-text ${trigger} explanation uses one compact Haiku request on ${surface}`, { options: { chatQuestions: 'on', language: lang, context: 'full' } }, async ($, on) => {
        const calls = engineBeneath(on, {}, { completeReply: { ...EXPLANATION, usage: MEASURED_USAGE } })
        await submit($, 'Build a demo todo app.')
        await finishTurn($, CHAT_QUESTIONS[lang])
        const ui = await mountBand($, surface)
        expect((await ui.find({ key: 'explain-waiting' }))?.props.label).toBe(lang === 'en' ? 'Explain' : 'AI要約')
        if (trigger === 'button') await ui.press({ key: 'explain-waiting' })
        else {
          const result = await submit($, '??')
          expect(result).toEqual({ drop: lang === 'en'
            ? 'qa-guide: explaining the question in the question guide (?? was not sent to Claude)'
            : 'qa-guide: 質問ガイドに AI 要約を表示しています（?? は Claude に送っていません）' })
        }
        await calls.clock.settle()
        expect(calls.complete).toBe(1)
        expect(calls.completeRequests).toHaveLength(1)
        expect(calls.completeRequests[0]).toMatchObject({ model: 'haiku', maxTokens: 1500 })
        expect(calls.fork).toBe(0)
        expect(calls.submitted.map(input => input.text)).toEqual(['Build a demo todo app.'])
        expectChatInstructions(calls.completePrompts[0]!, lang)
        expect(calls.completePrompts[0]).toContain(CHAT_QUESTIONS[lang])
        expect(calls.completePrompts[0]!.length).toBeLessThanOrEqual(12000)
        expect(calls.savedEntries).toHaveLength(1)
        expect(calls.savedEntries[0]).toMatchObject({
          id: 'chat-demo-chat', kind: 'chat', lang, lead: CHAT_QUESTIONS[lang],
          explainMode: 'compact', explainState: 'done', status: 'open',
          usage: MEASURED_USAGE, usageModel: 'haiku', usageModelId: 'claude-haiku-4-5',
          userPrompts: ['Build a demo todo app.'], answers: {},
          questions: [{ header: lang === 'en' ? 'In-text question' : '文章での質問', options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }] }],
        })
        expect(calls.savedWaiting?.entryId).toBe('chat-demo-chat')
        expect(calls.savedUsageTotal).toBe(2752)
        expectCost(calls.savedEntries[0]?.costUsd, 0.0052)
        expectCost(calls.savedCostTotal?.usd, 0.0052)
        expect(calls.savedCostTotal).toMatchObject({ tokens: 2752, hasPricedUsage: true, hasUnpricedUsage: false })
        expect(calls.opened).toEqual([{ id: 'qa-guide', title: lang === 'en' ? 'Question guide' : '質問ガイド' }])
        const repeated = await submit($, '??')
        expect(repeated).toHaveProperty('drop')
        expect(calls.submitted.map(input => input.text)).toEqual(['Build a demo todo app.'])
        expect(calls.complete).toBe(1)
        expect(calls.fork).toBe(0)
        expect(calls.savedEntries).toHaveLength(1)
        expect(calls.savedEntries[0]).toMatchObject({ status: 'open', answers: {} })
        await submit($, 'Use SQLite.')
        const pane = await mountPane($, surface, { ...PANE_PROPS, bodyColumns: 200 })
        expect(await pane.find({ type: 'Text', text: lang === 'en' ? /In-text question/ : /文章での質問/ })).toBeDefined()
        expect(await pane.find({ type: 'Text', text: USAGE_LINE[lang] + 'haiku' + COST_SUFFIX[lang]('$0.0052') })).toBeDefined()
        expect(await pane.find({ type: 'Text', text: sessionTokenLine(lang, '2.8k') + COST_SUFFIX[lang]('$0.0052') })).toBeDefined()
        await pane.unmount()
        await ui.unmount()
      })
    }

    test(`${lang} Full context on a chat entry keeps plain-text instructions on ${surface}`, { options: { chatQuestions: 'on', language: lang } }, async ($, on) => {
      const calls = engineBeneath(on, {}, {
        sessionModel: 'claude-opus-5-5', completeReply: { ...EXPLANATION, usage: MEASURED_USAGE }, forkReply: { ...EXPLANATION, text: 'FULL_CHAT_DEMO', usage: SESSION_USAGE },
      })
      await finishTurn($, CHAT_QUESTIONS[lang])
      await submit($, '??')
      await calls.clock.settle()
      const ui = await mountPane($, surface)
      await ui.press({ key: 'deep' })
      await calls.clock.settle()
      expect(calls.complete).toBe(1)
      expect(calls.fork).toBe(1)
      expectChatInstructions(calls.forkPrompts[0]!, lang)
      expect(calls.savedEntries[0]).toMatchObject({ kind: 'chat', explainMode: 'full', explanation: 'FULL_CHAT_DEMO', usage: SESSION_USAGE, usageModel: 'session' })
      expect(calls.savedUsageTotal).toBe(18400)
      expectCost(calls.savedEntries[0]?.costUsd, 0.01172)
      expectCost(calls.savedCostTotal?.usd, 0.01692)
      expect(calls.savedCostTotal).toMatchObject({ tokens: 18400, hasPricedUsage: true, hasUnpricedUsage: false })
      await ui.unmount()
    })
  }

  test(`the next normal prompt answers an explained chat entry and clears the band on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    await finishTurn($, 'Which approach do you prefer?')
    await submit($, '??')
    await calls.clock.settle()
    const input: PromptSubmitInput = { text: 'Use the simple approach. ' + 'Keep this detail. '.repeat(45), origin: { kind: 'composer' }, wait: false }
    expect(input.text.length).toBeGreaterThan(600)
    expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
    expect(calls.submitted).toEqual([input])
    expect(calls.savedEntries).toHaveLength(1)
    expect(calls.savedEntries[0]).toMatchObject({ kind: 'chat', status: 'answered', answers: { 'Which approach do you prefer?': input.text } })
    expect(calls.savedPrompts).toEqual([input.text.slice(0, 600)])
    expect(calls.savedWaiting).toBeNull()
    const ui = await mountBand($, surface)
    expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
    expect(await ui.find({ key: 'dismiss-waiting' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a reply without an explanation clears the pending question without an entry on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    await finishTurn($, 'Should I proceed?')
    await submit($, 'Yes, proceed.')
    expect(calls.savedWaiting).toBeNull()
    expect(calls.savedEntries).toEqual([])
    expect(calls.complete).toBe(0)
    expect(calls.fork).toBe(0)
    const ui = await mountBand($, surface)
    expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
    await ui.unmount()
  })

  test(`the dismiss button clears the pending plain-text question on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    await finishTurn($, 'Should I proceed?')
    const ui = await mountBand($, surface)
    expect((await ui.find({ key: 'dismiss-waiting' }))?.props.label).toBe('×')
    await ui.press({ key: 'dismiss-waiting' })
    expect(calls.savedWaiting).toBeNull()
    expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
    expect(await ui.find({ key: 'dismiss-waiting' })).toBeUndefined()
    expect(calls.savedEntries).toEqual([])
    expect(calls.complete).toBe(0)
    expect(calls.fork).toBe(0)
    await ui.unmount()
  })

  test(`a reply during slow plain-text context setup remains answered after explanation on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { messagesDelay: 1000 })
    await finishTurn($, 'Should I proceed?')
    const ui = await mountBand($, surface)
    const explained = ui.press({ key: 'explain-waiting' })
    await calls.clock.settle()
    expect(calls.savedEntries).toHaveLength(1)
    expect(calls.savedEntries[0]).toMatchObject({ kind: 'chat', status: 'open', explainState: 'pending' })
    expect(calls.complete).toBe(0)
    const input: PromptSubmitInput = { text: 'Yes, proceed.', origin: { kind: 'composer' }, wait: false }
    expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
    expect(calls.submitted).toEqual([input])
    expect(calls.savedWaiting).toBeNull()
    expect(calls.savedEntries[0]).toMatchObject({ status: 'answered', answers: { 'Should I proceed?': input.text } })
    expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
    await calls.clock.advance(1000)
    await explained
    await calls.clock.settle()
    expect(calls.savedEntries).toHaveLength(1)
    expect(calls.savedEntries[0]).toMatchObject({ kind: 'chat', status: 'answered', explainState: 'done', answers: { 'Should I proceed?': input.text } })
    expect(calls.savedWaiting).toBeNull()
    expect(calls.complete).toBe(1)
    expect(calls.fork).toBe(0)
    await ui.unmount()
  })

  test(`concurrent plain-text explanation button presses create one request on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {}, { completeDelay: 1000 })
    await finishTurn($, 'Should I proceed?')
    const ui = await mountBand($, surface)
    const first = ui.press({ key: 'explain-waiting' })
    const second = ui.press({ key: 'explain-waiting' })
    await calls.clock.settle()
    expect(calls.complete).toBe(1)
    expect(calls.fork).toBe(0)
    expect(calls.savedEntries).toHaveLength(1)
    await calls.clock.advance(1000)
    await Promise.all([first, second])
    expect(calls.savedUsageTotal).toBe(2)
    await ui.unmount()
  })

  test(`a delayed explanation button press cannot revive a dismissed question on ${surface}`, { options: { chatQuestions: 'on' } }, async ($, on) => {
    const calls = engineBeneath(on, {})
    on('ui.press', { component: 'AbovePrompt', element: 'explain-waiting' }, async (_$, e, next) => {
      await calls.clock.sleep(1000)
      return next(e)
    })
    await finishTurn($, 'Should I proceed?')
    const ui = await mountBand($, surface)
    const explained = ui.press({ key: 'explain-waiting' }).then(() => '', error => String(error))
    await calls.clock.settle()
    await ui.press({ key: 'dismiss-waiting' })
    await calls.clock.advance(1000)
    expect(await explained).toContain('no handler is held under')
    expect(calls.savedWaiting).toBeNull()
    expect(calls.savedEntries).toEqual([])
    expect(calls.complete).toBe(0)
    expect(calls.fork).toBe(0)
    await ui.unmount()
  })
}

test('?? without a pending plain-text question passes every input field through unchanged', { options: { chatQuestions: 'on' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  const input: PromptSubmitInput = { text: '??', origin: { kind: 'composer' }, wait: false, context: ['Demo context.'], attachments: [{ type: 'image', mediaType: 'image/png', filename: 'demo.png' }] }
  expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
  expect(calls.submitted).toEqual([input])
  expect(calls.savedEntries).toEqual([])
  expect(calls.complete).toBe(0)
  expect(calls.fork).toBe(0)
})

test('?? with plain-text detection off passes through even when waiting state is present', { options: { chatQuestions: 'off' } }, async ($, on) => {
  const calls = engineBeneath(on, {})
  on('state.get', { plugin: 'qa-guide', key: 'waiting' }, () => ({ value: { value: { id: 'demo-off', lang: 'en', question: 'Should I proceed?', options: [], text: 'Should I proceed?' }, version: 1 } }) as never)
  const input: PromptSubmitInput = { text: '??', origin: { kind: 'composer' }, wait: false }
  expect(await $.prompt.submit(input)).toEqual({ text: input.text, context: input.context, origin: input.origin })
  expect(calls.submitted).toEqual([input])
  expect(calls.savedEntries).toEqual([])
  expect(calls.complete).toBe(0)
  expect(calls.fork).toBe(0)
  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ key: 'explain-waiting' })).toBeUndefined()
    expect(await ui.find({ key: 'dismiss-waiting' })).toBeUndefined()
    await ui.unmount()
  }
})

for (const lang of ['en', 'ja'] as const) {
  test(`compact chat context budgets its own ${lang} instructions and oversized questions`, () => {
    const questions = [{ ...QUESTIONS[0]!, options: Array.from({ length: 10 }, (_, i) => ({ label: `Choice${i + 1}`, description: '\n"'.repeat(1000), preview: 'x'.repeat(20000) })) }]
    const prompt = buildCompactContext(toolSummaryMessages(), ['\n"'.repeat(10000)], 'lead text '.repeat(1000), questions, lang, 'chat')
    expectChatInstructions(prompt, lang)
    expect(prompt.length).toBeLessThanOrEqual(12000)
    for (const option of questions[0]!.options) expect(prompt).toContain(option.label)
  })

  for (const context of ['compact', 'full'] as const) {
    test(`${lang} ${context} dialog explanation retains the existing dialog instructions`, { options: { language: lang, context } }, async ($, on) => {
      const calls = engineBeneath(on, {})
      await ask($)
      await calls.clock.settle()
      const prompt = context === 'compact' ? calls.completePrompts[0] : calls.forkPrompts[0]
      expect(prompt).toContain('AskUserQuestion')
      expect(prompt).toContain(lang === 'en' ? '### Effect of each option' : '### 選択肢ごとの影響')
      expect(prompt).not.toContain(CHAT_SECTIONS[lang][2]!)
    })
  }
}
