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

export function AriaChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
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

  return (
    <Card className="flex h-[600px] flex-col p-0">
      <CardHeader className="border-b border-border px-5 pb-4 pt-5">
        <CardTitle>Aria</CardTitle>
        <CardDescription>Your AI portfolio &amp; market advisor</CardDescription>
      </CardHeader>

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
          isUser ? 'text-success' : 'text-accent'
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
              className="block truncate text-[11px] text-text-tertiary hover:text-accent hover:underline"
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
      <span className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
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
