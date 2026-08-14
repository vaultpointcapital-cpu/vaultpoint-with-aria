-- ============================================================================
-- VaultPoint Managed Accounts — fix missing disclosure_views UPDATE policy
-- ============================================================================
-- Gap found while building the onboarding routes: 20260718000004 gave
-- disclosure_views a SELECT policy only, but PATCH
-- /api/managed-accounts/disclosure-view/:id needs to set
-- scrolled_to_bottom_at once the client finishes reading — with no UPDATE
-- policy at all, that write would be silently rejected by RLS regardless
-- of what the application code checks. Scoped narrowly: a user can only
-- update their own row, and only ever needs to (the application layer
-- decides what changes; RLS just gates who).
-- ============================================================================

create policy "Users can mark their own disclosure views as read"
  on public.disclosure_views for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
