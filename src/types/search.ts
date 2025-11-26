import { z } from 'zod'

export const searchSchema = z.object({
  q: z.string().min(1),
  count: z.number().int().min(1).max(100).default(10),
  country: z.string().min(2).max(10).optional(),
  search_lang: z.string().optional(),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  safesearch: z.enum(['off', 'moderate', 'strict']).optional(),
})

export type SearchInput = z.infer<typeof searchSchema>
