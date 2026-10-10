package golaberto

_archiveGameOrder: #"{"by":"{played}","of":{"true":"day.desc,kickoff.desc.nullslast,id.asc","false":"day.asc,kickoff.asc.nullslast,id.asc"}}"#

#ArchiveGameList: G={
	filter:     string
	order:      string
	attendance: *false | bool
	out:        """
	<ol class="games" data-live="game_archive" data-filter="\(G.filter)" data-order='\(G.order)' data-empty="{msg.archive_empty}">
	  <template data-item><li>
	    <a class="game-row" data-show-country="{show_country}" data-route="jogo" data-param-slug="{slug}" data-played="{played}">
	      <span class="when"><span class="day" data-text="{day_display}"></span><span class="hour" data-text="{kickoff_local}"></span></span>
	      <span class="where"><span data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span><br><small data-text="{phase_name}"></small></span>
	      <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{show_country}|{home_country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}|{home_logo_key}" data-text-format="team-badge"></span></span></span>
	      \(_matchScoreMarkup)
	      <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}|{away_logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{show_country}|{away_country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
	    </a>
	\([if G.attendance {"<p class=\"phase-name\"><span data-text=\"{msg.game_attendance}\"></span>: <b data-text=\"{attendance}\" data-text-format=\"number\"></b></p>"}, ""][0])
	  </li></template>
	</ol>
	"""
}

#ArchiveGames: A={
	key:    string
	scoped: *false | bool
	_filter: "played=is.{played}&category_key=like.{category}&week_key=like.{week}&round_key=like.{round}" + [if A.scoped {"&championship_id=eq.{owner_id}&phase_key=like.{phase}"}, ""][0]
	out: (#PagedRead & {
		key: A.key
		owner: [if A.scoped {"{id}"}, "00000000-0000-0000-0000-000000000000"][0]
		table:  "game_archive"
		filter: A._filter
		order:  _archiveGameOrder
		context: {category: "*", played: "true", week: "*", week_day: "", round: "*", round_value: "", phase: "*"}
		events: {
			for field in ["category", "played", if A.scoped {"phase"}] {
				("change@\(A.key)-\(field)"): assign: {(field): {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
			}
			("change@\(A.key)-week"): assign: {week: {type: "archive-week"}, week_day: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
			("change@\(A.key)-round"): assign: {round: {type: "archive-round"}, round_value: {type: "event", params: field: "value"}, offset: 0, next_offset: 40, page: 1}
			("click@\(A.key)-all-weeks"): assign: {week: "*", week_day: "", offset: 0, next_offset: 40, page: 1}
		}
		controls: """
		<div class="team-filters" role="search">
		  <label><span data-text="{msg.col_played}"></span><select id="\(A.key)-played" data-value="{played}"><option value="true" data-text="{msg.games_results}"></option><option value="false" data-text="{msg.games_upcoming}"></option></select></label>
		  <label><span data-text="{msg.team_category}"></span><select id="\(A.key)-category" data-value="{category}"><option value="*" data-text="{msg.all}"></option><option value="professional" data-text="{msg.team_professional}"></option><optgroup data-live="category" data-filter="limit=40" data-order="name.asc,id.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select></label>
		  <label><span data-text="{msg.archive_week}"></span><input id="\(A.key)-week" type="date" value="{week_day}" aria-describedby="\(A.key)-week-hint"></label>
		  <button id="\(A.key)-all-weeks" type="button" class="btn-quiet" data-text="{msg.archive_all_weeks}"></button>
		  <label><span data-text="{msg.archive_round}"></span><input id="\(A.key)-round" type="number" min="1" max="2147483647" step="1" placeholder="{msg.all}" value="{round_value}"></label>
		\([if A.scoped {"""
		  <label><span data-text="{msg.team_phase}"></span><select id="\(A.key)-phase" data-value="{phase}"><option value="*" data-text="{msg.all}"></option><optgroup data-live="phase" data-filter="championship_id=eq.{owner_id}&limit=100" data-order="position.asc,id.asc" data-empty=""><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select></label>
		"""}, ""][0])
		</div>
		<p id="\(A.key)-week-hint" class="empty" data-text="{msg.archive_week_hint}"></p>
		"""
		content: (#ArchiveGameList & {filter: A._filter + "&offset={offset}&limit=40", order: _archiveGameOrder}).out
	}).out
}

_archiveMarkup: """
	<section class="screen" data-screen="arquivo">
	\((#Masthead & {route: "arquivo"}).out)
	<h1 class="band" data-text="{msg.archive_title}"></h1>
	<div class="page"><div class="content">
	\((#ArchiveGames & {key: "archive-games"}).out)
	</div><aside class="side"><p><a data-route="jogos" data-text="{msg.games_title}"></a></p></aside></div>
	</section>
	"""

_championshipArchiveMarkup: """
	<section class="screen" data-screen="arquivo-campeonato">
	\((#Masthead & {route: "arquivo-campeonato", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="championship" data-filter="slug=eq.{param.slug}&limit=1" data-exit-motion="none" data-empty="{msg.championship_gone}"><template data-item><article>
	  <h1 class="band"><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span><small data-text="{msg.archive_championship_title}"></small></h1>
	  <div class="page"><div class="content">
	    <nav class="team-section-links"><a class="btn-quiet" data-route="campeonato" data-param-slug="{slug}" data-text="{msg.back_championship}"></a><a data-route="publico" data-param-slug="{slug}" data-text="{msg.archive_attendance_title}"></a></nav>
	\((#ArchiveGames & {key: "championship-archive-games", scoped: true}).out)
	  </div><aside class="side"><p><a data-route="arquivo" data-text="{msg.archive_title}"></a></p></aside></div>
	</article></template></div>
	</section>
	"""

_attendanceMarkup: """
	<section class="screen" data-screen="publico">
	\((#Masthead & {route: "publico", params: " data-param-slug=\"{param.slug}\""}).out)
	<div data-live="championship" data-filter="slug=eq.{param.slug}&limit=1" data-exit-motion="none" data-empty="{msg.championship_gone}"><template data-item><article>
	  <h1 class="band"><span data-text="{full_name}|{msg.geography_names}" data-text-format="geography-label"></span><small data-text="{msg.archive_attendance_title}"></small></h1>
	  <div class="page"><div class="content">
	    <nav class="team-section-links"><a class="btn-quiet" data-route="campeonato" data-param-slug="{slug}" data-text="{msg.back_championship}"></a><a data-route="arquivo-campeonato" data-param-slug="{slug}" data-text="{msg.archive_championship_title}"></a></nav>
	    <h2 data-text="{msg.archive_attendance_averages}"></h2>
	\((#PagedRead & {
	key:    "attendance-teams"
	table:  "championship_attendance"
	filter: "championship_id=eq.{owner_id}&attendance_count=gt.0"
	order:  "average.desc.nullslast,team_name.asc,id.asc"
	content: """
		<div class="table-wrap"><table class="grid standings">
		  <thead><tr><th scope="col" data-text="{msg.col_team}"></th><th scope="col" class="num" data-text="{msg.archive_attendance_average}"></th><th scope="col" class="num" data-text="{msg.archive_attendance_maximum}"></th><th scope="col" class="num" data-text="{msg.archive_attendance_minimum}"></th><th scope="col" class="num" data-text="{msg.archive_attendance_count}"></th><th scope="col" class="num wide" data-text="{msg.archive_attendance_total}"></th></tr></thead>
		  <tbody data-live="championship_attendance" data-filter="championship_id=eq.{owner_id}&attendance_count=gt.0&offset={offset}&limit=40" data-order="average.desc.nullslast,team_name.asc,id.asc" data-empty="{msg.archive_attendance_empty}"><template data-item><tr><th scope="row"><a data-route="equipe-campeonato" data-param-slug="{team_slug}" data-param-championship="{param.slug}"><span class="archive-icon" data-text="{team_id}|{team_name}|{team_logo_key}" data-text-format="team-badge"></span><span data-text="{team_name}"></span></a></th><td class="num" data-text="{average}" data-text-format="number"></td><td class="num" data-text="{maximum}" data-text-format="number"></td><td class="num" data-text="{minimum}" data-text-format="number"></td><td class="num" data-text="{attendance_count}" data-text-format="number"></td><td class="num wide" data-text="{total}" data-text-format="number"></td></tr></template></tbody>
		</table></div>
		"""
}).out)
	    <h2 data-text="{msg.archive_attendance_games}"></h2>
	\((#PagedRead & {
	key:    "attendance-games"
	table:  "game_archive"
	filter: "championship_id=eq.{owner_id}&attendance=not.is.null"
	order:  "attendance.desc.nullslast,day.desc,id.asc"
	content: (#ArchiveGameList & {filter: "championship_id=eq.{owner_id}&attendance=not.is.null&offset={offset}&limit=40", order: "attendance.desc.nullslast,day.desc,id.asc", attendance: true}).out
}).out)
	  </div><aside class="side"><p><a data-route="arquivo" data-text="{msg.archive_title}"></a></p></aside></div>
	</article></template></div>
	</section>
	"""
