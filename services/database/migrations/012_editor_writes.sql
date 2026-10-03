-- An editor corrects games: their scores, facts and goals (ir
-- decision-editing). The grant is the editor table's row, synced to its holder
-- alone so a screen can ask whether to offer the editor; it is given out of
-- band, so the owner's own write arms the private scope emits are taken back —
-- a reader who could insert their grant would be an editor by asking.
--
-- Idempotent via DROP ... IF EXISTS / CREATE OR REPLACE; initdb replays this.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

-- is_editor() reads the grant past editor's forced RLS, which only an owner
-- that bypasses RLS can: installed by any other role, every editor would be
-- refused.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '012_editor_writes: % neither is a superuser nor bypasses RLS', current_user;
  END IF;
END
$$;

DROP POLICY IF EXISTS editor_app_user_insert ON editor;
DROP POLICY IF EXISTS editor_app_user_update ON editor;
DROP POLICY IF EXISTS editor_app_user_delete ON editor;

-- Definer rights: the grant is read past its own RLS, and a guest's token is
-- never an editor's whatever rows its id holds.
CREATE OR REPLACE FUNCTION is_editor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('request.jwt.claims', true)::json ->> 'guest' = 'false', false)
    AND EXISTS (SELECT 1 FROM public.editor WHERE app_user_id = auth_uid())
$$;

-- A refusal has to be one the writer hears. A USING clause that filters a
-- reader's update or delete out answers "0 rows" with success, and the screen
-- waits on a write that never lands; WITH CHECK raises. So an update admits
-- every row and checks the writer, and a delete, which has no WITH CHECK, is
-- refused by its trigger.
-- An editor corrects what decision-editing names and nothing else: the
-- policy says who, the column grant says what.
REVOKE UPDATE ON game FROM app_user;
GRANT UPDATE (played, home_score, away_score, attendance, stadium_id, referee_id) ON game TO app_user;
DROP POLICY IF EXISTS game_editor_update ON game;
CREATE POLICY game_editor_update ON game FOR UPDATE TO app_user
  USING (true) WITH CHECK (is_editor());
DROP POLICY IF EXISTS goal_editor_insert ON goal;
CREATE POLICY goal_editor_insert ON goal FOR INSERT TO app_user
  WITH CHECK (is_editor());
DROP POLICY IF EXISTS goal_editor_delete ON goal;
CREATE POLICY goal_editor_delete ON goal FOR DELETE TO app_user
  USING (true);

CREATE OR REPLACE FUNCTION goal_delete_by_editor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'app_user' AND is_editor() IS NOT TRUE THEN
    RAISE EXCEPTION 'only an editor removes a goal' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS goal_delete_by_editor ON goal;
CREATE TRIGGER goal_delete_by_editor BEFORE DELETE ON goal
  FOR EACH ROW EXECUTE FUNCTION goal_delete_by_editor();

COMMIT;
