-- ============================================================================
-- PamojaRide — one-shot live schema snapshot (READ-ONLY, changes nothing)
-- Run this single query in Supabase SQL Editor and paste back the ONE
-- row of JSON it returns.
-- ============================================================================

select json_build_object(
  'columns', (
    select json_agg(json_build_object(
      'table', table_name, 'column', column_name, 'type', data_type,
      'default', column_default, 'nullable', is_nullable
    ) order by table_name, ordinal_position)
    from information_schema.columns
    where table_schema = 'public'
  ),
  'constraints', (
    select json_agg(json_build_object(
      'table', tc.table_name, 'name', tc.constraint_name,
      'type', tc.constraint_type, 'check', cc.check_clause
    ))
    from information_schema.table_constraints tc
    left join information_schema.check_constraints cc
      on tc.constraint_name = cc.constraint_name and tc.table_schema = cc.constraint_schema
    where tc.table_schema = 'public'
  ),
  'triggers', (
    select json_agg(json_build_object(
      'table', event_object_table, 'name', trigger_name,
      'timing', action_timing, 'event', event_manipulation, 'action', action_statement
    ))
    from information_schema.triggers
    where trigger_schema = 'public'
  ),
  'public_rls_policies', (
    select json_agg(json_build_object(
      'table', tablename, 'policy', policyname, 'cmd', cmd,
      'roles', roles, 'using', qual, 'with_check', with_check
    ))
    from pg_policies
    where schemaname = 'public'
  ),
  'storage_buckets', (
    select json_agg(json_build_object(
      'id', id, 'public', public, 'size_limit', file_size_limit, 'mime_types', allowed_mime_types
    ))
    from storage.buckets
  ),
  'storage_rls_policies', (
    select json_agg(json_build_object(
      'policy', policyname, 'cmd', cmd, 'roles', roles, 'using', qual, 'with_check', with_check
    ))
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  ),
  'sample_driver_rows', (
    select json_agg(json_build_object(
      'profile_id', profile_id, 'status', verification_status,
      'kyc_documents', kyc_documents, 'submitted_at', kyc_submitted_at, 'created_at', created_at
    ))
    from (select * from public.driver_profiles order by created_at desc limit 3) d
  )
) as snapshot;
