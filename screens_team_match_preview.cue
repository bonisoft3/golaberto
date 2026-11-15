package golaberto

#TeamMatchPreviewGame: {
	let G = self
	championship: string
	played:       bool
	_label:       [if G.played {"team_match_preview_last"}, "team_match_preview_next"][0]
	_empty:       [if G.played {"games_none_results"}, "games_none_upcoming"][0]
	_order:       [if G.played {"day.desc,kickoff.desc.nullslast,game_id.desc"}, "day.asc,kickoff.asc.nullslast,game_id.asc"][0]
	_score: [if G.played {"""
		<b data-text="{game.home_score}|{game.home_aet}|{msg.game_aet}" data-text-format="match-final-score"></b><i aria-hidden="true">x</i><b data-text="{game.away_score}|{game.away_aet}|{msg.game_aet}" data-text-format="match-final-score"></b><span data-text="{game.home_pen}|{game.away_pen}|{msg.game_pen}" data-text-format="match-shootout"></span>
		"""}, "<span aria-hidden=\"true\">–</span>"][0]
	out: """
		<div class="team-match-preview-read" data-preview-played="\(G.played)" role="group" aria-label="{msg.\(G._label)}" data-live="team_game" data-select="*,championship!inner(slug),game:game_id(slug,home_score,away_score,home_aet,away_aet,home_pen,away_pen,home:home_id(name),away:away_id(name))" data-filter="team_id=eq.{team_id}&amp;championship.slug=eq.\(G.championship)&amp;played=is.\(G.played)&amp;limit=1" data-order="\(G._order)" data-project='{"reader_day":{"date":["kickoff","day"]}}' data-empty="{msg.\(G._empty)}">
		    <template data-item><a class="team-match-preview-game" data-route="jogo" data-param-slug="{game.slug}">
		      <span class="visually-hidden" data-text="{msg.\(G._label)}: "></span><span class="team-match-preview-date"><span class="team-match-preview-day" data-text="{reader_day}" data-text-format="date"></span> <span class="team-match-preview-time" data-text="{kickoff}" data-text-format="time"></span></span>
		      <span class="team-match-preview-fixture"><span class="team-match-preview-home" title="{game.home.name}" data-text="{game.home.name}"></span><span class="team-match-preview-score">\(G._score)</span><span class="team-match-preview-away" title="{game.away.name}" data-text="{game.away.name}"></span></span>
		    </a></template>
		</div>
		"""
}

#ChampionshipTeamName: {
	let T = self
	championship: string
	preview:      bool
	_attrs:       [if T.preview {" data-team-match-preview"}, ""][0]
	_button: [if T.preview {"""
		<button class="text-btn team-match-preview-toggle" type="button" popovertarget="team-matches-{group_id}-{team_id}" aria-label="{msg.team_match_preview}: {team_name}" aria-expanded="false" aria-pressed="false" data-preview-pin="{msg.team_match_preview_pin}" data-preview-unpin="{msg.team_match_preview_unpin}" aria-haspopup="dialog" aria-controls="team-matches-{group_id}-{team_id}"><span aria-hidden="true">⋯</span></button>
		"""}, ""][0]
	_popover: [if T.preview {"""
		<div class="team-match-preview" id="team-matches-{group_id}-{team_id}" popover="auto" role="dialog" aria-label="{msg.team_match_preview}: {team_name}">
		\((#TeamMatchPreviewGame & {championship: T.championship, played: true}).out)
		\((#TeamMatchPreviewGame & {championship: T.championship, played: false}).out)
		</div>
		"""}, ""][0]
	out: """
		<td class="name"\(T._attrs)><span class="team-name-cell"><span class="archive-icon" data-text="{team_id}|{team_name}|{team.logo_key}" data-text-format="team-badge"></span><a class="team-name" data-route="equipe-campeonato" data-param-slug="{team.slug}" data-param-championship="\(T.championship)" data-text="{team_name}"></a>\(T._button)</span>\(T._popover)</td>
		"""
}

code: capabilities: hatches: "team-match-preview": {
	kind:  "host-dom"
	src:   "shell/hatches/team-match-preview.js"
	files: ["shell/hatches/team-match-preview.js"]
	note:  "Native popover placement, hover hit testing, pinning and focus control escape standings scroll clipping; match data stays in declared live reads."
}
code: surface: screens: campeonato: hatches: ["team-match-preview"]
