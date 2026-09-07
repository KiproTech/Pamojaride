import { getSupabaseClient } from './supabaseClients';

// ============================================================================
// Backward-compatible `supabase` export.
//
// Dozens of existing pages do `import { supabase } from '../../lib/supabase'`
// and call it directly for CRUD (bookings, trips, notifications, etc).
// Rather than touch every one of those imports, this Proxy transparently
// resolves to whichever portal's isolated client (see supabaseClients.js)
// matches the CURRENT route every time a property is accessed — so
// `supabase.from('bookings')` called from a page under /driver/* uses the
// driver session's token, and the same call from /passenger/* uses the
// passenger session's token, automatically.
//
// This is safe because every page that uses this import only runs its
// queries while mounted on a route under its own portal.
// ============================================================================

function currentPortal() {
  const path = window.location.pathname;
  if (path.startsWith('/driver')) return 'driver';
  if (path.startsWith('/passenger')) return 'passenger';
  if (path.startsWith('/admin')) return 'admin';
  return 'driver'; // harmless default for pages outside any portal (e.g. "/")
}

export const supabase = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getSupabaseClient(currentPortal());
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  }
);
