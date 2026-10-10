package golaberto

import (
	"encoding/json"
	"strings"
)

_editingManagementLinkMarkup: """
	<a class="editing-management-link" data-route="gerenciar" data-text="{msg.manage_home}"></a>
	"""

#EditingChoice: C={
	key:           string
	field:         string
	table:         string
	selectedTable: *C.table | string
	label:         string
	column:        *"name" | string
	display:       *"{\(C.column)}" | string
	search:        *"search_key" | string
	select:        *"*" | string
	selected:      *null | string
	excluded:      *null | string
	required:      *false | bool
	filter:        *"" | string
	out:           """
  <div class="field wide editing-choice" data-live="editing_choice" data-filter="id=eq.\(C.key)" data-machine='\(json.Marshal({field: "state", initial: "choosing", context: {q: "", q_key: "", selected_id: C.selected, excluded_id: C.excluded}, states: choosing: on: {
		input: {guard: {type: "editing-choice-event", params: suffix: "-q"}, assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}}}
		change: {guard: {type: "editing-choice-event", params: suffix: "-pick"}, assign: selected_id: {type: "blank-null"}}
		if C.selected == null {
			reset: assign: {q: "", q_key: "", selected_id: null}
		}
	}}))' data-empty-row='\(json.Marshal({id: C.key, state: "choosing", q: "", q_key: "", selected_id: C.selected, excluded_id: C.excluded}))'>
    <label for="{id}-q" data-text="{msg.choice_search}"></label><input id="{id}-q" type="search" maxlength="80" value="{q}" autocomplete="off">
    <label for="{id}-pick" data-text="{msg.\(C.label)}"></label>
    <select id="{id}-pick" name="\(C.field)" data-value="{selected_id}" data-value-adapter="editing-uuid"\([if C.required {" required"}, ""][0])>
      <option value="" data-text="{msg.edit_unknown}"></option>
      <optgroup data-live="\(C.selectedTable)" data-select="\(C.select)" data-filter="id=in.({selected_id})&limit=1" data-empty=""><template data-item><option value="{id}" data-text="\(C.display)"></option></template></optgroup>
      <optgroup data-live="\(C.table)" data-select="\(C.select)" data-filter="\(C.search)=like.*{q_key}*&limit=40\(C.filter)" data-order="\(C.column).asc,id.asc" data-empty=""><template data-item><option value="{id}" data-text="\(C.display)"></option></template></optgroup>
    </select><p class="hint" data-text="{msg.manage_choice_hint}"></p>
  </div>
  """
}

#EditingField: F={
	name:     string
	label:    string
	control:  *"text" | string
	adapter:  *"editing-text" | string
	required: *false | bool
	max:      *160 | int
	minimum:  *"" | string
	maximum:  *"" | string
	options: *[] | [...{value: string, label: string}]
	current: *false | bool
	initial: *"" | string
	out:     """
  <label class="field wide"><span data-text="{msg.\(F.label)}"></span>
  \([if F.control == "select" {"<select name=\"\(F.name)\" data-value-adapter=\"\(F.adapter)\"\([if F.current {" data-value=\"{\(F.name)}\""}, ""][0])\([if F.required {" required"}, ""][0])>\(strings.Join([for option in F.options {"<option value=\"\(option.value)\" data-text=\"{msg.\(option.label)}\"></option>"}], ""))</select>"},
			"<input name=\"\(F.name)\" value=\"\(F.initial)\" type=\"\(F.control)\"\([if F.current {" data-value=\"{\(F.name)}\""}, ""][0])\([if F.control != "checkbox" {" data-value-adapter=\"\(F.adapter)\""}, ""][0])\([if F.required {" required"}, ""][0])\([if F.control == "text" {" maxlength=\"\(F.max)\""}, ""][0])\([if F.minimum != "" {" min=\"\(F.minimum)\""}, ""][0])\([if F.maximum != "" {" max=\"\(F.maximum)\""}, ""][0])\([if F.control == "number" || F.control == "datetime-local" {" step=\"\([if F.adapter == "editing-integer" {"1"}, "any"][0])\""}, ""][0])>",
	][0])
  </label>
  """
}

_editingFormMessages: """
	<p class="invalid" role="alert" hidden data-text="{msg.manage_invalid}"></p>
	<p class="store-error" role="alert" hidden data-text="{msg.manage_refused}"></p>
	"""

#EditingInlineCreate: I={
	key:   string
	table: string
	label: string
	fields: [...]
	out: """
  <details class="edit-sec editing-inline"><summary data-text="{msg.\(I.label)}"></summary>
    <form class="edit" data-form="\(I.key)-inline-create" data-entity="\(I.table)" data-action="create">
      <div class="fields">\(strings.Join([for field in I.fields {(#EditingField & field).out}], ""))</div>
      \(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.manage_add}"></button>
    </form>
  </details>
  """
}

_editingInlineStadium: (#EditingInlineCreate & {
	key: "estadio", table: "stadium", label: "manage_novo_estadio"
	fields: [{name: "name", label: "manage_name", max: 80, required: true}]
}).out

_editingInlineReferee: (#EditingInlineCreate & {
	key: "arbitro", table: "referee", label: "manage_novo_arbitro"
	fields: [
		{name: "name", label: "manage_name", max: 80, required: true},
		{name: "location", label: "manage_location", max: 80},
	]
}).out

_editingInlinePlayer: (#EditingInlineCreate & {
	key: "jogador", table: "player", label: "manage_novo_jogador"
	fields: [{name: "name", label: "manage_name", max: 60, required: true}]
}).out
#EditingDelete: D={
	table: string
	key:   string
	hint:  *"manage_delete_hint" | string
	out:   """
  <details class="edit-sec editing-danger"><summary data-text="{msg.manage_remove}"></summary>
    <p class="hint" data-text="{msg.\(D.hint)}"></p>
    <form data-form="\(D.key)-delete" data-entity="\(D.table)" data-action="delete">
      <label class="field"><input type="checkbox" required><span data-text="{msg.manage_confirm_delete}"></span></label>
      \(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.manage_remove}"></button>
    </form>
  </details>
  """
}

#EditingRecord: R={
	key:   string
	table: string
	label: string
	route: string
	read:  string
	fields: [...]
	choices: *[] | [...]
	current: *false | bool
	extra:   *"" | string
	out:     """
  <section class="screen" data-screen="\(R.route)">
  \((#Masthead & {route: R.route, params: [if R.current {" data-param-slug=\"{param.slug}\""}, ""][0]}).out)
  <h1 class="band" data-text="{msg.\(R.label)}"></h1>
  <div class="page"><div class="content">
  <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
  \([if R.current {"<div data-live=\"\(R.table)\" data-select=\"\(R.read)\" data-filter=\"slug=eq.{param.slug}&limit=1\" data-empty=\"{msg.manage_record_gone}\"><template data-item><div class=\"editing-record\">"}, ""][0])
    <form class="edit" data-form="\(R.key)-\([if R.current {"update"}, "create"][0])" data-entity="\(R.table)" data-action="\([if R.current {"update"}, "create"][0])">
      <fieldset class="edit-sec"><legend data-text="{msg.edit_facts}"></legend><div class="fields">
        \([if R.table == "game" {(#EditingScores & {key: R.route, current: R.current}).out}, ""][0])
        \([if R.table == "team" {(#MediaUpload & {field: "logo_key", label: "media_logo"}).out}, ""][0])
        \(strings.Join([for field in R.fields {(#EditingField & field & {current: R.current}).out}], ""))
        \(strings.Join([for choice in R.choices {(#EditingChoice & choice & {key: "\(R.route)-\(choice.field)-\([if R.current {"{id}"}, "new"][0])", if R.current {selected: "{\(choice.field)}"}}).out}], ""))
      </div></fieldset>
      \(_editingFormMessages)<div class="buttons"><button class="btn" type="submit" data-text="{msg.edit_save}"></button><a class="btn-quiet" data-route="gerenciar" data-text="{msg.manage_home}"></a></div>
    </form>
    \(R.extra)
    \([if R.table == "team" && R.current {_mediaLogoClear}, ""][0])
    \([if R.table == "team" {_mediaPendingMarkup}, ""][0])
    \([if R.table == "team" {_editingInlineStadium}, ""][0])
    \([if R.table == "game" {_editingInlineStadium + _editingInlineReferee}, ""][0])
    \([if R.current && R.table == "player" {"<a class=\"btn-quiet\" data-route=\"inscricoes-jogador\" data-param-slug=\"{param.slug}\" data-text=\"{msg.manage_registrations}\"></a>" + _editingMergeMarkup}, ""][0])
    \([if R.current && R.table == "game" {"<nav class=\"buttons\"><a class=\"btn-quiet\" data-route=\"gols-jogo\" data-param-slug=\"{param.slug}\" data-text=\"{msg.game_goals}\"></a><a class=\"btn-quiet\" data-route=\"escalacao-jogo\" data-param-slug=\"{param.slug}\" data-text=\"{msg.manage_lineups}\"></a></nav>"}, ""][0])
    \([if R.current {(#EditingDelete & {table: R.table, key: R.key}).out}, ""][0])
  \([if R.current {"</div></template></div>"}, ""][0])
  </div></template></div>
  </div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
  </section>
  """
}

#EditingScores: S={
	key:     string
	current: *false | bool
	_home: [if S.current {"{home_score}"}, null][0]
	_away: [if S.current {"{away_score}"}, null][0]
	_played: [if S.current {"{played}"}, false][0]
	_row: {id: "\(S.key)-scores-\([if S.current {"{id}"}, "new"][0])", state: "choosing", home_score: S._home, away_score: S._away, played: S._played}
	_machine: {field: "state", initial: "choosing", context: {home_score: S._home, away_score: S._away, played: S._played}, states: choosing: on: {
		("input@\(S.key)-home-score"): assign: {home_score: "count-or-null", played: {type: "editing-played", params: other: "away_score"}}
		("input@\(S.key)-away-score"): assign: {away_score: "count-or-null", played: {type: "editing-played", params: other: "home_score"}}
		if !S.current {
			reset: assign: {home_score: null, away_score: null, played: false}
		}
	}}
	out: """
 <div class="fields editing-scores" data-live="editing_choice" data-filter="id=eq.\(S._row.id)" data-empty-row='\(json.Marshal(S._row))' data-machine='\(json.Marshal(S._machine))'>
  <label class="field wide"><span data-text="{msg.manage_home_score}"></span><input id="\(S.key)-home-score" type="number" name="home_score" min="0" max="99" step="1" data-value="{home_score}" data-value-adapter="editing-integer"></label>
  <label class="field wide"><span data-text="{msg.manage_away_score}"></span><input id="\(S.key)-away-score" type="number" name="away_score" min="0" max="99" step="1" data-value="{away_score}" data-value-adapter="editing-integer"></label>
  <input hidden type="checkbox" name="played" data-value="{played}">
 </div>
 """
}

_editingMergeMarkup: """
<details class="edit-sec editing-danger"><summary data-text="{msg.manage_merge}"></summary>
 <p class="hint" data-text="{msg.manage_merge_hint}"></p>
 <form class="edit" data-form="jogador-merge" data-entity="player_merge" data-action="create">
  <input type="hidden" name="target_player_id" data-value="{id}">
  \((#EditingChoice & {key: "merge-{id}", field: "source_player_id", table: "player_directory", selectedTable: "player", label: "manage_source_player", required: true, excluded: "{id}", filter: "&id=neq.{excluded_id}"}).out)
  <label class="field"><input type="checkbox" required><span data-text="{msg.manage_confirm_merge}"></span></label>
  \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_merge}"></button>
 </form>
</details>
"""

#EditingRelated: R={
	route:  string
	owner:  string
	label:  string
	table:  string
	read:   *"*" | string
	filter: string
	order:  string
	fields: [...]
	choices: *[] | [...]
	hidden: *[] | [...{name: string, value: string}]
	heading:      string
	deletionHint: *"manage_delete_hint" | string
	ownerRead:    *"*" | string
	inline:       *"" | string
	out:          """
 <section class="screen" data-screen="\(R.route)">
 \((#Masthead & {route: R.route, params: " data-param-slug=\"{param.slug}\""}).out)
 <h1 class="band" data-text="{msg.\(R.label)}"></h1>
 <div class="page"><div class="content">
 <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
 <div data-live="\(R.owner)" data-select="\(R.ownerRead)" data-filter="slug=eq.{param.slug}&limit=1" data-empty="{msg.manage_record_gone}"><template data-item><div class="editing-record">
  <a class="btn-quiet" data-route="editar-\([if R.owner == "game" {"jogo"}, "jogador"][0])" data-param-slug="{param.slug}" data-text="{msg.manage_back_record}"></a>
  <form class="edit" data-form="\(R.route)-create" data-entity="\(R.table)" data-action="create">
   <fieldset class="edit-sec"><legend data-text="{msg.manage_add}"></legend><div class="fields">
    \(strings.Join([for input in R.hidden {"<input type=\"hidden\" name=\"\(input.name)\" data-value=\"\(input.value)\">"}], ""))
    \(strings.Join([for field in R.fields {(#EditingField & field).out}], ""))
    \(strings.Join([for choice in R.choices {(#EditingChoice & choice & {key: "\(R.route)-new-{id}-\(choice.field)"}).out}], ""))
   </div></fieldset>
   \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_add}"></button>
  </form>
  \(R.inline)
  \((#PagedRead & {key: R.route, table: R.table, filter: R.filter, order: R.order, content: """
   <ul class="editing-records" data-live="\(R.table)" data-select="\(R.read)" data-filter="\(R.filter)&offset={offset}&limit=40" data-order="\(R.order)" data-empty="{msg.manage_related_empty}"><template data-item>
    <li><details><summary data-text="{\(R.heading)}"></summary>
     <form class="edit" data-form="\(R.route)-update" data-entity="\(R.table)" data-action="update">
      \([if R.table == "team_player" {"<p class=\"hint\" data-text=\"{msg.manage_registration_delete_hint}\"></p>"}, ""][0])
      <div class="fields">
       \(strings.Join([for field in R.fields {(#EditingField & field & {current: true}).out}], ""))
       \(strings.Join([for choice in R.choices {(#EditingChoice & choice & {key: "\(R.route)-{id}-\(choice.field)", selected: "{\(choice.field)}"}).out}], ""))
      </div>
      \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button>
     </form>
     \((#EditingDelete & {table: R.table, key: R.route, hint: R.deletionHint}).out)
    </details></li>
   </template></ul>
   """}).out)
 </div></template></div>
 </div></template></div>
 </div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
 </section>
 """
}

_editingGoalsMarkup: (#EditingRelated & {
	route: "gols-jogo", owner: "game", label: "game_goals", table: "goal", read: "*,player(name)", filter: "game_id=eq.{owner_id}", order: "side.asc,aet.asc,minute.asc.nullslast,id.asc", heading: "player.name"
	hidden: [{name: "game_id", value: "{id}"}]
	fields: [
		{name: "side", label: "manage_side", control: "select", required: true, options: [{value: "home", label: "manage_home_team"}, {value: "away", label: "manage_away_team"}]},
		{name: "minute", label: "manage_minute", control: "number", adapter: "editing-integer", minimum: "0", maximum: "130"},
		{name: "penalty", label: "manage_penalty", control: "checkbox"},
		{name: "own_goal", label: "manage_own_goal", control: "checkbox"},
		{name: "aet", label: "manage_extra_time", control: "checkbox"},
	]
	choices: [{field: "player_id", table: "player_directory", selectedTable: "player", label: "manage_player", required: true}]
	inline: _editingInlinePlayer
}).out

_editingLineupsMarkup: (#EditingRelated & {
	route: "escalacao-jogo", owner: "game", label: "manage_lineups", table: "player_game", read: "*,player(name)", filter: "game_id=eq.{owner_id}", order: "side.asc,bench.asc,on_minute.asc,id.asc", heading: "player.name"
	hidden: [{name: "game_id", value: "{id}"}]
	fields: [
		{name: "side", label: "manage_side", control: "select", required: true, options: [{value: "home", label: "manage_home_team"}, {value: "away", label: "manage_away_team"}]},
		{name: "on_minute", label: "manage_on_minute", control: "number", adapter: "editing-integer", minimum: "0", maximum: "130", initial: "0", required: true},
		{name: "off_minute", label: "manage_off_minute", control: "number", adapter: "editing-integer", minimum: "0", maximum: "130"},
		{name: "yellow", label: "manage_yellow", control: "checkbox"},
		{name: "red", label: "manage_red", control: "checkbox"},
		{name: "bench", label: "manage_bench", control: "checkbox"},
	]
	choices: [{field: "player_id", table: "player_directory", selectedTable: "player", label: "manage_player", required: true}]
	inline: _editingInlinePlayer
}).out

_editingRegistrationsMarkup: (#EditingRelated & {
	route: "inscricoes-jogador", owner: "player", label: "manage_registrations", table: "team_player", read: "*,team(name),championship(full_name)", filter: "player_id=eq.{owner_id}", order: "championship_id.asc,team_id.asc,id.asc", heading: "championship.full_name", deletionHint: "manage_registration_delete_hint"
	hidden: [{name: "player_id", value: "{id}"}]
	fields: []
	choices: [
		{field: "championship_id", table: "championship", column: "full_name", label: "nav_championships", required: true},
		{field: "team_id", table: "team", label: "manage_team", required: true},
	]
}).out

#EditingDirectory: D={
	key:     string
	table:   string
	read:    *"*" | string
	label:   string
	search:  *"search_key" | string
	order:   *"name.asc,id.asc" | string
	name:    *"name" | string
	display: *"{\(D.name)}" | string
	out:     """
 <section class="edit-sec"><h2 data-text="{msg.\(D.label)}"></h2>
 <a class="btn-quiet" data-route="novo-\(D.key)" data-text="{msg.manage_add}"></a>
 \((#PagedRead & {key: "manage-\(D.key)", owner: "{id}", table: D.table, filter: "\(D.search)=like.*{q_key}*", order: D.order, context: {q: "", q_key: ""}, events: {("input@manage-\(D.key)-q"): assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}}, controls: "<label class=\"field\"><span data-text=\"{msg.choice_search}\"></span><input id=\"manage-\(D.key)-q\" type=\"search\" value=\"{q}\" maxlength=\"80\"></label>", content: """
 <ul class="editing-records" data-live="\(D.table)" data-select="\(D.read)" data-filter="\(D.search)=like.*{q_key}*&offset={offset}&limit=40" data-order="\(D.order)" data-empty="{msg.manage_related_empty}"><template data-item><li><a data-route="editar-\(D.key)" data-param-slug="{slug}" data-text="\(D.display)"></a></li></template></ul>
 """}).out)
 </section>
 """
}

_editingHubMarkup: """
<section class="screen" data-screen="gerenciar">
\((#Masthead & {route: "gerenciar"}).out)
<h1 class="band" data-text="{msg.manage_home}"></h1>
<div class="page"><div class="content">
 <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
  <p class="hint" data-text="{msg.manage_hint}"></p>
  <nav class="buttons"><a class="btn" data-route="gerenciar-competicoes" data-text="{msg.manage_competitions_open}"></a></nav>
  \(strings.Join([for directory in _editingDirectories {(#EditingDirectory & directory).out}], ""))
 </div></template></div>
</div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
</section>
"""

_editingDirectories: [
	{key: "equipe", table: "team", label: "nav_teams"},
	{key: "jogador", table: "player_directory", label: "players_title"},
	{key: "estadio", table: "stadium", label: "nav_stadiums"},
	{key: "arbitro", table: "referee", label: "nav_referees"},
	{key: "jogo", table: "game_archive", label: "nav_games", search: "slug", order: "day.desc,id.asc", name: "slug", display: "{day} · {home_name} — {away_name}"},
]

_editingRecords: [
	{
		"table": "team"
		"read":  "*"
		"fields": [
			{
				"name":     "name"
				"label":    "manage_name"
				"max":      60
				"required": true
			},
			{
				"name":  "full_name"
				"label": "manage_full_name"
			},
			{
				"name":  "city"
				"label": "manage_city"
				"max":   80
			},
			{
				"name":     "country"
				"label":    "manage_country"
				"max":      60
				"required": true
			},
			{
				"name":    "foundation"
				"label":   "manage_foundation"
				"control": "date"
			},
			{
				"name":     "team_type"
				"label":    "manage_team_type"
				"control":  "select"
				"required": true
				"options": [
					{
						"value": "club"
						"label": "teams_clubs"
					},
					{
						"value": "national"
						"label": "teams_national"
					},
				]
			},
		]
		"choices": [
			{
				"field": "stadium_id"
				"table": "stadium"
				"label": "game_stadium"
			},
		]
		"key": "equipe"
	},
	{
		"table": "player"
		"read":  "*"
		"fields": [
			{
				"name":     "name"
				"label":    "manage_name"
				"max":      60
				"required": true
			},
			{
				"name":  "full_name"
				"label": "manage_full_name"
			},
			{
				"name":    "birth"
				"label":   "manage_birth"
				"control": "date"
			},
			{
				"name":  "country"
				"label": "manage_country"
				"max":   60
			},
			{
				"name":    "height"
				"label":   "manage_height"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "100"
				"maximum": "230"
			},
			{
				"name":    "position"
				"label":   "manage_position"
				"control": "select"
				"options": [
					{
						"value": ""
						"label": "edit_unknown"
					},
					{
						"value": "g"
						"label": "player_position_g"
					},
					{
						"value": "dr"
						"label": "player_position_dr"
					},
					{
						"value": "dc"
						"label": "player_position_dc"
					},
					{
						"value": "dl"
						"label": "player_position_dl"
					},
					{
						"value": "dm"
						"label": "player_position_dm"
					},
					{
						"value": "cm"
						"label": "player_position_cm"
					},
					{
						"value": "am"
						"label": "player_position_am"
					},
					{
						"value": "fw"
						"label": "player_position_fw"
					},
				]
			},
		]
		"key": "jogador"
	},
	{
		"table": "stadium"
		"read":  "*"
		"fields": [
			{
				"name":     "name"
				"label":    "manage_name"
				"max":      80
				"required": true
			},
			{
				"name":  "full_name"
				"label": "manage_full_name"
			},
			{
				"name":  "city"
				"label": "manage_city"
				"max":   80
			},
			{
				"name":  "country"
				"label": "manage_country"
				"max":   60
			},
		]
		"key": "estadio"
	},
	{
		"table": "referee"
		"read":  "*"
		"fields": [
			{
				"name":     "name"
				"label":    "manage_name"
				"max":      80
				"required": true
			},
			{
				"name":  "location"
				"label": "manage_location"
				"max":   80
			},
		]
		"key": "arbitro"
	},
	{
		"table": "game"
		"read":  "*"
		"fields": [
			{
				"name":    "round"
				"label":   "manage_round"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "1"
			},
			{
				"name":     "day"
				"label":    "manage_day"
				"control":  "date"
				"required": true
			},
			{
				"name":    "kickoff"
				"control": "datetime-local"
				"label":   "manage_kickoff_utc"
				"max":     40
				"adapter": "editing-timestamp"
			},
			{
				"name":     "home_field"
				"label":    "manage_home_field"
				"control":  "select"
				"required": true
				"options": [
					{
						"value": "left"
						"label": "manage_home_advantage"
					},
					{
						"value": "neutral"
						"label": "manage_neutral"
					},
					{
						"value": "right"
						"label": "manage_away_advantage"
					},
				]
			},
			{
				"name":    "home_aet"
				"label":   "manage_home_aet"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "0"
				"maximum": "99"
			},
			{
				"name":    "away_aet"
				"label":   "manage_away_aet"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "0"
				"maximum": "99"
			},
			{
				"name":    "home_pen"
				"label":   "manage_home_pen"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "0"
				"maximum": "99"
			},
			{
				"name":    "away_pen"
				"label":   "manage_away_pen"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "0"
				"maximum": "99"
			},
			{
				"name":    "attendance"
				"label":   "manage_attendance"
				"control": "number"
				"adapter": "editing-integer"
				"minimum": "0"
				"maximum": "250000"
			},
		]
		"choices": [
			{
				"field":    "phase_id"
				"table":    "phase_directory"
				"label":    "manage_phase"
				"required": true
				"search":   "search_key"
				"select":   "id,name,championship_name"
				"display":  "{championship_name} · {name}"
			},
			{
				"field":    "home_id"
				"table":    "team"
				"label":    "manage_home_team"
				"required": true
			},
			{
				"field":    "away_id"
				"table":    "team"
				"label":    "manage_away_team"
				"required": true
			},
			{
				"field": "stadium_id"
				"table": "stadium"
				"label": "game_stadium"
			},
			{
				"field": "referee_id"
				"table": "referee"
				"label": "game_referee"
			},
		]
		"key": "jogo"
	},
]

_editingMarkups: {
	for spec in _editingRecords {
		for isCurrent in [false, true] {
			let screenRoute = "\([if isCurrent {"editar"}, "novo"][0])-\(spec.key)"
			(screenRoute): (#EditingRecord & spec & {route: screenRoute, label: "manage_\(strings.Replace(screenRoute, "-", "_", -1))", current: isCurrent}).out
		}
	}
	"gerenciar":          _editingHubMarkup
	"gols-jogo":          _editingGoalsMarkup
	"escalacao-jogo":     _editingLineupsMarkup
	"inscricoes-jogador": _editingRegistrationsMarkup
}
