-- Match names without accents or case, preserving their display spelling.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- PostgreSQL 18 LIKE supports ICU primary-strength nondeterministic collations.
-- Use separate search columns: record equality, uniqueness and ordering retain
-- their existing semantics. ILIKE does not support this collation.
CREATE COLLATION IF NOT EXISTS golaberto_search
  (provider = icu, locale = 'und-u-ks-level1', deterministic = false);

-- Retained databases gain the same generated columns as the declared baseline.
-- These name directories are rewritten once, bounded by the lock/statement
-- timeouts above; generated fields keep every subsequent name edit in sync.
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE championship ADD COLUMN IF NOT EXISTS search_name portable_string COLLATE golaberto_search GENERATED ALWAYS AS
  (region_name || ' - ' || name || ' ' || extract(year from begins)::int::text ||
   CASE WHEN extract(year from begins) = extract(year from ends) THEN ''
   ELSE '/' || extract(year from ends)::int::text END) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team ADD COLUMN IF NOT EXISTS search_name portable_string COLLATE golaberto_search GENERATED ALWAYS AS (name) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE stadium ADD COLUMN IF NOT EXISTS search_name portable_string COLLATE golaberto_search GENERATED ALWAYS AS (name) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE referee ADD COLUMN IF NOT EXISTS search_name portable_string COLLATE golaberto_search GENERATED ALWAYS AS (name) STORED;

-- The generated baseline already has these fields, with the portable type's
-- default collation. Skip already-correct columns: pgroll's version views can
-- depend on them when the baseline migration is replayed.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['championship', 'team', 'stadium', 'referee'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = target::regclass AND attname = 'search_name'
                 AND attcollation <> 'golaberto_search'::regcollation) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN search_name TYPE portable_string COLLATE golaberto_search', target);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
