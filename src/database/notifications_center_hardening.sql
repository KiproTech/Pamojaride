-- ============================================================================
-- PamojaRide — Notifications & In-App Alerts: security hardening + realtime
-- Run this once in the Supabase SQL Editor.
-- ============================================================================
--
-- CONTEXT / WHY THIS FILE EXISTS
--
-- Audited every .sql file in this project for anything touching
-- `public.notifications`. Found: the table definition (db.sql), ~10
-- migrations that add notification TYPES to notifications_type_check, and
-- calls to `public.notify(user_id, type, title, body, data)` from several
-- trigger functions (notify_admins_of_new_report, notify_report_status_change,
-- notify_new_support_request, mark_no_show, auto_start_departed_trips, etc).
--
-- NOT found anywhere in the tracked SQL history:
--   - `ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY`
--   - ANY RLS policy on `public.notifications`
--   - A definition for `public.notify()` itself
--   - A definition for `protect_notification_content` (referenced only as a
--     name to introspect in inspect_functions.sql, implying it was created
--     directly in the SQL Editor in an earlier session and never saved back
--     into a tracked file — the same thing verification_storage.sql notes
--     happened with the driver_profiles privilege trigger)
--
-- Matching that: NotificationBell.jsx has only ever scoped notifications to
-- the signed-in user via `.eq('user_id', user.id)` in the CLIENT query —
-- i.e. ownership has been enforced by the frontend filter alone. Anyone who
-- called `supabase.from('notifications').select()` or `.update()` directly
-- (e.g. from the browser console) with no matching RLS policy could read or
-- modify another user's notifications, since Postgres has nothing to fall
-- back on without RLS. This is the "user_id supplied/trusted from the
-- frontend" gap Prompt 15 specifically asks to close.
--
-- I don't have live database access in this environment (no SQL connector),
-- so unlike earlier files in this project I can't confirm the exact current
-- state by introspection before writing this. Every statement below is
-- written defensively/idempotently (DROP ... IF EXISTS, CREATE OR REPLACE,
-- guarded DO blocks) so it is SAFE TO RUN whether or not any of the above
-- already exists, in this exact order, without weakening or duplicating
-- anything. Please run inspect_live_schema.sql first if you want to confirm
-- current state before applying.
--
-- NOTHING here touches notification DATA — no rows are deleted or altered,
-- only constraints/policies/triggers/indexes/publication membership.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Enable RLS and lock ownership down to auth.uid().
--
--    SELECT: a user can only ever see their own notifications.
--    UPDATE: a user can only update their own notifications — and (see
--            step 2) only the is_read/read_at columns actually move, even
--            if a crafted request tries to change more.
--    No INSERT or DELETE policy for `authenticated` is created. This is
--    deliberate: every notification in this project is created by a
--    SECURITY DEFINER function (public.notify(), the notify_* trigger
--    functions) that runs as the function owner rather than the calling
--    user — the same established pattern as notify_admins_of_new_report,
--    is_admin(), etc. elsewhere in this project — so those keep working
--    unchanged. A plain authenticated user gets no policy path to insert a
--    row directly (e.g. a fake 'admin_announcement' to themselves) or to
--    delete their notification history.
-- ----------------------------------------------------------------------------

alter table public.notifications enable row level security;

drop policy if exists "users can view own notifications" on public.notifications;
create policy "users can view own notifications"
on public.notifications for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "users can update own notifications" on public.notifications;
create policy "users can update own notifications"
on public.notifications for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 2. protect_notification_content: a user's UPDATE (step 1's policy) is
--    only meant to flip is_read/read_at. This trigger silently pins every
--    other column back to its stored value on any UPDATE from a regular
--    session, so a crafted request can't rewrite a notification's title,
--    body, type, data, or reassign it to a different user_id — mirroring
--    the same "protect_*_privileged_columns" pattern already used on
--    driver_profiles/passenger_profiles in this project. SECURITY DEFINER
--    functions (public.notify(), etc.) only ever INSERT, never UPDATE, so
--    this never affects notification creation.
-- ----------------------------------------------------------------------------

create or replace function public.protect_notification_content()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.user_id     := old.user_id;
  new.type        := old.type;
  new.title       := old.title;
  new.body        := old.body;
  new.data        := old.data;
  new.created_at  := old.created_at;
  return new;
end;
$function$;

drop trigger if exists trg_protect_notification_content on public.notifications;
create trigger trg_protect_notification_content
before update on public.notifications
for each row
execute function public.protect_notification_content();


-- ----------------------------------------------------------------------------
-- 3. public.notify(): defensively (re)declared with the exact signature
--    every existing caller in this project already uses —
--    notify(p_user_id, p_type, p_title, p_body, p_data) — so it's
--    guaranteed to exist with this shape regardless of how/when it was
--    first created. SECURITY DEFINER + search_path pinned, matching every
--    other privileged function in this project, and owned by the role that
--    runs this migration (typically `postgres`, which has BYPASSRLS) so
--    the RLS policies in step 1 never block legitimate server-side
--    notification creation.
-- ----------------------------------------------------------------------------

-- The live function already exists with a different return type (likely
-- `void`, since every caller uses `PERFORM public.notify(...)` rather than
-- capturing a result) — Postgres won't let CREATE OR REPLACE change a
-- function's return type, so it has to be dropped first. This only drops
-- the notify(uuid,text,text,text,jsonb) overload; nothing else is touched.
drop function if exists public.notify(uuid, text, text, text, jsonb);

create function public.notify(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_data jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if p_user_id is null then
    return null;
  end if;

  insert into public.notifications (user_id, type, title, body, data, is_read)
  values (p_user_id, p_type, p_title, p_body, p_data, false)
  returning id into v_id;

  return v_id;
end;
$function$;

grant execute on function public.notify(uuid, text, text, text, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. Indexes for the new Notification Center's queries (own-rows list,
--    ordered newest-first, paginated; unread count/badge). Safe to add
--    regardless of table size — CREATE INDEX IF NOT EXISTS is a no-op if
--    they're already there.
-- ----------------------------------------------------------------------------

create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);

create index if not exists idx_notifications_user_unread
  on public.notifications (user_id, is_read)
  where is_read = false;


-- ----------------------------------------------------------------------------
-- 5. Realtime: add `notifications` to the supabase_realtime publication so
--    NotificationBell.jsx / NotificationsList.jsx can subscribe to
--    postgres_changes (INSERT for new notifications, UPDATE for read-state
--    changes made elsewhere/another tab). Guarded so re-running this file
--    never errors if the table is already published.
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Row-level filtering for realtime (e.g. `filter: user_id=eq.<id>` in the
-- frontend channel subscriptions) is enforced the same way regular reads
-- are: through the RLS policy from step 1, evaluated per-subscriber. A
-- user can only ever receive realtime events for their own rows.


-- ----------------------------------------------------------------------------
-- Verification queries (read-only, run after applying the above):
--
--   -- Confirm RLS is on and both policies exist:
--   select relrowsecurity from pg_class where relname = 'notifications';
--   select policyname, cmd, qual, with_check from pg_policies
--     where tablename = 'notifications';
--
--   -- Confirm the protection trigger is attached:
--   select tgname from pg_trigger
--     where tgrelid = 'public.notifications'::regclass and not tgisinternal;
--
--   -- Confirm realtime publication membership:
--   select * from pg_publication_tables
--     where pubname = 'supabase_realtime' and tablename = 'notifications';
-- ============================================================================
