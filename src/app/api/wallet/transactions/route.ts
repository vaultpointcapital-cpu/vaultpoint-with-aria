import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface Cursor {
  createdAt: string;
  id: string;
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * GET /api/wallet/transactions?cursor&limit
 *
 * Keyset pagination on (created_at, id) — stable under concurrent inserts,
 * unlike offset pagination. idx_wallet_txn_user (user_id, created_at desc)
 * covers this query.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const url = new URL(request.url);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  let query = supabase
    .from('wallet_transactions')
    .select('id, type, amount, currency, status, provider, provider_reference, metadata, created_at')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    // Keyset predicate: strictly older than the cursor row.
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
    );
  }

  const { data, error } = await query;

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load wallet transactions.');
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return apiSuccess({ transactions: page, nextCursor });
}
