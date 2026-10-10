package golaberto

#MatchContextGameRow: {
	out: """
		<a class="game-row" data-show-country="{show_country}" data-route="jogo" data-param-slug="{game_slug}" data-played="true">
		 <span class="when"><span class="day" data-text="{day_display}"></span> <span class="hour" data-text="{kickoff_local}"></span></span>
		 <span class="where" data-text="{championship_name}|{msg.geography_names}" data-text-format="geography-label"></span>
		 <span class="home"><span class="team-name" data-text="{home_name}"></span><span class="team-icons"><span class="archive-icon team-flag" data-text="{show_country}|{home_country}" data-text-format="country-flag"></span><span class="archive-icon team-badge" data-text="{home_id}|{home_name}|{home_logo_key}" data-text-format="team-badge"></span></span></span>
		 <span class="score"><b data-text="{home_score}|{home_aet}|{msg.game_aet}" data-text-format="match-final-score"></b><i>x</i><b data-text="{away_score}|{away_aet}|{msg.game_aet}" data-text-format="match-final-score"></b><span class="score-decider" data-text="{home_pen}|{away_pen}|{msg.game_pen}" data-text-format="match-shootout"></span></span>
		 <span class="away"><span class="team-icons"><span class="archive-icon team-badge" data-text="{away_id}|{away_name}|{away_logo_key}" data-text-format="team-badge"></span><span class="archive-icon team-flag" data-text="{show_country}|{away_country}" data-text-format="country-flag"></span></span><span class="team-name" data-text="{away_name}"></span></span>
		</a>
		"""
}

#MatchContextForm: F={
	teamID: string
	team:   string
	out:    """
		<section class="match-context-form">
		 <h2><span data-text="{msg.match_context_form}"></span> · <span data-text="{\(F.team)}"></span></h2>
		 <ol data-live="match_recent_result" data-filter="target_game_id=eq.{id}&team_id=eq.\(F.teamID)&limit=5" data-order="day.asc,kickoff.asc.nullsfirst,id.asc" data-empty="{msg.match_context_form_empty}">
		  <template data-item><li data-result="{result}"><a data-route="jogo" data-param-slug="{game_slug}" title="{day_display} · {championship_name}: {home_name} {home_score} x {away_score} {away_name}"><span aria-hidden="true" data-text="{result}"></span><span class="visually-hidden"><span data-text="{day_display}"></span> · <span data-text="{championship_name}"></span>: <span data-text="{home_name}"></span> <span data-text="{home_score}"></span> x <span data-text="{away_score}"></span> <span data-text="{away_name}"></span></span></a></li></template>
		 </ol>
		</section>
		"""
}

_matchContextTopMarkup: """
	<section class="match-context-top">
	 <div class="match-context-forms">
	  \((#MatchContextForm & {teamID: "{home_id}", team: "home_name"}).out)
	  \((#MatchContextForm & {teamID: "{away_id}", team: "away_name"}).out)
	 </div>
	 <section class="match-context-location" aria-labelledby="match-context-location-{id}">
	  <h2 id="match-context-location-{id}" data-text="{msg.match_context_location}"></h2>
	  <div data-live="match_location" data-filter="id=eq.{id}&limit=1" data-empty="{msg.match_context_location_none}">
	   <template data-item data-when="map_embed_url=not.is.null"><div class="match-context-map-shell"><iframe class="match-context-map-embed" src="{map_embed_url}" title="{msg.match_context_map_title}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe><p class="match-context-map-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" data-text="{msg.match_context_map_attribution}"></a></p><div data-text="{home_latitude}\u001f{home_longitude}\u001f{away_latitude}\u001f{away_longitude}\u001f{home_name}\u001f{away_name}\u001f{distance_km}\u001f{msg.match_context_distance}\u001f{msg.match_context_map_open}\u001f{msg.match_context_location_none}" data-text-format="match-context-map"></div></div></template>
	   <template data-item data-when="map_embed_url=is.null"><div data-text="{home_latitude}\u001f{home_longitude}\u001f{away_latitude}\u001f{away_longitude}\u001f{home_name}\u001f{away_name}\u001f{distance_km}\u001f{msg.match_context_distance}\u001f{msg.match_context_map_open}\u001f{msg.match_context_location_none}" data-text-format="match-context-map"></div></template>
	  </div>
	 </section>
	</section>
	"""

_matchContextHistoryMarkup: """
	<section class="match-context-history">
	 <h2 data-text="{msg.match_context_previous}"></h2>
	 <ol class="games" data-live="match_head_to_head" data-filter="target_game_id=eq.{id}&limit=5" data-order="day.desc,kickoff.desc.nullslast,id.desc" data-empty="{msg.match_context_previous_empty}">
	  <template data-item><li>\((#MatchContextGameRow).out)</li></template>
	 </ol>
	</section>
	"""

#MatchContextLineup: L={
	side: string
	out:  """
		<table class="grid lineup" data-side="\(L.side)">
		 <caption data-text="{\(L.side)_name}"></caption>
		 <thead><tr><th scope="col" data-text="{msg.col_player}"></th><th scope="col" class="num"><abbr title="{msg.col_position_long}" data-text="{msg.col_pos}"></abbr></th><th scope="col" class="num" data-text="{msg.col_on}"></th><th scope="col" class="num" data-text="{msg.col_off}"></th><th scope="col" class="num"><abbr title="{msg.col_contribution_long}" data-text="{msg.col_contribution}"></abbr></th><th scope="col"><span class="visually-hidden" data-text="{msg.col_cards}"></span></th></tr></thead>
		 <tbody data-live="match_lineup" data-filter="game_id=eq.{id}&side=eq.\(L.side)&limit=100" data-order="bench.asc,on_minute.asc,id.asc" data-empty="{msg.game_no_lineup}">
		  <template data-item><tr data-yellow="{yellow}" data-red="{red}" data-bench="{bench}"><td><a data-route="jogador" data-param-slug="{player_slug}" data-text="{player_name}"></a></td><td class="num" data-text="{position}"></td><td class="num" data-text="{on_minute}"></td><td class="num" data-text="{off_minute}"></td><td class="num" data-text="{contribution}" data-text-format="number"></td><td class="cards"><i class="yellow" title="{msg.card_yellow}"></i><i class="red" title="{msg.card_red}"></i></td></tr></template>
		 </tbody>
		</table>
		"""
}
