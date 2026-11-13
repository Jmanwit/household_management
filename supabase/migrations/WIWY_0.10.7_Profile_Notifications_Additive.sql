-- WIWY 0.10.7 additive profile and notification inbox support
-- Run once in the Supabase SQL Editor before deploying the 0.10.7 application files.
-- Safe to rerun: uses IF NOT EXISTS and does not delete or rewrite existing rows.

begin;

alter table public.member_profiles
  add column if not exists contact_email text,
  add column if not exists phone_number text,
  add column if not exists profile_notes text,
  add column if not exists avatar_url text;

alter table public.notifications
  add column if not exists dismissed_at timestamptz;

create index if not exists wiwy_notifications_workspace_created_idx
  on public.notifications (workspace_id, created_at desc);

create index if not exists wiwy_notifications_workspace_dismissed_idx
  on public.notifications (workspace_id, dismissed_at)
  where dismissed_at is null;

commit;

-- Notes:
-- 1. Profile fields are optional and preserve all existing member profile rows.
-- 2. avatar_url is reserved for a future profile-image upload flow; 0.10.7 does not
--    upload image files or expose avatar_url in the profile editor.
-- 3. dismissed_at hides a notification from the active inbox; it does not delete
--    notification history or task/activity records.
-- 4. The application filters the active inbox to the last 24 hours. This migration
--    intentionally does not purge historical notifications.
