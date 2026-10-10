import { query } from "./db.ts";

const ids = Array.from({ length: 33 }, () => crypto.randomUUID());

Deno.test("match context bounds prior form, category head-to-head, lineup contribution and distance", async () => {
  const [
    category,
    otherCategory,
    championship,
    otherChampionship,
    professionalChampionship,
    phase,
    otherPhase,
    professionalPhase,
    home,
    away,
    third,
    fourth,
    playerRated,
    playerUnrated,
    target,
    professionalTarget,
    ...games
  ] = ids;
  const game = (n: number) => games[n];

  await query(`BEGIN;
		INSERT INTO category(id,name) VALUES
			('${category}','Match context category'),
			('${otherCategory}','Other match context category');
		INSERT INTO championship(id,name,category_id,region_name,begins,ends) VALUES
			('${championship}','Match context season','${category}','Brasil','2026-01-01','2026-12-31'),
			('${otherChampionship}','Other match context season','${otherCategory}','Brasil','2026-01-01','2026-12-31'),
			('${professionalChampionship}','Professional match context season',NULL,'Brasil','2026-01-01','2026-12-31');
		INSERT INTO phase(id,championship_id,name) VALUES
			('${phase}','${championship}','Match context phase'),
			('${otherPhase}','${otherChampionship}','Other match context phase'),
			('${professionalPhase}','${professionalChampionship}','Professional match context phase');
		INSERT INTO team(id,name,country,latitude,longitude) VALUES
			('${home}','Match context São Paulo','Brasil',-23.5505,-46.6333),
			('${away}','Match context Rio','Brasil',-22.9068,-43.1729),
			('${third}','Match context third','Brasil',NULL,NULL),
			('${fourth}','Match context fourth','Brasil',NULL,NULL);
		INSERT INTO player(id,name,country,position) VALUES
			('${playerRated}','Match context rated','Brasil','cm'),
			('${playerUnrated}','Match context unrated','Brasil','fw');

		INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score) VALUES
			('${game(0)}','${phase}','2026-01-01','${home}','${away}',true,1,0),
			('${game(1)}','${phase}','2026-01-02','${away}','${home}',true,1,1),
			('${game(2)}','${phase}','2026-01-03','${home}','${away}',true,0,2),
			('${game(3)}','${phase}','2026-01-04','${away}','${home}',true,2,3),
			('${game(4)}','${phase}','2026-01-05','${home}','${away}',true,2,2),
			('${game(5)}','${phase}','2026-01-06','${away}','${home}',true,1,0),
			('${game(6)}','${otherPhase}','2026-01-07','${home}','${away}',true,4,0),
			('${game(7)}','${phase}','2026-01-08','${home}','${third}',true,1,1),
			('${game(8)}','${phase}','2026-01-09','${third}','${home}',true,1,2),
			('${game(9)}','${phase}','2026-01-10','${home}','${third}',true,0,1),
			('${game(10)}','${phase}','2026-01-08','${away}','${fourth}',true,2,0),
			('${game(11)}','${phase}','2026-01-09','${fourth}','${away}',true,3,3),
			('${game(12)}','${phase}','2026-01-10','${away}','${fourth}',true,0,1),
			('${
    game(13)
  }','${phase}','2026-01-19','${home}','${away}',false,NULL,NULL),
			('${game(14)}','${phase}','2026-01-20','${away}','${home}',true,9,9),
			('${target}','${phase}','2026-01-20','${home}','${away}',false,NULL,NULL),
			('${
    game(15)
  }','${professionalPhase}','2026-01-15','${third}','${fourth}',true,2,1),
			('${game(16)}','${phase}','2026-01-16','${third}','${fourth}',true,3,0),
			('${professionalTarget}','${professionalPhase}','2026-01-30','${third}','${fourth}',false,NULL,NULL);
		INSERT INTO player_game(game_id,player_id,side,on_minute,off_minute,off_rating,def_rating) VALUES
			('${target}','${playerRated}','home',0,90,1.25,-0.25),
			('${target}','${playerUnrated}','away',0,90,NULL,NULL);

		DO $$ BEGIN
			IF (SELECT count(*) FROM match_recent_result WHERE target_game_id='${target}' AND team_id='${home}')<>5
				OR (SELECT string_agg(day::text||':'||result,',' ORDER BY day,id) FROM match_recent_result
					WHERE target_game_id='${target}' AND team_id='${home}')
					IS DISTINCT FROM '2026-01-06:l,2026-01-07:w,2026-01-08:d,2026-01-09:w,2026-01-10:l'
			THEN RAISE EXCEPTION 'home form did not retain the five prior played matches across categories'; END IF;
			IF (SELECT count(*) FROM match_recent_result WHERE target_game_id='${target}' AND team_id='${away}')<>5
				OR (SELECT string_agg(day::text||':'||result,',' ORDER BY day,id) FROM match_recent_result
					WHERE target_game_id='${target}' AND team_id='${away}')
					IS DISTINCT FROM '2026-01-06:w,2026-01-07:l,2026-01-08:w,2026-01-09:d,2026-01-10:l'
			THEN RAISE EXCEPTION 'away form did not orient results to the selected team'; END IF;
			IF (SELECT string_agg(day::text,',' ORDER BY day) FROM match_head_to_head WHERE target_game_id='${target}')
				IS DISTINCT FROM '2026-01-02,2026-01-03,2026-01-04,2026-01-05,2026-01-06'
			THEN RAISE EXCEPTION 'head-to-head did not apply the five-match, strict-date, same-category cutoff'; END IF;
			IF (SELECT string_agg(day::text,',' ORDER BY day) FROM match_head_to_head WHERE target_game_id='${professionalTarget}')
				IS DISTINCT FROM '2026-01-15'
			THEN RAISE EXCEPTION 'professional head-to-head did not compare nullable categories safely'; END IF;
			IF (SELECT contribution FROM match_lineup WHERE game_id='${target}' AND player_id='${playerRated}') IS DISTINCT FROM 1::double precision
				OR (SELECT contribution FROM match_lineup WHERE game_id='${target}' AND player_id='${playerUnrated}') IS DISTINCT FROM 0::double precision
			THEN RAISE EXCEPTION 'lineup contribution did not sum ratings with Rails-compatible null coercion'; END IF;
			IF NOT ((SELECT distance_km FROM match_location WHERE id='${target}') BETWEEN 350 AND 370)
				OR (SELECT distance_km FROM match_location WHERE id='${professionalTarget}') IS NOT NULL
			THEN RAISE EXCEPTION 'match distance did not use both valid coordinate pairs only'; END IF;
			IF (SELECT map_embed_url FROM match_location WHERE id='${target}') !~
					'^https://www[.]openstreetmap[.]org/export/embed[.]html[?]bbox=-?[0-9]+([.][0-9]+)?%2C-?[0-9]+([.][0-9]+)?%2C-?[0-9]+([.][0-9]+)?%2C-?[0-9]+([.][0-9]+)?&layer=mapnik$'
				OR (SELECT map_embed_url FROM match_location WHERE id='${target}') LIKE '% %'
				OR (SELECT map_embed_url FROM match_location WHERE id='${professionalTarget}') IS NOT NULL
			THEN RAISE EXCEPTION 'embedded map URL was not a fixed-origin bounded OSM export URL'; END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='game_home_played_context_idx')
				OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='game_away_played_context_idx')
				OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='game_pair_played_context_idx')
			THEN RAISE EXCEPTION 'bounded context indexes are missing'; END IF;
			IF NOT has_table_privilege('app_user','match_recent_result','SELECT')
				OR has_table_privilege('app_user','match_recent_result','INSERT')
				OR NOT has_table_privilege('app_user','match_head_to_head','SELECT')
				OR has_table_privilege('app_user','match_lineup','UPDATE')
			THEN RAISE EXCEPTION 'match context views expose more than read access'; END IF;
			IF (SELECT count(*) FROM pg_class WHERE relname IN
					('match_recent_result','match_head_to_head','match_lineup','match_location')
					AND relkind='v' AND reloptions @> ARRAY['security_invoker=true'])<>4
				OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname='public' AND tablename IN
					('match_recent_result','match_head_to_head','match_lineup','match_location'))
			THEN RAISE EXCEPTION 'match context must remain invoker-security request-time views outside CDC'; END IF;
		END $$;

		SET LOCAL app.scopes='public:';
		SET LOCAL ROLE app_user;
		DO $$ BEGIN
			IF (SELECT count(*) FROM match_recent_result WHERE target_game_id='${target}')<>10
				OR (SELECT count(*) FROM match_head_to_head WHERE target_game_id='${target}')<>5
				OR (SELECT count(*) FROM match_lineup WHERE game_id='${target}')<>2
				OR (SELECT count(*) FROM match_location WHERE id='${target}')<>1
			THEN RAISE EXCEPTION 'public readers cannot read the bounded match context'; END IF;
		END $$;
		ROLLBACK;`);
});
