select p.proname as function_name, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
and p.proname in (
  'protect_driver_profile_privileged_columns',
  'protect_passenger_profile_privileged_columns',
  'is_verified_driver',
  'is_admin',
  'protect_notification_content',
  'audit_profile_admin_changes'
);
