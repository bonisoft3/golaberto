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
		  <ul class="champ-list" data-live="championship" data-filter="region=eq.\(R.region)&limit=6" data-order="begins.desc" data-empty="{msg.home_empty}">
		    <template data-item>
		      <li><a data-route="campeonato" data-param-id="{id}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}"></span></a></li>
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

_standingsCells: strings.Join(list.Concat([[for c in _standings {
	[
		if c.link != _|_ {"\t                                <td class=\"\(c.cls)\"><a data-route=\"equipe\" data-param-id=\"{\(c.link)}\"><span class=\"archive-icon\" data-text=\"{\(c.link)}|{\(c.bind)}\" data-text-format=\"team-badge\"></span><span data-text=\"{\(c.bind)}\"></span></a></td>"},
		"\t                                <td class=\"\(c.cls)\" data-text=\"{\(c.bind)}\"></td>",
	][0]
}], ["\t                                <td class=\"form wide\">" + strings.Join([for i in [1, 2, 3, 4, 5] {"<i data-result=\"{form\(i)}\" title=\"{msg[form\(i)]}\"></i>"}], "") + "</td>"]]), "\n")


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
	key: string
	table: string
	filter: string
	order: string
	out: """
	<nav class="archive-pager" data-page-offset="{offset}" aria-label="{msg.archive_pages}">
	  <button id="\(P.key)-previous" type="button" class="btn-quiet page-previous" data-text="{msg.page_previous}"></button>
	  <span class="page-status"><span data-text="{msg.page_label}"></span> <b data-text="{page}" data-text-format="number"></b></span>
	  <span data-live="\(P.table)" data-filter="\(P.filter)&amp;offset={next_offset}&amp;limit=1" data-order="\(P.order)" data-empty=""><template data-item><i data-next-page hidden></i></template></span>
	  <button id="\(P.key)-next" type="button" class="btn-quiet page-next" data-text="{msg.page_next}"></button>
	</nav>
	"""
}
#PagedRead: P={
	key: string
	table: string
	filter: string
	order: string
	owner: *"{id}" | string
	content: string
	_machine: json.Marshal({field: "state", initial: "browsing", context: {offset: 0, next_offset: 40, page: 1}, states: browsing: on: (#PageActions & {key: P.key}).out})
	out: """
	<div class="paged-read" data-live="archive_page" data-filter="id=eq.\(P.key)-\(P.owner)" data-machine='\(P._machine)' data-empty-row='{"id":"\(P.key)-\(P.owner)","owner_id":"\(P.owner)","offset":0,"next_offset":40,"page":1,"state":"browsing"}'>
	  <div class="page-window">
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
	context: {q: "", region: "", offset: 0, next_offset: 40, page: 1}
	states: browsing: on: (#PageActions & {key: "catalog"}).out & {
		"input@catalog-q": assign: {q: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
		"change@catalog-region": assign: {region: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
	}
})

// One game in a list: when, where it belongs, who played, the score. The row
// is a link to the game's page. It reads the game's card, its names written
// beside it (ir decision-local-reads); a list inside one championship leaves
// the championship out.
#GameList: G={
	table: *"game_card" | string
	filter: string
	order:  string
	empty:  string
	cls:    *"games" | string
	where:  *true | bool
	_where: [if G.where {"\n      <span class=\"where\" data-text=\"{championship_name}\"></span>"}, ""][0]
	out:    """
		<ol class="\(G.cls)" data-live="\(G.table)" data-select="*,championship(show_country),home:home_id(country),away:away_id(country)" data-filter="\(G.filter)" data-order="\(G.order)" data-empty="\(G.empty)">
		  <template data-item>
		    <li><a class="game-row" data-show-country="{championship.show_country}" data-route="jogo" data-param-id="{id}" data-played="{played}">
		      <span class="when"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span>\(G._where)
		      <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}" data-text-format="team-badge"></span></span></span>
		      <span class="score"><b data-text="{home_score}"></b><i>x</i><b data-text="{away_score}"></b></span>
		      <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{away.country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
		    </a></li>
		  </template>
		</ol>
		"""
}

// A selected card marks each championship once; its nested list reads only
// that championship's already-selected games, retaining the global feed cap.
#HomeGameFeed: H={
	feed: "upcoming" | "recent"
	played: string
	empty: string
	out: """
		<div class="home-championships" data-live="home_game_card" data-filter="home_\(H.feed)_group=is.true&amp;limit=20" data-order="home_\(H.feed)_rank.asc" data-empty="\(H.empty)" data-exit-motion="none">
		  <template data-item>
		    <section class="home-championship" data-championship="{championship_id}">
		      <h3><a data-route="campeonato" data-param-id="{championship_id}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}"></span></a></h3>
		\((#GameList & {table: "home_game_card", filter: "championship_id=eq.{championship_id}&played=is.\(H.played)&home_\(H.feed)_rank=gt.0&limit=20", order: "home_\(H.feed)_rank.asc", empty: "", where: false}).out)
		    </section>
		  </template>
		</div>
		"""
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
	"change@edit-stadium":   {assign: stadium_id: "blank-null"}
	"input@edit-stadium-q": {assign: stadium_q: {type: "event", params: field: "value"}}
	"change@edit-referee":   {assign: referee_id: "blank-null"}
	"input@edit-referee-q": {assign: referee_q: {type: "event", params: field: "value"}}
	"input@goal-minute":     {assign: goal_minute: "count-or-null"}
	"change@goal-player":    {assign: goal_player_id: "blank-null"}
	"click@edit-save": {target: "saving", effect: {level: "replicated", op: "update", entity: "game", values: {
		id: "{id}", played: "{played}", home_score: "{home_score}", away_score: "{away_score}",
		attendance: "{attendance}", stadium_id: "{stadium_id}", referee_id: "{referee_id}"}}}
	for s in ["home", "away"] {
		"click@goal-add-\(s)": {
			effect: {level: "replicated", op: "create", entity: "goal", values: {
				game_id: "{id}", side: s, minute: "{goal_minute}", player_id: "{goal_player_id}"}}
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
		  <ol class="goal-rows" data-live="goal" data-select="*,player(name)" data-filter="game_id=eq.{id}&side=eq.\(G.side)" data-order="aet.asc,minute.asc" data-empty="{msg.game_no_goals}">
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
	\((#Masthead & {route: "editar", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="game_card" data-select="*,championship(show_country),home:home_id(country),away:away_id(country)" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.game_gone}">
	  <template data-item>
	    <article class="game">
	      <h1 class="band"><a data-route="campeonato" data-param-id="{championship_id}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}"></span></a></h1>
	      <div class="page">
	        <div class="content">
	          <div data-live="game_edit" data-filter="id=eq.{id}" data-machine='\(_editMachine)'
	               data-empty-row='{"id":"{id}","state":"editing","played":"{played}","home_score":"{home_score}","away_score":"{away_score}","attendance":"{attendance}","stadium_id":"{stadium_id}","referee_id":"{referee_id}","goal_minute":null,"goal_player_id":null,"home_name":"{home_name}","away_name":"{away_name}","stadium_q":"","referee_q":""}'>
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
	                  <select id="edit-stadium" data-value="{stadium_id}"><option value="" data-text="{msg.edit_unknown}"></option><optgroup data-live="stadium" data-filter="id=eq.{stadium_id}" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup><optgroup data-live="stadium" data-filter="name=ilike.*{stadium_q}*&limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select>
	                </label>
	                <label class="field wide" for="edit-referee"><span data-text="{msg.game_referee}"></span>
	                  <input id="edit-referee-q" type="search" value="{referee_q}" placeholder="{msg.choice_search}" aria-label="{msg.game_referee}" maxlength="80" autocomplete="off">
	                  <select id="edit-referee" data-value="{referee_id}"><option value="" data-text="{msg.edit_unknown}"></option><optgroup data-live="referee" data-filter="id=eq.{referee_id}" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup><optgroup data-live="referee" data-filter="name=ilike.*{referee_q}*&limit=40" data-order="name.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select>
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
	                  <select id="goal-player" data-value="{goal_player_id}"><option value="" data-text="{msg.edit_goal_choose}"></option><optgroup data-live="player_game" data-select="*,player(name)" data-filter="game_id=eq.{id}" data-order="side.desc,bench.asc,on_minute.asc" data-empty=""><template data-item><option value="{player_id}" data-text="{player.name}"></option></template></optgroup></select>
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
	                <a class="btn-quiet cancel" data-route="jogo" data-param-id="{param.id}" data-text="{msg.edit_back}"></a>
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
// fixed cells, each in the row's own grid.
_chancesMarkup: """
	<section class="screen" data-screen="chances">
	\((#Masthead & {route: "chances", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="stage_group" data-select="*,phase(name,championship_id)" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.chances_gone}">
	  <template data-item>
	    <article class="chances-page">
	      <h1 class="band" data-live="championship" data-filter="id=eq.{phase.championship_id}" data-empty=""><template data-item><a data-route="campeonato" data-param-id="{id}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}"></span></a></template></h1>
	      <div class="page">
	        <div class="content">
	          <div class="chances-head">
	            <h2 data-text="{msg.chances_title}"></h2>
	            <p><span data-text="{phase.name}"></span> · <span data-text="{name}"></span> · <span data-text="{msg.chances_seasons}"></span></p>
	          </div>
	          <section class="chances-sec" data-live="team_chance" data-filter="group_id=eq.{id}&rank=eq.1" data-empty="{msg.chances_none}">
	            <template data-item>
	              <div class="chances-tables">
	                <h3 data-text="{msg.chances_zones}"></h3>
	                <div class="table-wrap" tabindex="0" role="region" aria-label="{msg.chances_zones}">
	                  <div class="grid-table zone-odds" role="table">
	                    <div class="row head" role="row">
	                      <span class="pos" role="columnheader">#</span><span class="name" role="columnheader" data-text="{msg.col_team}"></span><span class="pts" role="columnheader" data-text="{msg.col_points}"></span>
	                      <span class="cells" data-live="zone" data-filter="group_id=eq.{group_id}" data-order="first.asc,last.asc" data-empty=""><template data-item><span class="zone" role="columnheader" data-zone="{color}"><i aria-hidden="true"></i><span data-text="{name}"></span><small data-text="{first}–{last}"></small></span></template></span>
	                    </div>
	                    <div class="rows" data-live="team_chance" data-filter="group_id=eq.{group_id}" data-order="rank.asc" data-empty="">
	                      <template data-item>
	                        <div class="row" role="row">
	                          <span class="pos" role="cell" data-text="{rank}"></span><span class="name" role="rowheader"><a data-route="equipe" data-param-id="{team_id}"><span class="archive-icon" data-text="{team_id}|{team_name}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></span><span class="pts" role="cell" data-text="{points}"></span>
	                          <span class="cells" data-live="zone_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}" data-order="first.asc,last.asc" data-empty=""><template data-item><span class="pct" role="cell" data-zone="{color}" data-band="{band}"><span data-text="{percent}" data-text-format="number"></span>\(_reachMark)</span></template></span>
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
	                    <div class="rows" data-live="team_chance" data-filter="group_id=eq.{group_id}" data-order="rank.asc" data-empty="">
	                      <template data-item>
	                        <div class="row" role="row">
	                          <span class="pos" role="cell" data-text="{rank}"></span><span class="name" role="rowheader"><a data-route="equipe" data-param-id="{team_id}"><span class="archive-icon" data-text="{team_id}|{team_name}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></span>
	                          <span class="cells" data-live="position_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}" data-order="position.asc" data-empty=""><template data-item><span class="heat-cell" role="cell" data-band="{band}" data-current="{current}" title="{percent}%"><span class="visually-hidden" data-text="{percent}" data-text-format="number"></span>\(_reachMark)</span></template></span>
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
	\((#Masthead & {route: "jogo", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="game_card" data-select="*,championship(show_country),home:home_id(country),away:away_id(country)" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.game_gone}">
	  <template data-item>
	    <article class="game" data-played="{played}">
	      <h1 class="band"><a data-route="campeonato" data-param-id="{championship_id}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}"></span></a></h1>
	      <div class="page">
	        <div class="content">
	          <div class="game-head">
	            <p class="phase-name" data-text="{phase_name}"></p>
	            <div class="edit-gate" data-live="editor" data-empty=""><template data-item><a class="btn-quiet edit-link" data-route="editar" data-param-id="{param.id}" data-text="{msg.edit_link}"></a></template></div>
	          </div>
	          <div class="scoreboard" data-show-country="{championship.show_country}">
	            <a class="home" data-route="equipe" data-param-id="{home_id}"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}" data-text-format="team-badge"></span></span></a>
	            <span class="score"><b data-text="{home_score}"></b><i>x</i><b data-text="{away_score}"></b></span>
	            <a class="away" data-route="equipe" data-param-id="{away_id}"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{away.country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></a>
	          </div>
	          <p class="extra"><span class="aet"><span data-text="{msg.game_aet}"></span> <b data-text="{home_aet}"></b>–<b data-text="{away_aet}"></b></span> <span class="pen"><span data-text="{msg.game_pen}"></span> <b data-text="{home_pen}"></b>–<b data-text="{away_pen}"></b></span></p>
	          <dl class="game-facts">
	            <dt data-text="{msg.game_round}"></dt><dd data-text="{round}"></dd>
	            <dt data-text="{msg.game_day}"></dt><dd data-text="{day_display}"></dd>
	            <dt data-text="{msg.game_kickoff}"></dt><dd data-text="{kickoff_local}"></dd>
	            <dt data-text="{msg.game_stadium}"></dt><dd><a data-route="estadio" data-param-id="{stadium_id}" data-text="{stadium_name}"></a></dd>
	            <dt data-text="{msg.game_referee}"></dt><dd><a data-route="arbitro" data-param-id="{referee_id}" data-text="{referee_name}"></a></dd>
	            <dt data-text="{msg.game_attendance}"></dt><dd data-text="{attendance}" data-text-format="number"></dd>
	            <dt data-text="{msg.game_importance}"></dt><dd class="importance" data-live="game_importance" data-filter="id=eq.{id}" data-empty=""><template data-item><abbr title="{msg.game_importance_long}"><span data-text="{home}" data-text-format="number"></span> · <span data-text="{away}" data-text-format="number"></span></abbr></template></dd>
	          </dl>
	          <section class="goals-sec">
	            <h2 data-text="{msg.game_goals}"></h2>
	            <ol class="goals" data-live="goal" data-select="*,player(name)" data-filter="game_id=eq.{id}" data-order="aet.asc,minute.asc" data-empty="{msg.game_no_goals}">
	              <template data-item>
	                <li data-side="{side}" data-penalty="{penalty}" data-own-goal="{own_goal}"><span class="minute" data-text="{minute}"></span> <a data-route="jogador" data-param-id="{player_id}" data-text="{player.name}"></a> <span class="mark pen" data-text="{msg.goal_pen}"></span><span class="mark og" data-text="{msg.goal_og}"></span></li>
	              </template>
	            </ol>
	          </section>
	          <section class="lineups">
	            <h2 data-text="{msg.game_lineups}"></h2>
	            <div class="sides">
	              \((_lineup & {side: "home"}).out)
	              \((_lineup & {side: "away"}).out)
	            </div>
	          </section>
	        </div>
	        <aside class="side">
	          <p><a data-route="jogos" data-text="{msg.back_games}"></a></p>
	          <p data-text="{msg.about}"></p>
	        </aside>
	      </div>
	    </article>
	  </template>
	</div>
	  <section class="comments page-tail">
	    <h2 data-text="{msg.comments_title}"></h2>
	    <div class="composer" data-live="comment_draft" data-filter="id=eq.{param.id}" data-machine='\(_composerMachine)' data-state="{state}">
	      <label class="field" for="comment-body"><span data-text="{msg.comment_label}"></span>
	        <textarea id="comment-body" data-value="{body}" maxlength="1000" rows="3" placeholder="{msg.comment_placeholder}"></textarea>
	      </label>
	      <p class="refusal" role="alert" data-text="{msg.comment_refused}"></p>
	      <button id="comment-post" type="button" class="btn post"><span class="idle" data-text="{msg.comment_post}"></span><span class="busy" data-text="{msg.comment_posting}"></span></button>
	    </div>
	\((#PagedRead & {key: "game-comments", owner: "{param.id}", table: "comment", filter: "game_id=eq.{owner_id}", order: "created_at.desc", content: _game_commentsMarkup}).out)
	  </section>
	</section>
	"""

_game_commentsMarkup: """
	    <ol class="comment-list" data-live="comment" data-select="*,app_user(handle)" data-filter="game_id=eq.{owner_id}&amp;offset={offset}&amp;limit=40" data-order="created_at.desc" data-empty="{msg.comments_none}">
	      <template data-item>
	        <li><p class="byline"><b data-text="{app_user.handle}"></b> <time data-text="{created_at}" data-text-format="datetime"></time></p><p class="body" data-text="{body}"></p></li>
	      </template>
	    </ol>
	"""

_lineup: L={
	side: string
	out:  """
		<table class="grid lineup" data-side="\(L.side)">
		  <caption data-text="{\(L.side)_name}"></caption>
		  <thead><tr><th scope="col" data-text="{msg.col_player}"></th><th scope="col" class="num"><abbr title="{msg.col_position_long}" data-text="{msg.col_pos}"></abbr></th><th scope="col" class="num" data-text="{msg.col_on}"></th><th scope="col" class="num" data-text="{msg.col_off}"></th><th scope="col"><span class="visually-hidden" data-text="{msg.col_cards}"></span></th></tr></thead>
		  <tbody data-live="player_game" data-select="*,player(name,position)" data-filter="game_id=eq.{id}&side=eq.\(L.side)" data-order="bench.asc,on_minute.asc" data-empty="{msg.game_no_lineup}">
		    <template data-item>
		      <tr data-yellow="{yellow}" data-red="{red}" data-bench="{bench}"><td><a data-route="jogador" data-param-id="{player_id}" data-text="{player.name}"></a></td><td class="num" data-text="{player.position}"></td><td class="num" data-text="{on_minute}"></td><td class="num" data-text="{off_minute}"></td><td class="cards"><i class="yellow" title="{msg.card_yellow}"></i><i class="red" title="{msg.card_red}"></i></td></tr>
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
	            <h2><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}"></span></h2>
	            <a data-route="campeonato" data-param-id="{id}" data-text="{msg.home_table_link}"></a>
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
	                          <tbody data-live="standing" data-filter="group_id=eq.{id}&position=lte.6" data-order="position.asc" data-empty="{msg.no_teams}">
	                            <template data-item>
	                              <tr data-zone="{zone}">
	\(_standingsCells)
	                                <td class="odds"><span data-live="zone_chance" data-filter="group_id=eq.{group_id}&team_id=eq.{team_id}&color=eq.champion" data-empty=""><template data-item><span class="title-chance" data-band="{band}"><span class="bar" aria-hidden="true"><i></i></span><span data-text="{percent}" data-text-format="number"></span>\(_reachMark)</span></template></span></td>
	                              </tr>
	                            </template>
	                          </tbody>
	                        </table>
	                      </div>
	                      <div class="top-foot" data-live="team_chance" data-filter="group_id=eq.{id}&rank=eq.1" data-empty=""><template data-item><a class="btn-quiet chances-link" data-route="chances" data-param-id="{group_id}" data-text="{msg.chances_link}"></a></template></div>
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
	\(strings.Join([for r in ["world", "continental", "national"] {(#Recent & {region: r}).out}], "\n"))
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
	          <tbody data-live="championship" data-filter="full_name=ilike.*{q}*&region=like.*{region}*&offset={offset}&limit=40" data-order="region_name.asc,name.asc,begins.desc" data-empty="{msg.catalog_empty}">
	            <template data-item>
	              <tr>
	                <td><a data-route="campeonato" data-param-id="{id}"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}"></span></a></td>
	                <td class="narrow" data-text="{msg[region]}"></td>
	                <td class="narrow"><span data-live="category" data-filter="id=eq.{category_id}" data-empty="{msg.professional}"><template data-item><span data-text="{name}"></span></template></span></td>
	              </tr>
	            </template>
	          </tbody>
	        </table>
	\((#PageArrows & {key: "catalog", table: "championship", filter: "full_name=ilike.*{q}*&region=like.*{region}*", order: "region_name.asc,name.asc,begins.desc"}).out)
	      </div>
	    </template>
	  </div>
	  <aside class="side"><p data-text="{msg.about}"></p></aside>
	</div>
	</section>
	"""

_campeonatoMarkup: """
	<section class="screen" data-screen="campeonato">
	\((#Masthead & {route: "campeonato", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="championship" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.championship_gone}">
	  <template data-item>
	    <article class="championship">
	      <h1 class="band"><span class="archive-icon" data-text="{region_name}" data-text-format="country-flag"></span><span data-text="{full_name}"></span></h1>
	      <div class="page">
	        <div class="content">
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
	                        <div data-live="team_chance" data-filter="group_id=eq.{id}&rank=eq.1" data-empty=""><template data-item><a class="btn-quiet chances-link" data-route="chances" data-param-id="{group_id}" data-text="{msg.chances_link}"></a></template></div>
	                      </div>
	                      <div class="table-wrap">
	                        <table class="grid standings">
	                          <thead><tr>
	\(_standingsHead)
	                          </tr></thead>
	                          <tbody data-live="standing" data-filter="group_id=eq.{id}" data-order="position.asc" data-empty="{msg.no_teams}">
	                            <template data-item>
	                              <tr data-zone="{zone}">
	\(_standingsCells)
	                              </tr>
	                            </template>
	                          </tbody>
	                        </table>
	                      </div>
	                      <ul class="zones" data-live="zone" data-filter="group_id=eq.{id}" data-order="first.asc,last.asc" data-empty="">
	                        <template data-item>
	                          <li data-zone="{color}"><i aria-hidden="true"></i><span data-text="{name}"></span> <span class="range" data-text="{first}–{last}"></span></li>
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
	screen:  string
	row:     string
	table:   string
	route:   string
	// A column marked `drop` is the one a phone does without.
	columns: [...{key: string, bind: string, drop: *false | bool}]
	_input:  "\(D.row)-q"
	_machine: json.Marshal({
		field:   "state"
		initial: "browsing"
		context: {q: "", offset: 0, next_offset: 40, page: 1}
		states: browsing: on: (#PageActions & {key: D.row}).out & {"input@\(D._input)": assign: {q: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}}
	})
	_head: strings.Join([for i, c in D.columns {
		"            <th scope=\"col\"\([if i > 0 {" class=\"narrow\([if c.drop {" drop"}, ""][0])\""}, ""][0]) data-text=\"{msg.col_\(c.key)}\"></th>"
	}], "\n")
	_cells: strings.Join([for i, c in D.columns {
		[
			if i == 0 && D.table == "team" {"                <td><a data-route=\"\(D.route)\" data-param-id=\"{id}\"><span class=\"archive-icon\" data-text=\"{id}|{name}\" data-text-format=\"team-badge\"></span><span data-text=\"{\(c.bind)}\"></span></a></td>"},
			if i == 0 {"                <td><a data-route=\"\(D.route)\" data-param-id=\"{id}\" data-text=\"{\(c.bind)}\"></a></td>"},
			if c.bind == "country" {"                <td class=\"narrow\([if c.drop {" drop"}, ""][0])\"><span class=\"archive-icon\" data-text=\"{country}\" data-text-format=\"country-flag\"></span><span data-text=\"{country}\"></span></td>"},
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
		        </div>
		        <table class="grid catalog-table">
		          <thead><tr>
		\(D._head)
		          </tr></thead>
		          <tbody data-live="\(D.table)" data-filter="name=ilike.*{q}*&offset={offset}&limit=40" data-order="name.asc" data-empty="{msg.\(D.row)_empty}">
		            <template data-item>
		              <tr>
		\(D._cells)
		              </tr>
		            </template>
		          </tbody>
		        </table>
		\((#PageArrows & {key: D.row, table: D.table, filter: "name=ilike.*{q}*", order: "name.asc"}).out)
		      </div>
		    </template>
		  </div>
		  <aside class="side"><p data-text="{msg.about}"></p></aside>
		</div>
		</section>
		"""
}

_equipesMarkup: (#Directory & {screen: "equipes", row: "teams", table: "team", route: "equipe", columns: [{key: "team", bind: "name"}, {key: "city", bind: "city"}, {key: "country", bind: "country", drop: true}]}).out
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
	out:    """
		<ol class="games team-games" data-live="team_game" data-select="*,championship(show_country),opponent:opponent_id(country)" data-filter="\(T.filter)" data-order="\(T.order)" data-empty="\(T.empty)">
		  <template data-item>
		    <li><a class="game-row" data-show-country="{championship.show_country}" data-route="jogo" data-param-id="{game_id}" data-played="{played}" data-result="{result}">
		      <span class="when"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span>
		      <span class="where" data-text="{championship_name}"></span>
		      <span class="home"><span class="team-name"><span class="venue" data-text="{msg[side]}"></span> <span data-text="{opponent_name}"></span></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{opponent.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{opponent_id}|{opponent_name}" data-text-format="team-badge"></span></span></span>
		      <span class="score"><b data-text="{goals_for}"></b><i>x</i><b data-text="{goals_against}"></b></span>
		      <span class="away">\(T._outcome)</span>
		    </a></li>
		  </template>
		</ol>
		"""
}

_squadColumns: [
	{key: "player", bind: "player_name", cls: "name", link: "player_id"},
	{key: "pos", bind: "position", cls: "num"},
	{key: "played", bind: "played", cls: "num"},
	{key: "started", bind: "started", cls: "num wide"},
	{key: "came_on", bind: "came_on", cls: "num wide"},
	{key: "minutes", bind: "minutes", cls: "num wide"},
	{key: "goals", bind: "goals", cls: "num"},
	{key: "yellow", bind: "yellow", cls: "num wide"},
	{key: "red", bind: "red", cls: "num wide"},
]

_squadHead: strings.Join([for c in _squadColumns {
	"<th scope=\"col\" class=\"\(c.cls)\"><abbr title=\"{msg.col_\(c.key)_long}\" data-text=\"{msg.col_\(c.key)}\"></abbr></th>"
}], "")

_squadCells: strings.Join([for c in _squadColumns {
	[
		if c.link != _|_ {"<td class=\"\(c.cls)\"><a data-route=\"jogador\" data-param-id=\"{\(c.link)}\" data-text=\"{\(c.bind)}\"></a></td>"},
		"<td class=\"\(c.cls)\" data-text=\"{\(c.bind)}\"></td>",
	][0]
}], "")

_equipeMarkup: """
	<section class="screen" data-screen="equipe">
	\((#Masthead & {route: "equipe", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="team" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.team_gone}">
	  <template data-item>
	    <article class="team">
	      <h1 class="band"><span class="archive-icon" data-text="{id}|{name}" data-text-format="team-badge"></span><span data-text="{name}"></span></h1>
	      <div class="page">
	        <div class="content">
	          <dl class="game-facts">
	            <dt data-text="{msg.team_full_name}"></dt><dd data-text="{full_name}"></dd>
	            <dt data-text="{msg.team_city}"></dt><dd data-text="{city}"></dd>
	            <dt data-text="{msg.team_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}"></span></dd>
	            <dt data-text="{msg.team_founded}"></dt><dd data-text="{foundation_display}"></dd>
	            <dt data-text="{msg.team_rating}"></dt><dd class="rating" data-live="team_rating" data-filter="team_id=eq.{id}&limit=1" data-order="measure_date.desc" data-empty=""><template data-item><abbr title="{msg.team_rating_long}" data-text="{rating}" data-text-format="number"></abbr></template></dd>
	            <dt data-text="{msg.game_stadium}"></dt><dd data-live="stadium" data-filter="id=eq.{stadium_id}" data-empty=""><template data-item><span data-text="{name}"></span></template></dd>
	          </dl>
	          <section class="team-next">
	            <h2 data-text="{msg.team_next}"></h2>
	\((#TeamGames & {filter: "team_id=eq.{id}&played=is.false&limit=5", order: "day.asc,kickoff.asc", empty: "{msg.games_none_upcoming}", played: false}).out)
	          </section>
	          <section class="team-results">
	            <h2 data-text="{msg.team_results}"></h2>
	\((#TeamGames & {filter: "team_id=eq.{id}&played=is.true&limit=10", order: "day.desc,kickoff.desc", empty: "{msg.games_none_results}", played: true}).out)
	          </section>
	          <section class="squads">
	            <h2 data-text="{msg.team_squads}"></h2>
	\((#PagedRead & {key: "team-squads", table: "player_stat", filter: "team_id=eq.{owner_id}", order: "championship_name.asc,played.desc,minutes.desc,player_name.asc", content: _team_squadsMarkup}).out)
	          </section>
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

_seasonColumns: [
	{key: "played", bind: "played"},
	{key: "started", bind: "started"},
	{key: "came_on", bind: "came_on"},
	{key: "minutes", bind: "minutes"},
	{key: "goals", bind: "goals"},
	{key: "penalties", bind: "penalties"},
	{key: "yellow", bind: "yellow"},
	{key: "red", bind: "red"},
]

_jogadorMarkup: """
	<section class="screen" data-screen="jogador">
	\((#Masthead & {route: "jogador", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="player" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.player_gone}">
	  <template data-item>
	    <article class="player">
	      <h1 class="band" data-text="{name}"></h1>
	      <div class="page">
	        <div class="content">
	          <dl class="game-facts">
	            <dt data-text="{msg.player_position}"></dt><dd data-text="{position}"></dd>
	            <dt data-text="{msg.player_rating}"></dt><dd class="rating" data-live="player_rating" data-filter="id=eq.{id}" data-empty=""><template data-item><abbr title="{msg.player_rating_long}" data-text="{rating}" data-text-format="number"></abbr></template></dd>
	            <dt data-text="{msg.team_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}"></span></dd>
	          </dl>
	          <section class="seasons">
	            <h2 data-text="{msg.player_seasons}"></h2>
	\((#PagedRead & {key: "player-seasons", table: "player_stat", filter: "player_id=eq.{owner_id}", order: "championship_name.asc,team_name.asc", content: _player_seasonsMarkup}).out)
	          </section>
	          <section class="appearances">
	            <h2 data-text="{msg.player_games}"></h2>
	\((#PagedRead & {key: "player-appearances", table: "player_game", filter: "player_id=eq.{owner_id}", order: "day.desc", content: _player_appearancesMarkup}).out)
	          </section>
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

_estadioMarkup: """
	<section class="screen" data-screen="estadio">
	\((#Masthead & {route: "estadio", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="stadium" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.stadium_gone}">
	  <template data-item>
	    <article class="venue">
	      <h1 class="band" data-text="{name}"></h1>
	      <div class="page">
	        <div class="content">
	          <dl class="game-facts">
	            <dt data-text="{msg.team_full_name}"></dt><dd data-text="{full_name}"></dd>
	            <dt data-text="{msg.col_city}"></dt><dd data-text="{city}"></dd>
	            <dt data-text="{msg.col_country}"></dt><dd><span class="archive-icon" data-text="{country}" data-text-format="country-flag"></span><span data-text="{country}"></span></dd>
	          </dl>
	          <section class="home-teams">
	            <h2 data-text="{msg.stadium_teams}"></h2>
	            <ul class="chips" data-live="team" data-filter="stadium_id=eq.{id}" data-order="name.asc" data-empty="{msg.stadium_no_teams}">
	              <template data-item><li><a class="chip" data-route="equipe" data-param-id="{id}"><span class="archive-icon" data-text="{id}|{name}" data-text-format="team-badge"></span><span data-text="{name}"></span></a></li></template>
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
	\((#Masthead & {route: "arbitro", params: " data-param-id=\"{param.id}\""}).out)
	<div data-live="referee" data-filter="id=eq.{param.id}" data-exit-motion="none" data-empty="{msg.referee_gone}">
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

_team_squadsMarkup: """
	            <table class="grid squad-table">
	              <thead><tr><th scope="col" class="champ" data-text="{msg.col_championship}"></th>\(_squadHead)</tr></thead>
	              <tbody data-live="player_stat" data-filter="team_id=eq.{owner_id}&offset={offset}&limit=40" data-order="championship_name.asc,played.desc,minutes.desc,player_name.asc" data-empty="{msg.team_no_squads}">
	                <template data-item><tr><td class="champ"><a data-route="campeonato" data-param-id="{championship_id}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}"></span></a></td>\(_squadCells)</tr></template>
	              </tbody>
	            </table>
	"""

_player_seasonsMarkup: """
	            <table class="grid season-table">
	              <thead><tr><th scope="col" data-text="{msg.col_championship}"></th><th scope="col" data-text="{msg.col_team}"></th>\(strings.Join([for c in _seasonColumns {"<th scope=\"col\" class=\"num\"><abbr title=\"{msg.col_\(c.key)_long}\" data-text=\"{msg.col_\(c.key)}\"></abbr></th>"}], ""))</tr></thead>
	              <tbody data-live="player_stat" data-filter="player_id=eq.{owner_id}&offset={offset}&limit=40" data-order="championship_name.asc,team_name.asc" data-empty="{msg.player_no_seasons}">
	                <template data-item>
	                  <tr><td><a data-route="campeonato" data-param-id="{championship_id}"><span class="archive-icon" data-text="{championship_name}" data-text-format="country-flag"></span><span data-text="{championship_name}"></span></a></td><td><a data-route="equipe" data-param-id="{team_id}"><span class="archive-icon" data-text="{team_id}|{team_name}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></td>\(strings.Join([for c in _seasonColumns {"<td class=\"num\" data-text=\"{\(c.bind)}\"></td>"}], ""))</tr>
	                </template>
	              </tbody>
	            </table>
	"""

_player_appearancesMarkup: """
	            <ol class="games player-games" data-live="player_game" data-filter="player_id=eq.{owner_id}&offset={offset}&limit=40" data-order="day.desc" data-empty="{msg.player_no_games}">
	              <template data-item>
	                <li data-bench="{bench}" data-yellow="{yellow}" data-red="{red}">
	                  <span data-live="game_card" data-select="*,championship(show_country),home:home_id(country),away:away_id(country)" data-filter="id=eq.{game_id}" data-empty=""><template data-item>
	                    <a class="game-row" data-show-country="{championship.show_country}" data-route="jogo" data-param-id="{id}" data-played="{played}">
	                      <span class="when"><span class="day" data-text="{day_display}"></span></span>
	                      <span class="where" data-text="{championship_name}"></span>
	                      <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{championship.show_country}|{home.country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}" data-text-format="team-badge"></span></span></span>
	                      <span class="score"><b data-text="{home_score}"></b><i>x</i><b data-text="{away_score}"></b></span>
	                      <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{championship.show_country}|{away.country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
	                    </a>
	                  </template></span>
	                  <span class="minutes"><span data-text="{on_minute}"></span>–<span data-text="{off_minute}"></span></span>
	                  <span class="cards"><i class="yellow" title="{msg.card_yellow}"></i><i class="red" title="{msg.card_red}"></i></span>
	                </li>
	              </template>
	            </ol>
	"""
