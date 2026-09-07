select p.proname as function_name, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
and p.proname in ('book_seats', 'cancel_booking', 'cancel_trip', 'complete_trip', 'get_trip_contact');
