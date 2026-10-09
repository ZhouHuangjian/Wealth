"""Runtime grants shared by local initialization and ACL-free restore.

wealth_cleanup_scope is private to the migration owner's SECURITY DEFINER
functions. Granting it to the app would bypass immutable-ledger protections.
Apply the whole block in one transaction; never grant it even temporarily.
"""

RUNTIME_GRANTS_SQL = """
GRANT USAGE ON SCHEMA public TO wealth_app;
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND c.relowner='wealth_owner'::regrole
      AND c.relname<>'wealth_cleanup_scope'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO wealth_app', item.relname);
  END LOOP;
  IF to_regclass('public.wealth_cleanup_scope') IS NOT NULL THEN
    REVOKE ALL ON public.wealth_cleanup_scope FROM PUBLIC, wealth_app;
  END IF;
  -- pg_restore --no-acl also loses the migration's function ACLs.
  FOR item IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND p.proowner='wealth_owner'::regrole
      AND p.proname IN ('wealth_cleanup_permitted','wealth_purge_workspace',
        'wealth_delete_platform_user','wealth_purge_business_record')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC', item.proname, item.arguments);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO wealth_app', item.proname, item.arguments);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wealth_app;
"""
