import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ============================================================================
// Portal-isolated Supabase clients.
//
// One browser can now hold an independent, simultaneous session for each
// portal (driver / passenger / admin) because each client persists its
// auth token under its OWN localStorage key instead of the default shared
// key. Logging in on the driver client never touches the passenger
// client's token, and vice versa — even when both sessions belong to the
// same underlying account/email.
//
// This is the standard Supabase pattern for "multiple concurrent sessions
// in one browser": https://supabase.com/docs/reference/javascript/auth-api
// (see the `storageKey` option under createClient auth config).
// ============================================================================

const PORTALS = ['driver', 'passenger', 'admin'];

const clients = {};

for (const portal of PORTALS) {
  clients[portal] = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storageKey: `sb-${portal}-auth`,
      persistSession: true,
      autoRefreshToken: true,
      // Deliberately OFF. All three clients above are created together, on
      // every page load, regardless of which portal the user is actually
      // on. If this were left on for more than one client, they'd all try
      // to detect/consume a one-time auth link (e.g. a password recovery
      // link) from the URL at once — a race where the wrong portal's
      // client could silently "win" and claim a link that was never meant
      // for it (e.g. a passenger's password-reset link being consumed by
      // the driver client, since it's constructed first in `PORTALS`).
      // Password recovery links are instead handled explicitly, by the
      // one correct portal client, in src/pages/auth/ResetPassword.jsx.
      detectSessionInUrl: false,
    },
  });
}

export function getSupabaseClient(portal) {
  if (!clients[portal]) {
    throw new Error(`Unknown portal "${portal}". Expected one of: ${PORTALS.join(', ')}`);
  }
  return clients[portal];
}

export const driverSupabase = clients.driver;
export const passengerSupabase = clients.passenger;
export const adminSupabase = clients.admin;
