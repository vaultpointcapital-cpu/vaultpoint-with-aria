import { z } from 'zod';

/**
 * A single prior turn, sent by the client so Aria has conversational
 * context. We don't persist chat history server-side yet (Sprint 12
 * scope) — the client is the source of truth for the running thread.
 */
const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
});

export const ariaChatSchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(2000, 'Message is too long'),
  history: z.array(chatTurnSchema).max(20, 'Conversation history is too long').default([]),
});

export type AriaChatInput = z.infer<typeof ariaChatSchema>;

/**
 * Aria is a Pro/Elite differentiator per the PRD (Sprint 12–14, priority
 * 18/20) — Free tier does not get access. Centralized here so the API
 * route and any future client-side gating check the same thing.
 */
export function canUseAria(tier: 'free' | 'pro' | 'elite'): boolean {
  return tier === 'pro' || tier === 'elite';
}
