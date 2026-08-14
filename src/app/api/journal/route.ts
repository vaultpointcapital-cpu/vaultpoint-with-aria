import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createJournalEntrySchema } from '@/lib/validations/journal';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const LIST_LIMIT = 20;

/**
 * GET/POST /api/journal
 *
 * In-app equivalent of the Telegram Aria bot's /journal command (see
 * docs/aria-migration/01-telegram-to-in-app.md). No Claude call involved —
 * same as Telegram's version, this is a plain append-only log, not an
 * Aria conversation; the chat UI just uses this as a structured action.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, note, created_at')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load journal entries.');
  }

  return apiSuccess({ entries: data });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = createJournalEntrySchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid journal entry.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('journal_entries')
    .insert({ user_id: authData.user.id, note: parsed.data.note })
    .select('id, note, created_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not save journal entry.');
  }

  return apiSuccess({ entry: data }, 201);
}
