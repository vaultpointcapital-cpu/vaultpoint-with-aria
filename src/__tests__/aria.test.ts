import { describe, it, expect } from 'vitest';
import { ariaChatSchema, canUseAria } from '@/lib/validations/aria';

describe('canUseAria', () => {
  it('denies free tier', () => {
    expect(canUseAria('free')).toBe(false);
  });

  it('allows pro tier', () => {
    expect(canUseAria('pro')).toBe(true);
  });

  it('allows elite tier', () => {
    expect(canUseAria('elite')).toBe(true);
  });
});

describe('ariaChatSchema', () => {
  it('accepts a message with no history', () => {
    const result = ariaChatSchema.safeParse({ message: 'What is my BTC exposure?' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.history).toEqual([]);
    }
  });

  it('accepts a message with prior turns', () => {
    const result = ariaChatSchema.safeParse({
      message: 'And in USD terms?',
      history: [
        { role: 'user', content: 'What is my BTC exposure?' },
        { role: 'assistant', content: 'You hold 0.5 BTC long on Bybit.' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty message', () => {
    const result = ariaChatSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a message over 2000 characters', () => {
    const result = ariaChatSchema.safeParse({ message: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('rejects history longer than 20 turns', () => {
    const history = Array.from({ length: 21 }, (_, i) => ({
      role: 'user' as const,
      content: `turn ${i}`,
    }));
    const result = ariaChatSchema.safeParse({ message: 'hi', history });
    expect(result.success).toBe(false);
  });

  it('rejects a history turn with an invalid role', () => {
    const result = ariaChatSchema.safeParse({
      message: 'hi',
      history: [{ role: 'system', content: 'not allowed' }],
    });
    expect(result.success).toBe(false);
  });

  it('trims whitespace-only messages to empty and rejects them', () => {
    const result = ariaChatSchema.safeParse({ message: '   ' });
    expect(result.success).toBe(false);
  });
});
