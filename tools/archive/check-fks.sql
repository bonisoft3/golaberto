
DO $check$
DECLARE f record; equalities text; nonnull text; anynull text; anynonnull text; violation boolean; predicate text;
BEGIN
 FOR f IN SELECT conname, conrelid, confrelid, conkey, confkey, confmatchtype FROM pg_constraint
   WHERE contype='f' AND connamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'pg_%' OR nspname='information_schema') LOOP
   SELECT string_agg(format('c.%I = p.%I',ca.attname,pa.attname),' AND ' ORDER BY k.ordinality),
          string_agg(format('c.%I IS NOT NULL',ca.attname),' AND ' ORDER BY k.ordinality),
          string_agg(format('c.%I IS NULL',ca.attname),' OR ' ORDER BY k.ordinality),
          string_agg(format('c.%I IS NOT NULL',ca.attname),' OR ' ORDER BY k.ordinality)
   INTO equalities,nonnull,anynull,anynonnull
   FROM unnest(f.conkey, f.confkey) WITH ORDINALITY k(child, parent, ordinality)
   JOIN pg_attribute ca ON ca.attrelid=f.conrelid AND ca.attnum=k.child
   JOIN pg_attribute pa ON pa.attrelid=f.confrelid AND pa.attnum=k.parent;
   predicate := format('(%s) AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',nonnull,f.confrelid::regclass,equalities);
   IF f.confmatchtype='f' THEN predicate := format('((%s) AND (%s)) OR (%s)',anynull,anynonnull,predicate); END IF;
   EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s c WHERE %s)',f.conrelid::regclass,predicate) INTO violation;
   IF violation THEN RAISE EXCEPTION 'archive violates foreign key % on %',f.conname,f.conrelid::regclass; END IF;
 END LOOP;
END
$check$;
