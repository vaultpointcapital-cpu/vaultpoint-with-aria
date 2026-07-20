import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/send';
import { WelcomeEmailTemplate } from '@/lib/email/templates/welcome';

/**
 * Handles the redirect after a user clicks an email verification or
 * magic link. Exchanges the auth code for a session, then sends them
 * into onboarding.
 *
 * Also fires the welcome email exactly once — the first time this route
 * successfully confirms a user, per welcome_email_sent_at's own dedupe
 * contract (never re-sent on a later hit for the same user, e.g. a
 * second magic-link click). A failed send here never blocks the
 * redirect — same "never break the actual flow" rule as signup's own
 * Resend send.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = createClient();
    const { data } = await supabase.auth.exchangeCodeForSession(code);

    if (data.user) {
      const admin = createServiceClient();
      const { data: profile } = await admin
        .from('users')
        .select('full_name, welcome_email_sent_at')
        .eq('id', data.user.id)
        .single();

      if (profile && !profile.welcome_email_sent_at) {
        const emailResult = await sendEmail({
          to: data.user.email!,
          subject: 'Your VaultPoint account is ready',
          react: WelcomeEmailTemplate({ appUrl: origin, fullName: profile.full_name }),
          emailType: 'welcome',
        });

        if (emailResult.success) {
          await admin.from('users').update({ welcome_email_sent_at: new Date().toISOString() }).eq('id', data.user.id);
        }
      }
    }
  }

  return NextResponse.redirect(`${origin}/onboarding`);
}
