import { Resend } from 'resend';

let client: Resend | null = null;

/**
 * Server-only — RESEND_API_KEY must never reach a client bundle. Every
 * caller of this lives in an API route or a server-only lib module, same
 * trust boundary as createServiceClient() in lib/supabase/server.ts.
 */
export function getResendClient(): Resend {
  if (!client) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured.');
    }
    client = new Resend(apiKey);
  }
  return client;
}
