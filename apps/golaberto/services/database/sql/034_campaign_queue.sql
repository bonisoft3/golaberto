-- Source changes schedule bounded campaign work; worker restarts do not replay it.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE SEQUENCE IF NOT EXISTS team_campaign_revision_seq;
CREATE TABLE IF NOT EXISTS team_campaign_dirty (
  group_id uuid PRIMARY KEY,
  revision bigint NOT NULL,
  backfill boolean NOT NULL DEFAULT false,
  retry_after timestamptz NOT NULL DEFAULT '-infinity',
  last_error text
);
-- Retained installations may have the initial queue definition already applied.
-- squawk-ignore adding-field-with-default
ALTER TABLE team_campaign_dirty ADD COLUMN IF NOT EXISTS backfill boolean NOT NULL DEFAULT false;
-- squawk-ignore adding-field-with-default
ALTER TABLE team_campaign_dirty ADD COLUMN IF NOT EXISTS retry_after timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE team_campaign_dirty ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS team_campaign_dirty_revision_idx ON team_campaign_dirty(revision,group_id);
CREATE TABLE IF NOT EXISTS team_campaign_backfill (version text PRIMARY KEY);
REVOKE ALL ON team_campaign_dirty,team_campaign_backfill FROM PUBLIC,anon,app_user,electric;
GRANT SELECT,INSERT,UPDATE,DELETE ON team_campaign_dirty,team_campaign_backfill TO service;
REVOKE ALL ON SEQUENCE team_campaign_revision_seq FROM PUBLIC,anon,app_user,electric;
GRANT USAGE,SELECT ON SEQUENCE team_campaign_revision_seq TO service;

CREATE OR REPLACE FUNCTION enqueue_team_campaign(target_group uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public,pg_temp AS $$
  INSERT INTO team_campaign_dirty AS dirty(group_id,revision)
  VALUES (target_group,nextval('team_campaign_revision_seq'))
  ON CONFLICT(group_id) DO UPDATE SET revision=greatest(dirty.revision,EXCLUDED.revision),
    backfill=false,retry_after='-infinity',last_error=NULL;
$$;

CREATE OR REPLACE FUNCTION mark_team_campaign_game() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE affected uuid;
BEGIN
  IF TG_OP='UPDATE' AND
    (OLD.id,OLD.phase_id,OLD.home_id,OLD.away_id,OLD.played,OLD.home_score,OLD.away_score,
      OLD.home_aet,OLD.away_aet,OLD.home_pen,OLD.away_pen,OLD.day,OLD.kickoff,OLD.round)
    IS NOT DISTINCT FROM
    (NEW.id,NEW.phase_id,NEW.home_id,NEW.away_id,NEW.played,NEW.home_score,NEW.away_score,
      NEW.home_aet,NEW.away_aet,NEW.home_pen,NEW.away_pen,NEW.day,NEW.kickoff,NEW.round) THEN
    RETURN NULL;
  END IF;
  FOR affected IN
    SELECT sg.id FROM stage_group sg
    WHERE (TG_OP<>'INSERT' AND OLD.played AND OLD.home_score IS NOT NULL AND OLD.away_score IS NOT NULL
        AND sg.phase_id=OLD.phase_id AND EXISTS (SELECT 1 FROM team_group tg
          WHERE tg.group_id=sg.id AND tg.team_id IN (OLD.home_id,OLD.away_id)))
      OR (TG_OP<>'DELETE' AND NEW.played AND NEW.home_score IS NOT NULL AND NEW.away_score IS NOT NULL
        AND sg.phase_id=NEW.phase_id AND EXISTS (SELECT 1 FROM team_group tg
          WHERE tg.group_id=sg.id AND tg.team_id IN (NEW.home_id,NEW.away_id)))
    ORDER BY sg.id
  LOOP
    PERFORM enqueue_team_campaign(affected);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_team_campaign_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE affected uuid;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.group_id,OLD.team_id,OLD.add_sub,OLD.bias)
    IS NOT DISTINCT FROM (NEW.group_id,NEW.team_id,NEW.add_sub,NEW.bias) THEN RETURN NULL; END IF;
  FOR affected IN
    SELECT group_id FROM (SELECT OLD.group_id WHERE TG_OP<>'INSERT'
      UNION SELECT NEW.group_id WHERE TG_OP<>'DELETE') scopes ORDER BY group_id
  LOOP
    PERFORM enqueue_team_campaign(affected);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_team_campaign_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.phase_id IS NOT DISTINCT FROM NEW.phase_id THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN PERFORM enqueue_team_campaign(OLD.id);
  ELSE PERFORM enqueue_team_campaign(NEW.id); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_team_campaign_phase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE affected uuid;
BEGIN
  IF (OLD.championship_id,OLD.sort,OLD.bonus_points,OLD.bonus_points_threshold)
    IS NOT DISTINCT FROM (NEW.championship_id,NEW.sort,NEW.bonus_points,NEW.bonus_points_threshold) THEN
    RETURN NULL;
  END IF;
  FOR affected IN SELECT id FROM stage_group WHERE phase_id=NEW.id ORDER BY id LOOP
    PERFORM enqueue_team_campaign(affected);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_team_campaign_championship() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE affected uuid;
BEGIN
  IF (OLD.point_win,OLD.point_draw,OLD.point_loss)
    IS NOT DISTINCT FROM (NEW.point_win,NEW.point_draw,NEW.point_loss) THEN RETURN NULL; END IF;
  FOR affected IN SELECT sg.id FROM stage_group sg JOIN phase p ON p.id=sg.phase_id
    WHERE p.championship_id=NEW.id ORDER BY sg.id LOOP
    PERFORM enqueue_team_campaign(affected);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_team_campaign_team() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE affected uuid;
BEGIN
  IF OLD.name IS NOT DISTINCT FROM NEW.name THEN RETURN NULL; END IF;
  FOR affected IN SELECT group_id FROM team_group WHERE team_id=NEW.id ORDER BY group_id LOOP
    PERFORM enqueue_team_campaign(affected);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS team_campaign_dirty ON game;
CREATE TRIGGER team_campaign_dirty AFTER INSERT OR UPDATE OR DELETE ON game
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_game();
DROP TRIGGER IF EXISTS team_campaign_dirty ON team_group;
CREATE TRIGGER team_campaign_dirty AFTER INSERT OR UPDATE OR DELETE ON team_group
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_membership();
DROP TRIGGER IF EXISTS team_campaign_dirty ON stage_group;
CREATE TRIGGER team_campaign_dirty AFTER INSERT OR UPDATE OR DELETE ON stage_group
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_group();
DROP TRIGGER IF EXISTS team_campaign_dirty ON phase;
CREATE TRIGGER team_campaign_dirty AFTER UPDATE ON phase
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_phase();
DROP TRIGGER IF EXISTS team_campaign_dirty ON championship;
CREATE TRIGGER team_campaign_dirty AFTER UPDATE ON championship
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_championship();
DROP TRIGGER IF EXISTS team_campaign_dirty ON team;
CREATE TRIGGER team_campaign_dirty AFTER UPDATE ON team
  FOR EACH ROW EXECUTE FUNCTION mark_team_campaign_team();

CREATE OR REPLACE FUNCTION refresh_team_campaigns(batch_size integer DEFAULT 1) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp
SET statement_timeout='20s' SET lock_timeout='2s' AS $$
DECLARE item record; processed integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715034,1) THEN RETURN 0; END IF;
  -- Do not lock the queue while computing: a newer source revision must remain
  -- visible to compare-and-delete, even if it arrives during reconstruction.
  -- Live changes take priority over the one-time retained-group certification.
  FOR item IN SELECT group_id,revision FROM team_campaign_dirty
    WHERE retry_after<=clock_timestamp()
    ORDER BY backfill,revision,group_id LIMIT greatest(1,least(batch_size,20)) LOOP
    BEGIN
      PERFORM refresh_team_campaign_group(item.group_id);
      DELETE FROM team_campaign_dirty WHERE group_id=item.group_id AND revision=item.revision;
      processed:=processed+1;
    EXCEPTION WHEN OTHERS THEN
      -- This subtransaction rolls back partial projection writes. OTHERS does
      -- not catch query_canceled, so external cancellation still aborts the call.
      UPDATE team_campaign_dirty SET retry_after=clock_timestamp()+interval '30 seconds',last_error=SQLERRM
      WHERE group_id=item.group_id AND revision=item.revision;
    END;
  END LOOP;
  RETURN processed;
END $$;
REVOKE ALL ON FUNCTION enqueue_team_campaign(uuid),mark_team_campaign_game(),mark_team_campaign_membership(),
  mark_team_campaign_group(),mark_team_campaign_phase(),mark_team_campaign_championship(),mark_team_campaign_team(),
  refresh_team_campaigns(integer) FROM PUBLIC,anon,app_user;
GRANT EXECUTE ON FUNCTION refresh_team_campaigns(integer) TO service;

-- Existing projection rows have no reliable completion checkpoint. Certify
-- every retained group once; replaying this migration never reseeds the queue.
DO $$ BEGIN
  INSERT INTO team_campaign_backfill(version) VALUES ('034') ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO team_campaign_dirty(group_id,revision,backfill)
    SELECT id,nextval('team_campaign_revision_seq'),true FROM stage_group ORDER BY id
    ON CONFLICT(group_id) DO NOTHING;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
