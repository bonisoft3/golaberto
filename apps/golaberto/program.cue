// The machine rung of apps/golaberto: a pronto.#App compiled from ir.html
// (pinned below). Nobody reviews this; it must merely be checkable — cue vet,
// the ir bijection and the emitted surface are the contract.
@extern(embed)

package golaberto

import (
	pronto "bonisoft.org/plugins/pronto"
	"list"
	"strings"
)

_designMd: _ @embed(file="DESIGN.md", type=text)
_catalogues: _ @embed(glob="messages/*.json")
_homeGamesSql: string @embed(file="services/database/sql/013_home_games.sql", type=text)
_homeGamesUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_homeGamesSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")
_homeChampionshipsSql: string @embed(file="services/database/sql/014_home_championships.sql", type=text)
_homeChampionshipsUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_homeChampionshipsSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_homePerformanceSql: string @embed(file="services/database/sql/015_home_performance.sql", type=text)
_homePerformanceUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_homePerformanceSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_matchesPerformanceSql: string @embed(file="services/database/sql/016_matches_performance.sql", type=text)
_matchesPerformanceUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_matchesPerformanceSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_gameCountriesSql: string @embed(file="services/database/sql/017_game_countries.sql", type=text)
_gameCountriesUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_gameCountriesSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_normalizedGameFlagsSql: string @embed(file="services/database/sql/019_normalized_game_flags.sql", type=text)
_normalizedGameFlagsUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_normalizedGameFlagsSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_homeReferenceSql: string @embed(file="services/database/sql/020_home_reference_order.sql", type=text)
_homeReferenceUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_homeReferenceSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_recentChampionshipsSql: string @embed(file="services/database/sql/022_recent_championships.sql", type=text)
_recentChampionshipsUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_recentChampionshipsSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_searchCollationSql: string @embed(file="services/database/sql/023_search_collation.sql", type=text)
_searchCollationUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_searchCollationSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_teamDirectorySql: string @embed(file="services/database/sql/024_team_directory.sql", type=text)
_teamDirectoryUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_teamDirectorySql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")
// SQLite tab queries and PostgreSQL stored keys share the same two mappings.
#SearchKey: {col: string, out: "replace(replace(replace(\(col), 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')"}

_extendedSearchCollationSql: string @embed(file="services/database/sql/025_search_letter_equivalences.sql", type=text)
_extendedSearchCollationUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_extendedSearchCollationSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_homeHighlightsSql: string @embed(file="services/database/sql/021_home_highlights.sql", type=text)
_homeHighlightsUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_homeHighlightsSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

_routePerformanceSql: string @embed(file="services/database/sql/018_route_performance.sql", type=text)
_routePerformanceUpgrade: strings.Join(strings.Split(strings.Join(strings.Split(_routePerformanceSql, "\nBEGIN;\n"), "\n"), "\nCOMMIT;\n"), "\n")

// "2026" or "2026/2027", in immutable SQL: to_char is only STABLE.
_season: "extract(year from begins)::int::text || CASE WHEN extract(year from begins) = extract(year from ends) THEN '' ELSE '/' || extract(year from ends)::int::text END"

// dd/mm/yyyy from a DATE column, in immutable SQL: `date::text` reads DateStyle.
#dmy: D={
	col: string
	out: "lpad(extract(day from \(D.col))::int::text, 2, '0') || '/' || lpad(extract(month from \(D.col))::int::text, 2, '0') || '/' || extract(year from \(D.col))::int::text"
}
_dmy: (#dmy & {col: "day"}).out
// HH:MM of the kickoff on Brasília's wall clock, as the archive prints it;
// AT TIME ZONE with a literal zone is immutable where to_char is not.
_hm: "CASE WHEN kickoff IS NULL THEN '' ELSE lpad(extract(hour from (kickoff AT TIME ZONE 'America/Sao_Paulo'))::int::text, 2, '0') || ':' || lpad(extract(minute from (kickoff AT TIME ZONE 'America/Sao_Paulo'))::int::text, 2, '0') END"

// A count of goals: nobody scores a hundred.
_score: "this >= 0 && this < 100"

code: pronto.#App & {
	// Queries own their historical subsets; a detail page never loads an archive.
	state: entities: {
		AppUser: onDemand: true
		Category: onDemand: true
		Championship: onDemand: true
		Phase: onDemand: true
		Group: onDemand: true
		Zone: onDemand: true
		Stadium: onDemand: true
		Team: onDemand: true
		Referee: onDemand: true
		Player: onDemand: true
		Game: onDemand: true
		Goal: onDemand: true
		PlayerGame: onDemand: true
		Standing: onDemand: true
		TeamChance: onDemand: true
		ZoneChance: onDemand: true
		PositionChance: onDemand: true
		GameImportance: onDemand: true
		TeamRating: onDemand: true
		TeamDirectory: onDemand: true
		PlayerRating: onDemand: true
		GameCard: onDemand: true
		TeamGame: onDemand: true
		Comment: onDemand: true
		PlayerStat: onDemand: true
		PhaseRound: onDemand: true
	}
	state: entities: {
		// The auth plane's person: every reader is one, a guest until a passkey
		// keeps them (ir decision-guest-reading).
		AppUser: {
			id: "0x8648317c916df7f6"
			table:      "app_user"
			durability: "server"
			// Public: a handle is a byline (ir decision-comments).
			access: {scope: "public"}
			fields: [
				// No default: the auth service supplies the id.
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "handle", type: "string", unique: true, cel: "this.size() > 0"},
				{ordinal: 3, name: "created_at", type: "timestamp", default: "now()"},
			]
		}
		Category: {
			id: "0xfb1a379e02ff00a5"
			table:      "category"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", unique: true, cel: "this.size() > 0 && this.size() <= 40"},
			]
		}
		Championship: {
			id: "0xc7dbf58fcb09211a"
			table:      "championship"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 120"},
				// None is the professional class.
				{ordinal: 3, name: "category_id", type: "uuid", required: false, ref: "category"},
				{ordinal: 4, name: "region", type: "string", default: "'national'", cel: "this in ['world', 'continental', 'national']"},
				{ordinal: 5, name: "region_name", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 6, name: "begins", type: "date"},
				{ordinal: 7, name: "ends", type: "date"},
				{ordinal: 8, name: "point_win", type: "int32", default: "3", cel: "this >= 0 && this <= 9"},
				{ordinal: 9, name: "point_draw", type: "int32", default: "1", cel: "this >= 0 && this <= 9"},
				{ordinal: 10, name: "point_loss", type: "int32", default: "0", cel: "this >= 0 && this <= 9"},
				{ordinal: 11, name: "show_country", type: "bool", default: "false"},
				{ordinal: 12, name: "season", type: "string", generated: _season},
				{ordinal: 13, name: "full_name", type: "string", generated: "region_name || ' - ' || name || ' ' || \(_season)"},
				// The championship table highlighted below the home game feeds.
				{ordinal: 14, name: "featured", type: "bool", default: "false"},
				{ordinal: 15, name: "search_name", type: "string", generated: "region_name || ' - ' || name || ' ' || \(_season)"},
				{ordinal: 16, name: "search_key", type: "string", generated: (#SearchKey & {col: "region_name || ' - ' || name || ' ' || \(_season)"}).out},
			]
			invariant: {cel: "this.ends >= this.begins"}
			indexes: [{on: "begins"}]
		}
		HomeChampionship: {
			id: "0x9f7e16021a981047"
			table: "home_championship"
			durability: "live"
			writers: "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "championship"},
				{ordinal: 2, name: "region", type: "string"},
				{ordinal: 3, name: "region_name", type: "string"},
				{ordinal: 4, name: "full_name", type: "string"},
				{ordinal: 5, name: "strength", type: "double"},
			]
		}
		Phase: {
			id: "0xb8d8d6dc02bc184b"
			table:      "phase"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 3, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 4, name: "position", type: "int32", default: "0", cel: "this >= 0"},
				// The tie-break ladder, most significant first.
				{ordinal: 5, name: "sort", type: "string", default: "'pt,w,gd,gf,gp,g_away,name'", cel: "this.matches('^(pt|w|gd|gf|name|g_average|gp|g_aet|head|g_away|bias)(,(pt|w|gd|gf|name|g_average|gp|g_aet|head|g_away|bias))*$')"},
				{ordinal: 6, name: "bonus_points", type: "int32", default: "0", cel: "this >= 0 && this <= 9"},
				{ordinal: 7, name: "bonus_points_threshold", type: "int32", default: "0", cel: _score},
			]
			indexes: [{on: "championship_id"}]
		}
		Group: {
			id: "0xf221e9f7e13f6121"
			table:      "stage_group"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 40"},
				{ordinal: 4, name: "position", type: "int32", default: "0", cel: "this >= 0"},
			]
			indexes: [{on: "phase_id"}]
		}
		Zone: {
			id: "0xdc19a20e3738e3ce"
			table:      "zone"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 4, name: "color", type: "string", cel: "this in ['champion', 'promotion', 'qualify', 'playoff', 'relegation']"},
				{ordinal: 5, name: "first", type: "int32", cel: "this >= 1"},
				{ordinal: 6, name: "last", type: "int32", cel: "this >= 1"},
			]
			invariant: {cel: "this.last >= this.first"}
			indexes: [{on: "group_id"}]
		}
		Stadium: {
			id: "0x9f93bd78c79319bf"
			table:      "stadium"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 80"},
				{ordinal: 3, name: "full_name", type: "string", required: false, cel: "this.size() <= 160"},
				{ordinal: 4, name: "city", type: "string", required: false, cel: "this.size() <= 80"},
				{ordinal: 5, name: "country", type: "string", required: false, cel: "this.size() <= 60"},
				{ordinal: 6, name: "search_name", type: "string", generated: "name"},
				{ordinal: 7, name: "search_key", type: "string", generated: (#SearchKey & {col: "name"}).out},
			]
		}
		Team: {
			id: "0xb229052b7479a008"
			table:      "team"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 3, name: "full_name", type: "string", required: false, cel: "this.size() <= 160"},
				{ordinal: 4, name: "city", type: "string", required: false, cel: "this.size() <= 80"},
				{ordinal: 5, name: "country", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 6, name: "foundation", type: "date", required: false},
				{ordinal: 7, name: "stadium_id", type: "uuid", required: false, ref: "stadium"},
				{ordinal: 8, name: "team_type", type: "string", default: "'club'", cel: "this in ['club', 'national']"},
				{ordinal: 9, name: "foundation_display", type: "string", generated: (#dmy & {col: "foundation"}).out},
				{ordinal: 10, name: "search_name", type: "string", generated: "name"},
				{ordinal: 11, name: "search_key", type: "string", generated: (#SearchKey & {col: "name"}).out},
			]
			indexes: [{on: "name"}]
		}
		TeamGroup: {
			id: "0xa881d0753d2d99d0"
			table:      "team_group"
			durability: "server"
			access: {scope: "public"}
			uniques: [{name: "uq_team_group", cols: ["group_id", "team_id"]}]
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "add_sub", type: "int32", default: "0", cel: "this >= -99 && this <= 99"},
				{ordinal: 5, name: "bias", type: "int32", default: "0", cel: "this >= -99 && this <= 99"},
				{ordinal: 6, name: "comment", type: "string", required: false, cel: "this.size() <= 500"},
			]
			indexes: [{on: "team_id"}]
		}
		Referee: {
			id: "0xeeeb9eb6d5806593"
			table:      "referee"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 80"},
				{ordinal: 3, name: "location", type: "string", required: false, cel: "this.size() <= 80"},
				{ordinal: 4, name: "search_name", type: "string", generated: "name"},
				{ordinal: 5, name: "search_key", type: "string", generated: (#SearchKey & {col: "name"}).out},
			]
		}
		TeamDirectory: {
			id: "0x93d75c8ddada8190"
			table: "team_directory"
			durability: "live"
			writers: "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "team"},
				{ordinal: 2, name: "name", type: "string"},
				{ordinal: 3, name: "city", type: "string", required: false},
				{ordinal: 4, name: "country", type: "string", required: false},
				{ordinal: 5, name: "rating", type: "double", required: false},
				{ordinal: 6, name: "measure_date", type: "date", required: false},
				{ordinal: 7, name: "search_name", type: "string", generated: "name"},
				{ordinal: 8, name: "search_country", type: "string", generated: "coalesce(country, '')"},
				{ordinal: 9, name: "rating_display", type: "string", generated: "CASE WHEN rating IS NULL THEN '—' ELSE round(rating::numeric, 2)::text END"},
				{ordinal: 10, name: "search_key", type: "string", generated: (#SearchKey & {col: "name"}).out},
				{ordinal: 11, name: "country_key", type: "string", generated: (#SearchKey & {col: "coalesce(country, '')"}).out},
			]
		}
		Player: {
			id: "0xb159e5039a3133ce"
			table:      "player"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 60"},
				{ordinal: 3, name: "full_name", type: "string", required: false, cel: "this.size() <= 160"},
				{ordinal: 4, name: "birth", type: "date", required: false},
				{ordinal: 5, name: "country", type: "string", required: false, cel: "this.size() <= 60"},
				{ordinal: 6, name: "height", type: "int32", required: false, cel: "this >= 100 && this <= 230"},
				{ordinal: 7, name: "position", type: "string", required: false, cel: "this in ['g', 'dr', 'dc', 'dl', 'dm', 'cm', 'am', 'fw']"},
			]
			indexes: [{on: "name"}]
		}
		TeamPlayer: {
			id: "0xdbcdb9bb5c808317"
			table:      "team_player"
			durability: "server"
			access: {scope: "public"}
			uniques: [{name: "uq_team_player", cols: ["championship_id", "team_id", "player_id"]}]
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "player_id", type: "uuid", ref: "player"},
			]
			indexes: [{on: "player_id"}, {on: "team_id"}]
		}
		Game: {
			id: "0xa503999231c39ca2"
			table:      "game"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "round", type: "int32", required: false, cel: "this >= 1 && this <= 99"},
				// The calendar day of the match where it was played; the kickoff instant
				// only when the hour is known, which archive games mostly are not.
				{ordinal: 4, name: "day", type: "date"},
				{ordinal: 5, name: "kickoff", type: "timestamp", required: false},
				{ordinal: 6, name: "home_id", type: "uuid", ref: "team"},
				{ordinal: 7, name: "away_id", type: "uuid", ref: "team"},
				// Whose ground: the home side's, neither, or — rarely — the away side's.
				{ordinal: 8, name: "home_field", type: "string", default: "'left'", cel: "this in ['left', 'neutral', 'right']"},
				{ordinal: 9, name: "played", type: "bool", default: "false"},
				{ordinal: 10, name: "home_score", type: "int32", required: false, cel: _score},
				{ordinal: 11, name: "away_score", type: "int32", required: false, cel: _score},
				{ordinal: 12, name: "home_aet", type: "int32", required: false, cel: _score},
				{ordinal: 13, name: "away_aet", type: "int32", required: false, cel: _score},
				{ordinal: 14, name: "home_pen", type: "int32", required: false, cel: _score},
				{ordinal: 15, name: "away_pen", type: "int32", required: false, cel: _score},
				{ordinal: 16, name: "stadium_id", type: "uuid", required: false, ref: "stadium"},
				{ordinal: 17, name: "referee_id", type: "uuid", required: false, ref: "referee"},
				{ordinal: 18, name: "attendance", type: "int32", required: false, cel: "this >= 0 && this <= 250000"},
				{ordinal: 19, name: "day_display", type: "string", generated: _dmy},
				{ordinal: 20, name: "kickoff_local", type: "string", generated: _hm},
			]
			invariant: {cel: "this.home_id != this.away_id && this.played == (has(this.home_score) && has(this.away_score)) && has(this.home_score) == has(this.away_score) && has(this.home_aet) == has(this.away_aet) && has(this.home_pen) == has(this.away_pen) && (has(this.home_aet) == false || this.played) && (has(this.home_pen) == false || this.played)"}
			indexes: [{on: "phase_id"}, {on: "home_id"}, {on: "away_id"}, {on: "day"}, {on: "referee_id"}, {on: "stadium_id"}]
		}
		Goal: {
			id: "0xf2913e51cccaa056"
			table:      "goal"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "game_id", type: "uuid", ref: "game"},
				{ordinal: 3, name: "player_id", type: "uuid", ref: "player"},
				{ordinal: 4, name: "side", type: "string", cel: "this in ['home', 'away']"},
				// Optional: the archive records some goals of old seasons without one.
				{ordinal: 5, name: "minute", type: "int32", required: false, cel: "this >= 0 && this <= 130"},
				{ordinal: 6, name: "penalty", type: "bool", default: "false"},
				{ordinal: 7, name: "own_goal", type: "bool", default: "false"},
				{ordinal: 8, name: "aet", type: "bool", default: "false"},
			]
			invariant: {cel: "this.penalty == false || this.own_goal == false"}
			indexes: [{on: "game_id"}, {on: "player_id"}]
		}
		PlayerGame: {
			id: "0xeba60899800e6f98"
			table:      "player_game"
			durability: "server"
			access: {scope: "public"}
			uniques: [{name: "uq_player_game", cols: ["game_id", "player_id"]}]
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "game_id", type: "uuid", ref: "game"},
				{ordinal: 3, name: "player_id", type: "uuid", ref: "player"},
				{ordinal: 4, name: "side", type: "string", cel: "this in ['home', 'away']"},
				{ordinal: 5, name: "on_minute", type: "int32", default: "0", cel: "this >= 0 && this <= 130"},
				{ordinal: 6, name: "off_minute", type: "int32", required: false, cel: "this >= 0 && this <= 130"},
				{ordinal: 7, name: "yellow", type: "bool", default: "false"},
				{ordinal: 8, name: "red", type: "bool", default: "false"},
				// Named among the substitutes and never brought on (ir
				// decision-bench).
				{ordinal: 9, name: "bench", type: "bool", default: "false"},
				// The game's day, kept by a trigger (services/database/sql/010).
				{ordinal: 10, name: "day", type: "date", required: false},
				{ordinal: 11, name: "day_display", type: "string", generated: _dmy},
			]
			invariant: {cel: "this.bench == false || (this.on_minute == 0 && has(this.off_minute) == false)"}
			indexes: [{on: "player_id"}, {on: "game_id"}]
		}
		// A group's table, recounted by the standings stream from the games,
		// never typed (ir standings). Live and off the CDC publication, so the
		// stream that writes it cannot hear its own writes.
		Standing: {
			id: "0x926e5bdae6121306"
			table:      "standing"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				// <group id>:<team id>
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "team_name", type: "string"},
				{ordinal: 5, name: "position", type: "int32", cel: "this >= 1"},
				{ordinal: 6, name: "points", type: "int32"},
				{ordinal: 7, name: "played", type: "int32", cel: "this >= 0"},
				{ordinal: 8, name: "wins", type: "int32", cel: "this >= 0"},
				{ordinal: 9, name: "draws", type: "int32", cel: "this >= 0"},
				{ordinal: 10, name: "losses", type: "int32", cel: "this >= 0"},
				{ordinal: 11, name: "goals_for", type: "int32", cel: "this >= 0"},
				{ordinal: 12, name: "goals_against", type: "int32", cel: "this >= 0"},
				{ordinal: 13, name: "goal_diff", type: "int32"},
				// The last five results, oldest first: w, d, l, or empty.
				{ordinal: 14, name: "form1", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				{ordinal: 15, name: "form2", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				{ordinal: 16, name: "form3", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				{ordinal: 17, name: "form4", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				{ordinal: 18, name: "form5", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				// The narrowest zone the position falls in, or none.
				{ordinal: 19, name: "zone", type: "string", cel: "this in ['', 'champion', 'promotion', 'qualify', 'playoff', 'relegation']"},
			]
			indexes: [{on: "group_id"}]
		}
		// A group's chances, written by the chances computation over the lake
		// (ir decision-chances): one line per team of the group, in its current
		// order, with what each final position and each of the group's zones is
		// worth to it.
		TeamChance: {
			id: "0xd113a24abf038541"
			table:      "team_chance"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "team_name", type: "string"},
				{ordinal: 5, name: "rank", type: "int32", cel: "this >= 1"},
				{ordinal: 6, name: "points", type: "int32"},
				{ordinal: 7, name: "played", type: "int32", cel: "this >= 0"},
			]
			indexes: [{on: "group_id"}]
		}
		ZoneChance: {
			id: "0xdb4e4660787b8728"
			table:      "zone_chance"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "zone_id", type: "uuid", ref: "zone"},
				// The zone's first position, which orders the columns.
				{ordinal: 5, name: "first", type: "int32", cel: "this >= 1"},
				{ordinal: 6, name: "percent", type: "double", cel: "this >= 0 && this <= 100.5"},
				// The zone's colour and the cell's heat, as the standings draw them.
				{ordinal: 7, name: "color", type: "string", cel: "this in ['champion', 'promotion', 'qualify', 'playoff', 'relegation']"},
				{ordinal: 8, name: "band", type: "int32", cel: "this >= 0 && this <= 4"},
				// Its last position: zones sharing a first are ordered by it.
				{ordinal: 9, name: "last", type: "int32", cel: "this >= 1"},
				// For a cell that shows 0, whether the zone can still be reached
				// (ir decision-chances); empty for every other cell.
				{ordinal: 10, name: "reach", type: "string", cel: "this in ['', 'impossible', 'reachable', 'undecided']"},
			]
			indexes: [{on: "group_id"}]
		}
		PositionChance: {
			id: "0xdf842a9ab21d8ec3"
			table:      "position_chance"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "position", type: "int32", cel: "this >= 1"},
				{ordinal: 5, name: "percent", type: "double", cel: "this >= 0 && this <= 100.5"},
				// The heat the cell is drawn with: 0 unlikely … 4 likely.
				{ordinal: 6, name: "band", type: "int32", cel: "this >= 0 && this <= 4"},
				// Whether this is the team's position now.
				{ordinal: 7, name: "current", type: "bool"},
				// For a cell that shows 0, whether the position can still be
				// reached (ir decision-chances); empty for every other cell.
				{ordinal: 8, name: "reach", type: "string", cel: "this in ['', 'impossible', 'reachable', 'undecided']"},
			]
			indexes: [{on: "group_id"}]
		}
		// What a game's result can still change, written by the chances
		// computation (ir decision-chances): odds-rust's game importance, per side.
		GameImportance: {
			id: "0xd6038ae1ca7e0e64"
			table:      "game_importance"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "game"},
				{ordinal: 2, name: "home", type: "double", required: false, cel: "this >= 0"},
				{ordinal: 3, name: "away", type: "double", required: false, cel: "this >= 0"},
			]
		}
		// A team's strength on a day, written by the ratings computation (ir
		// decision-ratings): upstream's SPI, refit as the archive grows. The
		// chances read it for each game's expected goals.
		TeamRating: {
			id: "0xe0bdc3160f737f46"
			table:      "team_rating"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 3, name: "measure_date", type: "date"},
				{ordinal: 4, name: "offense", type: "double"},
				{ordinal: 5, name: "defense", type: "double"},
				{ordinal: 6, name: "rating", type: "double", cel: "this >= 0 && this <= 100"},
			]
			indexes: [{on: "team_id"}]
		}
		// A player's rating from every minute he played, written by the ratings
		// computation (upstream's player ratings).
		PlayerRating: {
			id: "0xd7098e87ab67f7eb"
			table:      "player_rating"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "player"},
				{ordinal: 2, name: "rating", type: "double"},
			]
		}
		// How well the ratings predicted a phase's played games (upstream's
		// /eval): the ranked probability score, lower is better.
		RatingEval: {
			id: "0xf8a29784e425c143"
			table:      "rating_eval"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "phase"},
				{ordinal: 2, name: "rps", type: "double", cel: "this >= 0"},
			]
		}
		// One game as every list shows it, its names written beside its ids by the
		// game-cards stream. Flag settings and countries join their owners (ir
		// decision-local-reads). Keyed by the game, and gone with it.
		GameCard: {
			id: "0xc922f963c8b2479d"
			table:      "game_card"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "game"},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 4, name: "round", type: "int32", required: false, cel: "this >= 1 && this <= 99"},
				{ordinal: 5, name: "day", type: "date"},
				{ordinal: 6, name: "kickoff", type: "timestamp", required: false},
				{ordinal: 7, name: "played", type: "bool"},
				{ordinal: 8, name: "home_id", type: "uuid", ref: "team"},
				{ordinal: 9, name: "away_id", type: "uuid", ref: "team"},
				{ordinal: 10, name: "home_name", type: "string"},
				{ordinal: 11, name: "away_name", type: "string"},
				{ordinal: 12, name: "home_score", type: "int32", required: false, cel: _score},
				{ordinal: 13, name: "away_score", type: "int32", required: false, cel: _score},
				{ordinal: 14, name: "home_aet", type: "int32", required: false, cel: _score},
				{ordinal: 15, name: "away_aet", type: "int32", required: false, cel: _score},
				{ordinal: 16, name: "home_pen", type: "int32", required: false, cel: _score},
				{ordinal: 17, name: "away_pen", type: "int32", required: false, cel: _score},
				{ordinal: 18, name: "championship_name", type: "string"},
				{ordinal: 19, name: "phase_name", type: "string"},
				{ordinal: 20, name: "stadium_name", type: "string", required: false},
				{ordinal: 21, name: "referee_name", type: "string", required: false},
				{ordinal: 22, name: "attendance", type: "int32", required: false, cel: "this >= 0 && this <= 250000"},
				{ordinal: 23, name: "day_display", type: "string", generated: _dmy},
				{ordinal: 24, name: "kickoff_local", type: "string", generated: _hm},
				{ordinal: 25, name: "stadium_id", type: "uuid", required: false, ref: "stadium"},
				{ordinal: 26, name: "referee_id", type: "uuid", required: false, ref: "referee"},
				{ordinal: 27, name: "home_upcoming_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 28, name: "home_recent_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 29, name: "home_upcoming_group", type: "bool", default: "false"},
				{ordinal: 30, name: "home_recent_group", type: "bool", default: "false"},
				{ordinal: 31, name: "show_country", type: "bool", default: "false", retired: true},
				{ordinal: 32, name: "home_country", type: "string", default: "''", retired: true},
				{ordinal: 33, name: "away_country", type: "string", default: "''", retired: true},
			]
			indexes: [{on: "phase_id"}, {on: "day"}, {on: "stadium_id"}, {on: "referee_id"}]
		}
		// The selected forty cards only: the home page never syncs the archive.
		HomeGameCard: {
			id: "0x86cf93d86b91d654"
			table:      "home_game_card"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "game"},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 4, name: "round", type: "int32", required: false, cel: "this >= 1 && this <= 99"},
				{ordinal: 5, name: "day", type: "date"},
				{ordinal: 6, name: "kickoff", type: "timestamp", required: false},
				{ordinal: 7, name: "played", type: "bool"},
				{ordinal: 8, name: "home_id", type: "uuid", ref: "team"},
				{ordinal: 9, name: "away_id", type: "uuid", ref: "team"},
				{ordinal: 10, name: "home_name", type: "string"},
				{ordinal: 11, name: "away_name", type: "string"},
				{ordinal: 12, name: "home_score", type: "int32", required: false, cel: _score},
				{ordinal: 13, name: "away_score", type: "int32", required: false, cel: _score},
				{ordinal: 14, name: "home_aet", type: "int32", required: false, cel: _score},
				{ordinal: 15, name: "away_aet", type: "int32", required: false, cel: _score},
				{ordinal: 16, name: "home_pen", type: "int32", required: false, cel: _score},
				{ordinal: 17, name: "away_pen", type: "int32", required: false, cel: _score},
				{ordinal: 18, name: "championship_name", type: "string"},
				{ordinal: 19, name: "phase_name", type: "string"},
				{ordinal: 20, name: "stadium_name", type: "string", required: false},
				{ordinal: 21, name: "referee_name", type: "string", required: false},
				{ordinal: 22, name: "attendance", type: "int32", required: false, cel: "this >= 0 && this <= 250000"},
				{ordinal: 23, name: "day_display", type: "string", generated: _dmy},
				{ordinal: 24, name: "kickoff_local", type: "string", generated: _hm},
				{ordinal: 25, name: "stadium_id", type: "uuid", required: false, ref: "stadium"},
				{ordinal: 26, name: "referee_id", type: "uuid", required: false, ref: "referee"},
				{ordinal: 27, name: "home_upcoming_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 28, name: "home_recent_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 29, name: "home_upcoming_group", type: "bool", default: "false"},
				{ordinal: 30, name: "home_recent_group", type: "bool", default: "false"},
				{ordinal: 31, name: "show_country", type: "bool", default: "false", retired: true},
				{ordinal: 32, name: "home_country", type: "string", default: "''", retired: true},
				{ordinal: 33, name: "away_country", type: "string", default: "''", retired: true},
				{ordinal: 34, name: "home_highlighted", type: "bool", default: "false"},
			]
			indexes: [{on: "championship_id"}]
		}
		// The matches page syncs only its two chronological forty-card feeds.
		MatchesGameCard: {
			id: "0x87ef7c2b79e4b4e4"
			table:      "matches_game_card"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "game"},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 4, name: "round", type: "int32", required: false, cel: "this >= 1 && this <= 99"},
				{ordinal: 5, name: "day", type: "date"},
				{ordinal: 6, name: "kickoff", type: "timestamp", required: false},
				{ordinal: 7, name: "played", type: "bool"},
				{ordinal: 8, name: "home_id", type: "uuid", ref: "team"},
				{ordinal: 9, name: "away_id", type: "uuid", ref: "team"},
				{ordinal: 10, name: "home_name", type: "string"},
				{ordinal: 11, name: "away_name", type: "string"},
				{ordinal: 12, name: "home_score", type: "int32", required: false, cel: _score},
				{ordinal: 13, name: "away_score", type: "int32", required: false, cel: _score},
				{ordinal: 14, name: "home_aet", type: "int32", required: false, cel: _score},
				{ordinal: 15, name: "away_aet", type: "int32", required: false, cel: _score},
				{ordinal: 16, name: "home_pen", type: "int32", required: false, cel: _score},
				{ordinal: 17, name: "away_pen", type: "int32", required: false, cel: _score},
				{ordinal: 18, name: "championship_name", type: "string"},
				{ordinal: 19, name: "phase_name", type: "string"},
				{ordinal: 20, name: "stadium_name", type: "string", required: false},
				{ordinal: 21, name: "referee_name", type: "string", required: false},
				{ordinal: 22, name: "attendance", type: "int32", required: false, cel: "this >= 0 && this <= 250000"},
				{ordinal: 23, name: "day_display", type: "string", generated: _dmy},
				{ordinal: 24, name: "kickoff_local", type: "string", generated: _hm},
				{ordinal: 25, name: "stadium_id", type: "uuid", required: false, ref: "stadium"},
				{ordinal: 26, name: "referee_id", type: "uuid", required: false, ref: "referee"},
				{ordinal: 27, name: "home_upcoming_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 28, name: "home_recent_rank", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
				{ordinal: 29, name: "home_upcoming_group", type: "bool", default: "false"},
				{ordinal: 30, name: "home_recent_group", type: "bool", default: "false"},
				{ordinal: 31, name: "show_country", type: "bool", default: "false", retired: true},
				{ordinal: 32, name: "home_country", type: "string", default: "''", retired: true},
				{ordinal: 33, name: "away_country", type: "string", default: "''", retired: true},
			]
			indexes: [{on: "championship_id"}]
		}
		// One game from one of its teams' side: the opponent, where, and how it
		// went for this team (ir decision-local-reads).
		TeamGame: {
			id: "0x91f9338be221f43d"
			table:      "team_game"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				// <team id>:<game id>
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 3, name: "game_id", type: "uuid", ref: "game"},
				{ordinal: 4, name: "side", type: "string", cel: "this in ['home', 'away']"},
				{ordinal: 5, name: "opponent_id", type: "uuid", ref: "team"},
				{ordinal: 6, name: "opponent_name", type: "string"},
				{ordinal: 7, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 8, name: "championship_name", type: "string"},
				{ordinal: 9, name: "day", type: "date"},
				{ordinal: 10, name: "kickoff", type: "timestamp", required: false},
				{ordinal: 11, name: "played", type: "bool"},
				{ordinal: 12, name: "goals_for", type: "int32", required: false, cel: _score},
				{ordinal: 13, name: "goals_against", type: "int32", required: false, cel: _score},
				// The regular-time result for this team, empty until played.
				{ordinal: 14, name: "result", type: "string", cel: "this in ['', 'w', 'd', 'l']"},
				{ordinal: 15, name: "day_display", type: "string", generated: _dmy},
				{ordinal: 16, name: "kickoff_local", type: "string", generated: _hm},
				{ordinal: 17, name: "show_country", type: "bool", default: "false", retired: true},
				{ordinal: 18, name: "opponent_country", type: "string", default: "''", retired: true},
			]
			indexes: [{on: "team_id"}, {on: "game_id"}]
		}
		// What a signed-in reader said about a game (ir decision-comments).
		Comment: {
			id: "0x9d5b62b134186fd8"
			table:      "comment"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "game_id", type: "uuid", ref: "game"},
				// The author; its name is the table's so a byline is a local embed.
				{ordinal: 3, name: "app_user_id", type: "uuid", ref: "app_user", default: "auth_uid()"},
				{ordinal: 4, name: "body", type: "string", cel: "this.trim().size() > 0 && this.size() <= 1000"},
				{ordinal: 5, name: "created_at", type: "timestamp", default: "now()"},
			]
			indexes: [{on: "game_id"}]
		}
		// A comment being written, one per game, held by the tab and moved by the
		// composer machine.
		CommentDraft: {
			id: "0xa0ef4bf8391c0c4e"
			table:      "comment_draft"
			durability: "tab"
			fields: [
				// The game's id.
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "body", type: "string", default: "''", cel: "this.size() <= 1000"},
				{ordinal: 3, name: "state", type: "string", default: "'writing'", cel: "this in ['writing', 'sending', 'refused']"},
			]
		}
		// The grant that makes a reader an editor (ir decision-editing): given
		// out of band, and synced to its holder alone.
		Editor: {
			id: "0xdd205e5b35051510"
			table:      "editor"
			durability: "server"
			access: {scope: "private", owner: "app_user_id"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "app_user_id", type: "uuid", ref: "app_user", unique: true},
			]
		}
		// A game being corrected, one per game, held by the tab and moved by the
		// editor machine; it starts from the game it is nested in.
		GameEdit: {
			id: "0xe8e8f26032b30c03"
			table:      "game_edit"
			durability: "tab"
			fields: [
				// The game's id.
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "state", type: "string", default: "'editing'", cel: "this in ['editing', 'saving', 'refused']"},
				{ordinal: 3, name: "played", type: "bool", required: false},
				{ordinal: 4, name: "home_score", type: "int32", required: false},
				{ordinal: 5, name: "away_score", type: "int32", required: false},
				{ordinal: 6, name: "attendance", type: "int32", required: false},
				{ordinal: 7, name: "stadium_id", type: "string", required: false},
				{ordinal: 8, name: "referee_id", type: "string", required: false},
				// The goal being added: its side, minute and scorer.
				{ordinal: 9, name: "goal_minute", type: "int32", required: false},
				{ordinal: 10, name: "goal_player_id", type: "string", required: false},
				// The sides' names, for the labels: a draft binds its own row.
				{ordinal: 11, name: "home_name", type: "string", required: false},
				{ordinal: 12, name: "away_name", type: "string", required: false},
				{ordinal: 13, name: "stadium_q", type: "string", default: "''", cel: "this.size() <= 80"},
				{ordinal: 14, name: "referee_q", type: "string", default: "''", cel: "this.size() <= 80"},
				{ordinal: 15, name: "stadium_q_key", type: "string", default: "''", cel: "this.size() <= 160"},
				{ordinal: 16, name: "referee_q_key", type: "string", default: "''", cel: "this.size() <= 160"},
			]
		}
		// A player's season for one team in one championship, recounted by the
		// player-stats stream from the line-ups and goals (ir
		// decision-player-stats).
		PlayerStat: {
			id: "0xb51a5cb741600107"
			table:      "player_stat"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				// <championship id>:<team id>:<player id>
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "championship_id", type: "uuid", ref: "championship"},
				{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
				{ordinal: 4, name: "player_id", type: "uuid", ref: "player"},
				{ordinal: 5, name: "player_name", type: "string"},
				{ordinal: 6, name: "position", type: "string", cel: "this in ['', 'g', 'dr', 'dc', 'dl', 'dm', 'cm', 'am', 'fw']"},
				{ordinal: 7, name: "played", type: "int32", cel: "this >= 0"},
				{ordinal: 8, name: "started", type: "int32", cel: "this >= 0"},
				{ordinal: 9, name: "came_on", type: "int32", cel: "this >= 0"},
				{ordinal: 10, name: "bench", type: "int32", cel: "this >= 0"},
				{ordinal: 11, name: "minutes", type: "int32", cel: "this >= 0"},
				{ordinal: 12, name: "goals", type: "int32", cel: "this >= 0"},
				{ordinal: 13, name: "penalties", type: "int32", cel: "this >= 0"},
				{ordinal: 14, name: "own_goals", type: "int32", cel: "this >= 0"},
				{ordinal: 15, name: "yellow", type: "int32", cel: "this >= 0"},
				{ordinal: 16, name: "red", type: "int32", cel: "this >= 0"},
				{ordinal: 17, name: "championship_name", type: "string"},
				{ordinal: 18, name: "team_name", type: "string"},
			]
			indexes: [{on: "player_id"}, {on: "team_id"}]
		}
		// A phase's current round and the next, recounted by the rounds stream
		// (ir decision-phase-round).
		PhaseRound: {
			id: "0xe326676ae2b1bd9a"
			table:      "phase_round"
			durability: "live"
			writers:    "pipeline"
			access: {scope: "public"}
			fields: [
				// The phase's id, as text: one row per phase.
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "phase_id", type: "uuid", ref: "phase"},
				{ordinal: 3, name: "current", type: "int32", cel: "this >= 1"},
				{ordinal: 4, name: "next", type: "int32", required: false, cel: "this >= 1"},
			]
		}
		// Which list the games page shows, held by the tab and switched by a
		// machine (ir decision-machines).
		GamesView: {
			id: "0xb03036305d7807fe"
			table:      "games_view"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 16"},
				{ordinal: 2, name: "state", type: "string", default: "'upcoming'", cel: "this in ['upcoming', 'results']"},
			]
			seed: [{id: "games", state: "upcoming"}]
		}
		// A directory's search, one row per directory (teams, stadiums, referees),
		// held by the tab and written by a machine (ir decision-catalog-tab).
		DirectoryFilter: {
			id: "0xae1a2e56ca75c9e6"
			table:      "directory_filter"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 16"},
				{ordinal: 2, name: "q", type: "string", default: "''", cel: "this.size() <= 80"},
				{ordinal: 3, name: "state", type: "string", default: "'browsing'", cel: "this in ['browsing']"},
				{ordinal: 4, name: "offset", type: "int32", default: "0", cel: "this >= 0"},
				{ordinal: 5, name: "next_offset", type: "int32", default: "40", cel: "this >= 40"},
				{ordinal: 6, name: "page", type: "int32", default: "1", cel: "this >= 1"},
				{ordinal: 7, name: "country", type: "string", default: "''", cel: "this.size() <= 60"},
				{ordinal: 8, name: "q_key", type: "string", default: "''", cel: "this.size() <= 160"},
				{ordinal: 9, name: "country_key", type: "string", default: "''", cel: "this.size() <= 120"},
			]
			seed: [{id: "teams", q: "", country: "", q_key: "", country_key: "", state: "browsing", offset: 0, next_offset: 40, page: 1}, {id: "stadiums", q: "", country: "", q_key: "", country_key: "", state: "browsing", offset: 0, next_offset: 40, page: 1}, {id: "referees", q: "", country: "", q_key: "", country_key: "", state: "browsing", offset: 0, next_offset: 40, page: 1}]
		}
		// The catalogue's search, held by the tab: what a reader typed survives a
		// trip to a championship and back, and belongs to nobody else.
		CatalogFilter: {
			id: "0xe858e7ade293bca2"
			table:      "catalog_filter"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 16"},
				{ordinal: 2, name: "q", type: "string", default: "''", cel: "this.size() <= 80"},
				// A pattern over Championship.region: empty is every level.
				{ordinal: 3, name: "region", type: "string", default: "''", cel: "this in ['', 'world', 'continental', 'national']"},
				// The search machine's state (ir decision-catalog-tab).
				{ordinal: 4, name: "state", type: "string", default: "'browsing'", cel: "this in ['browsing']"},
				{ordinal: 5, name: "offset", type: "int32", default: "0", cel: "this >= 0"},
				{ordinal: 6, name: "next_offset", type: "int32", default: "40", cel: "this >= 40"},
				{ordinal: 7, name: "page", type: "int32", default: "1", cel: "this >= 1"},
				{ordinal: 8, name: "q_key", type: "string", default: "''", cel: "this.size() <= 160"},
			]
			seed: [{id: "catalog", q: "", q_key: "", region: "", state: "browsing", offset: 0, next_offset: 40, page: 1}]
		}
		ArchivePage: {
			id: "0x93cef5ac14f2a64a"
			table: "archive_page"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "owner_id", type: "uuid"},
				{ordinal: 3, name: "offset", type: "int32", default: "0", cel: "this >= 0"},
				{ordinal: 4, name: "next_offset", type: "int32", default: "40", cel: "this >= 40"},
				{ordinal: 5, name: "page", type: "int32", default: "1", cel: "this >= 1"},
				{ordinal: 6, name: "state", type: "string", default: "'browsing'", cel: "this in ['browsing']"},
			]
		}
	}

	// A reader is a silent guest: the archive is read without a sign-in, and
	// public rows are the signed-in role's to read (ir decision-guest-reading).
	capabilities: auth: {required: false, service: "/auth", promote: true}

	surface: design: (pronto.#DesignMd & {text: _designMd}).design


	state: pipelines: standings: {
		raw:   true
		from:  "Game"
		to:    "Standing"
		group: "golaberto-standings"
	}
	state: rawMigrations: [
		{name: "010_game_days.sql", src: "services/database/sql/010_game_days.sql"},
		{name: "011_comment_writes.sql", src: "services/database/sql/011_comment_writes.sql"},
		{name: "012_editor_writes.sql", src: "services/database/sql/012_editor_writes.sql"},
		{name: "013_home_games.sql", src: "services/database/sql/013_home_games.sql"},
		{name: "014_home_championships.sql", src: "services/database/sql/014_home_championships.sql"},
		{name: "015_home_performance.sql", src: "services/database/sql/015_home_performance.sql"},
		{name: "016_matches_performance.sql", src: "services/database/sql/016_matches_performance.sql"},
		{name: "017_game_countries.sql", src: "services/database/sql/017_game_countries.sql"},
		{name: "018_route_performance.sql", src: "services/database/sql/018_route_performance.sql"},
		{name: "019_normalized_game_flags.sql", src: "services/database/sql/019_normalized_game_flags.sql"},
		{name: "020_home_reference_order.sql", src: "services/database/sql/020_home_reference_order.sql"},
		{name: "021_home_highlights.sql", src: "services/database/sql/021_home_highlights.sql"},
		{name: "022_recent_championships.sql", src: "services/database/sql/022_recent_championships.sql"},
		{name: "023_search_collation.sql", src: "services/database/sql/023_search_collation.sql"},
		{name: "024_team_directory.sql", src: "services/database/sql/024_team_directory.sql"},
		{name: "025_search_letter_equivalences.sql", src: "services/database/sql/025_search_letter_equivalences.sql"},
		// Large archive fixtures are copied at build, never expanded through CUE.
		{name: "900_seed.sql", src: "services/database/sql/900_seed.sql"},
	]
	// Initdb serves fresh volumes; the ledger carries this same additive SQL
	// into existing volumes before readers and pipelines start. The guarded
	// columns also allow a fresh generated baseline to run the upgrade.
	state: migrations: "013_home_games": {operations: [{sql: {up: _homeGamesUpgrade, onComplete: true}}]}
	state: migrations: "014_home_championships": {operations: [{sql: {up: _homeChampionshipsUpgrade, onComplete: true}}]}
	state: migrations: "015_home_performance": {operations: [{sql: {up: _homePerformanceUpgrade, onComplete: true}}]}
	state: migrations: "016_matches_performance": {operations: [{sql: {up: _matchesPerformanceUpgrade, onComplete: true}}]}
	state: migrations: "017_game_countries": {operations: [{sql: {up: _gameCountriesUpgrade, onComplete: true}}]}
	state: migrations: "018_route_performance": {operations: [{sql: {up: _routePerformanceUpgrade, onComplete: true}}]}
	state: migrations: "019_normalized_game_flags": {operations: [{sql: {up: _normalizedGameFlagsUpgrade, onComplete: true}}]}
	state: migrations: "020_home_reference_order": {operations: [{sql: {up: _homeReferenceUpgrade, onComplete: true}}]}
	state: migrations: "021_home_highlights": {operations: [{sql: {up: _homeHighlightsUpgrade, onComplete: true}}]}
	state: migrations: "022_recent_championships": {operations: [{sql: {up: _recentChampionshipsUpgrade, onComplete: true}}]}
	state: migrations: "023_search_collation": {operations: [{sql: {up: _searchCollationUpgrade, onComplete: true}}]}
	state: migrations: "024_team_directory": {operations: [{sql: {up: _teamDirectoryUpgrade, onComplete: true}}]}
	state: pipelines: "team-directory": {raw: true, from: "Team", to: "TeamDirectory", group: "golaberto-team-directory"}
	state: migrations: "025_search_letter_equivalences": {operations: [{sql: {up: _extendedSearchCollationUpgrade, onComplete: true}}]}
	// The numeric stage (ir decision-chances).
	// The chances read each game's power from team_rating, so they rerun
	// whenever the ratings change.
	state: computations: ratings: {
		to: ["TeamRating", "PlayerRating", "RatingEval"]
		wasm: ["computations/golaberto-odds.wasm"]
		every: 300
	}
	state: computations: chances: {
		to: ["TeamChance", "ZoneChance", "PositionChance", "GameImportance"]
		wasm: ["computations/golaberto-odds.wasm"]
		every: 30
	}
	state: pipelines: "game-cards": {
		raw:   true
		from:  "Game"
		to:    "GameCard"
		group: "golaberto-game-cards"
	}
	state: pipelines: "home-games": {
		raw: true
		from: "Game"
		to: "HomeGameCard"
		group: "golaberto-home-games"
	}
	state: pipelines: "recent-championships": {
		raw: true
		from: "Championship"
		to: "HomeChampionship"
		group: "golaberto-recent-championships"
	}
	state: pipelines: "matches-games": {
		raw: true
		from: "Game"
		to: "MatchesGameCard"
		group: "golaberto-matches-games"
	}
	state: pipelines: "player-stats": {
		raw:   true
		from:  "PlayerGame"
		to:    "PlayerStat"
		group: "golaberto-player-stats"
	}
	state: pipelines: rounds: {
		raw:   true
		from:  "Game"
		to:    "PhaseRound"
		group: "golaberto-rounds"
	}

	surface: handlers: {
		"search-key": {ir: "handler-search-key", of: "campeonatos", src: "shell/handlers/search-key.js", note: "fold dotless i and thorn in bounded search predicates while preserving typed input"}
		"page-value": {ir: "handler-page-value", of: "campeonatos", src: "shell/handlers/page-value.js", note: "a forty-row page changes its offset, next-page probe and displayed page together; previous never passes page one"}
		"blank-null": {ir: "handler-blank-null", of: "editar", src: "shell/handlers/blank-null.js", note: "an unset optional choice clears the game's reference rather than pointing it at an empty string"}
		"count-or-null": {ir: "handler-count-or-null", of: "editar", src: "shell/handlers/count-or-null.js", note: "a typed score, minute or crowd as the integer the game stores; a cleared box is an unknown count"}
		"both-scored": {ir: "handler-both-scored", of: "editar", src: "shell/handlers/both-scored.js", note: "a game is played exactly when both sides have a score; a score typed decides it"}
		"row-id": {ir: "handler-row-id", of: "editar", src: "shell/handlers/row-id.js", note: "the guard that lets a click remove a goal only when it names one"}
	}
	surface: screens: {
		principal: {
			title:     "Principal"
			route:     "/"
			label:     "nav_home"
			prerender: true
			markup:    _principalMarkup
			forms: []
			states: ["loading", "populated", "no-games", "populated-dark"]
			paths: {
				arrive: {states: ["loading", "populated"], accepts: ["accept-home-levels", "accept-home-featured", "accept-home-games"]}
				quiet: {states: ["populated", "no-games", "populated"], accepts: ["accept-home-games"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js", "shell/renderers/home-date.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		campeonatos: {
			title:     "Campeonatos"
			route:     "/campeonatos"
			slug:      "route_championships"
			// Rebuilt on every visit: the search a reader comes back to is the
			// tab's row, not a held page (ir decision-catalog-tab).
			keep:      0
			label:     "nav_championships"
			prerender: true
			markup:    _campeonatosMarkup
			forms: []
			states: ["loading", "populated", "filtered", "no-match", "populated-dark"]
			paths: {
				browse: {states: ["loading", "populated"], accepts: ["accept-catalog"]}
				search: {states: ["populated", "filtered", "no-match", "populated"], accepts: ["accept-catalog-search"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/catalog.css"]
		}
		jogos: {
			title:  "Jogos"
			route:  "/jogos"
			slug:   "route_games"
			label:  "nav_games"
			markup: _jogosMarkup
			forms: []
			states: ["loading", "populated", "results", "populated-dark"]
			paths: {
				browse: {states: ["loading", "populated"], accepts: ["accept-games-upcoming"]}
				switch: {states: ["populated", "results", "populated"], accepts: ["accept-games-results"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		jogo: {
			title:  "Jogo"
			route:  "/jogo/:id"
			slug:   "route_game"
			strip:  false
			keep:   3
			markup: _jogoMarkup
			forms: []
			states: ["loading", "populated", "scheduled", "gone", "sending", "refused", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-game-page", "accept-game-venue"]}
				comment: {states: ["populated", "sending", "populated"], accepts: ["accept-comment"]}
				refused: {states: ["populated", "sending", "refused"], accepts: ["accept-comment-refused"]}
				sign_in: {states: ["populated", "populated"], accepts: ["accept-sign-in"]}
				ahead: {states: ["loading", "scheduled"], accepts: ["accept-game-page"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-game-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		chances: {
			title:  "Chances"
			route:  "/chances/:id"
			slug:   "route_chances"
			strip:  false
			keep:   3
			markup: _chancesMarkup
			forms: []
			states: ["loading", "populated", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-chances"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-chances"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		editar: {
			title:  "Editar jogo"
			route:  "/editar/:id"
			slug:   "route_edit"
			strip:  false
			keep:   0
			markup: _editarMarkup
			forms: []
			states: ["loading", "populated", "saving", "refused", "gone", "populated-dark"]
			paths: {
				edit: {states: ["loading", "populated", "saving", "populated"], accepts: ["accept-edit-game"]}
				refused: {states: ["populated", "saving", "refused"], accepts: ["accept-edit-refused"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-game-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		equipes: {
			title:     "Equipes"
			route:     "/equipes"
			slug:      "route_teams"
			// Rebuilt on every visit, as the catalogue is (ir
			// decision-catalog-tab).
			keep:      0
			label:     "nav_teams"
			prerender: true
			markup:    _equipesMarkup
			forms: []
			states: ["loading", "populated", "filtered", "no-match", "populated-dark"]
			paths: {
				browse: {states: ["loading", "populated"], accepts: ["accept-teams"]}
				search: {states: ["populated", "filtered", "no-match", "populated"], accepts: ["accept-teams"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/catalog.css"]
		}
		estadios: {
			title:     "Estádios"
			route:     "/estadios"
			slug:      "route_stadiums"
			keep:      0
			label:     "nav_stadiums"
			prerender: true
			markup:    _estadiosMarkup
			forms: []
			states: ["loading", "populated", "filtered", "no-match", "populated-dark"]
			paths: {
				browse: {states: ["loading", "populated"], accepts: ["accept-venues"]}
				search: {states: ["populated", "filtered", "no-match", "populated"], accepts: ["accept-venues"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/catalog.css"]
		}
		estadio: {
			title:  "Estádio"
			route:  "/estadio/:id"
			slug:   "route_stadium"
			strip:  false
			keep:   3
			markup: _estadioMarkup
			forms: []
			states: ["loading", "populated", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-stadium-page"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-venue-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		arbitros: {
			title:     "Árbitros"
			route:     "/arbitros"
			slug:      "route_referees"
			keep:      0
			label:     "nav_referees"
			prerender: true
			markup:    _arbitrosMarkup
			forms: []
			states: ["loading", "populated", "filtered", "no-match", "populated-dark"]
			paths: {
				browse: {states: ["loading", "populated"], accepts: ["accept-venues"]}
				search: {states: ["populated", "filtered", "no-match", "populated"], accepts: ["accept-venues"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/catalog.css"]
		}
		arbitro: {
			title:  "Árbitro"
			route:  "/arbitro/:id"
			slug:   "route_referee"
			strip:  false
			keep:   3
			markup: _arbitroMarkup
			forms: []
			states: ["loading", "populated", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-referee-page"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-venue-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		equipe: {
			title:  "Equipe"
			route:  "/equipe/:id"
			slug:   "route_team"
			strip:  false
			keep:   3
			markup: _equipeMarkup
			forms: []
			states: ["loading", "populated", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-team-page", "accept-player-stats"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-team-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		jogador: {
			title:  "Jogador"
			route:  "/jogador/:id"
			slug:   "route_player"
			strip:  false
			keep:   3
			markup: _jogadorMarkup
			forms: []
			states: ["loading", "populated", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-player-page", "accept-player-stats", "accept-player-stats-live"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-team-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
		campeonato: {
			title:  "Campeonato"
			route:  "/campeonato/:id"
			slug:   "route_championship"
			strip:  false
			keep:   3
			markup: _campeonatoMarkup
			forms: []
			states: ["loading", "populated", "no-groups", "gone", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-championship-page", "accept-standings", "accept-rounds"]}
				early: {states: ["loading", "no-groups"], accepts: ["accept-championship-page"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-championship-gone"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/team-badge.js", "shell/renderers/country-flag.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css"]
		}
	}


	meta: {
		name:        "golaberto"
		description: "O banco de dados aberto do futebol — campeonatos, tabelas, jogos, gols e elencos, mantido pelos seus leitores."
		i18n: {
			default: "pt-BR"
			// Football's traditions before the rest: Brazil's own, then the
			// River Plate's (Argentina, the nearest rival and the Spanish most
			// of South America reads), then England's, where the game was
			// codified. A bare "es" negotiates to the first Spanish tag.
			locales: {
				"pt-BR": path: "pt-br"
				"es-AR": path: "es"
				"en-GB": path: "en"
				// Then the other great football cultures of Europe.
				"it-IT": path: "it"
				"de-DE": path: "de"
				"fr-FR": path: "fr"
			}
			catalogues: _catalogues
		}
		ir: sha256: "8ad36f4a9976021d022e007389dad63b2db3e708efe0bc28935774a96635e763"
		targets: []
		decisions: {
			"decision-favicon": {}
			"decision-bounded-route-reads": {}
			"decision-archive-images": {}
			"decision-uuid-keys": {}
			"decision-points": {}
			"decision-generated-names": {}
			"decision-zones": {}
			"decision-derived-joins": {}
			"decision-score-whole": {}
			"decision-game-day": {}
			"decision-sides": {}
			"decision-increments": {}
			"decision-design-identity": {}
			"decision-masthead": {}
			"decision-screen-range": {}
			"decision-languages": {}
			"decision-machines": {}
			"decision-catalog-tab": {}
			"decision-phases-stacked": {}
			"decision-seed-archive": {}
			"decision-standings-derived": {}
			"decision-standings-boot": {}
			"decision-head-to-head": {}
			"decision-brasilia-time": {}
			"decision-phase-round": {}
			"decision-local-reads": {}
			"decision-player-stats": {}
			"decision-bench": {}
			"decision-comments": {}
			"decision-editing": {}
			"decision-chances": {}
			"decision-home": {}
			"decision-ratings": {}
			"decision-game-lists": {}
			"decision-guest-reading": {}
			"decision-hatches": {}
		}
		tests: {
			"test-score-whole": {
				of:    "Game"
				says:  "a half-typed score is refused"
				given: {played: true, home_score: 2}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-played-game": {
				of:    "Game"
				says:  "a played game with both scores is kept as given"
				given: {played: true, home_score: 2, away_score: 1}
				when:  "create"
				then:  "output.home_score == 2 && output.away_score == 1"
			}
			"test-no-self-game": {
				of:    "Game"
				says:  "a team never plays itself"
				given: {home_id: "aaaaaaaa-0000-4000-8000-000000000001", away_id: "aaaaaaaa-0000-4000-8000-000000000001"}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-points-default": {
				of:    "Championship"
				says:  "a championship that states no points takes three, one and none"
				given: {name: "Campeonato Brasileiro", region_name: "Brasil", begins: "2026-01-28", ends: "2026-12-02"}
				when:  "create"
				then:  "output.point_win == 3 && output.point_draw == 1 && output.point_loss == 0"
			}
			"test-season-single": {
				of:    "Championship"
				says:  "a season inside one year reads as that year"
				given: {begins: "2026-01-28", ends: "2026-12-02"}
				when:  "create"
				then:  "output.season == \"2026\""
			}
			"test-season-span": {
				of:    "Championship"
				says:  "a season across two years reads as both"
				given: {begins: "2026-08-21", ends: "2027-05-30", region_name: "Inglaterra", name: "Premier League"}
				when:  "create"
				then:  "output.season == \"2026/2027\" && output.full_name == \"Inglaterra - Premier League 2026/2027\""
			}
			"test-half-score-unplayed": {
				of:    "Game"
				says:  "a score with one side is refused even on an unplayed game"
				given: {played: false, home_score: 2}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-unplayed-scored": {
				of:    "Game"
				says:  "an unplayed game carries no score"
				given: {played: false, home_score: 2, away_score: 1}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-unplayed-game": {
				of:    "Game"
				says:  "a game not yet played is kept with no score"
				given: {}
				when:  "create"
				then:  "output.played == false"
			}
			"test-aet-half": {
				of:    "Game"
				says:  "an extra-time score with one side is refused"
				given: {played: true, home_score: 1, away_score: 1, home_aet: 2}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-pen-half": {
				of:    "Game"
				says:  "a shoot-out with one side is refused"
				given: {played: true, home_score: 1, away_score: 1, home_pen: 4}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-aet-unplayed": {
				of:    "Game"
				says:  "extra time on an unplayed game is refused"
				given: {played: false, home_aet: 2, away_aet: 1}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-pen-unplayed": {
				of:    "Game"
				says:  "a shoot-out on an unplayed game is refused"
				given: {played: false, home_pen: 4, away_pen: 3}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-aet-pen-kept": {
				of:    "Game"
				says:  "a game decided after extra time and penalties keeps all three scores"
				given: {played: true, home_score: 1, away_score: 1, home_aet: 2, away_aet: 2, home_pen: 4, away_pen: 3}
				when:  "create"
				then:  "output.home_pen == 4"
			}
			"test-season-order": {
				of:    "Championship"
				says:  "a season that ends before it begins is refused"
				given: {begins: "2026-12-02", ends: "2026-01-28"}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-season-one-day": {
				of:    "Championship"
				says:  "a one-day tournament is a season"
				given: {begins: "2026-07-19", ends: "2026-07-19"}
				when:  "create"
				then:  "output.season == \"2026\""
			}
			"test-points-own": {
				of:    "Championship"
				says:  "a championship keeps the points it states"
				given: {point_win: 2}
				when:  "create"
				then:  "output.point_win == 2 && output.point_draw == 1"
			}
			"test-points-range": {
				of:    "Championship"
				says:  "points outside a single digit are refused"
				given: {point_win: 10}
				when:  "create"
				then:  "error.field == \"point_win\""
			}
			"test-position-kept": {
				of:    "Player"
				says:  "each of the eight positions, and none, is kept"
				given: {position: "am"}
				when:  "create"
				then:  "output.position == input.position"
			}
			"test-zone-order": {
				of:    "Zone"
				says:  "a zone whose last place is above its first is refused"
				given: {first: 17, last: 4}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-goal-kind": {
				of:    "Goal"
				says:  "a goal is not both a penalty and an own goal"
				given: {penalty: true, own_goal: true}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-sort-upstream": {
				of:    "Phase"
				says:  "upstream's own ladder is kept"
				given: {sort: "pt,w,gd,gf,gp,g_away,name"}
				when:  "create"
				then:  "output.sort == input.sort"
			}
			"test-sort-default": {
				of:    "Phase"
				says:  "a phase that states no ladder takes upstream's"
				given: {name: "Mata-mata"}
				when:  "create"
				then:  "output.sort == \"pt,w,gd,gf,gp,g_away,name\""
			}
			"test-sort-unknown": {
				of:    "Phase"
				says:  "a key outside the vocabulary is refused"
				given: {sort: "pt,xx"}
				when:  "create"
				then:  "error.field == \"sort\""
			}
			"test-side": {
				of:    "Goal"
				says:  "a goal counts for home or away and nothing else"
				given: {side: "visitor"}
				when:  "create"
				then:  "error.field == \"side\""
			}
			"test-home-featured": {
				of:    "principal"
				says:  "the front page retains the featured 2026 Brasileirão: its top six, Flamengo first, below the game feeds"
				given: {featured: "Campeonato Brasileiro 2026"}
				when:  "open"
				then:  "output.top[0].team == \"Flamengo-RJ\" && output.top.size() == 6"
			}
			"test-home-games": {
				of: "principal"
				says: "upcoming fixtures and recent results lead the home page in server rank order under shared dates with localized weekdays and phase headings, emphasize the selected important games and open their details"
				given: {upcoming: true, recent: true}
				when: "arrive"
				then: "output.upcoming.size() > 0 && output.recent.size() > 0"
			}
			"test-home-levels": {
				of:    "principal"
				says:  "the front page lists national, continental, then world championships, with all eligible tournaments ordered by descending geometric team strength within each region"
				given: {}
				when:  "view"
				then:  "output.matches_projection == true"
			}
			"test-catalog-category": {
				of:    "campeonatos"
				says:  "the catalogue lists every championship with its category, professional by default"
				given: {}
				when:  "view"
				then:  "output.rows.size() == 13 && output.category[\"Brasil - Campeonato Brasileiro 2026\"] == \"Profissional\""
			}
			"test-catalog-search": {
				of:    "campeonatos"
				says:  "part of a name narrows the catalogue"
				given: {q: "libertadores"}
				when:  "type"
				then:  "output.rows == [\"América do Sul - Copa Libertadores 2026\"]"
			}
			"test-catalog-no-match": {
				of:    "campeonatos"
				says:  "a search that matches nothing says so"
				given: {q: "xyzzy"}
				when:  "type"
				then:  "output.empty == \"Nenhum campeonato com esse nome nesta esfera.\""
			}
			"test-catalog-kept": {
				of:    "campeonatos"
				says:  "what was typed survives a trip to a championship and back"
				given: {q: "brasileiro"}
				when:  "return"
				then:  "output.q == \"brasileiro\""
			}
			"test-championship-structure": {
				of:    "campeonato"
				says:  "a championship shows its phases, groups, teams, zones and points"
				given: {}
				when:  "view"
				then:  "output.phases == [\"Turno e Returno\"] && output.members.size() == 20 && output.points == [3, 1, 0]"
			}
			"test-championship-old-points": {
				of:    "campeonato"
				says:  "a championship from the two-point era states its own points"
				given: {}
				when:  "view"
				then:  "output.points == [2, 1, 0]"
			}
			"test-championship-no-groups": {
				of:    "campeonato"
				says:  "a phase with no groups says so"
				given: {}
				when:  "view"
				then:  "output.phases.size() == 2"
			}
			"test-championship-gone": {
				of:    "campeonato"
				says:  "an address naming no championship says so"
				given: {id: "00000000-0000-4000-8000-000000000000"}
				when:  "view"
				then:  "output.empty == \"Este campeonato não existe ou foi removido.\""
			}
			"test-languages": {
				of:    "campeonatos"
				says:  "every page reads in three languages at its own address"
				given: {}
				when:  "view"
				then:  "output.title[\"en-GB\"] == \"Championships\""
			}
			"test-dark": {
				of:    "principal"
				says:  "the dark appearance resolves the dark tokens"
				given: {}
				when:  "view"
				then:  "output.column == \"rgb(35, 38, 15)\""
			}
			"test-screen-range": {
				of:    "principal"
				says:  "no page scrolls sideways from phone to desktop"
				given: {width: 390}
				when:  "view"
				then:  "output.scrollWidth <= output.clientWidth"
			}
			"test-standings-archive": {
				of:    "standings"
				says:  "the crawled 2026 Serie A recounts to the table golaberto.com.br shows"
				given: {games: 277}
				when:  "recount"
				then:  "output.size() == 20"
			}
			"test-standings-zones": {
				of:    "standings"
				says:  "a position takes the narrowest zone it falls in"
				given: {position: 1}
				when:  "recount"
				then:  "output[0].zone == \"champion\""
			}
			"test-standings-page": {
				of:    "campeonato"
				says:  "the championship page shows the recounted table"
				given: {}
				when:  "view"
				then:  "output.rows.size() == 20"
			}
			"test-standings-live": {
				of:    "standings"
				says:  "a result recorded after the fact moves the table with no reload"
				given: {home_score: 1, away_score: 0}
				when:  "update"
				then:  "output.points == input.points + 2"
			}
			"test-games-upcoming": {
				of:    "jogos"
				says:  "the games page opens on the upcoming games, soonest first"
				given: {}
				when:  "view"
				then:  "output.rows.size() > 0"
			}
			"test-games-results": {
				of:    "jogos"
				says:  "the results tab lists played games and is remembered"
				given: {}
				when:  "view"
				then:  "output.view == \"results\""
			}
			"test-game-page": {
				of:    "jogo"
				says:  "a game's page shows its score, facts, goals and line-ups"
				given: {}
				when:  "view"
				then:  "output.score == \"2x1\""
			}
			"test-game-gone": {
				of:    "jogo"
				says:  "an address naming no game says so"
				given: {}
				when:  "view"
				then:  "output.empty == \"Este jogo n\u00e3o existe ou foi removido.\""
			}
			"test-rounds": {
				of:    "campeonato"
				says:  "the championship page shows the current round and the next"
				given: {}
				when:  "view"
				then:  "output.rounds.size() == 2"
			}
			"test-bench-whole": {
				of:    "PlayerGame"
				says:  "a substitute never brought on has no minute off"
				given: {bench: true, on_minute: 0, off_minute: 90}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-bench-on": {
				of:    "PlayerGame"
				says:  "a substitute never brought on came on at nothing"
				given: {bench: true, on_minute: 10}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-appearance-live": {
				of:    "player-stats"
				says:  "an appearance removed after the fact moves the player's season with no reload"
				given: {played: 26}
				when:  "delete"
				then:  "output.played == input.played - 1"
			}
			"test-player-stats-archive": {
				of:    "player-stats"
				says:  "the crawled 2026 Serie A's players recount to the lines golaberto.com.br shows"
				given: {players: 885}
				when:  "recount"
				then:  "output.size() == 885"
			}
			"test-player-stats-live": {
				of:    "player-stats"
				says:  "a goal recorded after the fact moves the scorer's season with no reload"
				given: {minute: 90}
				when:  "create"
				then:  "output.goals == input.goals + 1"
			}
			"test-game-cards": {
				of:    "game-cards"
				says:  "every game's card carries its names, and each team's line its own result"
				given: {home_score: 2, away_score: 1}
				when:  "recount"
				then:  "output.lines.map(l, l.result) == [\"w\", \"l\"]"
			}
			"test-teams": {
				of:    "equipes"
				says:  "part of a name narrows the teams"
				given: {q: "athletico"}
				when:  "type"
				then:  "output.rows == [\"Athletico-PR\"]"
			}
			"test-team-page": {
				of:    "equipe"
				says:  "a team's page shows its facts, its games and its squad's seasons"
				given: {}
				when:  "view"
				then:  "output.squad.size() > 11"
			}
			"test-player-page": {
				of:    "jogador"
				says:  "a player's page shows their season and their games"
				given: {}
				when:  "view"
				then:  "output.goals == 18"
			}
			"test-team-gone": {
				of:    "equipe"
				says:  "an address naming no team says so"
				given: {id: "00000000-0000-4000-8000-000000000000"}
				when:  "view"
				then:  "output.empty == \"Esta equipe não existe ou foi removida.\""
			}
			"test-player-gone": {
				of:    "jogador"
				says:  "an address naming no player says so"
				given: {id: "00000000-0000-4000-8000-000000000000"}
				when:  "view"
				then:  "output.empty == \"Este jogador não existe ou foi removido.\""
			}
			"test-comment": {
				of:    "jogo"
				says:  "a signed-in reader's comment appears for every reader of the game"
				given: {body: "Que virada!"}
				when:  "post"
				then:  "output.comments[0].body == input.body"
			}
			"test-comment-refused": {
				of:    "jogo"
				says:  "a guest's comment is refused and what was typed is kept"
				given: {body: "Golaço!"}
				when:  "post"
				then:  "output.state == \"refused\" && output.body == input.body"
			}
			"test-edit-link": {
				of:    "jogo"
				says:  "an editor is offered the editor on a game's page, and a reader who is not is offered nothing"
				given: {editor: true}
				when:  "open"
				then:  "output.edit_link == input.editor"
			}
			"test-edit-game": {
				of:    "editar"
				says:  "an editor's correction of the score and the crowd reaches the game's page"
				given: {home_score: 3, attendance: 38000}
				when:  "save"
				then:  "output.home_score == input.home_score && output.attendance == input.attendance"
			}
			"test-edit-goal": {
				of:    "editar"
				says:  "a goal an editor adds and then removes moves the game's goals and the scorer's season each time"
				given: {goals: 2}
				when:  "add, remove"
				then:  "output.goals_after_add == input.goals + 1 && output.season_after_add == input.season + 1 && output.goals_after_remove == input.goals && output.season_after_remove == input.season"
			}
			"test-edit-refused": {
				of:    "editar"
				says:  "a non-editor's save and a goal with no scorer are refused with the reason, and the edits stay"
				given: {home_score: 7, goal_minute: 77}
				when:  "save, add goal"
				then:  "output.state == \"refused\" && output.refusal == input.reason && output.home_score == input.home_score && output.goal_minute == input.goal_minute"
			}
			"test-chances": {
				of:    "chances"
				says:  "the 2026 Série A's chances lead with Flamengo, near golaberto's own figure, and each team's positions sum to whole seasons"
				given: {group: "2026 Série A, Grupo Único"}
				when:  "open"
				then:  "output.leader == \"Flamengo-RJ\" && output.title >= 60.0 && output.title <= 90.0 && output.positions_sum >= 99.0 && output.positions_sum <= 101.0"
			}
			"test-chances-live": {
				of:    "chances"
				says:  "a result recorded for a game still to play moves the chances on a page left open, and undoing it brings them back"
				given: {before: "the leader's title chance"}
				when:  "record a result, then undo it"
				then:  "output.after != input.before && output.restored == input.before"
			}
			"test-chances-reach": {
				of:    "chances"
				says:  "in the 2026 Série A every chance that shows 0 says whether it can still happen, marked * when it can and unmarked when the points rule it out"
				given: {group: "2026 Série A, Grupo Único"}
				when:  "open"
				then:  "output.zeros_unsaid == 0 && output.impossible_mark == \"\" && output.reachable_mark == \"*\""
			}
			"test-team-rating": {
				of:    "equipe"
				says:  "a team's page shows its latest rating, a number from 0 to 100"
				given: {team: "Flamengo-RJ"}
				when:  "open"
				then:  "output.rating >= 0.0 && output.rating <= 100.0"
			}
			"test-game-importance": {
				of:    "jogo"
				says:  "a game still to play shows how much its result matters to each side"
				given: {game: "Flamengo's next home game"}
				when:  "open"
				then:  "output.importance.size() == 2"
			}
			"test-comment-empty": {
				of:    "Comment"
				says:  "a comment of blanks is refused"
				given: {body: "   "}
				when:  "create"
				then:  "error.kind == \"constraint\""
			}
			"test-sign-in": {
				of:    "jogo"
				says:  "a guest is offered a passkey, which keeps the guest's identity"
				given: {}
				when:  "view"
				then:  "output.strip.contains(\"Entrar\")"
			}
			"test-venue-home": {
				of:    "estadio"
				says:  "a team's ground shows the team and the games played there, under one name"
				given: {}
				when:  "view"
				then:  "output.teams.exists(t, t == \"São Paulo-SP\") && output.games.size() > 0"
			}
			"test-venues": {
				of:    "estadios"
				says:  "part of a name narrows the stadiums and the referees"
				given: {q: "pacaembu"}
				when:  "type"
				then:  "output.rows == [\"Pacaembu\"]"
			}
			"test-stadium-page": {
				of:    "estadio"
				says:  "a stadium's page lists the games played there, newest first"
				given: {}
				when:  "view"
				then:  "output.games.size() > 0"
			}
			"test-referee-page": {
				of:    "arbitro"
				says:  "a referee's page lists the games they refereed, newest first"
				given: {}
				when:  "view"
				then:  "output.games.size() > 0"
			}
			"test-game-venue": {
				of:    "jogo"
				says:  "a game's page names its stadium and its referee, each leading to their page"
				given: {}
				when:  "view"
				then:  "output.facts == [\"Pacaembu\", \"Cléber Wellington Abade\"]"
			}
			"test-venue-gone": {
				of:    "estadio"
				says:  "an address naming no stadium, or no referee, says so"
				given: {id: "00000000-0000-4000-8000-000000000000"}
				when:  "view"
				then:  "output.empty == \"Este estádio não existe ou foi removido.\""
			}
			"test-position": {
				of:    "Player"
				says:  "a position outside the eight is refused"
				given: {name: "Vinícius", position: "lw"}
				when:  "create"
				then:  "error.field == \"position\""
			}
		}
	}
}

cluster: (pronto.#DefaultCluster & {"code": code, statics: list.Concat([
	terminal.surface.statics,
	[for kind in ["svg", "ico"] {
		file: "branding/favicon.\(kind)"
		target: "/srv/shell/favicon.\(kind)"
		watch: true
	}],
])}).out
// Keep the archive in PostgreSQL's mounted volume when launch recreates services.
cluster: meta: databaseDataDir: "/var/lib/postgresql/18/docker"
cluster: meta: databaseVolume: "golaberto-archive"
terminal: (pronto.#DefaultTerminal & {"code": code}).out
terminal: favicon: "/shell/favicon.ico"
loop:     (pronto.#DefaultLoop & {"code": code, "cluster": cluster, "terminal": terminal}).out
loop: surface: checks: "seed-data": {
	verb: "test"
	cmds: ["python3 -m unittest discover -s tools -p seed_sql_test.py"]
	note: "the SQL fixture is reproducible from crawled records and stays outside CUE compilation"
}
// The archive's constraints live in Postgres, so they are graded there.
loop: surface: checks: "constraints": {
	verb:     "integrate"
	priority: 1
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/constraints.ts"]
	note: "each test pair of the ir run as a rolled-back transaction in the cluster's Postgres"
}

// The standings transform over the crawled 2026 Série A, asserting the table
// golaberto.com.br shows (tools/standings_fixture.py writes the fixture).
loop: surface: checks: "standings": {
	verb: "test"
	cmds: ["mise exec -- redpanda-connect test pipelines/standings.yaml pipelines/rounds.yaml pipelines/game-cards.yaml pipelines/player-stats.yaml"]
	note: "the derived streams over crawled data: the 2026 Serie A's table and its 885 players' seasons as golaberto.com.br shows them, a phase's current and next rounds, and a game's card and team lines"
}

loop: surface: checks: "home-games": {
	verb: "integrate"
	priority: 1
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/home-games.ts tests/home-upgrade.ts"]
	note: "the home selection's quality, time windows, cap, stable ordering and refresh in rolled-back Postgres transactions"
}

loop: surface: checks: "matches-games": {
	verb: "integrate"
	priority: 1
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/matches-games.ts"]
	note: "the bounded chronological matches feeds: cap, parity, selected changes, no-op refresh and service-only writes"
}

loop: surface: checks: "archive-refresh": {
	verb: "integrate"
	priority: 1
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker,python3 tests/archive-refresh.ts"]
	note: "a public-data refresh preserves local details and unknown times, converts UTC dates, replays without writes and rejects unmapped seed databases"
}

// The screens' invariants, walked in a browser against the running archive.
loop: surface: checks: "acceptance": {
	verb:     "integrate"
	priority: 1
	cmds: ["let project = (^mise exec -- printenv COMPOSE_PROJECT_NAME | complete | get stdout | str trim); if $project !~ '(?i)(check|test)' or ($project | str downcase) == 'golaberto' { error make {msg: 'acceptance requires an explicit disposable check/test compose project'} }; mise exec -- docker compose -p $project up -d --no-deps --scale apps_golaberto-compute=1 apps_golaberto-compute; if $env.LAST_EXIT_CODE != 0 { exit $env.LAST_EXIT_CODE }; deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/acceptance.ts; let verdict = $env.LAST_EXIT_CODE; mise exec -- docker compose -p $project stop apps_golaberto-compute; if $env.LAST_EXIT_CODE != 0 { exit $env.LAST_EXIT_CODE }; exit $verdict"]
	note: "the ir's screen invariants against the running archive: levels, catalogue and search, a championship's structure, three languages, the dark twin and the screen range"
}

build:    (pronto.#DefaultBuild & {"code": code, "loop": loop, "cluster": cluster}).out
// Development reads stored ratings and odds; keep the worker dormant until
// offline batching rules replace its automatic computation loop.
build: project: targets: compute: compose: scale: 0

loop: surface: checks: "archive-images": {
  verb: "integrate"
  cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/archive-images.ts"]
  note: "read-only browser evidence on the running archive: real crest and flag loading, accessible names, responsive layout and team details"
}
loop: surface: checks: "image-renderers": {
  verb: "test"
  cmds: ["mise exec -- deno test --config tests/deno.json --no-lock tests/image-renderers.ts"]
  note: "imported hexadecimal IDs, fixture mappings, country aliases and neutral badges"
}

out: pronto.#emit & {"code": code, "cluster": cluster, "terminal": terminal, "loop": loop, "build": build}

loop: surface: checks: "favicon": {
	verb: "integrate"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/favicon.ts"]
	note: "public icon packaging, localized entry documents and browser decoding; read-only against the running archive"
}

loop: surface: checks: "language-switch": {
	verb: "integrate"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/language-switch.ts"]
	note: "read-only browser regression: Portuguese overrides browser preferences through switches, navigation and reloads at phone and desktop widths"
}

loop: surface: checks: "accent-search": {
	verb: "integrate"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/accent-search.ts"]
	note: "search collation and every text search box match accented, plain, uppercase and decomposed names; bounded pages and picker selections survive filtering"
}

loop: surface: checks: "game-countries": {
  note: "championship flags and team countries propagate through game feeds; fixed badges align on desktop and mobile"
  verb: "integrate"
  cmds: [
    "mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/game-countries.ts",
    "mise exec -- deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/home-upgrade.ts",
  ]
}

loop: surface: checks: "route-queries": {verb: "integrate", priority: 1, cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/route-queries.ts"], note: "catalogs, histories and exact game reads use ordered indexes"}
loop: surface: checks: "route-loads": {verb: "integrate", priority: 1, cmds: ["deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/route-loads.ts"], note: "every route loads bounded subsets; pagination preserves access to the full archive"}

loop: surface: checks: "home-date-renderer": {
  verb: "test"
  cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-read --allow-env tests/home-date-renderer.ts"]
  note: "civil-date weekdays across week, leap-day and year boundaries, translated catalogues and the Jessie renderer cage"
}

loop: surface: checks: "recent-championships": {
	verb: "integrate"
	priority: 1
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-run=docker tests/recent-championships.ts"]
	note: "all recent tournaments, strict thirty-day boundaries, distinct membership, geometric strength, clock refresh and service-only writes"
}

loop: surface: checks: "team-directory": {
	verb: "integrate"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/team-directory.ts"]
	note: "latest-rating order, unrated/tied teams, combined accent-insensitive country/name filters, pagination, refresh and phone/desktop layout"
}
