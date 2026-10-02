-- A comment is written by its author, and only by one who signed in: public
-- emits the reading arm alone, so the writing arms are added here. Every token
-- states `guest`, and only `false` is admitted: a token that does not say is
-- refused, not taken for an account — commenting is what a passkey
-- is for (ir decision-comments). No UPDATE arm: a comment is not edited, and
-- the missing policy keeps that true.
--
-- Idempotent via DROP POLICY IF EXISTS; initdb replays this on a fresh volume.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

DROP POLICY IF EXISTS comment_author_insert ON comment;
CREATE POLICY comment_author_insert ON comment FOR INSERT TO app_user
  WITH CHECK (
    app_user_id = auth_uid()
    AND current_setting('request.jwt.claims', true)::json ->> 'guest' = 'false'
  );
DROP POLICY IF EXISTS comment_author_delete ON comment;
CREATE POLICY comment_author_delete ON comment FOR DELETE TO app_user
  USING (app_user_id = auth_uid());

COMMIT;
