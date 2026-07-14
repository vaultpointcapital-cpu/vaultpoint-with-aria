import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/types/database';

/**
 * Browser-side Supabase client. Uses the public anon key — safe to expose,
 * since Row Level Security on every table means this client can only ever
 * read/write rows the authenticated user actually owns.
 *
 * Call this fresh inside each Client Component that needs it; don't hoist
 * a single instance to module scope across the app.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase environment variables. Check .env.local against .env.example.'
    );
  }

  return createBrowserClient<Database>(url, anonKey);
}
