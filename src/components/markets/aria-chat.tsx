'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ url: string; title: string }>;
}

// Mirrors ariaChatSchema.history's cap in @/lib/validations/aria — chat
// history isn't persisted server-side yet, so the client only ever sends
// its own recent state back.
const MAX_HISTORY_TURNS = 20;

// Matches the Telegram Aria bot's analyze_symbol() template exactly
// (aria_bot/claude_advisor.py) — sent as a normal chat message through
// the same /api/aria/chat backend, per the Aria migration spec's own
// suggested pattern for structured actions ("a button that triggers the
// same backend function"), rather than a separate route.
function buildAnalyzePrompt(symbol: string): string {
  // symbol comes in TradingView's EXCHANGE:PAIR format (e.g.
  // "BINANCE:BTCUSDT") — strip the exchange prefix so the prompt reads
  // like Telegram's raw-pair /analyze <symbol> usage, not TradingView
  // widget syntax.
  const pair = symbol.includes(':') ? (symbol.split(':')[1] ?? symbol) : symbol;
  return (
    `Give me a Smart Money Concepts (SMC) multi-timeframe analysis for ${pair}. ` +
    `Cover: current structure (swing vs internal), any recent CHOCH, key order blocks ` +
    `or supply/demand zones, and a scored conviction setup with entry, stop loss, ` +
    `take profit, and R:R ratio if a valid setup exists.`
  );
}

function displaySymbol(symbol: string): string {
  return symbol.includes(':') ? (symbol.split(':')[1] ?? symbol) : symbol;
}

interface AriaChatProps {
  symbol?: string;
}

export function AriaChat({ symbol }: AriaChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  const [isJournalOpen, setIsJournalOpen] = useState(false);
  const [journalNote, setJournalNote] = useState('');
  const [isLoggingJournal, setIsLoggingJournal] = useState(false);
  const [journalStatus, setJournalStatus] = useState<string | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const history = messages.slice(-MAX_HISTORY_TURNS).map(({ role, content }) => ({
      role,
      content,
    }));

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/aria/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error ?? 'Aria is temporarily unavailable. Please try again.');
        return;
      }

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: body.reply, sources: body.sources },
      ]);
    } catch {
      setError('Could not reach Aria. Check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    await sendMessage(input);
  }

  function handleAnalyzeClick() {
    if (!symbol) return;
    void sendMessage(buildAnalyzePrompt(symbol));
  }

  async function handleJournalSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = journalNote.trim();
    if (!trimmed || isLoggingJournal) return;

    setIsLoggingJournal(true);
    setJournalStatus(null);

    try {
      const res = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setJournalStatus(body?.error ?? 'Could not save your note. Please try again.');
        return;
      }

      setJournalNote('');
      setIsJournalOpen(false);
      setJournalStatus('📝 Logged.');
    } catch {
      setJournalStatus('Could not reach the journal. Check your connection and try again.');
    } finally {
      setIsLoggingJournal(false);
    }
  }

  return (
    <Card className="flex h-[600px] flex-col p-0">
      <CardHeader className="border-b border-border px-5 pb-4 pt-5">
        <CardTitle>Aria</CardTitle>
        <CardDescription>Your AI portfolio &amp; market advisor</CardDescription>
        {/* Persistent, not dependent on what Aria's response happens to
            say in any given message — the system prompt instructs the
            model to frame answers as information, not advice
            (src/app/api/aria/chat/route.ts), but that alone isn't
            visible to a user reading the chat. This is. */}
        <p className="text-[11px] text-text-tertiary">
          Aria is an AI assistant, not a licensed financial advisor. Informational only — not financial advice.
        </p>
      </CardHeader>

      <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
        {symbol && (
          <Button type="button" variant="outline" size="sm" onClick={handleAnalyzeClick} disabled={isLoading}>
            Analyze {displaySymbol(symbol)}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setIsJournalOpen((open) => !open);
            setJournalStatus(null);
          }}
        >
          Log a note
        </Button>
      </div>

      {isJournalOpen && (
        <form onSubmit={handleJournalSubmit} className="flex gap-2 border-b border-border px-5 py-3">
          <Input
            value={journalNote}
            onChange={(e) => setJournalNote(e.target.value)}
            placeholder="Quick trade note..."
            maxLength={1000}
            disabled={isLoggingJournal}
            aria-label="Journal note"
          />
          <Button type="submit" size="sm" isLoading={isLoggingJournal} disabled={isLoggingJournal || !journalNote.trim()}>
            Log
          </Button>
        </form>
      )}

      {journalStatus && (
        <p className="px-5 pt-2 text-xs text-text-tertiary" role="status">
          {journalStatus}
        </p>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !isLoading && (
          <p className="text-sm text-text-tertiary">
            Ask Aria about your portfolio or what&apos;s moving the market.
          </p>
        )}

        {messages.map((message, i) => (
          <ChatBubble key={i} message={message} />
        ))}

        {isLoading && <ThinkingBubble />}

        <div ref={scrollAnchorRef} />
      </div>

      {error && (
        <div
          role="alert"
          className="mx-5 mb-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSend} className="flex gap-2 border-t border-border p-4">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Aria..."
          maxLength={2000}
          disabled={isLoading}
          aria-label="Message Aria"
        />
        <Button type="submit" isLoading={isLoading} disabled={isLoading || !input.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}>
      <span
        className={cn(
          'mb-1 text-[10px] font-semibold uppercase tracking-wide',
          isUser ? 'text-success' : 'text-accent-light'
        )}
      >
        {isUser ? 'You' : 'Aria'}
      </span>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm text-text-primary',
          isUser ? 'bg-success/10' : 'bg-accent/10'
        )}
      >
        {message.content}
      </div>
      {message.sources && message.sources.length > 0 && (
        <div className="mt-1 max-w-[85%] space-y-0.5">
          {message.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-[11px] text-text-tertiary hover:text-accent-light hover:underline"
            >
              {source.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex flex-col items-start">
      <span className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent-light">
        Aria
      </span>
      <div className="flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-2.5" aria-live="polite">
        <span className="sr-only">Aria is thinking</span>
        <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-accent" />
        <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-accent [animation-delay:200ms]" />
        <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-accent [animation-delay:400ms]" />
      </div>
    </div>
  );
}
