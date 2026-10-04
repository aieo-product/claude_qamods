import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelForkResult, On, PaneOpenArgs, PromptOrigin, PromptSubmitInput, RenderPropsOf, SessionMessage, ToolCallResult, UiScrollArgs } from 'claude-code'

import { openQuestionPane } from './register'
import type { QaEntry } from '../types'

const SURFACES = ['terminal', 'desktop'] as const

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
  submitted: PromptSubmitInput[]
  savedPrompts: string[]
  savedEntries: QaEntry[]
  savedCursor?: number
  toast: string[]
  opened: PaneOpenArgs[]
  registered: string[]
  order: string[]
  clock: MockClock
}

type EngineOptions = {
  isPlaced?: boolean
  forkDelay?: number
  toolDelay?: number
  forkReply?: ModelForkResult
  toolError?: boolean
  toolThrows?: boolean
  agentMessages?: SessionMessage[]
  response?: string
  messages?: SessionMessage[]
  cursor?: number
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
} satisfies ModelForkResult

function engineBeneath(on: On, answers: Record<string, string> | 'deny', options: EngineOptions = {}): Calls {
  const calls: Calls = {
    fork: 0,
    forkPrompts: [],
    submitted: [],
    savedPrompts: [],
    savedEntries: [],
    toast: [],
    opened: [],
    registered: [],
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
      if (e.key === 'cursor') calls.savedCursor = e.value
    }
    return ran
  })
  on('state.get', { plugin: 'qa-guide', key: 'cursor' }, (_$, e, next) =>
    options.cursor !== undefined
      ? { value: { value: options.cursor, version: 1 } } as never
      : next(e),
  )
  on('session.messages', (_$, e) => ({ value: e.agentId && options.agentMessages ? options.agentMessages : options.messages ?? [
    { role: 'user', text: 'Build a demo todo app', toolUses: [] },
    { role: 'assistant', text: 'I scaffolded the app. Next I need a database.', toolUses: [] },
  ] }))
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
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    calls.submitted.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('model.fork', async (_$, e) => {
    calls.fork += 1
    calls.forkPrompts.push(e.prompt)
    calls.order.push('fork')
    if (options.forkDelay) await calls.clock.sleep(options.forkDelay)
    return { value: options.forkReply ?? EXPLANATION }
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

const LONG_EXPLANATION: ModelForkResult = {
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

const NUMBERED_EXPLANATION: ModelForkResult = {
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

test('prompt submission records only the person origins and forwards every original input unchanged', async ($, on) => {
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

test('recorded prompts retain the last five and cap each at 600 characters without changing the submission', async ($, on) => {
  const calls = engineBeneath(on, {})
  const texts = Array.from({ length: 7 }, (_, i) => `Demo instruction ${i + 1}: ${'x'.repeat(650)}`)
  for (const text of texts) await submit($, text)
  await submit($, ' \n\t ')

  const saved = calls.savedPrompts
  expect(saved).toEqual(texts.slice(-5).map(text => text.slice(0, 600)))
  expect(calls.submitted.map(input => input.text)).toEqual([...texts, ' \n\t '])
  for (const text of saved) expect(text.length).toBeLessThanOrEqual(600)
})

test('a failed prompt history write still forwards the person prompt unchanged', async ($, on) => {
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

test('questions snapshot the latest three recorded prompts in order and include them as quoted fork data', async ($, on) => {
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
  const forkPrompt = calls.forkPrompts[0] ?? ''
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

test('the fork prompt requires short numbered guidance in dialog order for each question', async ($, on) => {
  const calls = engineBeneath(on, {})
  await ask($, NUMBERED_QUESTIONS)
  await calls.clock.settle()
  const prompt = calls.forkPrompts[0] ?? ''
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

test('session fallback keeps the latest three person rows and skips XML, empty and tool result rows', async ($, on) => {
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

test('an open pane shows only the newest composer instruction on at most two compact lines', async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, forkDelay: 10, messages: [
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
    expect(instructions.map(row => row.text).join('')).toContain('NEWEST_DEMO: explain the database tradeoffs.')
    expect(instructions.map(row => row.text).join('')).toContain('Keep the answer concise.')
    for (const row of instructions) {
      expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    expect(await ui.find({ text: /OLDER_DEMO|MIDDLE_DEMO|<task-notification>/ })).toBeUndefined()
    expect(rows.length).toBeLessThanOrEqual(20)
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('compact AI guidance strips Markdown markers, styles headings and keeps readable bullets', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    forkDelay: 10,
    forkReply: { ...EXPLANATION, text: [
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

test('compact numbered guidance has cyan number chips, bold labels and green recommendations on each surface', async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, forkDelay: 10, forkReply: NUMBERED_EXPLANATION })
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
      expect(row.props.wrap).toBe('truncate-end')
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

test('compact spacers never displace numbered AI content when the row budget is short', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    forkDelay: 10,
    forkReply: NUMBERED_EXPLANATION,
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

test('wrapped numbered option continuations align after the chip in a narrow compact pane', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    forkDelay: 10,
    forkReply: { ...EXPLANATION, text: [
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
      expect(row.props.wrap).toBe('truncate-end')
    }
    const chips = await ui.findAll({ type: 'Text', text: /^\s*[12]\s*$/ })
    expect(chips.map(chip => chip.text.trim())).toEqual(['1', '2'])
    expect(await ui.find({ type: 'Text', text: /^\s*SQLite[:：]?\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*PostgreSQL[:：]?\s*$/ })).toBeDefined()
    const rows = compactTextRows(await ui.drawn())
    expect(rows.length).toBeLessThanOrEqual(props.scroll!.bodyRows)
    for (const row of rows) {
      expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('an open question fits 20 background-only rows with AI, the newest instruction and lead tail on each surface', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    forkDelay: 10,
    forkReply: LONG_EXPLANATION,
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
    for (const row of rows) {
      expect(row.props.wrap).toBe('truncate-end')
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
  test(`compact ${explainState} AI guidance gives unused rows to instruction and lead context`, async ($, on) => {
    const calls = engineBeneath(on, {}, {
      toolDelay: 1000,
      forkDelay: explainState === 'pending' ? 2000 : 10,
      forkReply: { isAnswered: false, reason: 'nothing-to-fork' },
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
      expect(await ui.find({ type: 'Text', text: explainState === 'off' ? /OFF/ : explainState === 'pending' ? /生成中/ : /解説を生成できませんでした: nothing-to-fork/ })).toBeDefined()
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
    if (explainState === 'off') expect(calls.fork).toBe(0)
  })
}

test('compact rows remain bounded with full-width text in a narrow pane', async ($, on) => {
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
    forkDelay: 10,
    forkReply: { ...EXPLANATION, text: `理由は全角文字でも行数を制限するためです。${'背景と影響を確認して選択します。'.repeat(40)}` },
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
      expect(row.props.wrap).toBe('truncate-end')
      expect(row.text).not.toContain('\n')
    }
    expect((await ui.find({ type: 'Box' }))?.props.width).toBe(18)
    expect(await ui.find({ type: 'Text', text: /^✦ AI解説: 理由は全$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /全角Ａ案|全角Ｂ案|構成と移行方針/ })).toBeUndefined()
    expect(await ui.find({ text: /NARROW_PREVIEW/ })).toBeUndefined()
    await ui.unmount()
  }
  await calls.clock.advance(990)
  await pending
})

test('a taller compact pane clamps AI guidance to 65 percent and marks omitted lines', async ($, on) => {
  const calls = engineBeneath(on, {}, {
    toolDelay: 1000,
    forkDelay: 10,
    forkReply: LONG_EXPLANATION,
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

test('zero, one and tiny pane row budgets drop content without overflowing', async ($, on) => {
  const calls = engineBeneath(on, {}, { toolDelay: 1000, forkDelay: 2000 })
  const pending = ask($, COMPACT_QUESTIONS)
  await calls.clock.settle()
  for (const bodyRows of [0, 1, 2, 5]) {
    for (const surface of SURFACES) {
      const props: RenderPropsOf['Pane'] = { ...PANE_PROPS, scroll: { offset: 0, bodyRows } }
      const ui = await mountPane($, surface, props)
      const rows = compactTextRows(await ui.drawn())
      expect(rows.length).toBeLessThanOrEqual(bodyRows)
      for (const row of rows) {
        expect(row.props.wrap).toBe('truncate-end')
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

test('cancelling the dialog restores full previews and toolbar', async ($, on) => {
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
test('each question pane opens completely before requesting its scroll start', async () => {
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
  test(`a ${failure} scroll failure preserves the opened question pane result`, async () => {
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

test('a question still answers when the engine has no drawn pane to scroll', async ($, on) => {
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

test('an answered question shows context, options and the chosen answer', async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'PostgreSQL' })
  const ran = await ask($)

  expect(calls.fork).toBe(1)
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

test('a dismissed question is marked cancelled', async ($, on) => {
  engineBeneath(on, 'deny')
  await ask($)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /キャンセル/ })).toBeDefined()
    await ui.unmount()
  }
})

test('turning the AI explanation off skips the fork', async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'ai' }))?.props.hotkey).toBe('a')
  await ui.press({ key: 'ai' })
  await ui.unmount()

  await ask($)

  expect(calls.fork).toBe(0)
  const after = await mountPane($, 'terminal')
  expect(await after.find({ text: /AI解説: OFF/ })).toBeDefined()
  await after.press({ key: 'ai' })
  await after.unmount()

  await ask($, QUESTIONS, 'toolu_2')
  expect(calls.fork).toBe(1)
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
    options.forkReply = { ...EXPLANATION, text: `${name.toUpperCase()}_AI: this is why we ask.` }
    await ask($, questions, `toolu_navigation_${index}`)
  }
}

const NAV_ANSWERS = Object.fromEntries(NAV_QUESTIONS.map(questions => [questions[0]!.question, questions[0]!.options[0]!.label]))

async function expectNavigationUnavailable(ui: Awaited<ReturnType<typeof mountPane>>, key: string) {
  const button = await ui.find({ key })
  if (button) expect(button.props.disabled ?? button.props.isDisabled).toBe(true)
}

test('prev next and latest navigate selected question context and answers on each surface', async ($, on) => {
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
  test(`a stored cursor of ${cursor} clamps to the available entry range on every render`, async ($, on) => {
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

test('a historical open entry uses the full layout while the newest question is answered', async ($, on) => {
  engineBeneath(on, {}, { cursor: 1 })
  const history: QaEntry[] = NAV_QUESTIONS.map((questions, index) => ({
    id: `toolu_retained_${index}`,
    askedAt: index + 1,
    userPrompts: [`RETAINED_INSTRUCTION_${index}: review the demo.`],
    lead: `RETAINED_LEAD_${index}: the decision background.`,
    questions,
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

test('a new question resets history cursor and compact context always describes the newest open entry', async ($, on) => {
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
  options.forkReply = { ...EXPLANATION, text: 'ARRIVING_AI: the fresh decision needs background.' }
  options.toolDelay = 1000
  options.forkDelay = 10
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
    expect(await compact.findAll({ type: 'Button' })).toHaveLength(0)
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

test('history open buttons jump to each entry and mark the selected question', async ($, on) => {
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

test('history lists earlier questions with their answers', async ($, on) => {
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

test('/qa-guide opens the pane', async ($, on) => {
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

test('a single-select label containing a comma is highlighted in full', async ($, on) => {
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

test('a freeform response is shown on the current question', async ($, on) => {
  engineBeneath(on, {}, { response: 'Use in-memory storage.' })
  await ask($)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /Use in-memory storage\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a freeform response remains visible in history', async ($, on) => {
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

test('the AI fork starts before the question and never holds up the answer', async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    forkDelay: 1000,
    toolDelay: 100,
  })
  const pending = ask($)
  await calls.clock.settle()
  expect(calls.order).toEqual(['fork', 'tool'])

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

test('an unplaced pane offers the /qa-guide command in a toast', async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, { isPlaced: false })
  const ran = await ask($)

  expect(calls.opened).toEqual([{ id: 'qa-guide', title: '質問ガイド' }])
  expect(calls.toast).toEqual(['質問ガイド: /qa-guide で背景と選択肢の詳細を表示できます'])
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })
  expect(calls.fork).toBe(1)
  await calls.clock.settle()
})

test('multi-select question cards show previews and highlight every chosen option', async ($, on) => {
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

test('history retains the latest 20 entries including the current question', async ($, on) => {
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

test('an engine tool error is relayed and marks the question cancelled', async ($, on) => {
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

test('an unavailable AI explanation leaves the original answer intact', async ($, on) => {
  const calls = engineBeneath(on, { 'Which database should the demo app use?': 'SQLite' }, {
    forkReply: { isAnswered: false, reason: 'nothing-to-fork' },
  })
  const ran = await ask($)
  expect(calls.fork).toBe(1)
  expect(ran).toHaveProperty('result.answers', { 'Which database should the demo app use?': 'SQLite' })

  await calls.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /解説を生成できませんでした: nothing-to-fork/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✔ SQLite/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回答済み/ })).toBeDefined()
    await ui.unmount()
  }
})

test('context includes recent real user requests and the latest request following lead text', async ($, on) => {
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

test('a question with no context and no header still draws on every surface', async ($, on) => {
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

test('an entry stored before userPrompts existed still draws', async ($, on) => {
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

test('a multi-line answer stays on one line in history', async ($, on) => {
  engineBeneath(on, { 'Which database should the demo app use?': 'Make it readable\nand numbered' })
  await ask($)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_after', questions: QUESTIONS })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'hist' })
  expect(await ui.find({ type: 'Text', text: /→ Make it readable and numbered/ })).toBeDefined()
  await ui.unmount()
})

test('a question whose dispatch rejects is marked cancelled and the error propagates', async ($, on) => {
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

test('quoted multi-select answers containing commas are matched per label', async ($, on) => {
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

test('a subagent question reads the lead text from that agent\'s conversation', async ($, on) => {
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
