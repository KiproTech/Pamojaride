import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getSupabaseClient } from '../lib/supabaseClients';

const AuthContext = createContext({});

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];

function portalFromPath(pathname) {
  if (pathname.startsWith('/driver')) return 'driver';
  if (pathname.startsWith('/passenger')) return 'passenger';
  if (pathname.startsWith('/admin')) return 'admin';
  return null; // public pages (landing, etc.) aren't scoped to any portal
}

// Merge newly-uploaded document metadata into an existing kyc_documents
// array, replacing any prior entry of the same `type` (so re-uploading a
// document, e.g. a "Replace", never leaves a stale duplicate sitting
// alongside the fresh one). Pure helper — shared by the incremental
// per-step/autosave path and the final submission path so both merge
// documents exactly the same way.
function mergeKycDocuments(existingDocs, newDocuments) {
  if (!Array.isArray(newDocuments) || newDocuments.length === 0) return existingDocs;
  const incomingTypes = new Set(newDocuments.map(d => d.type));
  return [...existingDocs.filter(d => !incomingTypes.has(d.type)), ...newDocuments];
}

function makeSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts / older browsers where
  // crypto.randomUUID isn't available.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── per-portal, persisted "which device/browser is this" id ──────────────
//
// This id is what the "single active session" guard (claimSession below)
// registers against active_sessions. It's stored in localStorage under a
// key scoped to the PORTAL (mirroring the `sb-${portal}-auth` token key in
// supabaseClients.js), so:
//   - Two tabs of the SAME portal in the SAME browser (same localStorage)
//     always read back the SAME id -> re-claiming is a no-op, so opening a
//     second tab or refreshing an existing one never looks like "another
//     device" to the tabs that are already open.
//   - A genuinely different browser/device has its own localStorage, so it
//     always mints a fresh id on first claim -> it still correctly takes
//     over and kicks the old device, which is the intended security
//     behaviour.
//   - Different portals (driver/passenger/admin) use different keys, same
//     as their auth tokens, so they never share or collide with each
//     other's id.
function sessionGuardStorageKey(portal) {
  return `pamojaride-session-guard-${portal}`;
}

function getOrCreateSessionGuardId(portal) {
  try {
    const existing = window.localStorage.getItem(sessionGuardStorageKey(portal));
    if (existing) return existing;
  } catch (err) {
    // localStorage can throw in some private-browsing modes -- fall
    // through to an in-memory-only id below; auth itself still works,
    // this only means the device-guard id won't survive a refresh.
  }
  const fresh = makeSessionId();
  try { window.localStorage.setItem(sessionGuardStorageKey(portal), fresh); } catch (err) { /* see above */ }
  return fresh;
}

function clearSessionGuardId(portal) {
  try { window.localStorage.removeItem(sessionGuardStorageKey(portal)); } catch (err) { /* see above */ }
}

export function AuthProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const portal = portalFromPath(location.pathname);

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [driverProfile, setDriverProfile] = useState(null);
  const [passengerProfile, setPassengerProfile] = useState(null);
  const [adminProfile, setAdminProfile] = useState(null); // admin_profiles row: { admin_role, account_status, ... }
  const [loading, setLoading] = useState(true);
  const [kickedMessage, setKickedMessage] = useState(null); // set when another device took over this session

  const sessionIdRef = useRef(null);      // this tab's random id for the CURRENT portal's session
  const channelRef = useRef(null);        // realtime channel watching active_sessions
  const idleTimerRef = useRef(null);
  const heartbeatRef = useRef(null);      // fallback poll validating this session against the DB
  const portalRef = useRef(portal);
  portalRef.current = portal;

  const client = portal ? getSupabaseClient(portal) : null;

  // ── fetch identity + the role profile matching the current portal ─────
  const fetchProfile = useCallback(async (userId, activePortal, activeClient) => {
    try {
      const { data: profileRow, error: profileError } = await activeClient.from('profiles').select('*').eq('id', userId).single();
      if (profileError) console.error('fetchProfile: profiles query failed:', profileError);
      setProfile(profileRow ?? null);

      if (activePortal === 'driver') {
        const { data: driverRow, error: driverError } = await activeClient.from('driver_profiles').select('*').eq('profile_id', userId).maybeSingle();
        if (driverError) console.error('fetchProfile: driver_profiles query failed:', driverError);
        setDriverProfile(driverRow ?? null);
        setPassengerProfile(null);
      } else if (activePortal === 'passenger') {
        const { data: passengerRow, error: passengerError } = await activeClient.from('passenger_profiles').select('*').eq('profile_id', userId).maybeSingle();
        if (passengerError) console.error('fetchProfile: passenger_profiles query failed:', passengerError);
        setPassengerProfile(passengerRow ?? null);
        setDriverProfile(null);
        setAdminProfile(null);
      } else if (activePortal === 'admin') {
        // admin_profiles carries the role tier (super_admin / admin /
        // verification_admin / support_admin / reports_admin) and the
        // deactivated/active status. A row may legitimately be absent for
        // an admin created before this feature existed and not yet
        // backfilled -- isSuperAdmin/adminRole below just treat that as
        // "no elevated role", never as an error.
        const { data: adminRow, error: adminError } = await activeClient.from('admin_profiles').select('*').eq('profile_id', userId).maybeSingle();
        if (adminError) console.error('fetchProfile: admin_profiles query failed:', adminError);
        setAdminProfile(adminRow ?? null);
        setDriverProfile(null);
        setPassengerProfile(null);
      } else {
        setDriverProfile(null);
        setPassengerProfile(null);
        setAdminProfile(null);
      }
    } catch (err) {
      // Never let a thrown error here leave the caller's loading state
      // stuck at true forever -- fall back to "no profile" and let the
      // route guards handle it (they'll bounce to the right login page
      // instead of spinning indefinitely).
      console.error('fetchProfile threw:', err);
      setProfile(null);
      setDriverProfile(null);
      setPassengerProfile(null);
      setAdminProfile(null);
    }
  }, []);

  // ── register/refresh this BROWSER as the active session for this portal ──
  // Reuses the persisted guard id (getOrCreateSessionGuardId) rather than
  // minting a new random one every time this runs -- this fires on every
  // mount/refresh/tab-open for this portal, not just on a fresh login, so a
  // fresh id here every time would make every extra tab of the SAME
  // account+portal look like a takeover by "another device" and kick the
  // others. Reusing the id makes re-claiming from a sibling tab a no-op,
  // while a genuinely different browser (which has no id in its own
  // localStorage) still mints its own id and correctly takes over.
  const claimSession = useCallback(async (userId, activePortal, activeClient) => {
    const sessionId = getOrCreateSessionGuardId(activePortal);
    sessionIdRef.current = sessionId;
    await activeClient.from('active_sessions').upsert(
      {
        profile_id: userId,
        role: activePortal,
        session_id: sessionId,
        device_label: navigator.userAgent?.slice(0, 120) || 'unknown device',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'profile_id,role' }
    );
    return sessionId;
  }, []);

  // ── force sign-out (idle timeout OR kicked by another device) ─────────
  const forceSignOut = useCallback(async (message) => {
    if (!client || !portalRef.current) return;
    channelRef.current?.unsubscribe();
    clearInterval(heartbeatRef.current);
    await client.auth.signOut();
    clearSessionGuardId(portalRef.current);
    setUser(null);
    setProfile(null);
    setDriverProfile(null);
    setPassengerProfile(null);
    setAdminProfile(null);
    if (message) setKickedMessage(message);
    navigate(portalRef.current === 'admin' ? '/admin/login' : `/${portalRef.current}/login`, { replace: true });
  }, [client, navigate]);

  // ── session bootstrap + auth state changes, re-run whenever the portal changes ──
  useEffect(() => {
    let cancelled = false;
    channelRef.current?.unsubscribe();
    channelRef.current = null;

    if (!portal || !client) {
      setUser(null);
      setProfile(null);
      setDriverProfile(null);
      setPassengerProfile(null);
      setAdminProfile(null);
      setLoading(false);
      return;
    }

    // Mark auth state as "initializing" for THIS portal immediately/
    // synchronously with the portal change, rather than waiting for the
    // async work below to get around to it.
    //
    // Why this matters: `portal` is derived from the route, so switching
    // routes (e.g. "/" -> "/driver/dashboard", or "/passenger/..." ->
    // "/driver/...") changes `portal` and re-runs this effect -- but React
    // still renders route guards (ProtectedRoute/PublicRoute) with the
    // PREVIOUS portal's already-settled `loading`/`user` values for at
    // least one frame before this effect's promises resolve. If the
    // previous portal had already settled to `loading: false, user: null`
    // (e.g. the public landing page, where portal is null), a route guard
    // reading that stale snapshot for the new protected route sees "not
    // loading, no user" and immediately redirects back out -- which, if
    // something then navigates back in, becomes a redirect loop. Setting
    // `loading` true here, synchronously in the effect body (not inside
    // the awaited init()/loadSession()), closes that window: every portal
    // transition shows the loading spinner until this portal's session is
    // actually known, instead of ever acting on another portal's stale
    // state.
    setLoading(true);

    async function loadSession(session) {
      setLoading(true);
      try {
        setUser(session?.user ?? null);
        if (session?.user) {
          await fetchProfile(session.user.id, portal, client);
        } else {
          setProfile(null);
          setDriverProfile(null);
          setPassengerProfile(null);
          setAdminProfile(null);
        }
      } catch (err) {
        console.error('Auth session load failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function init() {
      let session = null;
      try {
        // client.auth.getSession() uses the browser's Web Locks API
        // internally (to coordinate auth state safely across tabs/portal
        // clients). There are known cases -- particularly in Firefox with
        // certain privacy/tracking-protection settings -- where that lock
        // never resolves, hanging this call forever and leaving the whole
        // portal stuck on the loading spinner. This timeout guarantees we
        // never wait more than 10s: if it's still pending by then, we log
        // a clear diagnostic and fall through with no session rather than
        // hang indefinitely.
        const result = await Promise.race([
          client.auth.getSession(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(
              'auth.getSession() timed out after 10s. This usually points to ' +
              'the browser\'s Web Locks API getting stuck (a known Firefox issue ' +
              'with some privacy/Enhanced-Tracking-Protection settings, or an ' +
              'extension). Try a Firefox private window, or check ' +
              'about:preferences#privacy for this site, to confirm.'
            )), 10000)
          ),
        ]);
        session = result.data.session;
      } catch (err) {
        console.error('Auth session init failed or timed out:', err);
      }
      if (cancelled) return;
      await loadSession(session);
    }
    init();

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      // NOTE: this fires on every sign-in/sign-out/token-refresh, not just
      // the initial page load. For SIGNED_IN/SIGNED_OUT/USER_UPDATED/
      // initial-session events it MUST also toggle `loading` (via
      // loadSession) -- otherwise a page like AdminLogin.jsx that
      // navigates right after supabase.auth.signInWithPassword() resolves
      // can land on a protected route a beat before `profile` has
      // actually been fetched, while `loading` is stuck at its old
      // `false` value from the initial mount. ProtectedRoute would then
      // read `isAdmin: false` (profile still null) and bounce straight
      // back to the login page -- which looks exactly like "nothing
      // happens when I try to log in".
      //
      // TOKEN_REFRESHED is different: it's a routine background event that
      // doesn't change WHO is signed in or their role, and it fires in
      // EVERY tab/client that shares this portal's storage key -- so a
      // driver working in one tab gets one every time a sibling tab (or
      // this one) silently rotates the access token. Routing it through
      // loadSession() would flip `loading` true and re-fetch profiles for
      // no reason, flashing the loading spinner over an already-working
      // dashboard. Just keep `user` in sync with the (possibly rotated)
      // session and leave `loading`/profiles alone.
      if (event === 'TOKEN_REFRESHED') {
        setUser(session?.user ?? null);
        return;
      }
      loadSession(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [portal, client, fetchProfile]);

  // ── single active session per (account, portal): claim on login, watch for takeover ──
  useEffect(() => {
    if (!user || !portal || !client) return;
    let cancelled = false;

    (async () => {
      const sessionId = await claimSession(user.id, portal, client);
      if (cancelled) return;

      channelRef.current = client
        .channel(`session-guard-${portal}-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'active_sessions', filter: `profile_id=eq.${user.id}` },
          (payload) => {
            const row = payload.new;
            if (row && row.role === portal && row.session_id !== sessionId) {
              forceSignOut('Your session ended because this account was signed in on another device.');
            }
          }
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, portal, client]);

  // ── heartbeat: authoritative DB re-check, independent of Realtime ────────
  //
  // Realtime is a convenience (instant kick while the old tab is sitting
  // open) but the task requires the DATABASE to remain the actual
  // authority, since a realtime channel can silently drop (network blip,
  // backgrounded tab, a proxy/firewall that kills long-lived websockets)
  // without the browser ever finding out its session was replaced.
  //
  // This calls the SECURITY DEFINER RPC is_my_session_active(), which
  // checks — server-side, against the row this portal's OWN OTHER login
  // last wrote — whether sessionIdRef.current is still the row stored for
  // (auth.uid(), portal). It runs:
  //   - immediately whenever the tab becomes visible again (covers "closed
  //     the laptop, opened it back up hours later" without waiting for the
  //     interval), and
  //   - on a 45s interval as a fallback for tabs that are never
  //     backgrounded (Realtime disconnect while the tab stays foregrounded).
  // A user can't spoof this by editing localStorage: the RPC doesn't trust
  // any value the client sends except the session id already established
  // by claimSession, and it looks up the CURRENT active_sessions row itself
  // via auth.uid() -- editing local storage only makes THIS check fail
  // sooner, it can never make it pass for a session the DB doesn't have on
  // record.
  useEffect(() => {
    if (!user || !portal || !client) return;
    let cancelled = false;

    async function checkStillActive() {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return; // hasn't finished claiming yet this mount
      try {
        const { data: stillActive, error } = await client.rpc('is_my_session_active', {
          p_role: portal,
          p_session_id: sessionId,
        });
        if (cancelled) return;
        if (error) {
          // Fail open on a transient/network error -- Realtime and the
          // next successful heartbeat remain the backstop. We only ever
          // sign out on an explicit `false` (a real, confirmed mismatch),
          // never merely because the check itself couldn't be reached.
          console.error('Session heartbeat check failed:', error);
          return;
        }
        if (stillActive === false) {
          await forceSignOut('Your session ended because this account was signed in on another device.');
        }
      } catch (err) {
        console.error('Session heartbeat check threw:', err);
      }
    }

    heartbeatRef.current = setInterval(checkStillActive, 45000);

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') checkStillActive();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(heartbeatRef.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, portal, client]);

  // ── 3-minute inactivity auto-logout, scoped to the current portal ─────
  useEffect(() => {
    if (!user || !portal) return;

    function resetTimer() {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        forceSignOut("Your session has expired. Please log in again.");
      }, IDLE_TIMEOUT_MS);
    }

    resetTimer();
    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, resetTimer, { passive: true }));

    return () => {
      clearTimeout(idleTimerRef.current);
      ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, resetTimer));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, portal]);

  // ── live account_status watch: catch a ban/suspension the instant an ──
  // admin applies it, even if this tab is already sitting on the
  // dashboard. Mirrors the active_sessions realtime pattern above, but
  // watches this user's OWN driver_profiles/passenger_profiles row
  // instead. Route guards (App.jsx ProtectedRoute) read driverProfile/
  // passengerProfile via statusFor(), so updating that state here is
  // enough to flip the UI to the Banned/Suspended page without a reload.
  useEffect(() => {
    if (!user || !portal || !client) return;
    if (portal !== 'driver' && portal !== 'passenger') return;

    const table = portal === 'driver' ? 'driver_profiles' : 'passenger_profiles';
    const setter = portal === 'driver' ? setDriverProfile : setPassengerProfile;

    const channel = client
      .channel(`account-status-${portal}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table, filter: `profile_id=eq.${user.id}` },
        (payload) => { if (payload.new) setter(payload.new); }
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [user?.id, portal, client]);

  function clearKickedMessage() {
    setKickedMessage(null);
  }

  // ── sign up (passenger) ────────────────────────────────────────────
  async function signUpPassenger({ fullName, phone, email, password }) {
    const c = getSupabaseClient('passenger');
    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, phone, role: 'passenger' } },
    });
    // Session claiming (active_sessions row) happens automatically via the
    // effect that watches `user` — it fires for ANY sign-in, whether
    // triggered here or by a page calling supabase.auth directly.
    return { data, error };
  }

  // ── sign up (driver) ───────────────────────────────────────────────
  async function signUpDriver({ fullName, phone, email, password }) {
    const c = getSupabaseClient('driver');
    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, phone, role: 'driver' } },
    });
    return { data, error };
  }

  // ── attach a role to an identity that already exists ─────────────────
  async function registerRoleForExistingIdentity(role) {
    const c = getSupabaseClient(role);
    const { data: userData, error: userError } = await c.auth.getUser();
    if (userError || !userData.user) return { error: userError || new Error('Not authenticated.') };

    const table = role === 'driver' ? 'driver_profiles' : 'passenger_profiles';
    const { data: existing } = await c.from(table).select('profile_id').eq('profile_id', userData.user.id).maybeSingle();
    if (existing) return { error: new Error(`This account already has a ${role} profile.`) };

    const { error } = await c.from(table).insert({ profile_id: userData.user.id });
    if (!error && portal === role) await fetchProfile(userData.user.id, role, c);
    return { error };
  }

  // ── sign in (portal-scoped: pass which portal explicitly, since this ──
  //    can be called from a login page even before routing settles) ─────
  async function signIn({ email, password }, explicitPortal = portal) {
    const c = getSupabaseClient(explicitPortal);
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    return { data, error };
  }

  // ── sign out (manual, user-initiated) ─────────────────────────────────
  async function signOut() {
    if (!client || !portal) return;
    channelRef.current?.unsubscribe();
    if (user && sessionIdRef.current) {
      // Only clear the row if we're still the current session — don't
      // clobber a session that already took over on another device.
      await client.from('active_sessions').delete().eq('profile_id', user.id).eq('role', portal).eq('session_id', sessionIdRef.current);
    }
    await client.auth.signOut();
    clearSessionGuardId(portal);
    setUser(null);
    setProfile(null);
    setDriverProfile(null);
    setPassengerProfile(null);
    setAdminProfile(null);
  }

  // ── update shared identity fields ─────────────────────────────────────
  async function updateProfile(updates) {
    const { data, error } = await client.from('profiles').update(updates).eq('id', user.id).select().single();
    if (!error && data) setProfile(data);
    return { data, error };
  }

  // ── update driver-specific fields ─────────────────────────────────────
  async function updateDriverProfile(updates) {
    const { data, error } = await client.from('driver_profiles').update(updates).eq('profile_id', user.id).select().single();
    if (!error && data) setDriverProfile(data);
    return { data, error };
  }

  async function refreshProfile() {
    if (user && portal && client) await fetchProfile(user.id, portal, client);
  }

  // ── save partial driver verification progress (autosave + per-step Next) ──
  // Persists whatever the driver has entered so far WITHOUT ever touching
  // verification_status — this is a plain update to columns the
  // protect_driver_profile_privileged_columns() trigger doesn't restrict
  // (vehicle/licence fields, kyc_documents, verification_step), scoped by
  // the existing "drivers can update own profile" RLS policy
  // (profile_id = auth.uid()). A driver can therefore never write into
  // another driver's row, and can never use this path to sneak a status
  // change past the trigger.
  //
  // `verificationStep`, if provided, only ever moves the stored resume
  // marker FORWARD (never backward) — so navigating Back to review or edit
  // an earlier step doesn't regress where the driver will resume next time.
  async function saveVerificationProgress({ driverFields = {}, profileFields = {}, newDocuments, verificationStep } = {}) {
    if (!client || !user) return { error: new Error('Not authenticated.') };

    const existingDocs = Array.isArray(driverProfile?.kyc_documents) ? driverProfile.kyc_documents : [];
    const driverUpdate = { ...driverFields };

    if (Array.isArray(newDocuments) && newDocuments.length > 0) {
      driverUpdate.kyc_documents = mergeKycDocuments(existingDocs, newDocuments);
      // A fresh face_verification capture always resets its sub-status back
      // to 'captured' — mirrors the same rule submitDriverVerification()
      // applies at final submission, so a previous admin decision on an old
      // capture can never leak forward onto a brand-new one, even mid-draft.
      if (newDocuments.some(d => d.type === 'face_verification')) {
        driverUpdate.face_verification_status = 'captured';
      }
    }

    if (typeof verificationStep === 'number') {
      const currentStep = driverProfile?.verification_step ?? 0;
      driverUpdate.verification_step = Math.max(currentStep, verificationStep);
    }

    let driverError = null;
    if (Object.keys(driverUpdate).length > 0) {
      const { data, error } = await client
        .from('driver_profiles')
        .update(driverUpdate)
        .eq('profile_id', user.id)
        .select()
        .single();
      if (!error && data) setDriverProfile(data);
      driverError = error;
    }

    let profileError = null;
    if (Object.keys(profileFields).length > 0) {
      const { error } = await updateProfile(profileFields);
      profileError = error;
    }

    return { error: driverError || profileError || null };
  }

  // ── submit driver verification (details + uploaded documents) ────────
  // `documents`, if provided, is an array of the small metadata objects
  // returned by uploadVerificationDocument() — never raw files, and never
  // anything the caller can use to point at another driver's record: this
  // always writes to the AUTHENTICATED user's own driver_profiles row
  // (.eq('profile_id', user.id)), regardless of what's in `fields`.
  async function submitDriverVerification(fields, documents) {
    // Merge with any documents already on file so re-uploading just one
    // replaced document (e.g. after a rejection) doesn't wipe the others.
    const existingDocs = Array.isArray(driverProfile?.kyc_documents) ? driverProfile.kyc_documents : [];
    const mergedDocs = mergeKycDocuments(existingDocs, documents);

    // vehicle_seats is clamped/validated here as a second line of defence —
    // the form already restricts it to an integer 1-100, and the DB has a
    // matching CHECK constraint (driver_approval_admin_policy / vehicle
    // verification migration), so this can never actually write outside
    // that range even if a caller somehow bypassed the form validation.
    const seats = fields.vehicleSeats ? parseInt(fields.vehicleSeats, 10) : null;
    const clampedSeats = Number.isInteger(seats) ? Math.min(100, Math.max(1, seats)) : null;

    const { data, error } = await client
      .from('driver_profiles')
      .update({
        licence_number: fields.licenceNumber,
        licence_expiry: fields.licenceExpiry,
        vehicle_plate: fields.vehiclePlate,
        vehicle_make: fields.vehicleMake,
        vehicle_model: fields.vehicleModel,
        vehicle_year: fields.vehicleYear ? parseInt(fields.vehicleYear, 10) : null,
        vehicle_color: fields.vehicleColor,
        vehicle_seats: clampedSeats,
        vehicle_type: fields.vehicleType || 'private_car',
        vehicle_type_other: fields.vehicleType === 'other' ? (fields.vehicleTypeOther || null) : null,
        kyc_documents: mergedDocs,
        // Draft/in-progress steps live at 0-3 (Personal/Vehicle/Documents/
        // Face); a completed, submitted verification is always recorded at
        // the final step index so a fresh load never bounces a submitted
        // driver back into an earlier step of the (now hidden) form.
        verification_step: 4,
        verification_status: 'pending_verification',
        // Driver-owned, not privileged — the trigger doesn't restrict this,
        // it's just an audit trail of when the accuracy checkbox was ticked.
        accuracy_confirmed_at: new Date().toISOString(),
        // Every (re)submission resets the face-verification sub-status back
        // to 'captured' if a new face_verification document came in this
        // call, so a previous admin decision on an old capture can't leak
        // forward onto a brand-new one.
        ...(mergedDocs.some(d => d.type === 'face_verification') ? { face_verification_status: 'captured' } : {}),
        // NOTE: kyc_submitted_at, kyc_attempts, and kyc_rejection_reason are
        // deliberately NOT sent here. The DB trigger
        // protect_driver_profile_privileged_columns() already sets
        // kyc_submitted_at/kyc_attempts itself on this exact transition,
        // and it HARD-BLOCKS any client-side change to kyc_rejection_reason
        // (raises an exception) — that field is admin-owned. Sending null
        // for it here would make every resubmission-after-rejection fail.
        // licence_class is intentionally never written anymore — the field
        // is deprecated (see database migration) but left untouched for any
        // driver whose historical row still has a value in it.
      })
      .eq('profile_id', user.id)
      .select()
      .single();
    if (!error && data) setDriverProfile(data);

    if (!error && (fields.nationalId || fields.emergencyContactName || fields.emergencyContactPhone)) {
      await updateProfile({
        national_id: fields.nationalId,
        emergency_contact_name: fields.emergencyContactName,
        emergency_contact_phone: fields.emergencyContactPhone,
      });
    }
    return { data, error };
  }

  // ── per-portal status helper ──────────────────────────────────────────
  function statusFor(role) {
    const roleProfile = role === 'driver' ? driverProfile : role === 'passenger' ? passengerProfile : null;
    return {
      exists: !!roleProfile,
      accountStatus: roleProfile?.account_status || 'active',
      isSuspended: roleProfile?.account_status === 'suspended',
      isBanned: roleProfile?.account_status === 'banned',
      suspensionReason: roleProfile?.suspension_reason || null,
    };
  }

  const verificationStatus = driverProfile?.verification_status ?? null;
  // NOTE: driver_profiles.verification_status DEFAULTs to 'pending' at the
  // DB level (src/database/db.sql) — that's the real initial value for a
  // brand-new driver, confirmed directly against the schema. A prior fix
  // here incorrectly trusted a code comment claiming a trigger sets
  // 'unverified' instead; 'unverified' and legacy 'active' are kept in the
  // list too, purely defensively, so nothing regresses if either value
  // turns out to exist on some row.

  const value = {
    user,
    profile,
    driverProfile,
    passengerProfile,
    adminProfile,
    loading,
    portal,
    supabase: client,
    kickedMessage,
    clearKickedMessage,
    signUpPassenger,
    signUpDriver,
    registerRoleForExistingIdentity,
    signIn,
    signOut,
    updateProfile,
    updateDriverProfile,
    refreshProfile,
    submitDriverVerification,
    saveVerificationProgress,
    statusFor,
    isDriver: !!driverProfile,
    isPassenger: !!passengerProfile,
    isAdmin: !!profile?.is_admin,
    // Admin role tier. Falls back to 'admin' (the general, least-privileged
    // tier) if is_admin is true but no admin_profiles row exists yet (e.g.
    // this migration hasn't been backfilled for this identity) -- never
    // silently grants super_admin. Non-admins get null.
    adminRole: profile?.is_admin ? (adminProfile?.admin_role || 'admin') : null,
    isSuperAdmin: !!profile?.is_admin && adminProfile?.admin_role === 'super_admin',
    // Convenience checker for gating a page/section to one or more roles.
    // super_admin is always allowed, matching the DB-side admin_has_role().
    hasAdminRole: (roles = []) => {
      if (!profile?.is_admin) return false;
      const role = adminProfile?.admin_role || 'admin';
      return role === 'super_admin' || roles.includes(role);
    },
    verificationStatus,
    isDriverVerified: verificationStatus === 'verified',
    needsVerification: ['pending', 'unverified', 'active', 'rejected'].includes(verificationStatus),
    verificationPending: ['pending_verification', 'under_review'].includes(verificationStatus),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
