// The screens' markup, composed here so the masthead every page opens with is
// written once. write.ts emits each to shell/screens/<name>.html.

package golaberto

import (
	"encoding/json"
	"list"
	"strings"
)

// The language switcher: the same route in each declared locale. `params` are
// the data-param-* attributes that keep a parametrized page on its own row.
// A link is named by whichever spelling its width shows, never an aria-label:
// "Português" does not contain the "PT" a phone shows (WCAG 2.5.3).
_locales: [
	{tag: "pt-BR", name: "lang_pt"},
	{tag: "es-AR", name: "lang_es"},
	{tag: "en-GB", name: "lang_en"},
	{tag: "it-IT", name: "lang_it"},
	{tag: "de-DE", name: "lang_de"},
	{tag: "fr-FR", name: "lang_fr"},
]

#Masthead: M={
	route:  string
	params: *"" | string
	_links: strings.Join([for l in _locales {
		"    <a data-route=\"\(M.route)\"\(M.params) data-locale=\"\(l.tag)\" data-locale-current=\"page\" lang=\"\(l.tag)\"><span class=\"long\" data-text=\"{msg.\(l.name)}\"></span><span class=\"short\" data-text=\"{msg.\(l.name)_short}\"></span></a>"
	}], "\n")
	out: """
		<header class="masthead">
		  <a class="wordmark" data-route="principal" aria-label="{msg.brand}"><b data-text="{msg.brand_gol}"></b><span data-text="{msg.brand_aberto}"></span></a>
		  \(_editingManagementLinkMarkup)
		  <nav class="langs" aria-label="{msg.lang_label}">
		\(M._links)
		  </nav>
		</header>
		"""
}

// One region of the home page's championship lists.
#Recent: R={
	region: string
	out:    """
		<section class="recent">
		  <h2 data-text="{msg.\(R.region)}"></h2>
		  <ul class="champ-list" data-live="home_championship" data-select="*,championship:id(slug)" data-filter="region=eq.\(R.region)" data-order="strength.desc,full_name.asc,id.asc" data-empty="{msg.home_empty}">
		    <template data-item>
		      <li><a data-route="campeonato" data-param-slug="{championship.slug}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></li>
		    </template>
		  </ul>
		</section>
		"""
}

// The table's columns: the message key of its header (and of the header's long
// form), the column it binds, and its classes. `wide` columns drop at phone width.
_standings: [
	{key: "position", bind: "position", cls: "pos"},
	{key: "team", bind: "team_name", cls: "name", plain: true, link: "team_id"},
	{key: "points", bind: "points", cls: "num pts"},
	{key: "played", bind: "played", cls: "num"},
	{key: "wins", bind: "wins", cls: "num wide"},
	{key: "draws", bind: "draws", cls: "num wide"},
	{key: "losses", bind: "losses", cls: "num wide"},
	{key: "for", bind: "goals_for", cls: "num wide"},
	{key: "against", bind: "goals_against", cls: "num wide"},
	{key: "diff", bind: "goal_diff", cls: "num"},
]

_standingsHead: strings.Join(list.Concat([[for c in _standings {
	[
		if c.plain != _|_ {"\t                            <th scope=\"col\" class=\"\(c.cls)\" data-text=\"{msg.col_\(c.key)}\"></th>"},
		"\t                            <th scope=\"col\" class=\"\(c.cls)\"><abbr title=\"{msg.col_\(c.key)_long}\" data-text=\"{msg.col_\(c.key)}\"></abbr></th>",
	][0]
}], ["\t                            <th scope=\"col\" class=\"form wide\" data-text=\"{msg.col_form}\"></th>"]]), "\n")

#StandingsCells: S={
	championship_param: string
	out: strings.Join(list.Concat([[for c in _standings {
		[
			if c.link != _|_ && S.championship_param != "" {"\t                                <td class=\"\(c.cls)\"><span class=\"team-name-cell\"><span class=\"archive-icon\" data-text=\"{\(c.link)}|{\(c.bind)}|{team.logo_key}\" data-text-format=\"team-badge\"></span><a class=\"team-name\" title=\"{\(c.bind)}\" data-route=\"equipe-campeonato\" data-param-slug=\"{team.slug}\" data-param-championship=\"\(S.championship_param)\" data-text=\"{\(c.bind)}\"></a></span></td>"},
			if c.link != _|_ {"\t                                <td class=\"\(c.cls)\"><a data-route=\"equipe\" data-param-slug=\"{team.slug}\"><span class=\"archive-icon\" data-text=\"{\(c.link)}|{\(c.bind)}|{team.logo_key}\" data-text-format=\"team-badge\"></span><span data-text=\"{\(c.bind)}\"></span></a></td>"},
			"\t                                <td class=\"\(c.cls)\" data-text=\"{\(c.bind)}\"></td>",
		][0]
	}], ["\t                                <td class=\"form wide\">" + strings.Join([for i in [1, 2, 3, 4, 5] {"<i data-result=\"{form\(i)}\" title=\"{msg[form\(i)]}\"></i>"}], "") + "</td>"]]), "\n")
}

_standingsCells: (#StandingsCells & {championship_param: ""}).out
_championshipStandingsCells: (#StandingsCells & {championship_param: "{param.championship}"}).out

// Forty rows per page; a one-row probe shows Next only when another page exists.
#PageActions: P={
	key: string
	out: {
		("click@\(P.key)-previous"): assign: {
			offset: {type: "page-value", params: {step: -40, field: "offset"}}
			next_offset: {type: "page-value", params: {step: -40, field: "next_offset"}}
			page: {type: "page-value", params: {step: -40, field: "page"}}
		}
		("click@\(P.key)-next"): assign: {
			offset: {type: "page-value", params: {step: 40, field: "offset"}}
			next_offset: {type: "page-value", params: {step: 40, field: "next_offset"}}
			page: {type: "page-value", params: {step: 40, field: "page"}}
		}
	}
}
#PageArrows: P={
	key:    string
	table:  string
	filter: string
	order:  string
	out:    """
	<nav class="archive-pager" data-page-offset="{offset}" aria-label="{msg.archive_pages}">
	  <button id="\(P.key)-previous" type="button" class="btn-quiet page-previous" data-text="{msg.page_previous}"></button>
	  <span class="page-status"><span data-text="{msg.page_label}"></span> <b data-text="{page}" data-text-format="number"></b></span>
	  <span data-live="\(P.table)" data-filter="\(P.filter)&amp;offset={next_offset}&amp;limit=1" data-order='\(P.order)' data-empty=""><template data-item><i data-next-page hidden></i></template></span>
	  <button id="\(P.key)-next" type="button" class="btn-quiet page-next" data-text="{msg.page_next}"></button>
	</nav>
	"""
}
#PagedRead: P={
	seed:     *false | bool
	key:      string
	table:    string
	filter:   string
	order:    string
	// archive_page.owner_id is a uuid: a placeholder for the owning row, or a literal one.
	owner: *"{id}" | =~"^(\\{[a-z_]+\\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
	scope:    *"" | string
	content:  string
	controls: *"" | string
	context: *{} | {[string]: _}
	events: *{} | {[string]: _}
	_seed: [if P.seed {#" data-on-mutation="player-csv-seed" data-read-stored="archive_page?id=eq.{id}""#}, ""][0]
	_empty: json.Marshal({id: "\(P.key)-\(P.owner)\(P.scope)", owner_id: P.owner, offset: 0, next_offset: 40, page: 1, state: "browsing"} & P.context)
	_machine: json.Marshal({field: "state", initial: "browsing", context: {owner_id: P.owner, offset: 0, next_offset: 40, page: 1} & P.context, states: browsing: on: (#PageActions & {key: P.key}).out & P.events})
	out: """
	<div class="paged-read" data-live="archive_page" data-filter="id=eq.\(P.key)-\(P.owner)\(P.scope)" data-machine='\(P._machine)' data-empty-row='\(P._empty)'\(P._seed)>
	  <div class="page-window">
	\(P.controls)
	\(P.content)
	\((#PageArrows & {key: P.key, table: P.table, filter: P.filter, order: P.order}).out)
	  </div>
	</div>
	"""
}

// The catalogue search and page belong to the tab.
_catalogMachine: json.Marshal({
	field:   "state"
	initial: "browsing"
	context: {q: "", q_key: "", region: "", offset: 0, next_offset: 40, page: 1}
	states: browsing: on: (#PageActions & {key: "catalog"}).out & {
		"input@catalog-q": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}
		"change@catalog-region": assign: {region: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
	}
})

// One game in a list: when, where it belongs, who played, the score. The row
// is a link to the game's page. It reads the game's card, its names written
// beside it (ir decision-local-reads); a list inside one championship leaves
// the championship out.
#GameList: G={
	table:    *"game_card" | string
	filter:   string
	order:    string
	empty:    string
	cls:      *"games" | string
	where:    *true | bool
	homeFeed: *"" | "upcoming" | "recent"
	_where: [if G.where {"\n      <span class=\"where\" data-text=\"{championship_name}|{msg.geography_names}\" data-text-format=\"geography-label\"></span>"}, ""][0]
	_project: [if G.homeFeed != "" {#" data-project='{"day_first":{"first":"day"},"previous":"prev"}'"#}, ""][0]
	_exitMotion: [if G.homeFeed != "" {#" data-exit-motion="none""#}, ""][0]
	_dayClass: [if G.homeFeed != "" {"day visually-hidden"}, "day"][0]
	_dayHeading: [if G.homeFeed != "" {"""
	      <h3 class="home-day" data-live="\(G.table)" data-filter="id=eq.{day_first}&amp;id=eq.{id}" data-empty="" data-exit-motion="none"><template data-item><span class="home-day-label" data-text="{day}|{msg.home_weekdays}" data-text-format="home-date"></span></template></h3>
	"""}, ""][0]
	_phaseHeading: [if G.homeFeed != "" {"""
		      <h4 class="home-phase"><span hidden data-live="home_game_card" data-filter="id=eq.{previous}" data-empty="" data-exit-motion="none" data-project='{"same_day":{"eq":["day","{day}"]},"same_phase":{"eq":["phase_id","{phase_id}"]},"is_first":{"eq":["id","{id}"]}}'><template data-item><span class="home-phase-context" data-same-day="{same_day}" data-same-phase="{same_phase}" data-first="{is_first}"></span></template></span><a class="home-phase-label" data-route="campeonato" data-param-slug="{championship.slug}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span> <small data-text="{phase_name}"></small></a></h4>
		"""}, ""][0]
	_itemAttributes: [if G.homeFeed != "" {#" class="home-championship" data-championship="{championship_id}" data-phase="{phase_id}""#}, ""][0]
	_highlightAttribute: [if G.homeFeed != "" {#" data-highlighted="{home_highlighted}""#}, ""][0]
	out: """
		<ol class="\(G.cls)" data-live="\(G.table)" data-select="*,game:id(slug),championship(show_country,slug),home:home_id(country,slug,logo_key),away:away_id(country,slug,logo_key)" data-filter="\(G.filter)" data-order="\(G.order)" data-empty="\(G.empty)"\(G._project)\(G._exitMotion)>
		  <template data-item>
		    <li\(G._itemAttributes)>\(G._dayHeading)\(G._phaseHeading)<a class="game-row" data-show-country="{championship.show_country}" data-route="jogo" data-param-slug="{game.slug}" data-played="{played}"\(G._highlightAttribute)>
		      <span class="when"><span class="\(G._dayClass)" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span>\(G._where)
		      <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}|{home.logo_key}" data-text-format="team-badge"></span></span></span>
		      \(_matchScoreMarkup)
		      <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}|{away.logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{away.country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
		    </a></li>
		  </template>
		</ol>
		"""
}

// Preserve global rank order; date and phase headings precede their first row.
#HomeGameFeed: H={
	feed:   "upcoming" | "recent"
	played: string
	empty:  string
	out: (#GameList & {
		table:    "home_game_card"
		filter:   "played=is.\(H.played)&home_\(H.feed)_rank=gt.0&limit=20"
		order:    "home_\(H.feed)_rank.asc"
		empty:    H.empty
		cls:      "games home-championships"
		where:    false
		homeFeed: H.feed
	}).out
}

// The games page's two lists, switched by a machine over the tab's view row.
_gamesMachine: json.Marshal({
	field:   "state"
	initial: "upcoming"
	states: {
		upcoming: on: "click@games-tab-results": target: "results"
		results: on: "click@games-tab-upcoming": target: "upcoming"
	}
})

_jogosMarkup: """
	<section class="screen" data-screen="jogos">
	\((#Masthead & {route: "jogos"}).out)
	<h1 class="band" data-text="{msg.games_title}"></h1>
	<div class="page">
	  <div class="content" data-live="games_view" data-filter="id=eq.games" data-machine='\(_gamesMachine)' data-project='{"up":{"eq":["state","upcoming"]},"res":{"eq":["state","results"]}}'>
	    <template data-item>
	      <div class="games-view" data-view="{state}">
	        <div class="tabs" role="tablist" aria-label="{msg.games_title}">
	          <button type="button" id="games-tab-upcoming" role="tab" aria-selected="{up}" data-text="{msg.games_upcoming}"></button>
	          <button type="button" id="games-tab-results" role="tab" aria-selected="{res}" data-text="{msg.games_results}"></button>
	        </div>
	\((#GameList & {table: "matches_game_card", filter: "played=is.false&kickoff=not.is.null&limit=40", order: "kickoff.asc,id.asc", empty: "{msg.games_none_upcoming}", cls: "games upcoming"}).out)
	\((#GameList & {table: "matches_game_card", filter: "played=is.true&limit=40", order: "day.desc,kickoff.desc,id.asc", empty: "{msg.games_none_results}", cls: "games results"}).out)
	      </div>
	    </template>
	  </div>
	  <aside class="side"><p data-text="{msg.about}"></p></aside>
	</div>
	</section>
	"""

// The comment composer: a machine over the tab's draft for this game. Posting
// is a create the store sends; an acknowledged one clears the draft, a refused
// one keeps it and says why (ir decision-comments).
_post: {target: "sending", effect: {level: "replicated", op: "create", entity: "comment", values: {game_id: "{id}", body: "{body}"}}}
_type: {assign: body: {type: "event", params: field: "value"}}
_composerMachine: json.Marshal({
	field:   "state"
	initial: "writing"
	context: {body: ""}
	on: refused: target: "refused"
	states: {
		writing: on: {"input@comment-body": _type, "click@comment-post": _post}
		sending: on: sync_ack: {target: "writing", assign: body: ""}
		refused: on: {"input@comment-body": _type & {target: "writing"}, "click@comment-post": _post}
	}
})

// The game editor: a machine over the tab's draft of one game, seeded from the
// game it is nested in (ir decision-editing). Saving is one update the store
// sends; a refused one keeps the draft and says why. A goal is added or
// removed on its own, as the archive's goals are rows of their own.
_editKeys: {
	// A game is played exactly when both sides have a score.
	"input@edit-home": {assign: {home_score: "count-or-null", played: {type: "both-scored", params: other: "away_score"}}}
	"input@edit-away": {assign: {away_score: "count-or-null", played: {type: "both-scored", params: other: "home_score"}}}
	"input@edit-attendance": {assign: attendance: "count-or-null"}
	"change@edit-stadium": {assign: stadium_id: "blank-null"}
	"input@edit-stadium-q": {assign: {stadium_q: {type: "event", params: field: "value"}, stadium_q_key: {type: "search-key"}}}
	"change@edit-referee": {assign: referee_id: "blank-null"}
	"input@edit-referee-q": {assign: {referee_q: {type: "event", params: field: "value"}, referee_q_key: {type: "search-key"}}}
	"input@goal-minute": {assign: goal_minute: "count-or-null"}
	"change@goal-player": {assign: goal_player_id: "blank-null"}
	"click@edit-save": {target: "saving", effect: {level: "replicated", op: "update", entity: "game", values: {
		id:         "{id}", played:             "{played}", home_score:     "{home_score}", away_score: "{away_score}"
		attendance: "{attendance}", stadium_id: "{stadium_id}", referee_id: "{referee_id}"
	}}}
	for s in ["home", "away"] {
		"click@goal-add-\(s)": {
			effect: {level: "replicated", op: "create", entity: "goal", values: {
				game_id: "{id}", side: s, minute: "{goal_minute}", player_id: "{goal_player_id}"
			}}
		}
	}

	// A goal's remove button carries the goal's id as its value.
	click: {guard: "row-id", effect: {level: "replicated", op: "delete", entity: "goal", values: id: {type: "event", params: field: "value"}}}
}
_editMachine: json.Marshal({
	field:   "state"
	initial: "editing"
	on: refused: target: "refused"
	states: {
		// An effect reads the row after its own transition's assigns, so the
		// goal being added is cleared once the cluster has it.
		editing: on: _editKeys & {sync_ack: assign: {goal_minute: null, goal_player_id: null}}
		saving: on: sync_ack: target: "editing"
		refused: on: _editKeys & {sync_ack: {target: "editing", assign: {goal_minute: null, goal_player_id: null}}}
	}
})

#GoalSide: G={
	side: string
	out:  """
		<section class="goal-side">
		  <header><h3 data-text="{\(G.side)_name}"></h3></header>
		  <ol class="goal-rows" data-live="goal" data-select="*,player(name,slug)" data-filter="game_id=eq.{id}&side=eq.\(G.side)" data-order="aet.asc,minute.asc" data-empty="{msg.game_no_goals}">
		    <template data-item>
		      <li><span class="minute" data-text="{minute}"></span><span class="who" data-text="{player.name}"></span><button type="button" class="text-btn remove" value="{id}" data-text="{msg.edit_goal_remove}"></button></li>
		    </template>
		  </ol>
		  <button id="goal-add-\(G.side)" type="button" class="btn-quiet add-goal" data-text="{msg.edit_goal_add}"></button>
		</section>
		"""
}

_editarMarkup: """
	<section class="screen" data-screen="editar">
	\((#Masthead & {route: "editar", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="game_card" data-select="*,game:id!inner(slug),stadium(slug),referee(slug),championship(show_country,slug),home:home_id(country,slug,logo_key),away:away_id(country,slug,logo_key)" data-filter="game.slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.game_gone}">
	  <template data-item>
	    <article class="game">
	      <h1 class="band"><a data-route="campeonato" data-param-slug="{championship.slug}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></h1>
	      <div class="page">
	        <div class="content">
	          <div data-live="game_edit" data-filter="id=eq.{id}" data-machine='\(_editMachine)'
	               data-empty-row='{"id":"{id}","state":"editing","played":"{played}","home_score":"{home_score}","away_score":"{away_score}","attendance":"{attendance}","stadium_id":"{stadium_id}","referee_id":"{referee_id}","goal_minute":null,"goal_player_id":null,"home_name":"{home_name}","away_name":"{away_name}","stadium_q":"","referee_q":"","stadium_q_key":"","referee_q_key":""}'>
	           <div class="edit" data-state="{state}">
	            <!-- The game itself, held so the save has the row it updates. -->
	            <span data-live="game" data-filter="id=eq.{id}" data-empty="" hidden></span>
	            <div class="edit-head"><h2 data-text="{msg.edit_title}"></h2><span class="meta" data-text="{msg.edit_meta}"></span></div>
	            <fieldset class="edit-sec score-edit">
	              <legend class="visually-hidden" data-text="{msg.edit_score}"></legend>
	              <div class="score-row">
	                <label class="team home" for="edit-home" data-text="{home_name}"></label>
	                <span class="pair"><input id="edit-home" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" data-value="{home_score}"><i>x</i><input id="edit-away" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" aria-label="{away_name}" data-value="{away_score}"></span>
	                <span class="team away" data-text="{away_name}"></span>
	              </div>
	            </fieldset>
	            <fieldset class="edit-sec">
	              <legend data-text="{msg.edit_facts}"></legend>
	              <div class="fields">
	                <label class="field wide" for="edit-stadium"><span data-text="{msg.game_stadium}"></span>
	                  <input id="edit-stadium-q" type="search" value="{stadium_q}" placeholder="{msg.choice_search}" aria-label="{msg.game_stadium}" maxlength="80" autocomplete="off">
	                  <select id="edit-stadium" data-value="{stadium_id}"><option value="" data-text="{msg.edit_unknown}"></option><optgroup data-live="stadium" data-filter="id=eq.{stadium_id}" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup><optgroup data-live="stadium" data-filter="search_key=like.*{stadium_q_key}*&limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select>
	                </label>
	                <label class="field wide" for="edit-referee"><span data-text="{msg.game_referee}"></span>
	                  <input id="edit-referee-q" type="search" value="{referee_q}" placeholder="{msg.choice_search}" aria-label="{msg.game_referee}" maxlength="80" autocomplete="off">
	                  <select id="edit-referee" data-value="{referee_id}"><option value="" data-text="{msg.edit_unknown}"></option><optgroup data-live="referee" data-filter="id=eq.{referee_id}" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup><optgroup data-live="referee" data-filter="search_key=like.*{referee_q_key}*&limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select>
	                </label>
	                <label class="field" for="edit-attendance"><span data-text="{msg.game_attendance}"></span>
	                  <input id="edit-attendance" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="{msg.edit_unrecorded}" data-value="{attendance}">
	                </label>
	              </div>
	            </fieldset>
	            <fieldset class="edit-sec">
	              <legend data-text="{msg.game_goals}"></legend>
	              <p class="hint" data-text="{msg.edit_goal_hint}"></p>
	              <div class="goal-new">
	                <label class="field" for="goal-minute"><span data-text="{msg.edit_goal_minute}"></span><input id="goal-minute" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-value="{goal_minute}"></label>
	                <label class="field wide" for="goal-player"><span data-text="{msg.edit_goal_player}"></span>
	                  <select id="goal-player" data-value="{goal_player_id}"><option value="" data-text="{msg.edit_goal_choose}"></option><optgroup data-live="player_game" data-select="*,player(name,slug)" data-filter="game_id=eq.{id}" data-order="side.desc,bench.asc,on_minute.asc" data-empty=""><template data-item><option value="{player_id}" data-text="{player.name}"></option></template></optgroup></select>
	                </label>
	              </div>
	              <div class="goal-sides">
	                \((#GoalSide & {side: "home"}).out)
	                \((#GoalSide & {side: "away"}).out)
	              </div>
	            </fieldset>
	            <div class="edit-actions">
	              <p class="refusal" role="alert" data-text="{msg.edit_refused}"></p>
	              <div class="buttons">
	                <button id="edit-save" type="button" class="btn save"><span class="idle" data-text="{msg.edit_save}"></span><span class="busy" data-text="{msg.edit_saving}"></span></button>
	                <a class="btn-quiet cancel" data-route="jogo" data-param-slug="{param.slug}" data-text="{msg.edit_back}"></a>
	              </div>
	            </div>
	           </div>
	          </div>
	        </div>
	        <aside class="side">
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

// What a chance row's 0 means (ir decision-chances): a mark drawn from its
// reach, and the reach said in words.
_reachMark: "<span class=\"reach\" data-reach=\"{reach}\" title=\"{msg[reach]}\" aria-hidden=\"true\"></span><span class=\"visually-hidden\" data-text=\"{msg[reach]}\"></span>"

// A group's chances (ir decision-chances): its zones as columns and the final
// positions as a heat map. Rows are grids rather than table rows: a row's
// cells for zones or positions are a list of its own, which takes its
// element's children, so they sit in a contents-only list beside the row's
// fixed cells, each in the row's own grid. A compact odds figure is drawn for
// the eye only; the exact value is what a screen reader hears.
_chancesMarkup: """
	<section class="screen" data-screen="chances">
	\((#Masthead & {route: "chances", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="stage_group" data-select="*,phase(name,championship_id)" data-filter="slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.chances_gone}">
	  <template data-item>
	    <article class="chances-page">
	      <h1 class="band" data-live="championship" data-filter="id=eq.{phase.championship_id}" data-empty=""><template data-item><a data-route="campeonato" data-param-slug="{slug}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></template></h1>
	      <div class="page">
	        <div class="content">
	          <div class="chances-head">
	            <h2 data-text="{msg.chances_title}"></h2>
	            <p><span data-text="{phase.name}"></span> · <span data-text="{name}"></span> · <span data-text="{msg.chances_seasons}"></span></p>
	          </div>
	          <section class="chances-sec" data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{id}&rank=eq.1" data-empty="{msg.chances_none}">
	            <template data-item>
	              <div class="chances-tables">
	                <h3 data-text="{msg.chances_zones}"></h3>
	                <div class="table-wrap" tabindex="0" role="region" aria-label="{msg.chances_zones}">
	                  <div class="grid-table zone-odds" role="table">
	                    <div class="row head" role="row">
	                      <span class="pos" role="columnheader">#</span><span class="name" role="columnheader" data-text="{msg.col_team}"></span><span class="pts" role="columnheader" data-text="{msg.col_points}"></span>
	                      <span class="cells" data-live="zone" data-filter="group_id=eq.{group_id}" data-order="first.asc,last.asc" data-empty=""><template data-item><span class="zone" role="columnheader" data-zone="{color}" style="--zone-source: {color}"><i aria-hidden="true"></i><span data-text="{name}"></span><small data-text="{first}–{last}"></small></span></template></span>
	                    </div>
	                    <div class="rows" data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{group_id}" data-order="rank.asc" data-empty="">
	                      <template data-item>
	                        <div class="row" role="row">
	                          <span class="pos" role="cell" data-text="{rank}"></span><span class="name" role="rowheader"><a data-route="equipe" data-param-slug="{team.slug}"><span class="archive-icon" data-text="{team_id}|{team_name}|{team.logo_key}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></span><span class="pts" role="cell" data-text="{points}"></span>
	                          <span class="cells" data-live="zone_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}" data-order="first.asc,last.asc" data-empty=""><template data-item><span class="pct" role="cell" data-zone="{color}" style="--zone-source: {color}" data-band="{band}"><span aria-hidden="true" data-text="{percent}\u001f{msg.chart_locale}\u001fcompact-percent" data-text-format="position-odds"></span><span class="visually-hidden"><span class="exact" data-text="{percent}" data-text-format="number"></span>%</span>\(_reachMark)</span></template></span>
	                        </div>
	                      </template>
	                    </div>
	                  </div>
	                </div>
	                <h3 data-text="{msg.chances_positions}"></h3>
	                <div class="table-wrap" tabindex="0" role="region" aria-label="{msg.chances_positions}">
	                  <div class="grid-table heat" role="table">
	                    <div class="row head" role="row">
	                      <span class="pos" role="columnheader">#</span><span class="name" role="columnheader" data-text="{msg.col_team}"></span>
	                      <span class="cells" data-live="position_chance" data-filter="group_id=eq.{group_id}&current=is.true" data-order="position.asc" data-empty=""><template data-item><span class="at" role="columnheader" data-text="{position}"></span></template></span>
	                    </div>
	                    <div class="rows" data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{group_id}" data-order="rank.asc" data-empty="">
	                      <template data-item>
	                        <div class="row" role="row">
	                          <span class="pos" role="cell" data-text="{rank}"></span><span class="name" role="rowheader"><a data-route="equipe" data-param-slug="{team.slug}"><span class="archive-icon" data-text="{team_id}|{team_name}|{team.logo_key}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></span>
	                          <span class="cells" data-live="position_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}" data-order="position.asc" data-empty=""><template data-item><span class="heat-cell" role="cell" data-band="{band}" data-current="{current}" title="{percent}%"><span class="visually-hidden"><span class="exact" data-text="{percent}" data-text-format="number"></span>%</span>\(_reachMark)</span></template></span>
	                        </div>
	                      </template>
	                    </div>
	                  </div>
	                </div>
	                <ul class="heat-legend">
	                  <li data-band="0"><i></i><span data-text="{msg.heat_0}"></span></li>
	                  <li data-band="1"><i></i><span data-text="{msg.heat_1}"></span></li>
	                  <li data-band="2"><i></i><span data-text="{msg.heat_2}"></span></li>
	                  <li data-band="3"><i></i><span data-text="{msg.heat_3}"></span></li>
	                  <li data-band="4"><i></i><span data-text="{msg.heat_4}"></span></li>
	                  <li><i class="current"></i><span data-text="{msg.heat_current}"></span></li>
	                  <li><span class="reach" data-reach="reachable" aria-hidden="true"></span><span data-text="{msg.reachable}"></span></li>
	                  <li><span class="reach" data-reach="undecided" aria-hidden="true"></span><span data-text="{msg.undecided}"></span></li>
	                </ul>
	              </div>
	            </template>
	          </section>
	        </div>
	        <aside class="side">
	          <p data-text="{msg.chances_method}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

_jogoMarkup: """
	<section class="screen" data-screen="jogo">
	\((#Masthead & {route: "jogo", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="game_card" data-select="*,game:id!inner(slug),stadium(slug),referee(slug),championship(show_country,slug),home:home_id(country,slug,logo_key),away:away_id(country,slug,logo_key)" data-filter="game.slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.game_gone}">
	  <template data-item>
	    <article class="game" data-played="{played}">
	      <h1 class="band"><a data-route="campeonato" data-param-slug="{championship.slug}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></h1>
	      <div class="page">
	        <div class="content">
	          <div class="game-head">
	            <p class="phase-name" data-text="{phase_name}"></p>
	            <div class="edit-gate" data-live="editor" data-empty=""><template data-item><a class="btn-quiet edit-link" data-route="editar" data-param-slug="{param.slug}" data-text="{msg.edit_link}"></a></template></div>
	          </div>
	          <div class="scoreboard" data-show-country="{championship.show_country}">
	            <a class="home" data-route="equipe" data-param-slug="{home.slug}"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}|{home.logo_key}" data-text-format="team-badge"></span></span></a>
	            <span class="score"><b data-text="{home_score}"></b><i>x</i><b data-text="{away_score}"></b></span>
	            <a class="away" data-route="equipe" data-param-slug="{away.slug}"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}|{away.logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{away.country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></a>
	          </div>
	          <p class="extra"><span class="aet"><span data-text="{msg.game_aet}"></span> <b data-text="{home_aet}"></b>–<b data-text="{away_aet}"></b></span> <span class="pen"><span data-text="{msg.game_pen}"></span> <b data-text="{home_pen}"></b>–<b data-text="{away_pen}"></b></span></p>
	          <dl class="game-facts">
	            <dt data-text="{msg.game_round}"></dt><dd data-text="{round}"></dd>
	            <dt data-text="{msg.game_day}"></dt><dd data-text="{day_display}"></dd>
	            <dt data-text="{msg.game_kickoff}"></dt><dd data-text="{kickoff_local}"></dd>
	            <dt data-text="{msg.game_stadium}"></dt><dd><a data-route="estadio" data-param-slug="{stadium.slug}" data-text="{stadium_name}"></a></dd>
	            <dt data-text="{msg.game_referee}"></dt><dd><a data-route="arbitro" data-param-slug="{referee.slug}" data-text="{referee_name}"></a></dd>
	            <dt data-text="{msg.game_attendance}"></dt><dd data-text="{attendance}" data-text-format="number"></dd>
	            <dt data-text="{msg.game_importance}"></dt><dd class="importance" data-live="game_importance" data-filter="id=eq.{id}" data-empty=""><template data-item><abbr title="{msg.game_importance_long}"><span data-text="{home}" data-text-format="number"></span> · <span data-text="{away}" data-text-format="number"></span></abbr></template></dd>
	          </dl>
	          \(_matchContextTopMarkup)
	          <section class="goals-sec">
	            <h2 data-text="{msg.game_goals}"></h2>
	            <ol class="goals" data-live="goal" data-select="*,player(name,slug)" data-filter="game_id=eq.{id}" data-order="aet.asc,minute.asc" data-empty="{msg.game_no_goals}">
	              <template data-item>
	                <li data-side="{side}" data-penalty="{penalty}" data-own-goal="{own_goal}"><span class="minute" data-text="{minute}"></span> <a data-route="jogador" data-param-slug="{player.slug}" data-text="{player.name}"></a> <span class="mark pen" data-text="{msg.goal_pen}"></span><span class="mark og" data-text="{msg.goal_og}"></span></li>
	              </template>
	            </ol>
	          </section>
	          \(_matchProbabilityMarkup)
	          <section class="lineups">
	            <h2 data-text="{msg.game_lineups}"></h2>
	            <div class="sides">
	              \((#MatchContextLineup & {side: "home"}).out)
	              \((#MatchContextLineup & {side: "away"}).out)
	            </div>
	          </section>
	          \(_matchContextHistoryMarkup)
	          <nav class="buttons"><a class="btn-quiet" data-route="historico-jogo" data-param-slug="{param.slug}" data-text="{msg.community_history}"></a></nav>
	        </div>
	        <aside class="side">
	          <p><a data-route="jogos" data-text="{msg.back_games}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	  <section class="comments page-tail">
	    <h2 data-text="{msg.comments_title}"></h2>
	    <div class="composer" data-live="comment_draft" data-filter="id=eq.{id}" data-machine='\(_composerMachine)' data-state="{state}">
	      <label class="field" for="comment-body"><span data-text="{msg.comment_label}"></span>
	        <textarea id="comment-body" data-value="{body}" maxlength="1000" rows="3" placeholder="{msg.comment_placeholder}"></textarea>
	      </label>
	      <p class="refusal" role="alert" data-text="{msg.comment_refused}"></p>
	      <button id="comment-post" type="button" class="btn post"><span class="idle" data-text="{msg.comment_post}"></span><span class="busy" data-text="{msg.comment_posting}"></span></button>
	    </div>
	\((#PagedRead & {key: "game-comments", owner: "{id}", table: "comment", filter: "game_id=eq.{owner_id}", order: "created_at.desc", content: _game_commentsMarkup}).out)
	  </section>
	    </article>
	  </template>
	</div>
	</section>
	"""

_game_commentsMarkup: """
	    <ol class="comment-list" data-live="comment" data-select="*,app_user(handle)" data-filter="game_id=eq.{owner_id}&amp;offset={offset}&amp;limit=40" data-order="created_at.desc" data-empty="{msg.comments_none}">
	      <template data-item>
	        <li><p class="byline"><a data-route="usuario" data-param-id="{app_user_id}" data-text="{app_user.handle}"></a> <time data-text="{created_at}" data-text-format="datetime"></time></p><p class="body" data-text="{body}"></p>\((#CommunityCommentDelete & {table: "comment"}).out)</li>
	      </template>
	    </ol>
	"""

_lineup: L={
	side: string
	out:  """
		<table class="grid lineup" data-side="\(L.side)">
		  <caption data-text="{\(L.side)_name}"></caption>
		  <thead><tr><th scope="col" data-text="{msg.col_player}"></th><th scope="col" class="num"><abbr title="{msg.col_position_long}" data-text="{msg.col_pos}"></abbr></th><th scope="col" class="num" data-text="{msg.col_on}"></th><th scope="col" class="num" data-text="{msg.col_off}"></th><th scope="col"><span class="visually-hidden" data-text="{msg.col_cards}"></span></th></tr></thead>
		  <tbody data-live="player_game" data-select="*,player(name,position,slug)" data-filter="game_id=eq.{id}&side=eq.\(L.side)" data-order="bench.asc,on_minute.asc" data-empty="{msg.game_no_lineup}">
		    <template data-item>
		      <tr data-yellow="{yellow}" data-red="{red}" data-bench="{bench}"><td><a data-route="jogador" data-param-slug="{player.slug}" data-text="{player.name}"></a></td><td class="num" data-text="{player.position}"></td><td class="num" data-text="{on_minute}"></td><td class="num" data-text="{off_minute}"></td><td class="cards"><i class="yellow" title="{msg.card_yellow}"></i><i class="red" title="{msg.card_red}"></i></td></tr>
		    </template>
		  </tbody>
		</table>
		"""
}

_principalMarkup: """
	<section class="screen" data-screen="principal">
	\((#Masthead & {route: "principal"}).out)
	<h1 class="band" data-text="{msg.home_title}"></h1>
	<div class="page">
	  <div class="content">
	    <div class="home-games">
	      <section class="home-upcoming" aria-labelledby="home-upcoming-heading">
	        <h2 id="home-upcoming-heading" class="home-games-title" data-text="{msg.games_upcoming}"></h2>
	\((#HomeGameFeed & {feed: "upcoming", played: "false", empty: "{msg.home_no_upcoming}"}).out)
	      </section>
	      <section class="home-results" aria-labelledby="home-results-heading">
	        <h2 id="home-results-heading" class="home-games-title" data-text="{msg.games_results}"></h2>
	\((#HomeGameFeed & {feed: "recent", played: "true", empty: "{msg.home_no_results}"}).out)
	      </section>
	      <p class="more"><a data-route="jogos" data-text="{msg.home_all_games}"></a></p>
	    </div>
	    <section class="feature" data-live="championship" data-filter="featured=is.true&limit=1" data-order="begins.desc" data-empty="">
	      <template data-item>
	        <div class="feature-body">
	          <div class="feature-head">
	            <h2><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></h2>
	            <a data-route="campeonato" data-param-slug="{slug}" data-text="{msg.home_table_link}"></a>
	          </div>
	          <div class="feature-phase" data-live="phase" data-filter="championship_id=eq.{id}&limit=1" data-order="position.asc" data-empty="">
	            <template data-item>
	              <div class="feature-grid">
	                <div class="top" data-live="stage_group" data-filter="phase_id=eq.{id}&limit=1" data-order="position.asc,name.asc" data-empty="">
	                  <template data-item>
	                    <section class="top-six">
	                      <h3 data-text="{msg.home_top6}"></h3>
	                      <div class="table-wrap">
	                        <table class="grid standings">
	                          <thead><tr>
	\(_standingsHead)
	                            <th scope="col" class="odds"><abbr title="{msg.col_title_chance_long}" data-text="{msg.col_title_chance}"></abbr></th>
	                          </tr></thead>
	                          <tbody data-live="standing" data-select="*,team(slug,logo_key)" data-filter="group_id=eq.{id}&position=lte.6" data-order="position.asc" data-empty="{msg.no_teams}">
	                            <template data-item>
	                              <tr data-zone="{zone}" style="--zone-source: {zone}">
	\(_standingsCells)
	                                <td class="odds"><span data-live="position_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}&position=eq.1" data-empty=""><template data-item><span class="title-chance" data-band="{band}"><span class="bar" aria-hidden="true"><i></i></span><span data-text="{percent}" data-text-format="number"></span>\(_reachMark)</span></template></span></td>
	                              </tr>
	                            </template>
	                          </tbody>
	                        </table>
	                      </div>
	                      <div class="top-foot" data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{id}&rank=eq.1" data-empty=""><template data-item><a class="btn-quiet chances-link" data-route="chances" data-param-slug="{group.slug}" data-text="{msg.chances_link}"></a></template></div>
	                    </section>
	                  </template>
	                </div>
	              </div>
	            </template>
	          </div>
	        </div>
	      </template>
	    </section>
	    <h2 class="recent-title" data-text="{msg.home_recent}"></h2>
	    <div class="regions">
	\(strings.Join([for r in ["national", "continental", "world"] {(#Recent & {region: r}).out}], "\n"))
	    </div>
	    <p class="more"><a data-route="campeonatos" data-text="{msg.home_all}"></a></p>
	  </div>
	  <aside class="side"><p data-text="{msg.about}"></p></aside>
	</div>
	</section>
	"""

_campeonatosMarkup: """
	<section class="screen" data-screen="campeonatos">
	\((#Masthead & {route: "campeonatos"}).out)
	<h1 class="band" data-text="{msg.catalog_title}"></h1>
	<div class="page">
	  <div class="content" data-live="catalog_filter" data-filter="id=eq.catalog" data-machine='\(_catalogMachine)'>
	    <template data-item>
	      <div class="catalog">
	        <div class="filters" role="search">
	          <label class="field grow" for="catalog-q"><span data-text="{msg.search_label}"></span>
	            <input id="catalog-q" type="search" value="{q}" placeholder="{msg.search_placeholder}" maxlength="80" autocomplete="off">
	          </label>
	          <label class="field" for="catalog-region"><span data-text="{msg.region_label}"></span>
	            <select id="catalog-region" data-value="{region}">
	              <option value="" data-text="{msg.region_all}"></option>
	              <option value="world" data-text="{msg.world}"></option>
	              <option value="continental" data-text="{msg.continental}"></option>
	              <option value="national" data-text="{msg.national}"></option>
	            </select>
	          </label>
	        </div>
	        <table class="grid catalog-table">
	          <thead><tr>
	            <th scope="col" data-text="{msg.col_name}"></th>
	            <th scope="col" class="narrow" data-text="{msg.col_region}"></th>
	            <th scope="col" class="narrow" data-text="{msg.col_category}"></th>
	          </tr></thead>
	          <tbody data-live="championship" data-filter="search_key=like.*{q_key}*&region=like.*{region}*&offset={offset}&limit=40" data-order="region_name.asc,name.asc,begins.desc" data-empty="{msg.catalog_empty}">
	            <template data-item>
	              <tr>
	                <td><a data-route="campeonato" data-param-slug="{slug}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></a></td>
	                <td class="narrow" data-text="{msg[region]}"></td>
	                <td class="narrow"><span data-live="category" data-filter="id=eq.{category_id}" data-empty="{msg.professional}"><template data-item><span data-text="{name}"></span></template></span></td>
	              </tr>
	            </template>
	          </tbody>
	        </table>
	\((#PageArrows & {key: "catalog", table: "championship", filter: "search_key=like.*{q_key}*&region=like.*{region}*", order: "region_name.asc,name.asc,begins.desc"}).out)
	      </div>
	    </template>
	  </div>
	  <aside class="side"><p data-text="{msg.about}"></p></aside>
	</div>
	</section>
	"""

_campeonatoMarkup: """
	<section class="screen" data-screen="campeonato">
	\((#Masthead & {route: "campeonato", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="championship" data-filter="slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.championship_gone}">
	  <template data-item>
	    <article class="championship">
	      <h1 class="band"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span></h1>
	      <div class="page">
	        <div class="content">
	          <p class="chips"><a class="chip" data-route="campeonato-jogadores" data-param-slug="{slug}" data-text="{msg.players_title}"></a><a class="chip" data-route="arquivo-campeonato" data-param-slug="{slug}" data-text="{msg.archive_title}"></a><a class="chip" data-route="publico" data-param-slug="{slug}" data-text="{msg.archive_attendance_title}"></a></p>
	          <p class="facts">
	            <span class="chip"><span data-text="{msg[region]}"></span></span>
	            <span class="chip" data-live="category" data-filter="id=eq.{category_id}" data-empty="{msg.professional}"><template data-item><span data-text="{name}"></span></template></span>
	            <span class="points"><span data-text="{msg.win}"></span> <b data-text="{point_win}"></b> · <span data-text="{msg.draw}"></span> <b data-text="{point_draw}"></b> · <span data-text="{msg.loss}"></span> <b data-text="{point_loss}"></b></span>
	          </p>
	          <nav class="phase-chips" aria-label="{msg.phases_label}" data-live="phase" data-filter="championship_id=eq.{id}" data-order="position.asc" data-empty="{msg.no_phases}">
	            <template data-item><a class="chip" href="#fase-{id}" data-text="{name}"></a></template>
	          </nav>
	          <div class="phases" data-live="phase" data-filter="championship_id=eq.{id}" data-order="position.asc" data-empty="">
	            <template data-item>
	              <section class="phase" id="fase-{id}">
	                <h2 data-text="{name}"></h2>
	                <div class="groups" data-live="stage_group" data-filter="phase_id=eq.{id}" data-order="position.asc,name.asc" data-empty="{msg.no_groups}">
	                  <template data-item>
	                    <section class="group">
	                      <div class="group-head">
	                        <h3 data-text="{name}"></h3>
	                        <div data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{id}&rank=eq.1" data-empty=""><template data-item><a class="btn-quiet chances-link" data-route="chances" data-param-slug="{group.slug}" data-text="{msg.chances_link}"></a></template></div>
	                      </div>
	                      <div class="table-wrap">
	                        <table class="grid standings">
	                          <thead><tr>
	\(_standingsHead)
	                          </tr></thead>
	                          <tbody data-live="standing" data-select="*,team(slug,logo_key)" data-filter="group_id=eq.{id}" data-order="position.asc" data-empty="{msg.no_teams}">
	                            <template data-item>
	                              <tr data-zone="{zone}" style="--zone-source: {zone}">
	\((#StandingsCells & {championship_param: "{param.slug}"}).out)
	                              </tr>
	                            </template>
	                          </tbody>
	                        </table>
	                      </div>
	                      <ul class="zones" data-live="zone" data-filter="group_id=eq.{id}" data-order="first.asc,last.asc" data-empty="">
	                        <template data-item>
	                          <li data-zone="{color}" style="--zone-source: {color}"><i aria-hidden="true"></i><span data-text="{name}"></span> <span class="range" data-text="{first}–{last}"></span></li>
	                        </template>
	                      </ul>
	                    </section>
	                  </template>
	                </div>
	                <div class="rounds" data-live="phase_round" data-filter="phase_id=eq.{id}" data-empty="">
	                  <template data-item>
	                    <div class="round-pair">
	                      <section class="round">
	                        <h3><span data-text="{msg.round}"></span> <span data-text="{current}"></span></h3>
	\((#GameList & {filter: "phase_id=eq.{phase_id}&round=eq.{current}", order: "day.asc,kickoff.asc", empty: "{msg.round_empty}", where: false}).out)
	                      </section>
	                      <div class="round-next" data-live="phase_round" data-filter="id=eq.{id}&next=not.is.null" data-empty="">
	                        <template data-item>
	                          <section class="round">
	                            <h3><span data-text="{msg.round}"></span> <span data-text="{next}"></span></h3>
	\((#GameList & {filter: "phase_id=eq.{phase_id}&round=eq.{next}", order: "day.asc,kickoff.asc", empty: "{msg.round_empty}", where: false}).out)
	                          </section>
	                        </template>
	                      </div>
	                    </div>
	                  </template>
	                </div>
	              </section>
	            </template>
	          </div>
	        </div>
	        <aside class="side">
	          <p><a data-route="campeonatos" data-text="{msg.back_catalog}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

// A directory: everything of one kind, narrowed by a name typed. The search is
// the tab's row of DirectoryFilter for this directory, written by a one-arrow
// machine (ir decision-catalog-tab).
#Directory: D={
	screen:       string
	row:          string
	table:        string
	route:        string
	select:       *"*" | string
	order:        *"name.asc" | string
	withCountry:  *false | bool
	withTeamType: *false | bool
	// A column marked `drop` is the one a phone does without.
	columns: [...{key: string, bind: string, drop: *false | bool}]
	_input: "\(D.row)-q"
	_machine: json.Marshal({
		field:   "state"
		initial: "browsing"
		context: {q: "", q_key: "", country: "", country_key: "", region_selection: "*", country_selection: "*", team_type: "club", offset: 0, next_offset: 40, page: 1}
		states: browsing: on: (#PageActions & {key: D.row}).out & {"input@\(D._input)": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}}
		if D.withTeamType {states: browsing: on: {
			"change@teams-type": assign: {team_type: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
		}}
		if D.withCountry {states: browsing: on: {
			"input@teams-country": assign: {country: {type: "event", params: field: "value"}, country_key: {type: "search-key"}, country_selection: "*", offset: 0, next_offset: 40, page: 1}
			"change@teams-region": assign: {region_selection: {type: "geography-selection"}, country_selection: "*", country: "", country_key: "", offset: 0, next_offset: 40, page: 1}
			"click@teams-country-all": assign: {country_selection: "*", country: "", country_key: "", offset: 0, next_offset: 40, page: 1}
		}}
	})
	_filter: "search_key=like.*{q_key}*\([if D.withCountry {"&country_search_key=like.*{country_key}*&region_id=like.{region_selection}&country_id=like.{country_selection}"}, ""][0])\([if D.withTeamType {"&team_type=eq.{team_type}"}, ""][0])"
	_type: [if D.withTeamType {"""
		            <label class="field" for="teams-type"><span data-text="{msg.teams_type}"></span>
		              <select id="teams-type" data-value="{team_type}"><option value="club" data-text="{msg.teams_clubs}"></option><option value="national" data-text="{msg.teams_national}"></option></select>
		            </label>
		"""}, ""][0]
	_country: [if D.withCountry {"""
			          <div class="geography-group">
			            <div class="field country-picker"><span id="teams-country-label" data-text="{msg.geography_country}"></span>
			              <button id="teams-country-open" type="button" class="country-open" command="toggle-popover" commandfor="teams-country-pop" aria-labelledby="teams-country-label teams-country-readout" aria-haspopup="dialog" aria-controls="teams-country-pop" data-country-selection="{country_selection}" data-country-query="{country}">
			                <span id="teams-country-readout" class="country-readout">
			                  <span class="country-all" data-text="{msg.geography_all_countries}"></span>
			                  <span class="country-query" data-text="{country}"></span>
			                  <span class="country-selected" data-live="geography_country" data-filter="id=eq.{country_selection}&limit=1" data-empty="" data-exit-motion="none"><template data-item><span data-text="{msg[message_key]}"></span></template></span>
			                </span>
			              </button>
			            </div>
			            <label class="field" for="teams-region"><span data-text="{msg.geography_region}"></span>
			              <select id="teams-region" data-value="{region_selection}"><option value="*" data-text="{msg.geography_world}"></option><optgroup data-live="geography_region" data-filter="limit=6" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{msg[message_key]}"></option></template></optgroup></select>
			            </label>
			            <div id="teams-country-pop" class="country-pop" popover role="dialog" aria-label="{msg.geography_country}">
			              <label class="field" for="teams-country"><span data-text="{msg.geography_search_country}"></span>
			                <input id="teams-country" type="text" role="searchbox" data-value="{country}" placeholder="{msg.geography_search_country}" maxlength="60" autocomplete="off" autofocus>
			              </label>
			              <button id="teams-country-all" type="button" class="country-option country-all-option" command="hide-popover" commandfor="teams-country-pop" data-text="{msg.geography_all_countries}"></button>
			              <div id="teams-country-options" class="country-options" data-live="geography_country" data-filter="region_id=like.{region_selection}&search_key=like.*{country_key}*&limit=250" data-order="name.asc" data-project='{"selected":{"eq":["id","{country_selection}"]}}' data-empty="{msg.geography_country_empty}">
			                <template data-item><button type="button" class="country-option" id="teams-country-option-{id}" value="{id}" aria-pressed="{selected}" data-on-click="country-option" command="hide-popover" commandfor="teams-country-pop" data-text="{msg[message_key]}"></button></template>
			              </div>
			            </div>
			          </div>
		"""}, ""][0]
	_head: strings.Join([for i, c in D.columns {
		"            <th scope=\"col\"\([if i > 0 {" class=\"narrow\([if c.drop {" drop"}, ""][0])\""}, ""][0]) data-text=\"{msg.col_\(c.key)}\"></th>"
	}], "\n")
	_cells: strings.Join([for i, c in D.columns {
		[
			if i == 0 && D.route == "equipe" {"                <td><a data-route=\"\(D.route)\" data-param-slug=\"{team.slug}\"><span class=\"archive-icon\" data-text=\"{id}|{name}|{team.logo_key}\" data-text-format=\"team-badge\"></span><span data-text=\"{\(c.bind)}\"></span></a></td>"},
			if i == 0 {"                <td><a data-route=\"\(D.route)\" data-param-slug=\"{slug}\" data-text=\"{\(c.bind)}\"></a></td>"},
			if c.bind == "country" {"                <td class=\"narrow\([if c.drop {" drop"}, ""][0])\"><span class=\"archive-icon\" data-text=\"{country}\" data-text-format=\"country-flag\"></span><span data-text=\"{country}|{msg.geography_names}\" data-text-format=\"geography-label\"></span></td>"},
			"                <td class=\"narrow\([if c.drop {" drop"}, ""][0])\" data-text=\"{\(c.bind)}\"></td>",
		][0]
	}], "\n")
	out: """
		<section class="screen" data-screen="\(D.screen)">
		\((#Masthead & {route: D.screen}).out)
		<h1 class="band" data-text="{msg.\(D.row)_title}"></h1>
		<div class="page">
		  <div class="content" data-live="directory_filter" data-filter="id=eq.\(D.row)" data-machine='\(D._machine)'>
		    <template data-item>
		      <div class="catalog">
		        <div class="filters" role="search">
		          <label class="field grow" for="\(D._input)"><span data-text="{msg.search_label}"></span>
		            <input id="\(D._input)" type="search" value="{q}" placeholder="{msg.\(D.row)_placeholder}" maxlength="80" autocomplete="off">
		          </label>
		\(D._country)
		\(D._type)
		        </div>
		        <table class="grid catalog-table">
		          <thead><tr>
		\(D._head)
		          </tr></thead>
		          <tbody data-live="\(D.table)" data-select="\(D.select)" data-filter="\(D._filter)&offset={offset}&limit=40" data-order="\(D.order)" data-empty="{msg.\(D.row)_empty}">
		            <template data-item>
		              <tr>
		\(D._cells)
		              </tr>
		            </template>
		          </tbody>
		        </table>
		\((#PageArrows & {key: D.row, table: D.table, filter: D._filter, order: D.order}).out)
		      </div>
		    </template>
		  </div>
		  <aside class="side"><p data-text="{msg.about}"></p></aside>
		</div>
		</section>
		"""
}

_equipesMarkup: (#Directory & {screen: "equipes", row: "teams", table: "team_directory", select: "*,team:id(slug,logo_key)", route: "equipe", order: "rating.desc.nullslast,name.asc,id.asc", withCountry: true, withTeamType: true, columns: [{key: "team", bind: "name"}, {key: "rating", bind: "rating_display"}, {key: "city", bind: "city", drop: true}, {key: "country", bind: "country"}]}).out
_estadiosMarkup: (#Directory & {screen: "estadios", row: "stadiums", table: "stadium", route: "estadio", columns: [{key: "stadium", bind: "name"}, {key: "city", bind: "city"}, {key: "country", bind: "country", drop: true}]}).out
_arbitrosMarkup: (#Directory & {screen: "arbitros", row: "referees", table: "referee", route: "arbitro", columns: [{key: "referee", bind: "name"}, {key: "from", bind: "location"}]}).out

// One team's games from its own side: when, where, home or away, the
// opponent, its score first, and how it went.
#TeamGames: T={
	filter: string
	order:  string
	empty:  string
	// Only a played game has an outcome to name.
	played: bool
	_outcome: [if T.played {"<i class=\"outcome\" title=\"{msg[result]}\"></i><span class=\"visually-hidden\" data-text=\"{msg[result]}\"></span>"}, ""][0]
	out: """
		<ol class="games team-games" data-live="team_game" data-select="*,game:game_id(slug),championship(show_country,slug),opponent:opponent_id(country,logo_key)" data-filter="\(T.filter)" data-order="\(T.order)" data-empty="\(T.empty)">
		  <template data-item>
		    <li><a class="game-row" data-show-country="{championship.show_country}" data-route="jogo" data-param-slug="{game.slug}" data-played="{played}" data-result="{result}">
		      <span class="when"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span>
		      <span class="where" data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span>
		      <span class="home"><span class="team-name"><span class="venue" data-text="{msg[side]}"></span> <span data-text="{opponent_name}"></span></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{opponent.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{opponent_id}|{opponent_name}|{opponent.logo_key}" data-text-format="team-badge"></span></span></span>
		      <span class="score"><b data-text="{goals_for}"></b><i>x</i><b data-text="{goals_against}"></b></span>
		      <span class="away">\(T._outcome)</span>
		    </a></li>
		  </template>
		</ol>
		"""
}

// A championship-scoped archive lists each fixture once in the match's own
// home/away order, regardless of which side the selected team played.
#TeamChampionshipGames: T={
	filter: string
	order:  string
	empty:  string
	played: bool
	_outcome: [if T.played {"<i class=\"outcome\" title=\"{msg[result]}\" aria-hidden=\"true\"></i><span class=\"visually-hidden\" data-text=\"{msg[result]}\"></span>"}, ""][0]
	_score: [if T.played {"<b data-text=\"{game.home_score}\"></b><i aria-hidden=\"true\">x</i><b data-text=\"{game.away_score}\"></b>"}, "<span class=\"fixture-score-placeholder\" aria-hidden=\"true\">–</span>"][0]
	_scoreLabel: [if T.played {" aria-label=\"{msg.team_home} {game.home.name} {game.home_score} x {game.away_score} {msg.team_away} {game.away.name}\""}, " aria-label=\"{msg.team_home} {game.home.name} x {msg.team_away} {game.away.name}\""][0]
	out: """
		<div class="table-wrap">
		  <table class="grid team-fixture-table">
		    <thead><tr><th scope="col" class="fixture-date-head" data-text="{msg.team_date}"></th><th scope="col" class="fixture-home-head" data-text="{msg.team_home}"></th><th scope="col" class="fixture-score-head"><span class="visually-hidden" data-text="{msg.team_score}"></span></th><th scope="col" class="fixture-away-head" data-text="{msg.team_away}"></th><th scope="col" class="fixture-result-head"><span class="visually-hidden" data-text="{msg.team_result}"></span></th></tr></thead>
		    <tbody data-live="team_game" data-select="*,championship(show_country,slug),game:game_id(slug,home_id,away_id,home_score,away_score,home:home_id(name,country,slug,logo_key),away:away_id(name,country,slug,logo_key))" data-filter="\(T.filter)" data-order="\(T.order)" data-empty="\(T.empty)">
		      <template data-item>
		        <tr class="game-row fixture-row" data-game-id="{game_id}" data-show-country="{championship.show_country}" data-played="\(T.played)" data-side="{side}" data-result="{result}">
		          <td class="fixture-date"><a data-route="jogo" data-param-slug="{game.slug}"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></a></td>
		          <td class="home"><span class="fixture-team"><a class="team-name" title="{game.home.name}" data-route="equipe-campeonato" data-param-slug="{game.home.slug}" data-param-championship="{param.championship}" data-text="{game.home.name}"></a><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{game.home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{game.home_id}|{game.home.name}|{game.home.logo_key}" data-text-format="team-badge"></span></span></span></td>
		          <td class="score"><a data-route="jogo" data-param-slug="{game.slug}"\(T._scoreLabel)>\(T._score)</a></td>
		          <td class="away"><span class="fixture-team"><span class="team-icons"><span class="archive-icon team-badge" data-text="{game.away_id}|{game.away.name}|{game.away.logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{game.away.country}" data-text-format="country-flag"></span></span><a class="team-name" title="{game.away.name}" data-route="equipe-campeonato" data-param-slug="{game.away.slug}" data-param-championship="{param.championship}" data-text="{game.away.name}"></a></span></td>
		          <td class="fixture-result">\(T._outcome)</td>
		        </tr>
		      </template>
		    </tbody>
		  </table>
		</div>
		"""
}

#TeamProfileChampionships: P={
	key:      string
	filter:   string
	order:    string
	empty:    string
	_content: """
	<ul class="team-championship-list" data-live="team_championship" data-select="*,team(slug,logo_key),championship(slug)" data-filter="\(P.filter)&offset={offset}&limit=40" data-order='\(P.order)' data-empty="\(P.empty)">
	  <template data-item><li><a data-route="equipe-campeonato" data-param-slug="{team.slug}" data-param-championship="{championship.slug}"><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span><span class="chip" data-text="{msg[status]}"></span></a></li></template>
	</ul>
	"""
	out: (#PagedRead & {key: P.key, owner: "{id}", table: "team_championship", filter: P.filter, order: P.order, content: P._content}).out
}

#TeamProfilePlayers: P={
	key:      string
	filter:   string
	order:    string
	empty:    string
	_content: """
	<ul class="team-player-list" data-live="team_player_history" data-select="*,player(slug)" data-filter="\(P.filter)&search_key=like.*{q_key}*&offset={offset}&limit=40" data-order='\(P.order)' data-empty="\(P.empty)">
	  <template data-item><li><a data-route="jogador" data-param-slug="{player.slug}"><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{player_name}"></span> <small data-text="{position}"></small></a></li></template>
	</ul>
	"""
	out: (#PagedRead & {key: P.key, owner: "{id}", table: "team_player_history", filter: P.filter + "&search_key=like.*{q_key}*", order: P.order, content: P._content, context: {q: "", q_key: ""}, events: {("input@\(P.key)-q"): assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}}, controls: "<label class=\"team-filter\"><span data-text=\"{msg.team_player_search}\"></span><input id=\"\(P.key)-q\" type=\"search\" value=\"{q}\" maxlength=\"80\"></label>"}).out
}

_teamRosterColumns: [
	{key: "player", bind: "player_name", cls: "name", link: "player_id"},
	{key: "pos", bind: "position", cls: "num"},
	{key: "played", bind: "played", cls: "num"},
	{key: "started", bind: "started", cls: "num wide"},
	{key: "came_on", bind: "came_on", cls: "num wide"},
	{key: "bench", bind: "bench", cls: "num wide"},
	{key: "minutes", bind: "minutes", cls: "num wide"},
	{key: "goals", bind: "goals", cls: "num"},
	{key: "goals_per90", bind: "goals_per90", cls: "num wide"},
	{key: "contribution", bind: "contribution", cls: "num wide"},
	{key: "contribution_per90", bind: "contribution_per90", cls: "num wide"},
	{key: "off_rating", bind: "off_rating", cls: "num wide"},
	{key: "def_rating", bind: "def_rating", cls: "num wide"},
	{key: "penalties", bind: "penalties", cls: "num wide"},
	{key: "own_goals", bind: "own_goals", cls: "num wide"},
	{key: "yellow", bind: "yellow", cls: "num wide"},
	{key: "red", bind: "red", cls: "num wide"},
]

#TeamRosterPage: R={
	filter: string
	order:  string
	empty:  string
	out:    """
	<div class="table-wrap"><table class="grid squad-table"><thead><tr>\(_teamRosterHead)</tr></thead>
	<tbody data-live="team_roster" data-select="*,player(slug)" data-filter="\(R.filter)" data-order='\(R.order)' data-empty="\(R.empty)"><template data-item><tr>\(_teamRosterCells)</tr></template></tbody><tfoot data-live="team_roster_total" data-filter="team_id=eq.{owner_id}&championship_id=eq.{championship_id}&limit=1" data-empty=""><template data-item><tr>\(_teamRosterTotalCells)</tr></template></tfoot></table></div>
	"""
}

_teamRosterHead: strings.Join([for c in _teamRosterColumns {
	"<th scope=\"col\" class=\"\(c.cls)\"><abbr title=\"{msg.col_\(c.key)_long}\" data-text=\"{msg.col_\(c.key)}\"></abbr></th>"
}], "")

_teamRosterCells: strings.Join([for c in _teamRosterColumns {
	[
		if c.link != _|_ {"<td class=\"\(c.cls)\"><a data-route=\"jogador-campeonato\" data-param-team=\"{param.slug}\" data-param-championship=\"{param.championship}\" data-param-slug=\"{player.slug}\" data-text=\"{\(c.bind)}\"></a></td>"},
		"<td class=\"\(c.cls)\" data-text=\"{\(c.bind)}\"\([if c.bind != "position" {" data-text-format=\"number\""}, ""][0])></td>",
	][0]
}], "")

_teamRosterTotalCells: strings.Join([for c in _teamRosterColumns {[
	if c.link != _|_ {"<th scope=\"row\" class=\"\(c.cls)\" data-text=\"{msg.team_total}\"></th>"},
	if c.bind == "position" {"<td class=\"\(c.cls)\"></td>"},
	"<td class=\"\(c.cls)\" data-text=\"{\(c.bind)}\" data-text-format=\"number\"></td>",
][0]}], "")

#TeamGameArchive: G={
	key:    string
	played: bool
	scoped: *false | bool
	_scope: [if G.scoped {"&championship_id=eq.{championship_id}"}, ""][0]
	_filter: "team_id=eq.{owner_id}&played=is.\(G.played)&side=like.{side}&phase_key=like.{phase}" + G._scope + [if !G.scoped {"&category_key=like.{category}"}, ""][0]
	_order: [if G.played {"day.desc,kickoff.desc,id.asc"}, "day.asc,kickoff.asc,id.asc"][0]
	_controls: """
 <div class="team-filters">
 \([if !G.scoped {"""
 <label><span data-text="{msg.team_category}"></span><select id="\(G.key)-category" data-value="{category}"><option value="*" data-text="{msg.all}"></option><option value="professional" data-text="{msg.team_professional}"></option><optgroup data-live="category" data-filter="id=not.is.null&limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select></label>
 """}, ""][0])
 <label><span data-text="{msg.team_venue}"></span><select id="\(G.key)-side" data-value="{side}"><option value="*" data-text="{msg.all}"></option><option value="home" data-text="{msg.home}"></option><option value="away" data-text="{msg.away}"></option></select></label>
 \([if G.scoped {"""
 <label><span data-text="{msg.team_phase}"></span><select id="\(G.key)-phase" data-value="{phase}"><option value="*" data-text="{msg.all}"></option><optgroup data-live="phase" data-filter="championship_id=eq.{championship_id}&limit=100" data-order="position.asc,id.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select></label>
 """}, ""][0])
 </div>
 """
	out: (#PagedRead & {key: G.key, owner: [if G.scoped {"{team_id}"}, "{id}"][0], scope: [if G.scoped {"-championship-{championship_id}"}, ""][0], table: "team_game", filter: G._filter, order: G._order, context: {category: "*", side: "*", phase: "*", if G.scoped {championship_id: "{championship_id}"}}, events: {for f in [if !G.scoped {"category"}, "side", "phase"] {("change@\(G.key)-\(f)"): assign: {(f): {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}}}, controls: G._controls, content: [if G.scoped {(#TeamChampionshipGames & {filter: G._filter + "&offset={offset}&limit=40", order: G._order, empty: [if G.played {"{msg.games_none_results}"}, "{msg.games_none_upcoming}"][0], played: G.played}).out}, (#TeamGames & {filter: G._filter + "&offset={offset}&limit=40", order: G._order, empty: [if G.played {"{msg.games_none_results}"}, "{msg.games_none_upcoming}"][0], played: G.played}).out][0]}).out
}

_teamCommentMachine: json.Marshal({field: "state", initial: "writing", context: {body: ""}, on: refused: target: "refused", states: {writing: on: {"input@team-comment-body": _type, "click@team-comment-post": {target: "sending", effect: {level: "replicated", op: "create", entity: "team_comment", values: {team_id: "{id}", body: "{body}"}}}}, sending: on: sync_ack: {target: "writing", assign: body: ""}, refused: on: {"input@team-comment-body": _type & {target: "writing"}, "click@team-comment-post": {target: "sending", effect: {level: "replicated", op: "create", entity: "team_comment", values: {team_id: "{id}", body: "{body}"}}}}}})
_teamComments:      """
 <section class="comments"><h2 data-text="{msg.comments_title}"></h2>
 <div class="composer" data-live="team_comment_draft" data-filter="id=eq.{id}" data-machine='\(_teamCommentMachine)' data-state="{state}"><label class="field" for="team-comment-body"><span data-text="{msg.comment_label}"></span><textarea id="team-comment-body" data-value="{body}" maxlength="1000" rows="3" placeholder="{msg.team_comment_placeholder}"></textarea></label><p class="refusal" role="alert" data-text="{msg.comment_refused}"></p><button id="team-comment-post" type="button" class="btn post"><span class="idle" data-text="{msg.comment_post}"></span><span class="busy" data-text="{msg.comment_posting}"></span></button></div>
 \((#PagedRead & {key: "team-comments", owner: "{id}", table: "team_comment", filter: "team_id=eq.{owner_id}", order: "created_at.desc,id.asc", content: """
	<ol class="comment-list" data-live="team_comment" data-select="*,app_user(handle)" data-filter="team_id=eq.{owner_id}&offset={offset}&limit=40" data-order="created_at.desc,id.asc" data-empty="{msg.team_comment_empty}"><template data-item><li><p class="byline"><a data-route="usuario" data-param-id="{app_user_id}" data-text="{app_user.handle}"></a> <time data-text="{created_at}" data-text-format="datetime"></time></p><p class="body" data-text="{body}"></p>\((#CommunityCommentDelete & {table: "team_comment"}).out)</li></template></ol>
	"""}).out)
 </section>
 """
_teamRatingHistory: """
 <section class="team-rating-history"><h2 data-text="{msg.team_rating_history}"></h2>
 \((#PagedRead & {key: "team-rating-history", owner: "{id}", table: "team_rating", filter: "team_id=eq.{owner_id}", order: "measure_date.desc,id.asc", context: {period: "1y", date_from: "", date_to: "", series_json: "{}"}, events: {"change@team-rating-period": assign: {period: {type: "event", params: field: "value"}, date_from: "", date_to: ""}, "change@team-rating-from": assign: {date_from: {type: "event", params: field: "value"}, period: "all"}, "change@team-rating-to": assign: {date_to: {type: "event", params: field: "value"}, period: "all"}, "click@team-rating-reset": assign: {period: "1y", date_from: "", date_to: ""}}, controls: """
	<div class="team-filters"><label><span data-text="{msg.team_period}"></span><select id="team-rating-period" data-value="{period}"><option value="1m" data-text="{msg.period_1m}"></option><option value="3m" data-text="{msg.period_3m}"></option><option value="6m" data-text="{msg.period_6m}"></option><option value="1y" data-text="{msg.period_1y}"></option><option value="5y" data-text="{msg.period_5y}"></option><option value="all" data-text="{msg.all}"></option></select></label><label><span data-text="{msg.team_date_from}"></span><input id="team-rating-from" type="date" value="{date_from}"></label><label><span data-text="{msg.team_date_to}"></span><input id="team-rating-to" type="date" value="{date_to}"></label><button id="team-rating-reset" class="btn-quiet" type="button" data-text="{msg.team_chart_reset}"></button></div>
	""", content: """
	<div class="team-chart-source" data-live="team_rating_chart" data-filter="team_id=eq.{owner_id}&period=eq.{period}" data-on-mutation="team-rating-series" data-read-view="archive_page?id=eq.team-rating-history-{owner_id}"><template data-item><span hidden></span></template></div>
	<div data-text="{series_json}\u001f{msg.team_rating_history}\u001f{msg.chart_locale}\u001f{msg.team_history_none}\u001fdate\u001f{date_from}\u001f{date_to}\u001f{msg.team_chart_invalid_range}" data-text-format="team-chart"></div>
	<p class="team-chart-note" data-text="{msg.team_chart_sample}"></p>
	<details><summary data-text="{msg.team_history_table}"></summary><table class="grid"><thead><tr><th data-text="{msg.team_date}"></th><th data-text="{msg.team_rating}"></th><th data-text="{msg.col_off_rating}"></th><th data-text="{msg.col_def_rating}"></th></tr></thead><tbody data-live="team_rating" data-filter="team_id=eq.{owner_id}&offset={offset}&limit=40" data-order="measure_date.desc,id.asc" data-empty="{msg.team_history_none}"><template data-item><tr><th scope="row" data-text="{measure_date}"></th><td data-text="{rating}" data-text-format="number"></td><td data-text="{offense}" data-text-format="number"></td><td data-text="{defense}" data-text-format="number"></td></tr></template></tbody></table></details>
	"""}).out)
 </section>
 """

_teamRosterOrder: #"{"by":"{sort}","of":{"name":"player_name.asc,player_id.asc","played":"played.desc.nullslast,player_name.asc,player_id.asc","minutes":"minutes.desc.nullslast,player_name.asc,player_id.asc","goals":"goals.desc.nullslast,player_name.asc,player_id.asc","goals_per90":"goals_per90.desc.nullslast,player_name.asc,player_id.asc","contribution":"contribution.desc.nullslast,player_name.asc,player_id.asc","contribution_per90":"contribution_per90.desc.nullslast,player_name.asc,player_id.asc"}}"#

_teamRosterArchive: """
 \((#PagedRead & {key: "team-roster", owner: "{team_id}", scope: "-championship-{championship_id}", table: "team_roster", filter: "team_id=eq.{owner_id}&championship_id=eq.{championship_id}&search_key=like.*{q_key}*", order: _teamRosterOrder, context: {q: "", q_key: "", sort: "name", championship_id: "{championship_id}"}, events: {"input@team-roster-q": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}, "change@team-roster-sort": assign: {sort: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}}, controls: """
	<div class="team-filters"><label><span data-text="{msg.team_player_search}"></span><input id="team-roster-q" type="search" value="{q}" maxlength="80"></label><label><span data-text="{msg.team_sort}"></span><select id="team-roster-sort" data-value="{sort}"><option value="name" data-text="{msg.col_player}"></option><option value="played" data-text="{msg.col_played_long}"></option><option value="minutes" data-text="{msg.col_minutes_long}"></option><option value="goals" data-text="{msg.col_goals_long}"></option><option value="goals_per90" data-text="{msg.col_goals_per90_long}"></option><option value="contribution" data-text="{msg.col_contribution_long}"></option><option value="contribution_per90" data-text="{msg.col_contribution_per90_long}"></option></select></label></div>
	""", content: (#TeamRosterPage & {filter: "team_id=eq.{owner_id}&championship_id=eq.{championship_id}&search_key=like.*{q_key}*&offset={offset}&limit=40", order: _teamRosterOrder, empty: "{msg.team_no_roster}"}).out}).out)
 <p class="team-chart-note" data-text="{msg.team_contribution_note}"></p>

 """

_teamCampaign: """
 <section class="team-campaign"><h2 data-text="{msg.team_progress}"></h2><p class="team-chart-note" data-text="{msg.team_progress_note}"></p>
 <div data-live="team_group" data-select="*,group:stage_group!inner(name,slug,phase!inner(name,championship_id))" data-filter="team_id=eq.{team_id}&group.phase.championship_id=eq.{championship_id}" data-order="group_id.asc" data-empty="{msg.team_no_table}"><template data-item><section class="team-group-card"><h3><span data-text="{group.phase.name}"></span> · <span data-text="{group.name}"></span></h3>
 <div data-live="team_chart_state" data-filter="id=eq.{group_id}:{team_id}" data-machine='{"field":"metric","initial":"points","context":{"group_id":"{group_id}","team_id":"{team_id}","compare_id":"{team_id}","series_json":"{}","game_prefix":"{msg.chart_game_prefix}"},"on":{"change":{"assign":{"compare_id":{"type":"chart-compare"}}}},"states":{"points":{}}}' data-empty-row='{"id":"{group_id}:{team_id}","group_id":"{group_id}","team_id":"{team_id}","compare_id":"{team_id}","metric":"points","series_json":"{}","game_prefix":"{msg.chart_game_prefix}"}' data-on-mutation="team-chart-seed" data-read-stored="team_chart_state?id=eq.{id}">
 <div class="team-filters"><label><span data-text="{msg.team_compare}"></span><select data-value="{compare_id}"><optgroup data-live="standing" data-select="*,team(slug,logo_key)" data-filter="group_id=eq.{group_id}&limit=250" data-order="team_name.asc,team_id.asc" data-empty=""><template data-item><option value="{team_id}" data-text="{team_name}"></option></template></optgroup></select></label></div>
 <div data-text="{series_json}\u001f{msg.team_progress}\u001f{msg.chart_locale}\u001f{msg.team_history_none}\u001fcombined\u001f\u001f\u001f\u001f{msg.col_points_long}\u001f{msg.col_position_long}" data-text-format="team-chart"></div>
 <div class="team-chart-source" data-live="team_campaign_point" data-select="*,team(name),game(slug)" data-filter="group_id=eq.{group_id}&team_id=in.({team_id},{compare_id})&limit=800" data-order="sequence.asc,team_id.asc" data-on-mutation="team-chart-fold" data-read-view="team_chart_state?id=eq.{id}" data-read-memberships="team_group?group_id=eq.{group_id}&limit=250"><template data-item><span hidden></span></template></div>
 \((#PagedRead & {key: "team-campaign-history", owner: "{team_id}", scope: "-{group_id}", context: {phase: "{group_id}"}, table: "team_campaign_point", filter: "group_id=eq.{phase}&team_id=eq.{owner_id}", order: "sequence.asc", content: """
	<details><summary data-text="{msg.team_history_table}"></summary><table class="grid"><thead><tr><th data-text="{msg.team_date}"></th><th data-text="{msg.col_points}"></th><th data-text="{msg.col_position}"></th><th data-text="{msg.team_fixtures}"></th></tr></thead><tbody data-live="team_campaign_point" data-select="*,game(slug)" data-filter="group_id=eq.{phase}&team_id=eq.{owner_id}&offset={offset}&limit=40" data-order="sequence.asc" data-empty="{msg.team_history_none}"><template data-item><tr><th scope="row" data-text="{day}"></th><td data-text="{points}"></td><td data-text="{position}"></td><td><a data-route="jogo" data-param-slug="{game.slug}" data-text="{sequence}"></a></td></tr></template></tbody></table></details>
	"""}).out)
 </div></section></template></div></section>
 """

// One tab row joins a team's current position odds with its recorded history.
// Each source region re-folds it; the machine keeps the reader's selections.
_teamOddsEvolution: """
	<div class="team-odds-current" data-live="team_odds_progress_state" data-filter="id=eq.{group_id}:{team_id}" data-empty-row='{"id":"{group_id}:{team_id}","group_id":"{group_id}","team_id":"{team_id}","state":"viewing","zone_id":"*","snapshot_index":-1,"snapshot_last":0,"pointer_x":1000,"series_json":"{}","current_json":"{}","position_number":-1,"position_last":0,"table_mode":"current","range_from":"","range_to":""}' data-machine='{"field":"state","initial":"viewing","context":{"group_id":"{group_id}","team_id":"{team_id}","zone_id":"*","snapshot_index":-1,"snapshot_last":0,"pointer_x":1000,"series_json":"{}","current_json":"{}","position_number":-1,"position_last":0,"table_mode":"current","range_from":"","range_to":""},"on":{"input":{"assign":{"snapshot_index":{"type":"odds-progress-snapshot"},"position_number":{"type":"position-odds-control","params":{"field":"position_number"}}}},"click":[{"guard":{"type":"chart-position-bound","params":{"operation":"matches","suffix":"-reset"}},"assign":{"range_from":"","range_to":""}},{"assign":{"zone_id":{"type":"odds-progress-zone"}}}],"change":{"assign":{"zone_id":{"type":"odds-progress-zone"},"table_mode":{"type":"position-odds-control","params":{"field":"table_mode"}},"range_from":{"type":"chart-position-bound","params":{"field":"range_from","suffix":"-from"}},"range_to":{"type":"chart-position-bound","params":{"field":"range_to","suffix":"-to"}}}},"pointermove":{"guard":{"type":"position-odds-control","params":{"field":"guard-pointer"}},"assign":{"snapshot_index":{"type":"odds-progress-point"},"position_number":{"type":"position-odds-control","params":{"field":"position_number"}},"pointer_x":{"type":"event","params":{"field":"pointerX"}}}},"pointerdown":{"guard":{"type":"position-odds-control","params":{"field":"guard-pointer"}},"assign":{"snapshot_index":{"type":"odds-progress-point"},"position_number":{"type":"position-odds-control","params":{"field":"position_number"}},"pointer_x":{"type":"event","params":{"field":"pointerX"}}}}},"states":{"viewing":{}}}' data-on-mutation="position-odds-fold" data-read-view="team_odds_progress_state?id=eq.{id}" data-read-positions="position_chance?group_id=eq.{group_id}&team_id=eq.{team_id}&order=position.asc&limit=250" data-read-zones="zone?group_id=eq.{group_id}&order=first.asc,last.asc,id.asc&limit=250" data-read-history="team_odds_progress?group_id=eq.{group_id}&team_id=eq.{team_id}&order=group_id.asc,team_id.asc&limit=1">
	<div class="position-odds-graph" id="position-graph-{group_id}-{team_id}" data-text="{current_json}\u001f{series_json}\u001f{msg.team_position_odds}\u001f{msg.chart_locale}\u001f{msg.team_no_odds}\u001f{position_number}\u001f{snapshot_index}\u001f{table_mode}\u001fgraph\u001f{msg.col_position_long}\u001f{msg.col_probability}\u001f{msg.team_odds_current_position}\u001f{msg.team_date}\u001f{msg.team_odds_current}\u001f{msg.team_odds_recorded}\u001f{msg.impossible}\u001f{msg.reachable}\u001f{msg.undecided}\u001f{msg.team_history_none}\u001f{range_from}\u001f{range_to}\u001f{msg.team_selected_probability}\u001f{msg.team_chart_invalid_range}" data-text-format="position-odds"></div>
	<div class="position-odds-controls"><div class="position-odds-inspection" data-text="{current_json}\u001f{series_json}\u001f{msg.team_position_odds}\u001f{msg.chart_locale}\u001f{msg.team_no_odds}\u001f{position_number}\u001f{snapshot_index}\u001f{table_mode}\u001finspector\u001f{msg.col_position_long}\u001f{msg.col_probability}\u001f{msg.team_odds_current_position}\u001f{msg.team_date}\u001f{msg.team_odds_current}\u001f{msg.team_odds_recorded}\u001f{msg.impossible}\u001f{msg.reachable}\u001f{msg.undecided}\u001f{msg.team_history_none}\u001f{range_from}\u001f{range_to}\u001f{msg.team_selected_probability}\u001f{msg.team_chart_invalid_range}" data-text-format="position-odds"></div><label class="position-odds-slider" data-last="{position_last}"><span data-text="{msg.col_position_long}"></span><input id="position-slider-{group_id}-{team_id}" type="range" min="1" max="{position_last}" step="1" data-value="{position_number}" aria-label="{msg.col_position_long}"></label></div>
	<div class="team-filters"><label><span data-text="{msg.team_position_from}"></span><input id="{id}-from" type="number" inputmode="numeric" min="1" max="250" step="1" data-value="{range_from}"></label><label><span data-text="{msg.team_position_to}"></span><input id="{id}-to" type="number" inputmode="numeric" min="1" max="250" step="1" data-value="{range_to}"></label><button id="{id}-reset" class="btn-quiet" type="button" data-text="{msg.team_chart_reset}"></button></div>
	<details class="odds-position-data"><summary data-text="{msg.team_odds_values}"></summary><label class="odds-values-select"><span data-text="{msg.team_odds_values_from}"></span><select id="odds-values-{group_id}-{team_id}" data-value="{table_mode}"><option value="current" data-text="{msg.team_odds_current}"></option><option value="history" data-text="{msg.team_odds_recorded}"></option></select></label><div class="odds-progress-table" data-text="{current_json}\u001f{series_json}\u001f{msg.team_position_odds}\u001f{msg.chart_locale}\u001f{msg.team_no_odds}\u001f{position_number}\u001f{snapshot_index}\u001f{table_mode}\u001ftable\u001f{msg.col_position_long}\u001f{msg.col_probability}\u001f{msg.team_odds_current_position}\u001f{msg.team_date}\u001f{msg.team_odds_current}\u001f{msg.team_odds_recorded}\u001f{msg.impossible}\u001f{msg.reachable}\u001f{msg.undecided}\u001f{msg.team_history_none}\u001f{range_from}\u001f{range_to}\u001f{msg.team_selected_probability}\u001f{msg.team_chart_invalid_range}" data-text-format="position-odds"></div></details>
	<section class="team-odds-evolution"><h4 data-text="{msg.team_odds_history}"></h4><p class="team-chart-note" data-text="{msg.team_zone_history_note}"></p>
	<p class="team-chart-note" id="odds-help-{group_id}-{team_id}" data-text="{msg.team_odds_inspect}"></p>
	<div class="odds-progress-graph" id="odds-graph-{group_id}-{team_id}" role="group" aria-label="{msg.team_odds_history}" aria-describedby="odds-help-{group_id}-{team_id}" data-text="{series_json}\u001f{msg.team_odds_history}\u001f{msg.chart_locale}\u001f{msg.team_history_none}\u001f{zone_id}\u001f{snapshot_index}\u001f{msg.chart_game_prefix}\u001f{msg.team_history_table}\u001f{msg.col_position_long}\u001f{msg.team_odds_sampled}\u001f{msg.team_odds_omitted}\u001fgraph\u001f{msg.team_date}\u001f{msg.team_odds_last_game}\u001f{msg.team_odds_no_game}" data-text-format="odds-progress"></div>
	<div class="odds-progress-controls"><div class="odds-progress-zones" role="group" aria-label="{msg.chances_zones}"><label class="odds-progress-zone"><input type="radio" name="odds-zone-{group_id}" value="*" data-value="{zone_id}"><span data-text="{msg.team_odds_all}"></span></label><div data-live="zone" data-filter="group_id=eq.{group_id}&limit=50" data-order="first.asc,last.asc,id.asc" data-project='{"selected_zone":{"eq":["id","{zone_id}"]}}' data-empty=""><template data-item><label class="odds-progress-zone"><input type="radio" name="odds-zone-{group_id}" value="{id}" checked="{selected_zone}"><i class="odds-progress-swatch" data-zone="{color}" style="--zone-source: {color}" aria-hidden="true"></i><span data-text="{name}"></span></label></template></div></div><label class="odds-progress-date"><span data-text="{msg.team_odds_snapshot}"></span><input id="odds-date-{group_id}-{team_id}" type="range" min="0" max="{snapshot_last}" step="1" data-value="{snapshot_index}" aria-label="{msg.team_odds_snapshot}"></label></div>
	<div class="odds-progress-inspection" data-text="{series_json}\u001f{msg.team_odds_history}\u001f{msg.chart_locale}\u001f{msg.team_history_none}\u001f{zone_id}\u001f{snapshot_index}\u001f{msg.chart_game_prefix}\u001f{msg.team_history_table}\u001f{msg.col_position_long}\u001f{msg.team_odds_sampled}\u001f{msg.team_odds_omitted}\u001finspector\u001f{msg.team_date}\u001f{msg.team_odds_last_game}\u001f{msg.team_odds_no_game}" data-text-format="odds-progress"></div>
	</section>
	<div class="team-chart-source" data-live="team_odds_progress" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}&limit=1" data-order="group_id.asc,team_id.asc" data-on-mutation="position-odds-fold" data-read-view="team_odds_progress_state?id=eq.{id}" data-read-positions="position_chance?group_id=eq.{group_id}&team_id=eq.{team_id}&order=position.asc&limit=250" data-read-zones="zone?group_id=eq.{group_id}&order=first.asc,last.asc,id.asc&limit=250" data-read-history="team_odds_progress?group_id=eq.{group_id}&team_id=eq.{team_id}&order=group_id.asc,team_id.asc&limit=1"><template data-item><span hidden></span></template></div>
	<div class="team-chart-source" data-live="position_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}&limit=250" data-order="position.asc" data-on-mutation="position-odds-fold" data-read-view="team_odds_progress_state?id=eq.{id}" data-read-positions="position_chance?group_id=eq.{group_id}&team_id=eq.{team_id}&order=position.asc&limit=250" data-read-zones="zone?group_id=eq.{group_id}&order=first.asc,last.asc,id.asc&limit=250" data-read-history="team_odds_progress?group_id=eq.{group_id}&team_id=eq.{team_id}&order=group_id.asc,team_id.asc&limit=1"><template data-item><span hidden></span></template></div>
	<div class="team-chart-source" data-live="zone" data-filter="group_id=eq.{group_id}&limit=250" data-order="first.asc,last.asc,id.asc" data-on-mutation="position-odds-fold" data-read-view="team_odds_progress_state?id=eq.{id}" data-read-positions="position_chance?group_id=eq.{group_id}&team_id=eq.{team_id}&order=position.asc&limit=250" data-read-zones="zone?group_id=eq.{group_id}&order=first.asc,last.asc,id.asc&limit=250" data-read-history="team_odds_progress?group_id=eq.{group_id}&team_id=eq.{team_id}&order=group_id.asc,team_id.asc&limit=1"><template data-item><span hidden></span></template></div>
	</div>
	"""

_equipeMarkup: """
	<section class="screen" data-screen="equipe">
	\((#Masthead & {route: "equipe", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="team" data-filter="slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.team_gone}">
	  <template data-item>
	    <article class="team">
	      <h1 class="band"><span class="archive-icon" data-text="{id}|{name}|{logo_key}" data-text-format="team-badge"></span><span data-text="{name}"></span></h1>
	      <div class="page">
	        <div class="content">
	          <div class="community-media" data-text="{logo_key}" data-text-format="media-image"></div>
	          <dl class="game-facts">
	            <dt data-text="{msg.team_full_name}"></dt><dd data-text="{full_name}"></dd>
	            <dt data-text="{msg.team_city}"></dt><dd data-text="{city}"></dd>
	            <dt data-text="{msg.team_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}|{msg.geography_names}" data-text-format="geography-label"></span></dd>
	            <dt data-text="{msg.team_founded}"></dt><dd data-text="{foundation_display}"></dd>
	            <dt data-text="{msg.team_rating}"></dt><dd class="rating" data-live="team_rating" data-filter="team_id=eq.{id}&limit=1" data-order="measure_date.desc,id.asc" data-empty=""><template data-item><abbr title="{msg.team_rating_long}" data-text="{rating}" data-text-format="number"></abbr></template></dd>
	            <dt data-text="{msg.game_stadium}"></dt><dd data-live="stadium" data-filter="id=eq.{stadium_id}" data-empty=""><template data-item><a data-route="estadio" data-param-slug="{slug}" data-text="{name}"></a></template></dd>
	          </dl>
	          <div data-text="{latitude}|{longitude}|{msg.team_location}|{msg.team_location_none}" data-text-format="team-location"></div>
	          \(_teamRatingHistory)
	          <section><h2 data-text="{msg.games_upcoming}"></h2>\((#TeamGameArchive & {key: "team-upcoming", played: false}).out)</section>
	          <section><h2 data-text="{msg.games_results}"></h2>\((#TeamGameArchive & {key: "team-results", played: true}).out)</section>
	          <section class="team-current-championships">
	            <h2 data-text="{msg.team_current_championships}"></h2>
	            \((#TeamProfileChampionships & {key: "team-current-championships", filter: "team_id=eq.{owner_id}&status=neq.past", order: "status.asc,begins.desc,championship_id.asc", empty: "{msg.team_no_current_championships}"}).out)
	          </section>
	          <section class="team-past-championships">
	            <h2 data-text="{msg.team_past_championships}"></h2>
	            \((#TeamProfileChampionships & {key: "team-past-championships", filter: "team_id=eq.{owner_id}&status=eq.past", order: "begins.desc,championship_id.asc", empty: "{msg.team_no_past_championships}"}).out)
	          </section>
	          <section class="team-current-players">
	            <h2 data-text="{msg.team_current_players}"></h2>
	            \((#TeamProfilePlayers & {key: "team-current-players", filter: "team_id=eq.{owner_id}&is_current=is.true", order: "player_name.asc,player_id.asc", empty: "{msg.team_no_current_players}"}).out)
	          </section>
	          <section class="team-past-players">
	            <h2 data-text="{msg.team_past_players}"></h2>
	            \((#TeamProfilePlayers & {key: "team-past-players", filter: "team_id=eq.{owner_id}&is_current=is.false", order: "player_name.asc,player_id.asc", empty: "{msg.team_no_past_players}"}).out)
	          </section>

	          \(_teamComments)
	        </div>
	        <aside class="side">
	          <p><a data-route="equipes" data-text="{msg.back_teams}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

_equipe_campeonatoMarkup: """
	<section class="screen" data-screen="equipe-campeonato">
	\((#Masthead & {route: "equipe-campeonato", params: " data-param-slug=\"{param.slug}\" data-param-championship=\"{param.championship}\""}).out)
	<div class="team-membership" data-live="team_championship" data-select="*,team:team!inner(id,name,slug,logo_key),championship!inner(slug)" data-filter="team.slug=eq.{param.slug}&championship.slug=eq.{param.championship}" data-exit-motion="none" data-empty="{msg.team_championship_gone}">
	  <template data-item>
	    <article class="team-championship team-championship-page">
	      <h1 class="band"><span class="archive-icon" data-text="{team.id}|{team.name}|{team.logo_key}" data-text-format="team-badge"></span><span data-text="{team.name}"></span><small data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></small></h1>
	      <div class="page">
	        <div class="content">
	          <div class="team-championship-links"><a class="btn-quiet" data-route="equipe" data-param-slug="{team.slug}"><span data-text="{msg.back_team_profile}"></span></a><span class="chip" data-text="{msg[status]}"></span></div>
	          <form class="team-switch" data-action="navigate" data-route="equipe-campeonato" data-param-slug="{param.slug}" data-param-championship="{param.championship}"><input type="hidden" name="championship" value="{param.championship}"><label><span data-text="{msg.team_switch}"></span><select name="slug" data-value="{param.slug}"><optgroup data-live="team_championship" data-select="*,team(name,slug)" data-filter="championship_id=eq.{championship_id}&limit=250" data-order="team_id.asc" data-empty=""><template data-item><option value="{team.slug}" data-text="{team.name}"></option></template></optgroup></select></label><button type="submit" class="btn-quiet" data-text="{msg.team_open}"></button></form>
	          <nav class="team-section-links" aria-label="{msg.team_section_links}"><a href="#team-fixtures" data-text="{msg.team_fixtures}"></a><a href="#team-table" data-text="{msg.team_table}"></a><a href="#team-roster" data-text="{msg.team_roster}"></a><a href="#team-odds" data-text="{msg.team_odds}"></a></nav>
	          <section id="team-fixtures" class="team-next">
	            <h2 data-text="{msg.games_upcoming}"></h2>
	\((#TeamGameArchive & {key: "team-championship-upcoming", played: false, scoped: true}).out)
	          </section>
	          <section class="team-results">
	            <h2 data-text="{msg.games_results}"></h2>
	\((#TeamGameArchive & {key: "team-championship-results", played: true, scoped: true}).out)
	          </section>
	          <section id="team-table" class="team-standings">
	            <h2 data-text="{msg.team_table}"></h2>
	            <div class="team-group" data-live="team_group" data-select="*,group:stage_group!inner(name,slug,phase!inner(name,championship_id))" data-filter="team_id=eq.{team_id}&group.phase.championship_id=eq.{championship_id}" data-order="group_id.asc" data-empty="{msg.team_no_table}">
	              <template data-item><section class="team-group-card"><h3><span data-text="{group.phase.name}"></span> · <span data-text="{group.name}"></span></h3><div class="table-wrap"><table class="grid standings"><thead><tr>\(_standingsHead)</tr></thead><tbody data-live="standing" data-select="*,team(slug,logo_key)" data-project='{"current":{"eq":["team_id","{team_id}"]}}' data-filter="group_id=eq.{group_id}" data-order="position.asc,id.asc" data-empty="{msg.no_teams}"><template data-item><tr data-zone="{zone}" style="--zone-source: {zone}" data-current="{current}">\(_championshipStandingsCells)</tr></template></tbody></table></div><div class="team-full-group"><a data-route="chances" data-param-slug="{group.slug}" data-text="{msg.chances_link}"></a></div></section></template>
	            </div>
	          </section>
	          <section id="team-roster" class="team-roster">
	            <h2 data-text="{msg.team_roster}"></h2>
	\(_teamRosterArchive)
	          </section>
	          \(_teamCampaign)
	          <section id="team-odds" class="team-odds">
	            <h2 data-text="{msg.team_odds}"></h2>
	            <div class="team-group-odds" data-live="team_group" data-select="*,group:stage_group!inner(name,slug,phase!inner(name,championship_id))" data-filter="team_id=eq.{team_id}&group.phase.championship_id=eq.{championship_id}" data-order="group_id.asc" data-empty="{msg.team_no_odds}">
	              <template data-item><section class="team-group-card"><h3><span data-text="{group.phase.name}"></span> · <span data-text="{group.name}"></span></h3><div data-live="team_chance" data-select="*,team(slug,logo_key),group:group_id(slug)" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}&limit=1" data-order="rank.asc,id.asc" data-empty="{msg.team_no_odds}"><template data-item><div class="team-chance-detail"><p class="team-odds-summary"><span data-text="{msg.col_position}"></span> <b data-text="{rank}"></b><span data-text="{msg.col_points}"></span> <b data-text="{points}"></b><span data-text="{msg.col_played}"></span> <b data-text="{played}"></b></p><div class="team-zone-odds" data-live="zone_chance" data-select="*,zone:zone_id(name)" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}" data-order="first.asc,last.asc" data-empty=""><template data-item><p><span><i class="odds-progress-swatch" data-zone="{color}" style="--zone-source: {color}" aria-hidden="true"></i> <span data-text="{zone.name}"></span></span> <span class="title-chance" data-band="{band}"><span class="bar" aria-hidden="true"><i></i></span><span data-text="{percent}" data-text-format="number"></span>%<span class="reach" data-reach="{reach}" title="{msg[reach]}" aria-hidden="true"></span><span class="visually-hidden" data-text="{msg[reach]}"></span></span></p></template></div><p><a data-route="chances" data-param-slug="{group.slug}" data-text="{msg.chances_link}"></a></p></div></template></div>\(_teamOddsEvolution)</section></template>
	            </div>
	          </section>
	        </div>
	        <aside class="side"><p><a data-route="equipe" data-param-slug="{team.slug}" data-text="{msg.back_team_profile}"></a></p><p data-text="{msg.about}"></p></aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

_estadioMarkup: """
	<section class="screen" data-screen="estadio">
	\((#Masthead & {route: "estadio", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="stadium" data-filter="slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.stadium_gone}">
	  <template data-item>
	    <article class="venue">
	      <h1 class="band" data-text="{name}"></h1>
	      <div class="page">
	        <div class="content">
	          <dl class="game-facts">
	            <dt data-text="{msg.team_full_name}"></dt><dd data-text="{full_name}"></dd>
	            <dt data-text="{msg.col_city}"></dt><dd data-text="{city}"></dd>
	            <dt data-text="{msg.col_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}|{msg.geography_names}" data-text-format="geography-label"></span></dd>
	          </dl>
	          <section class="home-teams">
	            <h2 data-text="{msg.stadium_teams}"></h2>
	            <ul class="chips" data-live="team" data-filter="stadium_id=eq.{id}" data-order="name.asc" data-empty="{msg.stadium_no_teams}">
	              <template data-item><li><a class="chip" data-route="equipe" data-param-slug="{slug}"><span class="archive-icon" data-text="{id}|{name}|{logo_key}" data-text-format="team-badge"></span><span data-text="{name}"></span></a></li></template>
	            </ul>
	          </section>
	          <section class="venue-games">
	            <h2 data-text="{msg.stadium_games}"></h2>
	\((#PagedRead & {key: "stadium-history", table: "game_card", filter: "stadium_id=eq.{owner_id}", order: "day.desc,kickoff.desc", content: (#GameList & {filter: "stadium_id=eq.{owner_id}&offset={offset}&limit=40", order: "day.desc,kickoff.desc", empty: "{msg.stadium_no_games}"}).out}).out)
	          </section>
	        </div>
	        <aside class="side">
	          <p><a data-route="estadios" data-text="{msg.back_stadiums}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""

_arbitroMarkup: """
	<section class="screen" data-screen="arbitro">
	\((#Masthead & {route: "arbitro", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="referee" data-filter="slug=eq.{param.slug}" data-exit-motion="none" data-empty="{msg.referee_gone}">
	  <template data-item>
	    <article class="venue">
	      <h1 class="band" data-text="{name}"></h1>
	      <div class="page">
	        <div class="content">
	          <dl class="game-facts">
	            <dt data-text="{msg.col_from}"></dt><dd data-text="{location}"></dd>
	          </dl>
	          <section class="venue-games">
	            <h2 data-text="{msg.referee_games}"></h2>
	\((#PagedRead & {key: "referee-history", table: "game_card", filter: "referee_id=eq.{owner_id}", order: "day.desc,kickoff.desc", content: (#GameList & {filter: "referee_id=eq.{owner_id}&offset={offset}&limit=40", order: "day.desc,kickoff.desc", empty: "{msg.referee_no_games}"}).out}).out)
	          </section>
	        </div>
	        <aside class="side">
	          <p><a data-route="arbitros" data-text="{msg.back_referees}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	</section>
	"""
