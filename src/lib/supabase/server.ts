import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database';

/**
 * Server-side Supabase client for use in Server Components, Route Handlers,
 * and Server Actions. Reads/writes the session via Next.js cookies so auth
 * state stays in sync between server and client.
 *
 * Still uses the anon key + RLS, not the service role key — this respects
 * the logged-in user's own permissions. Use createServiceClient() instead
 * for trusted backend jobs (cron, webhooks) that need to bypass RLS.
 */
export function createClient() {
  const cookieStore = cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase environment variables. Check .env.local against .env.example.'
    );
  }

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Called from a Server Component — middleware handles the actual
          // session refresh, so this can safely no-op here.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // Same as above — safe to ignore in Server Component context.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses Row Level Security entirely.
 *
 * SECURITY: only ever import this in trusted server-side contexts —
 * webhook handlers, cron jobs, the FastAPI poller's callback endpoints.
 * NEVER import this in a Client Component or expose its result to the
 * browser. The service role key must never reach the client bundle.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing Supabase service role environment variables. This client must only run server-side.'
    );
  }

  return createServerClient<Database>(url, serviceKey, {
    cookies: {
      get() {
        return undefined;
      },
      set() {
        // Service client is never tied to a user session — no cookies to set.
      },
      remove() {
        // Service client is never tied to a user session — no cookies to remove.
      },
    },
  });
}
