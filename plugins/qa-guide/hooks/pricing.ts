import type { QaUsage } from '../types'

type Price = { modelId: string; input: number; output: number; cacheRead: number }

/** USD per million tokens, list prices as of 2026-09. Update when prices change. */
export const API_PRICES: readonly Price[] = [
  { modelId: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.10 },
  { modelId: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.20 },
  { modelId: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.20 },
  { modelId: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.20 },
  { modelId: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.50 },
  { modelId: 'claude-opus-4-8', input: 5, output: 25, cacheRead: 0.50 },
  { modelId: 'claude-opus-4-7', input: 5, output: 25, cacheRead: 0.50 },
  { modelId: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.50 },
]

export function resolvePrice(model: string | undefined): Price | undefined {
  const id = model?.replace(/\[[^\]]*\]/g, '').trim()
  const modelId = id === 'haiku' ? 'claude-haiku-4-5' : id
  // The longest prefix wins (Opus 5.5 must not use the Opus 5 rate).
  return API_PRICES.reduce<Price | undefined>((match, price) =>
    modelId?.startsWith(price.modelId) && (!match || price.modelId.length > match.modelId.length)
      ? price : match, undefined)
}

export function estimateCost(usage: QaUsage, model: string | undefined): number | undefined {
  const price = resolvePrice(model)
  if (!price) return undefined
  return (usage.input_tokens * price.input + usage.output_tokens * price.output +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.input * 1.25) / 1_000_000
}

export const formatCost = (usd: number): string =>
  `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`
