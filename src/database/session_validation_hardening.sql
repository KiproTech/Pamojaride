-- ============================================================================
-- PamojaRide — Login/session: single-active-session server-side enforcement
-- ============================================================================
--
-- CONTEXT: public.active_sessions (profile_id, role, session_id,
-- device_label, updated_at; PK (profile_id, role)) already exists in the
-- live schema (db.sql) and AuthContext.jsx already reads/writes it (claim on
-- login, Realtime channel that watches for another device overwriting the
-- row, delete on logout). What's missing, and what this migration adds, is
-- the piece that makes the DATABASE — not just a Realtime message the old
-- tab might never receive — the actual authority:
--
--   1. RLS on active_sessions itself. No policy for this table appears in
--      any migration in this project; if none exists live either, every
--      claim/kick/logout call from the client (all plain REST calls, not
--      SECURITY DEFINER) has been silently failing closed. This adds the
--      minimum idempotent set: a user may only see/claim/release their OWN
--      row, by their OWN authenticated identity — never anyone else's.
--
--   2. is_my_session_active(p_role, p_session_id): a SECURITY DEFINER RPC
--      the app polls (AuthContext.jsx heartbeat, every 45s + on tab focus)
--      as a Realtime-independent fallback. It trusts nothing the client
--      sends except "is auth.uid() who you say you are" (from the verified
--      JWT) and the session id the client is holding — it looks up the
--      CURRENT row in active_sessions itself and returns a plain boolean.
--      A client cannot make a replaced session "pass" this check by editing
--      localStorage: doing so only changes which (wrong) id gets compared
--      against the DB's row, it can't change what the DB's row says.
--
-- This is additive: no existing table, column, trigger, or policy on any
-- OTHER table is touched. Safe to run multiple times.
-- ============================================================================

ALTER TABLE public.active_sessions ENABLE ROW LEVEL SECURITY;

-- A user may read only their own active-session rows (all three portal rows
-- if they're logged into more than one) — needed for any client-side
-- "which of my portals are currently active" check, and harmless since a
-- row only ever contains this user's own device_label/session_id.
DROP POLICY IF EXISTS "users can read own active sessions" ON public.active_sessions;
CREATE POLICY "users can read own active sessions"
ON public.active_sessions FOR SELECT
TO authenticated
USING (profile_id = auth.uid());

-- Claiming a session (login, or a same-device/same-portal tab re-claiming
-- its already-persisted id) is the user writing their OWN row. WITH CHECK
-- blocks writing a row for anyone else's profile_id — there is no
-- legitimate client-side reason to ever do that, and this is what stops a
-- malicious client from forging a takeover of another account's session.
DROP POLICY IF EXISTS "users can claim own active session" ON public.active_sessions;
CREATE POLICY "users can claim own active session"
ON public.active_sessions FOR INSERT
TO authenticated
WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS "users can update own active session" ON public.active_sessions;
CREATE POLICY "users can update own active session"
ON public.active_sessions FOR UPDATE
TO authenticated
USING (profile_id = auth.uid())
WITH CHECK (profile_id = auth.uid());

-- Logout (AuthContext.signOut) deletes this device's own row, scoped by
-- session_id so it can never delete a row that already belongs to a device
-- that took over after it (see the .eq('session_id', ...) guard in the app).
DROP POLICY IF EXISTS "users can delete own active session" ON public.active_sessions;
CREATE POLICY "users can delete own active session"
ON public.active_sessions FOR DELETE
TO authenticated
USING (profile_id = auth.uid());

-- Admin visibility (User Management-style screens, and useful for support
-- diagnosing "why was I logged out") — read-only, no admin write path exists
-- or is needed for this table.
DROP POLICY IF EXISTS "admin can read all active sessions" ON public.active_sessions;
CREATE POLICY "admin can read all active sessions"
ON public.active_sessions FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- is_my_session_active: the authoritative check AuthContext.jsx's heartbeat
-- polls. SECURITY DEFINER so it can read active_sessions regardless of the
-- caller's own RLS visibility, but it only EVER evaluates the CALLER's own
-- auth.uid() — p_role/p_session_id are just "which of my rows, and what do
-- I currently think its id is", never another user's identity.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_my_session_active(p_role text, p_session_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.active_sessions
    WHERE profile_id = auth.uid()
      AND role = p_role
      AND session_id = p_session_id
  );
$function$;

-- Callable by any signed-in user (checks only their own row, per above) —
-- not admin-only, since every logged-in device needs to poll its own status.
GRANT EXECUTE ON FUNCTION public.is_my_session_active(text, uuid) TO authenticated;

-- ============================================================================
-- Deliberately NOT done here, and why:
--
-- - No CHECK/trigger restricting the free-text `role` column beyond the
--   existing ARRAY['driver','passenger','admin'] constraint in db.sql —
--   that constraint already exists and already rejects anything else.
--
-- - No attempt to revoke a device's Supabase Auth JWT the instant it's
--   replaced. Supabase's access tokens are short-lived and independently
--   verified by PostgREST/GoTrue on every request; this migration's RLS +
--   RPC make the APPLICATION correctly refuse to treat a replaced session as
--   valid (the actual product requirement here), which is what every check
--   in this file enforces. Proactively revoking the raw token itself before
--   its natural expiry would require a server-side call (e.g. an Edge
--   Function using the service-role key) to Supabase Auth's admin session
--   API — a genuinely separate, optional hardening layer, not something
--   achievable from RLS/client code alone, and out of this task's scope
--   ("do not create a second authentication system"). See the response's
--   "remaining issues" note.
-- ============================================================================
