-- Expand search equivalence without changing existing columns or version views.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- PostgreSQL 18 LIKE supports ICU primary-strength nondeterministic collations.
-- New keys preserve the original search columns and their dependent version
-- views. Names, uniqueness and display ordering retain their original semantics.
-- Keep the existing primary-strength collation. PostgreSQL custom ICU rules
-- force tertiary strength; generated keys instead fold the two extra letters.

-- Retained databases gain the same generated columns as the declared baseline.
-- These name directories are rewritten once, bounded by the lock/statement
-- timeouts above; generated fields keep every subsequent name edit in sync.
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE championship ADD COLUMN IF NOT EXISTS search_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS
  (replace(replace(replace(region_name || ' - ' || name || ' ' || extract(year from begins)::int::text ||
   CASE WHEN extract(year from begins) = extract(year from ends) THEN ''
   ELSE '/' || extract(year from ends)::int::text END, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team ADD COLUMN IF NOT EXISTS search_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE stadium ADD COLUMN IF NOT EXISTS search_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE referee ADD COLUMN IF NOT EXISTS search_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;

-- The rating-ordered teams projection applies the same mappings to both filters.
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS search_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS country_key portable_string COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(coalesce(country, ''), 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;

-- The generated baseline already has these fields, with the portable type's
-- default collation. Skip already-correct columns: pgroll's version views can
-- depend on them when the baseline migration is replayed.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['championship', 'team', 'stadium', 'referee', 'team_directory'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = target::regclass AND attname = 'search_key'
                 AND attcollation <> 'golaberto_search'::regcollation) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN search_key TYPE portable_string COLLATE golaberto_search', target);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='team_directory'::regclass AND attname='country_key' AND attcollation <> 'golaberto_search'::regcollation) THEN
    ALTER TABLE team_directory ALTER COLUMN country_key TYPE portable_string COLLATE golaberto_search;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
