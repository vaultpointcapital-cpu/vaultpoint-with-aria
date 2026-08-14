import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase auth session on every request and keeps cookies
 * in sync. Required for SSR auth to work correctly with the App Router —
 * without this, sessions silently expire mid-use.
 *
 * Uses getAll/setAll (the current @supabase/ssr cookie API), not the
 * deprecated get/set/remove trio — the response object must be
 * re-created after mutating request.cookies so the new cookies actually
 * propagate to it, same as the old pattern did per-cookie.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Misconfigured environment — let the request through rather than
    // crashing the whole app; downstream pages will surface the error.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: request.headers } });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Touching getUser() is what actually triggers the token refresh.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except static assets and image optimization files,
     * so the session refresh runs on every real page/API request. Also
     * excludes the PWA's own static files (sw.js, manifest.webmanifest,
     * icons/*, offline) and .well-known/* — none of these are
     * user-specific pages, so there's no session to refresh for them, and
     * every one of them must stay reachable even when auth/Supabase state
     * is broken (that's the whole point of /offline and the manifest).
     */
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|offline|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
