package golaberto

import (
	"strings"
	"list"
)

_playerPositionOptions: strings.Join([for position in ["g", "dr", "dc", "dl", "dm", "cm", "am", "fw"] {
	"<option value=\"\(position)\" data-text=\"{msg.player_position_\(position)}\"></option>"
}], "")

_playerDirectoryFilter: "search_key=like.*{q_key}*&country_search_key=like.*{country_key}*&region_id=like.{region}&position_key=like.{position}"
_playerDirectoryOrder:  #"{"by":"{sort}","of":{"name":"name.asc,id.asc","rating":"rating.desc.nullslast,name.asc,id.asc"}}"#
#PlayerDirectoryRow:    R={
	latestTeam: bool
	_latestTeam: [if R.latestTeam {"<td><a data-route=\"equipe\" data-param-slug=\"{latest_team_slug}\"><span class=\"archive-icon\" data-text=\"{latest_team_id}|{latest_team_name}|{latest_team_logo_key}\" data-text-format=\"team-badge\"></span><span data-text=\"{latest_team_name}\"></span></a></td>"}, "<td></td>"][0]
	out: "<tr><td><a data-route=\"jogador\" data-param-slug=\"{slug}\" data-text=\"{name}\"></a></td><td data-text=\"{full_name}\"></td><td data-text=\"{position}|{msg.player_positions}\" data-text-format=\"player-position\"></td><td><span class=\"archive-icon\" data-text=\"{country}\" data-text-format=\"country-flag\"></span><span data-text=\"{country}|{msg.geography_names}\" data-text-format=\"geography-label\"></span></td>\(R._latestTeam)<td class=\"num\" data-text=\"{rating}\" data-text-format=\"number\"></td><td class=\"num wide\" data-text=\"{off_rating}\" data-text-format=\"number\"></td><td class=\"num wide\" data-text=\"{def_rating}\" data-text-format=\"number\"></td></tr>"
}
_playerDirectoryMarkup: """
	<section class="screen" data-screen="jogadores">
	\((#Masthead & {route: "jogadores"}).out)
	<h1 class="band" data-text="{msg.players_title}"></h1>
	<div class="page"><div class="content catalog">
	\((#PagedRead & {
	key:    "players-directory"
	owner:  "00000000-0000-0000-0000-000000000000"
	table:  "player_directory"
	filter: _playerDirectoryFilter
	order:  _playerDirectoryOrder
	context: {q: "", q_key: "", country: "", country_key: "", region: "*", position: "*", sort: "rating"}
	events: {
		"input@players-directory-q": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}
		"input@players-directory-country": assign: {country: {type: "event", params: field: "value"}, country_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}
		for field in ["position", "region", "sort"] {
			("change@players-directory-\(field)"): assign: {(field): {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
		}
	}
	controls: """
		<div class="team-filters" role="search">
		  <label><span data-text="{msg.search_label}"></span><input id="players-directory-q" type="search" value="{q}" placeholder="{msg.players_placeholder}" maxlength="80"></label>
		  <label><span data-text="{msg.player_position}"></span><select id="players-directory-position" data-value="{position}"><option value="*" data-text="{msg.all}"></option>\(_playerPositionOptions)</select></label>
		  <label><span data-text="{msg.geography_country}"></span><input id="players-directory-country" type="search" value="{country}" placeholder="{msg.geography_search_country}" maxlength="60"></label>
		  <label><span data-text="{msg.geography_region}"></span><select id="players-directory-region" data-value="{region}"><option value="*" data-text="{msg.geography_world}"></option><optgroup data-live="geography_region" data-filter="limit=6" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{msg[message_key]}"></option></template></optgroup></select></label>
		  <label><span data-text="{msg.team_sort}"></span><select id="players-directory-sort" data-value="{sort}"><option value="rating" data-text="{msg.player_rating}"></option><option value="name" data-text="{msg.col_player}"></option></select></label>
		</div>
		"""
	content:  """
		<div class="table-wrap"><table class="grid catalog-table">
		  <thead><tr><th scope="col" data-text="{msg.col_player}"></th><th scope="col" data-text="{msg.player_full_name}"></th><th scope="col" data-text="{msg.player_position}"></th><th scope="col" data-text="{msg.col_country}"></th><th scope="col" data-text="{msg.player_latest_club}"></th><th scope="col" class="num" data-text="{msg.player_rating}"></th><th scope="col" class="num wide" data-text="{msg.col_off_rating}"></th><th scope="col" class="num wide" data-text="{msg.col_def_rating}"></th></tr></thead>
		  <tbody data-live="player_directory" data-filter="\(_playerDirectoryFilter)&offset={offset}&limit=40" data-order='\(_playerDirectoryOrder)' data-empty="{msg.players_empty}">
		    <template data-item data-when="latest_team_id=not.is.null">\((#PlayerDirectoryRow & {latestTeam: true}).out)</template>
		    <template data-item data-when="latest_team_id=is.null">\((#PlayerDirectoryRow & {latestTeam: false}).out)</template>
		  </tbody>
		</table></div>
		"""
}).out)
	</div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
	</section>
	"""

_playerSeasonOrder: #"{"by":"{sort}","of":{"name":"player_name.asc,team_name.asc,id.asc","played":"played.desc.nullslast,player_name.asc,id.asc","minutes":"minutes.desc.nullslast,player_name.asc,id.asc","goals":"goals.desc.nullslast,player_name.asc,id.asc","goals_per90":"goals_per90.desc.nullslast,player_name.asc,id.asc","contribution":"contribution.desc.nullslast,player_name.asc,id.asc","contribution_per90":"contribution_per90.desc.nullslast,player_name.asc,id.asc"}}"#
_playerSeasonStatColumns: [for column in _teamRosterColumns if column.bind != "player_name" {column}]
_playerSeasonStatHead: strings.Join([for column in _playerSeasonStatColumns {
	"<th scope=\"col\" class=\"\(column.cls)\"><abbr title=\"{msg.col_\(column.key)_long}\" data-text=\"{msg.col_\(column.key)}\"></abbr></th>"
}], "")
_playerSeasonStatCells: strings.Join([for column in _playerSeasonStatColumns {
	[
		if column.bind == "position" {"<td class=\"\(column.cls)\" data-text=\"{position}|{msg.player_positions}\" data-text-format=\"player-position\"></td>"},
		"<td class=\"\(column.cls)\" data-text=\"{\(column.bind)}\" data-text-format=\"number\"></td>",
	][0]
}], "")

#PlayerSeasonTable: T={
	filter: string
	order:  string
	career: *false | bool
	total:  *"" | string
	out:    """
	<div class="table-wrap"><table class="grid squad-table season-table">
	  <thead><tr>\([if T.career {"<th scope=\"col\" data-text=\"{msg.player_season}\"></th><th scope=\"col\" data-text=\"{msg.col_championship}\"></th>"}, "<th scope=\"col\" data-text=\"{msg.col_player}\"></th>"][0])<th scope="col" data-text="{msg.col_team}"></th>\(_playerSeasonStatHead)</tr></thead>
	  <tbody data-live="player_stat" data-select="*,player(full_name,slug),team(slug,logo_key),championship(slug,season,category_id,begins)" data-filter="\(T.filter)&offset={offset}&limit=40" data-order='\(T.order)' data-empty="{msg.player_no_seasons}" data-on-mutation="player-csv-fold" data-read-view="archive_page?id=eq.{id}"><template data-item><tr>
	    \([if T.career {"<td data-text=\"{championship.season}\"></td><td><a data-route=\"jogador-campeonato\" data-param-slug=\"{player.slug}\" data-param-team=\"{team.slug}\" data-param-championship=\"{championship.slug}\"><span class=\"archive-icon\" data-text=\"{championship_name}\" data-text-format=\"country-flag\"></span><span data-text=\"{championship_name}|{msg.geography_names}\" data-text-format=\"geography-label\"></span></a></td>"}, "<td><a data-route=\"jogador-campeonato\" data-param-slug=\"{player.slug}\" data-param-team=\"{team.slug}\" data-param-championship=\"{championship.slug}\" data-text=\"{player_name}\"></a></td>"][0])
	    <td><a data-route="equipe-campeonato" data-param-slug="{team.slug}" data-param-championship="{championship.slug}"><span class="archive-icon" data-text="{team_id}|{team_name}|{team.logo_key}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></td>\(_playerSeasonStatCells)
	  </tr></template></tbody>\(T.total)
	</table></div>
	"""
}

#PlayerSeasonControls: C={
	key: string
	out: """
	<div class="team-filters">
	  <label><span data-text="{msg.team_player_search}"></span><input id="\(C.key)-q" type="search" value="{q}" maxlength="80"></label>
	  <label><span data-text="{msg.player_minimum_minutes}"></span><input id="\(C.key)-minimum-minutes" type="number" min="0" max="1000000" step="1" value="{minimum_minutes}"></label>
	  <label><span data-text="{msg.team_sort}"></span><select id="\(C.key)-sort" data-value="{sort}"><option value="name" data-text="{msg.col_player}"></option><option value="played" data-text="{msg.col_played_long}"></option><option value="minutes" data-text="{msg.col_minutes_long}"></option><option value="goals" data-text="{msg.col_goals_long}"></option><option value="goals_per90" data-text="{msg.col_goals_per90_long}"></option><option value="contribution" data-text="{msg.col_contribution_long}"></option><option value="contribution_per90" data-text="{msg.col_contribution_per90_long}"></option></select></label>
	</div>
	<p><span data-text="{csv_rows}\u001f{msg.player_csv_columns}\u001f{msg.player_csv_export}\u001f{msg.player_csv_filename}" data-text-format="player-csv"></span></p>
	"""
}
#PlayerSeasonEvents: E={
	key: string
	out: {
		("input@\(E.key)-q"): assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}
		("change@\(E.key)-sort"): assign: {sort: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
		("change@\(E.key)-minimum-minutes"): assign: {minimum_minutes: {type: "parity-minutes"}, offset: 0, next_offset: 40, page: 1}
	}
}

_playerTotalSelect: strings.Join([for column in _playerSeasonStatColumns if !list.Contains(["position", "goals_per90", "contribution_per90"], column.bind) {
	"\(column.bind):\(column.bind).sum()"
}], ",")
_playerTotalCells: strings.Join([for column in _playerSeasonStatColumns {
	[
		if column.bind == "position" {"<td class=\"\(column.cls)\"></td>"},
		if column.bind == "goals_per90" {"<td class=\"\(column.cls)\" data-text=\"{goals}|{minutes}|{msg.chart_locale}\" data-text-format=\"player-rate-per90\"></td>"},
		if column.bind == "contribution_per90" {"<td class=\"\(column.cls)\" data-text=\"{contribution}|{minutes}|{msg.chart_locale}\" data-text-format=\"player-rate-per90\"></td>"},
		"<td class=\"\(column.cls)\" data-text=\"{\(column.bind)}\" data-text-format=\"number\"></td>",
	][0]
}], "")
_playerCareerTotalMarkup:        """
    <tfoot data-live="player_stat" data-select="\(_playerTotalSelect)" data-filter="\(_playerCareerFilter)&limit=1" data-empty=""><tr><th scope="row" colspan="3" data-text="{msg.player_total}"></th>\(_playerTotalCells)</tr></tfoot>
    """
_championshipPlayersTotalMarkup: """
    <tfoot data-live="player_stat" data-select="\(_playerTotalSelect)" data-filter="\(_championshipPlayersFilter)&limit=1" data-empty=""><tr><th scope="row" colspan="2" data-text="{msg.player_total}"></th>\(_playerTotalCells)</tr></tfoot>
    """
_playerCareerFilter:             "player_id=eq.{owner_id}&search_key=like.*{q_key}*&minutes=gte.{minimum_minutes}"
_playerCareerMarkup: (#PagedRead & {
	key:    "player-career"
	table:  "player_stat"
	filter: _playerCareerFilter
	order:  _playerSeasonOrder
	seed:   true
	context: {q: "", q_key: "", minimum_minutes: 0, sort: "minutes", csv_rows: "[]"}
	events: (#PlayerSeasonEvents & {key: "player-career"}).out
	controls: (#PlayerSeasonControls & {key: "player-career"}).out
	content: (#PlayerSeasonTable & {filter: _playerCareerFilter, order: _playerSeasonOrder, career: true, total: _playerCareerTotalMarkup}).out
}).out

#PlayerAppearances: A={
	key:    string
	scoped: *false | bool
	_filter: "player_id=eq.{owner_id}&played_key=like.{played}&category_key=like.{category}" + [if A.scoped {"&team_id=eq.{team_id}&championship_id=eq.{championship_id}"}, ""][0]
	_order: #"{"by":"{played}","of":{"true":"day.desc.nullslast,kickoff.desc.nullslast,id.asc","false":"day.asc.nullslast,kickoff.asc.nullslast,id.asc","*":"day.desc.nullslast,kickoff.desc.nullslast,id.asc"}}"#
	out: (#PagedRead & {
		key: A.key
		owner: [if A.scoped {"{player_id}"}, "{id}"][0]
		scope: [if A.scoped {"-championship-{championship_id}-team-{team_id}"}, ""][0]
		table:  "player_appearance"
		filter: A._filter
		order:  A._order
		context: {category: "*", played: "true", if A.scoped {championship_id: "{championship_id}", team_id: "{team_id}"}}
		events: {for field in ["category", "played"] {
			("change@\(A.key)-\(field)"): assign: {(field): {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
		}}
		controls: """
		<div class="team-filters">
		  <label><span data-text="{msg.team_category}"></span><select id="\(A.key)-category" data-value="{category}"><option value="*" data-text="{msg.all}"></option><option value="professional" data-text="{msg.team_professional}"></option><optgroup data-live="category" data-filter="limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select></label>
		  <label><span data-text="{msg.player_match_status}"></span><select id="\(A.key)-played" data-value="{played}"><option value="true" data-text="{msg.player_matches_played}"></option><option value="false" data-text="{msg.player_matches_scheduled}"></option><option value="*" data-text="{msg.all}"></option></select></label>
		</div>
		"""
		content:  """
		<ol class="games player-games" data-live="player_appearance" data-filter="\(A._filter)&offset={offset}&limit=40" data-order='\(A._order)' data-empty="{msg.player_no_games}"><template data-item>
		  <li data-bench="{bench}" data-yellow="{yellow}" data-red="{red}">
		    <a data-route="equipe-campeonato" data-param-slug="{team_slug}" data-param-championship="{championship_slug}"><span data-text="{team_name}"></span> · <span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span></a>
		    <a class="game-row" data-route="jogo" data-param-slug="{game_slug}" data-show-country="{show_country}" data-played="{played}">
		      <span class="when"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span><span class="where" data-text="{phase_name}"></span>
		      <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{show_country}|{home_country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}|{home_logo_key}" data-text-format="team-badge"></span></span></span>
		      \(_matchScoreMarkup)
		      <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}|{away_logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{show_country}|{away_country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
		    </a>
		    <div class="player-appearance-detail">
		      <span class="minutes"><span data-text="{msg.player_on}"></span> <span data-text="{on_minute}" data-text-format="number"></span> · <span data-text="{msg.player_off}"></span> <span data-text="{off_minute}" data-text-format="number"></span> · <span data-text="{minutes}" data-text-format="number"></span> <span data-text="{msg.col_minutes_long}"></span></span>
		      <span class="cards"><i class="yellow" title="{msg.card_yellow}"></i><i class="red" title="{msg.card_red}"></i></span>
		      <span class="player-bench" data-text="{msg.col_bench_long}"></span>
		      <dl class="game-facts"><dt data-text="{msg.col_goals_long}"></dt><dd data-text="{goals}" data-text-format="number"></dd><dt data-text="{msg.col_penalties_long}"></dt><dd data-text="{penalties}" data-text-format="number"></dd><dt data-text="{msg.col_own_goals_long}"></dt><dd data-text="{own_goals}" data-text-format="number"></dd><dt data-text="{msg.col_off_rating_long}"></dt><dd data-text="{off_rating}" data-text-format="number"></dd><dt data-text="{msg.col_def_rating_long}"></dt><dd data-text="{def_rating}" data-text-format="number"></dd><dt data-text="{msg.col_contribution_long}"></dt><dd data-text="{contribution}" data-text-format="number"></dd></dl>
		      <ul class="chips" data-live="goal" data-filter="player_id=eq.{player_id}&game_id=eq.{game_id}&limit=40" data-order="minute.asc,id.asc" data-empty=""><template data-item><li class="chip"><span data-text="{minute}" data-text-format="number"></span>′ <span data-text="{msg.col_goals_long}"></span><span data-text="{penalty}|{msg.col_penalties_long}" data-text-format="player-event-label"></span><span data-text="{own_goal}|{msg.col_own_goals_long}" data-text-format="player-event-label"></span></li></template></ul>
		    </div>
		  </li>
		</template></ol>
		"""
	}).out
}

#PlayerProfileArticle: P={
	latestTeam: bool
	_latestTeam: [if P.latestTeam {"<a data-route=\"equipe\" data-param-slug=\"{latest_team_slug}\" data-text=\"{latest_team_name}\"></a>"}, ""][0]
	out: """
	<article class="player"><h1 class="band" data-text="{name}"></h1><div class="page"><div class="content">
	  <h2 data-text="{msg.player_biography}"></h2>
	  <dl class="game-facts">
	    <dt data-text="{msg.player_full_name}"></dt><dd data-text="{full_name}"></dd>
	    <dt data-text="{msg.player_birth}"></dt><dd data-text="{birth}"></dd>
	    <dt data-text="{msg.player_height}"></dt><dd data-text="{height}|{msg.player_height_unit}" data-text-format="player-height"></dd>
	    <dt data-text="{msg.player_position}"></dt><dd data-text="{position}|{msg.player_positions}" data-text-format="player-position"></dd>
	    <dt data-text="{msg.team_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}|{msg.geography_names}" data-text-format="geography-label"></span></dd>
	    <dt data-text="{msg.player_rating}"></dt><dd><abbr title="{msg.player_rating_long}" data-text="{rating}" data-text-format="number"></abbr></dd>
	    <dt data-text="{msg.player_latest_club}"></dt><dd>\(P._latestTeam)</dd>
	  </dl>
	  <section class="seasons"><h2 data-text="{msg.player_seasons}"></h2>\(_playerCareerMarkup)<p data-text="{msg.team_contribution_note}"></p></section>
	  <section class="appearances"><h2 data-text="{msg.player_games}"></h2>\((#PlayerAppearances & {key: "player-appearances"}).out)</section>
	</div><aside class="side"><p><a data-route="jogadores" data-text="{msg.back_players}"></a></p><p data-text="{msg.about}"></p></aside></div></article>
	"""
}
_playerProfileMarkup: """
	<section class="screen" data-screen="jogador">
	\((#Masthead & {route: "jogador", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="player_directory" data-filter="slug=eq.{param.slug}&limit=1" data-exit-motion="none" data-empty="{msg.player_gone}">
	  <template data-item data-when="latest_team_id=not.is.null">\((#PlayerProfileArticle & {latestTeam: true}).out)</template>
	  <template data-item data-when="latest_team_id=is.null">\((#PlayerProfileArticle & {latestTeam: false}).out)</template>
	</div>
	</section>
	"""

_championshipPlayersFilter: "championship_id=eq.{owner_id}&search_key=like.*{q_key}*&minutes=gte.{minimum_minutes}"
_championshipPlayersMarkup: """
	<section class="screen" data-screen="campeonato-jogadores">
	\((#Masthead & {route: "campeonato-jogadores", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="championship" data-filter="slug=eq.{param.slug}&limit=1" data-empty="{msg.championship_gone}" data-exit-motion="none"><template data-item><article>
	  <h1 class="band"><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></h1>
	  <div class="page"><div class="content"><h2 data-text="{msg.players_title}"></h2>
	\((#PagedRead & {
	key:    "championship-players"
	table:  "player_stat"
	filter: _championshipPlayersFilter
	order:  _playerSeasonOrder
	seed:   true
	context: {q: "", q_key: "", minimum_minutes: 0, sort: "goals", csv_rows: "[]"}
	events: (#PlayerSeasonEvents & {key: "championship-players"}).out
	controls: (#PlayerSeasonControls & {key: "championship-players"}).out
	content: (#PlayerSeasonTable & {filter: _championshipPlayersFilter, order: _playerSeasonOrder, total: _championshipPlayersTotalMarkup}).out
}).out)
	  <p data-text="{msg.team_contribution_note}"></p></div><aside class="side"><p><a data-route="campeonato" data-param-slug="{param.slug}" data-text="{msg.back_championship}"></a></p><p data-text="{msg.about}"></p></aside></div>
	</article></template></div>
	</section>
	"""

_scopedPlayerMarkup: """
	<section class="screen" data-screen="jogador-campeonato">
	\((#Masthead & {route: "jogador-campeonato", params: " data-param-slug=\"{param.slug}\" data-param-team=\"{param.team}\" data-param-championship=\"{param.championship}\""}).out)
	<div data-live="player_stat" data-select="*,player!inner(full_name,slug),team!inner(slug,logo_key),championship!inner(slug,season,category_id,begins)" data-filter="player.slug=eq.{param.slug}&team.slug=eq.{param.team}&championship.slug=eq.{param.championship}&limit=1" data-empty="{msg.player_scope_gone}" data-exit-motion="none"><template data-item><article>
	  <h1 class="band" data-text="{player_name}"></h1><div class="page"><div class="content">
	    <h2><a data-route="equipe-campeonato" data-param-slug="{team.slug}" data-param-championship="{championship.slug}" data-text="{team_name}"></a> · <a data-route="campeonato" data-param-slug="{championship.slug}"><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></h2>
	    <div class="table-wrap"><table class="grid squad-table"><thead><tr>\(_playerSeasonStatHead)</tr></thead><tbody><tr>\(_playerSeasonStatCells)</tr></tbody></table></div>
	    <p data-text="{msg.team_contribution_note}"></p>
	    <section class="appearances"><h2 data-text="{msg.player_games}"></h2>\((#PlayerAppearances & {key: "scoped-player-appearances", scoped: true}).out)</section>
	  </div><aside class="side"><p><a data-route="jogador" data-param-slug="{player.slug}" data-text="{msg.player_profile}"></a></p><p><a data-route="campeonato-jogadores" data-param-slug="{championship.slug}" data-text="{msg.players_title}"></a></p><p data-text="{msg.about}"></p></aside></div>
	</article></template></div>
	</section>
	"""
