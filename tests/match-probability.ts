import { query } from "./db.ts";

Deno.test("match probability selects historical ratings and bounds timed events", async () => {
  const [
    championship,
    phase,
    home,
    away,
    ambiguous,
    missing,
    player,
    dayGame,
    kickoffGame,
    ambiguousGame,
    missingGame,
    limitedGame,
  ] = Array.from({ length: 12 }, () => crypto.randomUUID());
  const rating = (
    team: string,
    day: string,
    offense: number,
    defense: number,
  ) => `('${crypto.randomUUID()}','${team}','${day}',${offense},${defense},50)`;
  await query(`BEGIN;
    INSERT INTO championship(id,name,region_name,begins,ends)
      VALUES ('${championship}','Probability season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${championship}','Probability phase');
    INSERT INTO team(id,name,country) VALUES
      ('${home}','Probability home','Brasil'),('${away}','Probability away','Brasil'),
      ('${ambiguous}','Probability ambiguous','Brasil'),('${missing}','Probability missing','Brasil');
    INSERT INTO player(id,name,country) VALUES ('${player}','Probability player','Brasil');
    INSERT INTO team_rating(id,team_id,measure_date,offense,defense,rating) VALUES
      ${rating(home, "2026-01-01", 1.8, 0.9)},
      ${rating(home, "2026-01-03", 8, 8)},
      ${rating(home, "2026-01-04", 9, 9)},
      ${rating(away, "2026-01-02", 1.3, 1.1)},
      ${rating(ambiguous, "2026-01-02", 1.1, 1.2)},
      ${rating(ambiguous, "2026-01-02", 1.3, 1.4)};
    INSERT INTO game(id,phase_id,day,kickoff,home_id,away_id,home_field,played,home_score,away_score,slug) VALUES
      ('${dayGame}','${phase}','2026-01-03',NULL,'${home}','${away}','left',true,1,0,'probability-day'),
      ('${kickoffGame}','${phase}','2026-01-03','2026-01-03T12:00:00Z','${home}','${away}','neutral',true,0,0,'probability-kickoff'),
      ('${ambiguousGame}','${phase}','2026-01-03',NULL,'${ambiguous}','${away}','left',false,NULL,NULL,'probability-ambiguous'),
      ('${missingGame}','${phase}','2026-01-03',NULL,'${missing}','${away}','left',false,NULL,NULL,'probability-missing'),
      ('${limitedGame}','${phase}','2026-01-03',NULL,'${home}','${away}','left',true,9,9,'probability-limited');
    INSERT INTO goal(game_id,player_id,side,minute) VALUES
      ('${dayGame}','${player}','home',10),('${kickoffGame}','${player}','away',NULL);
    INSERT INTO player_game(game_id,player_id,side,on_minute,off_minute,red)
      VALUES ('${dayGame}','${player}','away',0,20,true);
    INSERT INTO goal(game_id,player_id,side,minute)
      SELECT '${limitedGame}','${player}',CASE WHEN n%2=0 THEN 'home' ELSE 'away' END,n%96
      FROM generate_series(1,101) n;

    DO $$ DECLARE payload jsonb; BEGIN
      SELECT payload_json::jsonb INTO payload FROM match_probability WHERE id='${dayGame}';
      IF payload#>>'{home_measure_date}'<>'2026-01-01'
        OR payload#>>'{away_measure_date}'<>'2026-01-02'
        OR abs((payload#>>'{home_power}')::double precision-1.7132705603476661)>1e-12
        OR abs((payload#>>'{away_power}')::double precision-0.7115873134210589)>1e-12
        OR payload#>>'{rating_status}'<>'available' OR payload#>>'{timeline_status}'<>'available'
        OR jsonb_array_length(payload->'goals')<>1 OR payload#>>'{goals,0,minute}'<>'10'
        OR jsonb_array_length(payload->'red_cards')<>1 OR payload#>>'{red_cards,0,minute}'<>'20'
      THEN RAISE EXCEPTION 'day cutoff, powers, or known event payload changed: %',payload; END IF;

      SELECT payload_json::jsonb INTO payload FROM match_probability WHERE id='${kickoffGame}';
      IF payload#>>'{home_measure_date}'<>'2026-01-03'
        OR payload#>>'{away_measure_date}'<>'2026-01-02'
        OR payload#>>'{rating_status}'<>'available'
        OR payload#>>'{timeline_status}'<>'unknown-event-minute'
        OR payload->'goals' IS DISTINCT FROM 'null'::jsonb
        OR payload->'red_cards' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'kickoff cutoff or unknown event state changed: %',payload; END IF;

      SELECT payload_json::jsonb INTO payload FROM match_probability WHERE id='${ambiguousGame}';
      IF payload#>>'{rating_status}'<>'ambiguous-rating' OR payload#>>'{timeline_status}'<>'ambiguous-rating'
        OR payload->'home_power'<>'null'::jsonb OR payload->'away_power'<>'null'::jsonb
      THEN RAISE EXCEPTION 'ambiguous latest ratings were used: %',payload; END IF;

      SELECT payload_json::jsonb INTO payload FROM match_probability WHERE id='${missingGame}';
      IF payload#>>'{rating_status}'<>'missing-rating' OR payload#>>'{timeline_status}'<>'missing-rating'
      THEN RAISE EXCEPTION 'missing ratings were fabricated: %',payload; END IF;

      SELECT payload_json::jsonb INTO payload FROM match_probability WHERE id='${limitedGame}';
      IF payload#>>'{rating_status}'<>'available' OR payload#>>'{timeline_status}'<>'event-limit'
        OR payload->'goals' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'event limit did not suppress the timeline: %',payload; END IF;

      IF (SELECT count(*) FROM match_probability WHERE id IN ('${dayGame}','${kickoffGame}','${ambiguousGame}','${missingGame}','${limitedGame}'))<>5
        OR NOT has_table_privilege('app_user','match_probability','SELECT')
        OR has_table_privilege('app_user','match_probability','INSERT')
        OR has_table_privilege('app_user','match_probability','UPDATE')
        OR has_table_privilege('app_user','match_probability','DELETE')
      THEN RAISE EXCEPTION 'probability request view is incomplete or writable'; END IF;
    END $$;
    SET LOCAL app.scopes='public:';
    SET LOCAL request.jwt.claims='{"sub":"00000000-0000-0000-0000-000000000001","guest":true}';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT count(*) FROM match_probability WHERE id='${dayGame}')<>1
      THEN RAISE EXCEPTION 'public reader cannot evaluate the security-invoker view'; END IF;
    END $$;
    RESET ROLE;
    ROLLBACK;`);
});

// The Rails oracle, against the formula the view computes: a JavaScript copy
// once held these cases while production read the SQL.
Deno.test("match powers match the independent Rails oracle, its floor and its ceiling", async () => {
  const advantage = { left: 0.16133676871779334, neutral: 0, right: -0.16133676871779334 };
  const oracle: [keyof typeof advantage, number, number][] = [
    ["left", 1.7132705603476661, 0.7115873134210589],
    ["neutral", 1.523382677768666, 0.8707733723982072],
    ["right", 1.3334947951896658, 1.0299594313753555],
  ];
  const cases = oracle.map(([field, home, away]) =>
    `(match_probability_power(1.8,1.1+(${advantage[field]})),${home}),` +
    `(match_probability_power(1.3,0.9-(${advantage[field]})),${away})`
  ).join(",");
  await query(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM (VALUES ${cases},
        (match_probability_power(-100,-100),0.01),(match_probability_power(100,100),10)) c(actual,expected)
      WHERE abs(actual-expected)>1e-12)
      THEN RAISE EXCEPTION 'match powers left the Rails oracle'; END IF;
  END $$;`);
});
