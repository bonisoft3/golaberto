#!/usr/bin/env python3
"""Build a guarded, transactional full archive import for an explicit destination.

The private legacy schema retains original domain records, including detached
goals and comments whose subjects have no public comment entity. Source users
are exported only as public bylines; credentials and sessions never leave MySQL.
PyYAML 6.0.3 is required for safe, lossless legacy zone and odds parsing.
Preserving imported originals requires a worker profile that disables the
ratings replacement job and the chances job's computed snapshot capture hook.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shlex
import subprocess

TABLES = ('categories', 'championships', 'phases', 'groups', 'stadia', 'teams',
          'team_groups', 'referees', 'players', 'team_players', 'games', 'goals',
          'player_games', 'historical_ratings', 'team_group_odds_histories',
          'team_geocodes', 'comments')
USER_COLUMNS = ('id', 'login', 'name', 'created_at')
RATING_NAMESPACE = '0b7e1c2a-4d5f-4e6a-9b8c-7d6e5f4a3b2c'
PUBLIC_HANDLE_SQL = "CASE WHEN byline_rank=1 THEN byline ELSE byline||' (legacy '||id||')' END"
USER_SOURCE = "(SELECT *,row_number() OVER(PARTITION BY byline ORDER BY id) AS byline_rank FROM (SELECT *,coalesce(nullif(name,''),CASE WHEN position('@' IN login)=0 THEN nullif(login,'') END,'Legacy user '||id) AS byline FROM pg_temp.users) labels) bylines"
UID_SQL = "CREATE FUNCTION pg_temp.uid(kind integer,n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT ('a'||lpad(to_hex(kind),2,'0')||'00000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid $$;"
KINDS = {'category': 1, 'championship': 2, 'phase': 3, 'stage_group': 4,
         'zone': 5, 'stadium': 6, 'team': 7, 'team_group': 8, 'game': 9,
         'referee': 10, 'player': 11, 'team_player': 12, 'player_game': 13,
         'goal': 14, 'app_user': 18, 'comment': 19}


def ident(value: str) -> str:
    if not re.fullmatch(r'[a-z_][a-z_0-9]*', value):
        raise ValueError(f'unsafe identifier: {value!r}')
    return '"' + value + '"'


def literal(value: object) -> str:
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError('non-finite correction')
        return str(value)
    if not isinstance(value, str) or '\x00' in value:
        raise ValueError('correction values must be scalar JSON values without NUL')
    return "'" + value.replace("'", "''") + "'"


def legacy_uuid(kind: int, number: int) -> str:
    if not 0 < kind < 256 or not 0 < number < 2**48:
        raise ValueError('legacy UUID kind or id outside namespace')
    return f'a{kind:02x}00000-0000-4000-8000-{number:012x}'


def sql_do(body: str) -> str:
    return 'DO ' + literal('BEGIN ' + body + ' END;') + ';'


def paired_score(first: str, second: str) -> str:
    return f'CASE WHEN {first} IS NOT NULL OR {second} IS NOT NULL THEN coalesce({first},0) END'


def game_day(date: str = 'date', has_time: str = 'has_time') -> str:
    return f"CASE WHEN {has_time}=1 THEN ({date}::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date ELSE {date}::timestamp::date END"


def yaml_value(value: str | None) -> object:
    import yaml
    if yaml.__version__ != '6.0.3':
        raise RuntimeError('install the pinned parser: PyYAML==6.0.3')
    return yaml.load(value, Loader=yaml.CSafeLoader) if value else None


def zones(value: str | None) -> list[tuple[str, str, int, int]]:
    parsed = yaml_value(value)
    if parsed is None:
        return []
    if not isinstance(parsed, list):
        raise ValueError('zones must be a YAML sequence')
    result = []
    for zone in parsed:
        if not isinstance(zone, dict) or set(zone) != {'name', 'color', 'position'}:
            raise ValueError(f'unsupported zone shape: {zone!r}')
        name, color, positions = zone['name'], zone['color'], zone['position']
        if not isinstance(name, str) or not name.strip() or not isinstance(color, str):
            raise ValueError(f'invalid zone label or color: {zone!r}')
        color = {'lightgreen': '#90ee90'}.get(color, color)
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            raise ValueError(f'unsupported CSS zone color: {color!r}')
        if (not isinstance(positions, list) or not positions
                or any(type(p) is not int or p < 1 for p in positions)
                or len(set(positions)) != len(positions)):
            raise ValueError(f'invalid zone positions: {positions!r}')
        # A legacy zone can have disjoint positions; preserve its set as runs.
        ordered = sorted(positions)
        first = last = ordered[0]
        for position in ordered[1:]:
            if position != last + 1:
                result.append((name, color, first, last))
                first = position
            last = position
        result.append((name, color, first, last))
    return result


def odds(value: str) -> list[float | None]:
    parsed = yaml_value(value)
    if not isinstance(parsed, list):
        raise ValueError('odds must be a YAML sequence')
    for number in parsed:
        if number is not None and (type(number) not in (int, float)
                or not math.isfinite(number) or not 0 <= number <= 100):
            raise ValueError(f'invalid odds percentage: {number!r}')
    return parsed


def validate_corrections(raw: object, columns: dict[str, list[tuple[str, str]]]) -> dict:
    if not isinstance(raw, dict):
        raise ValueError('corrections must be keyed by source table and source id')
    for table, records in raw.items():
        if table not in columns or not isinstance(records, dict):
            raise ValueError(f'unknown correction source table: {table!r}')
        allowed = {name for name, _ in columns[table]} - {'id'}
        for number, correction in records.items():
            if not isinstance(number,str) or not re.fullmatch(r'[1-9][0-9]*', number) or int(number)>=2**48:
                raise ValueError(f'invalid correction source id: {number!r}')
            if not isinstance(correction, dict) or set(correction) != {'before', 'after', 'reason'}:
                raise ValueError(f'{table}/{number}: correction needs before, after, reason')
            before, after = correction['before'], correction['after']
            if (not isinstance(correction['reason'], str) or not correction['reason'].strip()
                    or before is None and (not isinstance(after,dict) or not after or not set(after)<=allowed)
                    or before is not None and (not isinstance(before,dict) or not before or not set(before)<=allowed)
                    or before is not None and after is not None and (not isinstance(after,dict) or not after or not set(after)<=set(before))):
                raise ValueError(f'{table}/{number}: correction lacks exact field guards or reason')
            for value in (*(before or {}).values(), *(after or {}).values()):
                literal(value)
    return raw


def corrected_views(columns: dict, corrections: dict) -> str:
    statements = []
    for table, fields in columns.items():
        records = corrections.get(table, {})
        for number, correction in records.items():
            if correction['before'] is None:
                statements.append(sql_do(f"IF EXISTS(SELECT 1 FROM legacy.{ident(table)} WHERE id={number}) THEN RAISE EXCEPTION 'addition already exists: {table}/{number}'; END IF;"))
                continue
            matches = ' AND '.join(f'{ident(field)} IS NOT DISTINCT FROM {literal(value)}'
                                   for field, value in correction['before'].items())
            statements.append(sql_do(f"IF (SELECT count(*) FROM legacy.{ident(table)} WHERE id={number} AND {matches})<>1 THEN RAISE EXCEPTION 'correction mismatch: {table}/{number}'; END IF;"))
        projection = []
        for field, sql_type in fields:
            changes = [(number, correction['after'][field]) for number, correction in records.items()
                       if correction['before'] is not None and correction['after'] is not None and field in correction['after']]
            expression = ident(field)
            if changes:
                expression = ('CASE ' + ' '.join(f'WHEN id={number} THEN {literal(value)}::{sql_type}'
                                               for number, value in changes)
                              + f' ELSE {expression} END AS {ident(field)}')
            projection.append(expression)
        removed = [number for number, correction in records.items() if correction['after'] is None]
        selection = f'SELECT {",".join(projection)} FROM legacy.{ident(table)}'
        if removed:
            selection += ' WHERE id NOT IN(' + ','.join(removed) + ')'
        for number, correction in records.items():
            if correction['before'] is None:
                values = ','.join(f'{number}::bigint' if field=='id' else f"{literal(correction['after'].get(field))}::{sql_type}" for field,sql_type in fields)
                selection += ' UNION ALL SELECT ' + values
        statements.append(f'CREATE TEMP VIEW {ident(table)} AS {selection};')
    return '\n'.join(statements)


class Database:
    def __init__(self, source_container: str, source_database: str, target_container: str, target_database: str):
        self.source = ['docker', 'exec', source_container, 'mysql', '-uroot', '-D', source_database,
                       '--quick', '--default-character-set=utf8mb4', '--batch', '--raw', '--skip-column-names']
        self.target = ['docker', 'exec', '-i', target_container, 'psql', '-X', '-q', '-A', '-t',
                       '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target_database]

    def pg(self, sql: str) -> str:
        result = subprocess.run(self.target,input=sql,text=True,capture_output=True)
        if result.returncode:
            raise RuntimeError(f'PostgreSQL command failed: {result.stderr.strip()}')
        return result.stdout.strip()

    def mysql(self, sql: str):
        query = 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY; ' + sql + '; COMMIT;'
        with subprocess.Popen(self.source + ['-e', query], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True) as process:
            assert process.stdout is not None
            for line in process.stdout:
                yield json.loads(line)
            error = process.stderr.read()
            if process.wait():
                raise RuntimeError(f'MySQL read-only export failed: {error}')

    def stage(self, table: str, fields: list[tuple[str, str]], expected: int):
        definitions = ','.join(f'{ident(name)} {kind}' for name, kind in fields)
        self.pg(f'CREATE TABLE legacy.{ident(table)}({definitions});')
        structured = {row[0] for row in self.mysql("SELECT JSON_ARRAY(column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name="+literal(table)+" AND data_type='json'")}
        # JSON_ARRAY otherwise merges a JSON null scalar with a SQL NULL.
        projection = ','.join('CAST(`'+name+'` AS CHAR)' if name in structured else '`'+name+'`' for name, _ in fields)
        count = 0
        with subprocess.Popen(self.target + ['-c', f"COPY legacy.{ident(table)} FROM STDIN WITH(FORMAT csv,NULL '\\N');"],
                              stdin=subprocess.PIPE, text=True) as destination:
            assert destination.stdin is not None
            for row in self.mysql(f'SELECT JSON_ARRAY({projection}) FROM `{table}` ORDER BY id'):
                destination.stdin.write(csv_row(row))
                count += 1
            destination.stdin.close()
            if destination.wait():
                raise RuntimeError(f'PostgreSQL staging COPY failed: {table}')
        if count != expected:
            raise ValueError(f'{table}: staged {count}, expected {expected}')
        self.pg(f'CREATE UNIQUE INDEX ON legacy.{ident(table)}(id); ANALYZE legacy.{ident(table)};')


MAPS = (
 ('category','categories','name','name'),
 ('championship','championships','name,category_id,region,region_name,begins,ends,point_win,point_draw,point_loss,show_country',
  'name,pg_temp.uid(1,CASE WHEN category_id IN (0,1) THEN NULL ELSE category_id END),(ARRAY[\'world\',\'continental\',\'national\'])[region+1],region_name,begin::date,"end"::date,point_win,point_draw,point_loss,show_country=1'),
 ('phase','phases','championship_id,name,position,sort,bonus_points,bonus_points_threshold',
  "pg_temp.uid(2,championship_id),name,order_by,regexp_replace(sort,'\\s','','g'),bonus_points,bonus_points_threshold"),
 ('stage_group','groups','phase_id,name,position','pg_temp.uid(3,phase_id),name,(row_number() OVER(PARTITION BY phase_id ORDER BY id)-1)::integer'),
 ('stadium','stadia','name,full_name,city,country','name,full_name,city,country'),
 ('team','teams','name,full_name,city,country,foundation,stadium_id,team_type',
  "name,full_name,city,country,nullif(foundation,'0000-00-00')::date,pg_temp.uid(6,nullif(stadium_id,0)),(ARRAY['club','national'])[team_type+1]"),
 ('team_group','team_groups','group_id,team_id,add_sub,bias,comment','pg_temp.uid(4,group_id),pg_temp.uid(7,team_id),add_sub,bias,comment'),
 ('referee','referees','name,location','name,location'),
 ('player','players','name,full_name,birth,country,height,position',"name,full_name,nullif(birth,'0000-00-00')::date,country,nullif(height,0),nullif(position,'')"),
 ('team_player','team_players','championship_id,team_id,player_id','pg_temp.uid(2,championship_id),pg_temp.uid(7,team_id),pg_temp.uid(11,player_id)'),
 ('game','games','phase_id,round,day,kickoff,home_id,away_id,home_field,played,home_score,away_score,home_aet,away_aet,home_pen,away_pen,stadium_id,referee_id,attendance',
  "pg_temp.uid(3,phase_id),nullif(round,0)," + game_day() + ",CASE WHEN has_time=1 THEN date::timestamp AT TIME ZONE 'UTC' END,pg_temp.uid(7,home_id),pg_temp.uid(7,away_id),(ARRAY['left','neutral','right'])[home_field+1],played=1,CASE WHEN played=1 THEN home_score END,CASE WHEN played=1 THEN away_score END," + ','.join((paired_score('home_aet','away_aet'),paired_score('away_aet','home_aet'),paired_score('home_pen','away_pen'),paired_score('away_pen','home_pen'))) + ",pg_temp.uid(6,nullif(stadium_id,0)),pg_temp.uid(10,nullif(referee_id,0)),nullif(attendance,-1)"),
 ('goal','goals','game_id,player_id,side,minute,penalty,own_goal,aet',
  "pg_temp.uid(9,a.game_id),pg_temp.uid(11,a.player_id),CASE WHEN (a.team_id=g.home_id)<>(a.own_goal=1) THEN 'home' ELSE 'away' END,a.time,a.penalty=1,a.own_goal=1,a.aet=1"),
 ('player_game','player_games','game_id,player_id,side,on_minute,off_minute,yellow,red,bench,day,off_rating,def_rating',
  "pg_temp.uid(9,a.game_id),pg_temp.uid(11,a.player_id),CASE WHEN a.team_id=g.home_id THEN 'home' ELSE 'away' END,a.\"on\",CASE WHEN a.\"on\"=0 AND a.\"off\"=0 THEN NULL ELSE a.\"off\" END,a.yellow=1,a.red=1,a.\"on\"=0 AND a.\"off\"=0," + game_day('g.date', 'g.has_time') + ",a.off_rating,a.def_rating"),
 ('team_rating','historical_ratings','team_id,measure_date,offense,defense,rating','pg_temp.uid(7,team_id),measure_date::date,off_rating,def_rating,rating'),
 ('app_user','users','handle,created_at',PUBLIC_HANDLE_SQL+",created_at::timestamp AT TIME ZONE 'UTC'"),
)
PUBLIC_TABLES = tuple(row[0] for row in MAPS) + ('zone', 'comment', 'team_comment', 'team_odds_history')
DEFERRED_TRIGGERS = {
 'team_player': ('team_profile_dirty_team_player',),
 'game': ('team_profile_dirty_game',),
 'team_group': ('team_profile_dirty_team_group', 'team_odds_members_dirty'),
 'stage_group': ('team_profile_dirty_stage_group',),
 'phase': ('team_profile_dirty_phase',),
 'team': ('team_profile_dirty_team',),
 'zone': ('team_odds_zone_dirty',),
 'player_game': ('player_metric_dirty_insert_delete',),
 'team_rating': ('team_rating_chart_dirty_insert',),
 'team_odds_history': ('team_odds_history_dirty_insert',),
}


def target_guard(database: str, system_id: str) -> str:
    tests = ' OR '.join(f'EXISTS(SELECT 1 FROM public.{ident(table)})' for table in PUBLIC_TABLES)
    return sql_do(f"""
IF current_database()<>{literal(database)} OR (SELECT system_identifier::text FROM pg_control_system())<>{literal(system_id)} THEN RAISE EXCEPTION 'archive destination mismatch'; END IF;
IF {tests} THEN RAISE EXCEPTION 'archive destination must be empty; existing data is never reset'; END IF;
""")


def corrected_count(source: str, count: int, corrections: dict) -> int:
    return count + sum(c['before'] is None for c in corrections.get(source,{}).values()) - sum(c['after'] is None for c in corrections.get(source,{}).values())


def copy_csv(table: str, path: Path, nulls: bool = False) -> str:
    options = "FORMAT csv,HEADER true" + (",NULL '\\N'" if nulls else '')
    return f'\\copy {table} FROM STDIN WITH({options})\n' + path.read_text(encoding='utf-8') + '\\.\n'


def enrichment_preflight_sql(columns: dict, corrections: dict, files: dict[str,Path]) -> str:
    sql = ['BEGIN;',"SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'; SET LOCAL statement_timeout='30min';",UID_SQL,corrected_views(columns,corrections)]
    for table in ('zone','team_odds_history','app_user','comment','team_comment','team'):
        sql.append(f'CREATE TEMP TABLE _pf_{table}(LIKE public.{ident(table)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;')
    sql.append(copy_csv('_pf_zone(id,group_id,name,color,first,last)',files['zones']))
    sql.extend(["CREATE TEMP TABLE _pf_odds(group_id uuid,team_id uuid,recorded_on date,captured_at timestamptz,position integer,percent double precision) ON COMMIT DROP;",
                copy_csv('_pf_odds',files['odds'],True),
                "INSERT INTO _pf_team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source) SELECT group_id::text||':'||team_id::text||':'||recorded_on::text||':'||position::text,group_id,team_id,recorded_on,captured_at,position,percent,'imported' FROM _pf_odds;",
                f"INSERT INTO _pf_app_user(id,handle,created_at) SELECT pg_temp.uid(18,id),{PUBLIC_HANDLE_SQL},created_at::timestamp AT TIME ZONE 'UTC' FROM {USER_SOURCE};",
                "INSERT INTO _pf_comment(id,game_id,app_user_id,body,created_at) SELECT pg_temp.uid(19,id),pg_temp.uid(9,commentable_id),pg_temp.uid(18,user_id),comment,created_at::timestamp AT TIME ZONE 'UTC' FROM pg_temp.comments WHERE commentable_type='Game';",
                "INSERT INTO _pf_team_comment(id,team_id,app_user_id,body,created_at) SELECT pg_temp.uid(19,id),pg_temp.uid(7,commentable_id),pg_temp.uid(18,user_id),comment,created_at::timestamp AT TIME ZONE 'UTC' FROM pg_temp.comments WHERE commentable_type='Team';"])
    _,_,fields,values = next(mapping for mapping in MAPS if mapping[0]=='team')
    sql.append(f"INSERT INTO _pf_team(id,{fields},slug) SELECT pg_temp.uid(7,id),{values},'preflight-'||id FROM pg_temp.teams;")
    sql.extend(["CREATE TEMP TABLE _pf_geocodes(team_id uuid PRIMARY KEY,latitude double precision,longitude double precision) ON COMMIT DROP;",
                copy_csv('_pf_geocodes',files['geocodes']),
                'UPDATE _pf_team t SET latitude=g.latitude,longitude=g.longitude FROM _pf_geocodes g WHERE t.id=g.team_id;',
                "DO $$ BEGIN IF (SELECT count(*) FROM _pf_geocodes g LEFT JOIN _pf_team t ON t.id=g.team_id WHERE t.id IS NULL)<>0 OR (SELECT count(*) FROM _pf_zone z LEFT JOIN pg_temp.groups g ON pg_temp.uid(4,g.id)=z.group_id WHERE g.id IS NULL)<>0 OR (SELECT count(*) FROM _pf_team_odds_history h LEFT JOIN pg_temp.groups g ON pg_temp.uid(4,g.id)=h.group_id LEFT JOIN _pf_team t ON t.id=h.team_id WHERE g.id IS NULL OR t.id IS NULL)<>0 OR (SELECT count(*) FROM _pf_comment c LEFT JOIN pg_temp.games g ON pg_temp.uid(9,g.id)=c.game_id LEFT JOIN _pf_app_user u ON u.id=c.app_user_id WHERE g.id IS NULL OR u.id IS NULL)<>0 OR (SELECT count(*) FROM _pf_team_comment c LEFT JOIN _pf_team t ON t.id=c.team_id LEFT JOIN _pf_app_user u ON u.id=c.app_user_id WHERE t.id IS NULL OR u.id IS NULL)<>0 THEN RAISE EXCEPTION 'enrichment source foreign key mismatch'; END IF; END $$;",
                "SELECT json_build_object('zones',(SELECT count(*) FROM _pf_zone),'odds',(SELECT count(*) FROM _pf_team_odds_history),'users',(SELECT count(*) FROM _pf_app_user),'game_comments',(SELECT count(*) FROM _pf_comment),'team_comments',(SELECT count(*) FROM _pf_team_comment),'geocodes',(SELECT count(*) FROM _pf_geocodes));",
                'ROLLBACK;'])
    return '\n'.join(sql)


def promotion_sql(columns: dict, corrections: dict, counts: dict, database: str, system_id: str,
                  files: dict[str, Path], defer: bool) -> str:
    sql = ["\\set ON_ERROR_STOP on", 'BEGIN;', "SET LOCAL TIME ZONE 'UTC';",
           "SET LOCAL DateStyle='ISO,YMD';",
           "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='0';",
           'SELECT pg_advisory_xact_lock(715029,4);',
           'LOCK TABLE ' + ','.join('public.' + ident(t) for t in PUBLIC_TABLES) + ' IN ACCESS EXCLUSIVE MODE;',
           target_guard(database, system_id),
           'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public VERSION \'1.1\';',
           "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='uuid-ossp' AND e.extversion='1.1' AND n.nspname='public') THEN RAISE EXCEPTION 'uuid-ossp 1.1 in public is required'; END IF; END $$;",
           UID_SQL,
           corrected_views(columns, corrections)]
    for table, count in counts.items():
        if table in ('current_goals','unique_team_players'):
            continue
        sql.append(f"DO $$ BEGIN IF (SELECT count(*) FROM legacy.{ident(table)})<>{count} THEN RAISE EXCEPTION 'staging count changed: {table}'; END IF; END $$;")
    sql.append("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM categories WHERE id=1 AND name='Profissional') THEN RAISE EXCEPTION 'professional category contract mismatch'; END IF; END $$;")
    sql.append("DO $$ BEGIN IF EXISTS(SELECT team_id,measure_date FROM pg_temp.historical_ratings GROUP BY team_id,measure_date HAVING count(*)>1) THEN RAISE EXCEPTION 'historical rating team/day must be unique'; END IF; END $$;")
    sql.append("DO $$ BEGIN IF EXISTS(SELECT game_id,player_id FROM pg_temp.player_games GROUP BY game_id,player_id HAVING count(*)>1) OR EXISTS(SELECT group_id,team_id FROM pg_temp.team_groups GROUP BY group_id,team_id HAVING count(*)>1) OR EXISTS(SELECT name FROM pg_temp.categories GROUP BY name HAVING count(*)>1) THEN RAISE EXCEPTION 'source projection violates a public unique key'; END IF; END $$;")
    sql.append(sql_do(f"IF EXISTS(SELECT handle FROM(SELECT {PUBLIC_HANDLE_SQL} AS handle FROM {USER_SOURCE}) handles GROUP BY handle HAVING count(*)>1) THEN RAISE EXCEPTION 'public byline identities collide'; END IF;"))
    sql.append("DO $$ BEGIN IF (SELECT count(*) FROM pg_temp.player_games a JOIN pg_temp.games g ON g.id=a.game_id WHERE a.team_id NOT IN(g.home_id,g.away_id))<>0 OR (SELECT count(*) FROM pg_temp.goals a JOIN pg_temp.games g ON g.id=a.game_id WHERE a.team_id NOT IN(g.home_id,g.away_id))<>0 THEN RAISE EXCEPTION 'source event team is not a match participant'; END IF; END $$;")
    if defer:
        pairs = ','.join(f'({literal(table)},{literal(name)})' for table, names in DEFERRED_TRIGGERS.items() for name in names)
        sql.extend([f"CREATE TEMP TABLE _deferred ON COMMIT DROP AS SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN (VALUES {pairs}) allowed(tab,trig) ON c.relname=tab AND t.tgname=trig WHERE n.nspname='public' AND NOT t.tgisinternal;",
                    "DO $$ DECLARE t record; BEGIN FOR t IN SELECT * FROM _deferred LOOP EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t.relname,t.tgname); END LOOP; END $$;"])
    for target, source, fields, values in MAPS:
        joined = target in ('goal', 'player_game')
        from_sql = f'pg_temp.{ident(source)} a JOIN pg_temp.games g ON g.id=a.game_id' if joined else f'pg_temp.{ident(source)}'
        if target == 'app_user':
            from_sql = USER_SOURCE
        if target == 'team_player':
            if fields != 'championship_id,team_id,player_id':
                raise ValueError('membership collapse requires equality of every mapped field')
            from_sql = '(SELECT DISTINCT ON(championship_id,team_id,player_id) * FROM pg_temp.team_players ORDER BY championship_id,team_id,player_id,id) memberships'
        source_id = 'a.id' if joined else 'id'
        row_id = f"public.uuid_generate_v5({literal(RATING_NAMESPACE)}::uuid,pg_temp.uid(7,team_id)::text||':'||measure_date::date::text)" if target=='team_rating' else f'pg_temp.uid({KINDS[target]},{source_id})'
        sql.append(f'INSERT INTO public.{ident(target)}(id,{fields}) SELECT {row_id},{values} FROM {from_sql} ORDER BY {source_id};')
        expected = corrected_count(source,counts[source],corrections) if target != 'goal' else counts['current_goals']
        if target == 'team_player':
            expected = counts['unique_team_players']
        sql.append(f"DO $$ BEGIN IF (SELECT count(*) FROM public.{ident(target)})<>{expected} THEN RAISE EXCEPTION 'promotion count mismatch: {target}'; END IF; END $$;")
    sql.extend(["CREATE TEMP TABLE _zones(id uuid,group_id uuid,name text,color text,first integer,last integer) ON COMMIT DROP;",
                copy_csv('_zones',files['zones']),
                'INSERT INTO public.zone(id,group_id,name,color,first,last) SELECT * FROM _zones;',
                "CREATE TEMP TABLE _odds(group_id uuid,team_id uuid,recorded_on date,captured_at timestamptz,position integer,percent double precision) ON COMMIT DROP;",
                copy_csv('_odds',files['odds'],True),
                "INSERT INTO public.team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source) SELECT group_id::text||':'||team_id::text||':'||recorded_on::text||':'||position::text,group_id,team_id,recorded_on,captured_at,position,percent,'imported' FROM _odds;",
                "CREATE TEMP TABLE _geocodes(team_id uuid,latitude double precision,longitude double precision) ON COMMIT DROP;",
                copy_csv('_geocodes',files['geocodes']),
                'UPDATE public.team t SET latitude=g.latitude,longitude=g.longitude FROM _geocodes g WHERE t.id=g.team_id;',
                "DO $$ BEGIN IF EXISTS(SELECT 1 FROM _geocodes g LEFT JOIN public.team t ON t.id=g.team_id WHERE t.id IS NULL) OR EXISTS(SELECT team_id FROM _geocodes GROUP BY team_id HAVING count(*)>1) THEN RAISE EXCEPTION 'geocode membership is missing or duplicated'; END IF; END $$;",
                "INSERT INTO public.comment(id,game_id,app_user_id,body,created_at) SELECT pg_temp.uid(19,id),pg_temp.uid(9,commentable_id),pg_temp.uid(18,user_id),comment,created_at::timestamp AT TIME ZONE 'UTC' FROM pg_temp.comments WHERE commentable_type='Game';",
                "INSERT INTO public.team_comment(id,team_id,app_user_id,body,created_at) SELECT pg_temp.uid(19,id),pg_temp.uid(7,commentable_id),pg_temp.uid(18,user_id),comment,created_at::timestamp AT TIME ZONE 'UTC' FROM pg_temp.comments WHERE commentable_type='Team';",
                "DO $$ BEGIN IF (SELECT count(*) FROM public.zone)<>(SELECT count(*) FROM _zones) OR (SELECT count(*) FROM public.team_odds_history)<>(SELECT count(*) FROM _odds) OR (SELECT count(*) FROM public.comment)<>(SELECT count(*) FROM pg_temp.comments WHERE commentable_type='Game') OR (SELECT count(*) FROM public.team_comment)<>(SELECT count(*) FROM pg_temp.comments WHERE commentable_type='Team') THEN RAISE EXCEPTION 'enrichment promotion count mismatch'; END IF; END $$;"])
    if defer:
        sql.extend(["DO $$ DECLARE t record; operation text; BEGIN FOR t IN SELECT * FROM _deferred LOOP operation:=CASE t.tgenabled WHEN 'O' THEN 'ENABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'D' THEN 'DISABLE' ELSE NULL END; IF operation IS NULL THEN RAISE EXCEPTION 'unknown trigger state'; END IF; EXECUTE format('ALTER TABLE public.%I %s TRIGGER %I',t.relname,operation,t.tgname); END LOOP; END $$;",
                    "INSERT INTO public.team_profile_dirty(team_id,revision) SELECT id,nextval('public.team_profile_revision_seq') FROM public.team ON CONFLICT(team_id) DO UPDATE SET revision=EXCLUDED.revision;",
                    "INSERT INTO public.player_metric_dirty(player_id,championship_id,revision) SELECT player_id,championship_id,nextval('public.player_metric_revision_seq') FROM (SELECT DISTINCT a.player_id,p.championship_id FROM public.player_game a JOIN public.game g ON g.id=a.game_id JOIN public.phase p ON p.id=g.phase_id) seasons ON CONFLICT(player_id,championship_id) DO UPDATE SET revision=EXCLUDED.revision;",
                    "INSERT INTO public.team_rating_chart_dirty(team_id,revision) SELECT id,nextval('public.team_rating_chart_revision_seq') FROM public.team ON CONFLICT(team_id) DO UPDATE SET revision=EXCLUDED.revision;",
                    "INSERT INTO public.team_odds_chart_dirty(group_id,revision) SELECT id,nextval('public.team_odds_chart_revision_seq') FROM public.stage_group ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;"])
    sql.extend(['COMMIT;', ''])
    return '\n'.join(sql)


def source_columns(db: Database) -> dict:
    columns = {}
    for table in (*TABLES, 'users'):
        rows = list(db.mysql("SELECT JSON_ARRAY(column_name,data_type) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=" + literal(table) + ' ORDER BY ordinal_position'))
        if table == 'users':
            types = dict(rows)
            rows = [(name,types[name]) for name in USER_COLUMNS if name in types]
        if not rows or not any(name == 'id' for name, _ in rows):
            raise ValueError(f'missing source schema: {table}')
        columns[table] = [(name, source_type(kind)) for name, kind in rows]
    if tuple(name for name, _ in columns['users']) != USER_COLUMNS:
        raise ValueError('source public user schema mismatch')
    return columns


def source_type(kind: str) -> str:
    if kind in ('bigint','int','tinyint','smallint','mediumint'):
        return 'bigint'
    if kind in ('float','double','decimal'):
        return 'double precision'
    if kind in ('varchar','char','text','mediumtext','longtext','date','datetime','timestamp','json'):
        return 'text'
    raise ValueError(f'unsupported source column type: {kind!r}')


def write_csv(path: Path, header: tuple, rows) -> int:
    count = 0
    with path.open('x', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(header)
        for row in rows:
            stream.write(csv_row(row))
            count += 1
    return count


def csv_row(row) -> str:
    fields = []
    for value in row:
        if value is None:
            fields.append('\\N')
        else:
            if isinstance(value,(dict,list)):
                value = json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)
            buffer = io.StringIO()
            csv.writer(buffer,quoting=csv.QUOTE_ALL,lineterminator='').writerow([value])
            fields.append(buffer.getvalue())
    return ','.join(fields) + '\n'


def apply_script(target: list[str]) -> str:
    command = ' '.join(shlex.quote(value) for value in target)
    return '#!/bin/sh\nset -eu\narchive_sql=$(CDPATH= cd "$(dirname "$0")" && pwd)/apply.sql\n'+command+' < "$archive_sql"\n'


def build(args) -> dict:
    db = Database(args.source_container, args.source_database, args.target_container, args.target_database)
    system_id = db.pg('SELECT system_identifier FROM pg_control_system();')
    db.pg(target_guard(args.target_database, system_id))
    columns = source_columns(db)
    corrections = validate_corrections(json.loads(args.corrections.read_text()) if args.corrections else {}, columns)
    counts = json.loads(args.expected_counts.read_text())
    if set(counts) != set(TABLES) or any(type(n) is not int or n < 0 for n in counts.values()):
        raise ValueError('expected counts must contain exactly the original domain tables')
    source_counts = {table: next(db.mysql(f'SELECT JSON_ARRAY(count(*)) FROM `{table}`'))[0] for table in (*TABLES, 'users')}
    if any(counts[table] != source_counts[table] for table in TABLES):
        raise ValueError('source cardinalities differ from reviewed expected counts')
    counts['users'] = source_counts['users']
    args.output.mkdir(parents=True, exist_ok=False)
    if not args.reuse_staging:
        db.pg('CREATE SCHEMA legacy; REVOKE ALL ON SCHEMA legacy FROM PUBLIC;')
        for table, fields in columns.items():
            db.stage(table, fields, counts[table])
    else:
        for table, fields in columns.items():
            if table == 'users' and db.pg("SELECT to_regclass('legacy.users') IS NULL;") == 't':
                db.stage(table, fields, counts[table])
            actual = json.loads(db.pg(f"SELECT coalesce(json_agg(json_build_array(column_name,udt_name) ORDER BY ordinal_position),'[]') FROM information_schema.columns WHERE table_schema='legacy' AND table_name={literal(table)};"))
            expected = [[name, {'bigint':'int8','double precision':'float8','text':'text'}[kind]] for name, kind in fields]
            if actual != expected:
                raise ValueError(f'{table}: staging schema mismatch')
            if int(db.pg(f'SELECT count(*) FROM legacy.{ident(table)};')) != counts[table]:
                raise ValueError(f'{table}: staging count mismatch')
            if db.pg(f"SELECT EXISTS(SELECT id FROM legacy.{ident(table)} GROUP BY id HAVING count(*)>1) OR EXISTS(SELECT 1 FROM legacy.{ident(table)} WHERE id IS NULL OR id<=0 OR id>=281474976710656);") != 'f':
                raise ValueError(f'{table}: staging ids not unique positive 48-bit numbers')
    prefix = 'BEGIN;\n' + corrected_views(columns, corrections) + '\n'
    def query(sql):
        return json.loads(db.pg(prefix + "SELECT coalesce(json_agg(row_to_json(s)),'[]') FROM (" + sql + ') s; ROLLBACK;'))
    zone_rows = []
    for row in query('SELECT id,zones FROM pg_temp.groups ORDER BY id'):
        for index, (name, color, first, last) in enumerate(zones(row['zones']), 1):
            if index >= 2**16:
                raise ValueError('zone namespace exhausted')
            zone_rows.append((legacy_uuid(5, row['id'] * 2**16 + index), legacy_uuid(4,row['id']),name,color,first,last))
    odds_rows = []
    null_odds = 0
    for row in query('SELECT h.id,t.group_id,t.team_id,h.recorded_on,h.captured_at,h.odds FROM pg_temp.team_group_odds_histories h LEFT JOIN pg_temp.team_groups t ON t.id=h.team_group_id ORDER BY h.id'):
        if row['group_id'] is None:
            raise ValueError(f"odds {row['id']}: missing source membership")
        for position, percent in enumerate(odds(row['odds']), 1):
            if percent is None:
                null_odds += 1
                continue
            odds_rows.append((legacy_uuid(4,row['group_id']),legacy_uuid(7,row['team_id']),row['recorded_on'],row['captured_at'],position,percent))
    geocode_rows = []
    for row in query('SELECT id,team_id,data FROM pg_temp.team_geocodes ORDER BY id'):
        data = json.loads(row['data']) if row['data'] else None
        if not data:
            continue
        if not isinstance(data,list) or not isinstance(data[0],dict) or 'lat' not in data[0] or 'lon' not in data[0]:
            raise ValueError(f"geocode {row['id']}: unknown shape")
        latitude, longitude = float(data[0]['lat']),float(data[0]['lon'])
        if not math.isfinite(latitude) or not -90<=latitude<=90 or not math.isfinite(longitude) or not -180<=longitude<=180:
            raise ValueError(f"geocode {row['id']}: invalid coordinates")
        geocode_rows.append((legacy_uuid(7,row['team_id']),latitude,longitude))
    files = {kind: args.output.resolve() / (kind+'.csv') for kind in ('zones','odds','geocodes')}
    counts['current_goals'] = query('SELECT count(*) AS count FROM pg_temp.goals a JOIN pg_temp.games g ON g.id=a.game_id')[0]['count']
    counts['unique_team_players'] = query('SELECT count(*) AS count FROM(SELECT DISTINCT championship_id,team_id,player_id FROM pg_temp.team_players) memberships')[0]['count']
    csv_counts = {kind: write_csv(files[kind],header,rows) for kind,header,rows in (
        ('zones',('id','group_id','name','color','first','last'),zone_rows),
        ('odds',('group_id','team_id','recorded_on','captured_at','position','percent'),odds_rows),
        ('geocodes',('team_id','latitude','longitude'),geocode_rows))}
    enrichment_preflight = json.loads(db.pg(enrichment_preflight_sql(columns,corrections,files)))
    sql = promotion_sql(columns,corrections,counts,args.target_database,system_id,files,args.defer_projections)
    (args.output/'apply.sql').write_text(sql,encoding='utf-8')
    (args.output/'apply.sh').write_text(apply_script(db.target),encoding='utf-8')
    manifest = {'source_container':args.source_container,'source_database':args.source_database,
                'target_container':args.target_container,'target_database':args.target_database,
                'target_system_identifier':system_id,'counts':counts,'mapped_cells':csv_counts,
                'enrichment_preflight':enrichment_preflight,
                'retained_detached_goals':counts['goals']-counts['current_goals'],
                'retained_null_odds_cells':null_odds,
                'retained_geocodes_without_coordinates':counts['team_geocodes']-csv_counts['geocodes'],
                'normalized_partial_score_pairs':query('SELECT count(*) FILTER(WHERE (home_aet IS NULL)<>(away_aet IS NULL)) AS extra_time,count(*) FILTER(WHERE (home_pen IS NULL)<>(away_pen IS NULL)) AS penalties FROM pg_temp.games')[0],
                'appearance_duration_anomalies':query('SELECT a.*,p.championship_id FROM pg_temp.player_games a JOIN pg_temp.games g ON g.id=a.game_id JOIN pg_temp.phases p ON p.id=g.phase_id WHERE a."off"<a."on" ORDER BY a.id'),
                'appearance_duration_policy':'Retain contradictory source minutes and enumerate them for review; off=0 is not assumed to mean full time. Original TeamPlayer.stats sums off-on, counts played when off>0 and bench when off=0.',
                'retained_not_served_comments':query("SELECT commentable_type,count(*) AS count FROM pg_temp.comments WHERE commentable_type NOT IN('Game','Team') GROUP BY commentable_type ORDER BY commentable_type"),
                'corrections':corrections,'deferred_projection_triggers':DEFERRED_TRIGGERS if args.defer_projections else {},
                'promoted_counts':{target:counts['unique_team_players'] if target=='team_player' else corrected_count(source,counts[source],corrections) if target!='goal' else counts['current_goals'] for target,source,_,_ in MAPS},
                'collapsed_team_player_memberships':query('SELECT championship_id,team_id,player_id,id AS redundant_source_id,retained_source_id FROM(SELECT *,min(id) OVER(PARTITION BY championship_id,team_id,player_id) AS retained_source_id FROM pg_temp.team_players) memberships WHERE id<>retained_source_id ORDER BY retained_source_id,id'),
                'normalizations':['Professional source category 1 and category 0 map to uncategorized professional championships',
                    'Optional zero dates, foreign keys, round and height map to NULL; attendance -1 maps to NULL',
                    'Known kickoff instants determine match and appearance days in America/Sao_Paulo; hourless games retain the source calendar date',
                    'Unplayed regulation scores map to NULL; bench on=off=0 maps to off=NULL',
                    'AET and penalty pairs with one recorded side retain that score and represent the absent side as zero, matching original Rails total_score semantics; entirely absent pairs remain NULL',
                    'Phase sort whitespace is removed; CSS lightgreen maps to equivalent #90ee90',
                    'Disjoint zone position sets become contiguous runs without changing covered positions',
                    'Repeated identical roster memberships map to the lowest source ID for the complete mapped triple(championship,team,player); all redundant legacy rows remain privately archived',
                    'Public bylines prefer name then non-email login; absent bylines receive Legacy user ID; duplicates receive legacy ID suffix'],
                'team_rating_identity':{'algorithm':'UUIDv5','namespace':RATING_NAMESPACE,'name':'teamUUID:YYYY-MM-DD','runtime':'computations/ratings.js'},
                'runtime_preservation_requirement':'Disable ratings replacement and omit chances onComplete snapshot capture when serving imported original ratings and odds; the default computation sink prunes outputs absent from recalculation.',
                'staging_assumption':'Restored source is immutable; reused typed legacy schema must originate from this exact source export. Counts, column types and positive unique source IDs are checked.',
                'files_sha256':{path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in (*files.values(),args.output/'apply.sql')}}
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-container',required=True)
    parser.add_argument('--source-database',required=True)
    parser.add_argument('--target-container',required=True)
    parser.add_argument('--target-database',required=True)
    parser.add_argument('--expected-counts',type=Path,required=True)
    parser.add_argument('--corrections',type=Path)
    parser.add_argument('--reuse-staging',action='store_true')
    parser.add_argument('--defer-projections',action='store_true')
    parser.add_argument('output',type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args),indent=2,ensure_ascii=False))


if __name__ == '__main__':
    main()
