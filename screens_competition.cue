package golaberto

import "strings"

#CompetitionFields: F={
	fields: [...]
	current: *false | bool
	out: strings.Join([for field in F.fields {(#EditingField & field & {current: F.current}).out}], "")
}

_competitionChampionshipFields: [
	{name: "name", label: "manage_competition_name", max: 120, required: true},
	{name: "region", label: "manage_competition_region", control: "select", required: true, initial: "national", options: [
		{value: "national", label: "manage_region_national"},
		{value: "world", label: "manage_region_world"},
		{value: "continental", label: "manage_region_continental"},
	]},
	{name: "region_name", label: "manage_region_name", max: 60, required: true},
	{name: "begins", label: "manage_begins", control: "date", required: true},
	{name: "ends", label: "manage_ends", control: "date", required: true},
	{name: "point_win", label: "manage_points_win", control: "number", adapter: "editing-integer", minimum: "0", maximum: "9", initial: "3", required: true},
	{name: "point_draw", label: "manage_points_draw", control: "number", adapter: "editing-integer", minimum: "0", maximum: "9", initial: "1", required: true},
	{name: "point_loss", label: "manage_points_loss", control: "number", adapter: "editing-integer", minimum: "0", maximum: "9", initial: "0", required: true},
	{name: "show_country", label: "manage_show_country", control: "checkbox"},
	{name: "featured", label: "manage_featured", control: "checkbox"},
]

_competitionPhaseFields: [
	{name: "name", label: "manage_phase_name", max: 60, required: true},
	{name: "position", label: "manage_order", control: "number", adapter: "editing-integer", minimum: "0", initial: "0", required: true},
	{name: "sort", label: "manage_tiebreaks", max: 160, initial: "pt,w,gd,gf,gp,g_away,name", required: true},
	{name: "bonus_points", label: "manage_bonus_points", control: "number", adapter: "editing-integer", minimum: "0", maximum: "9", initial: "0", required: true},
	{name: "bonus_points_threshold", label: "manage_bonus_threshold", control: "number", adapter: "editing-integer", minimum: "0", maximum: "99", initial: "0", required: true},
]

_competitionGroupFields: [
	{name: "name", label: "manage_group_name", max: 40, required: true},
	{name: "position", label: "manage_order", control: "number", adapter: "editing-integer", minimum: "0", initial: "0", required: true},
]

_competitionMembershipFields: [
	{name: "add_sub", label: "manage_points_adjustment", control: "number", adapter: "editing-integer", minimum: "-99", maximum: "99", initial: "0", required: true},
	{name: "bias", label: "manage_tiebreak_bias", control: "number", adapter: "editing-integer", minimum: "-99", maximum: "99", initial: "0", required: true},
	{name: "comment", label: "manage_adjustment_reason", max: 1000},
]

_competitionZoneFields: [
	{name: "name", label: "manage_zone_name", max: 120, required: true},
	{name: "color", label: "manage_zone_color", max: 16, initial: "qualify", required: true},
	{name: "first", label: "manage_zone_first", control: "number", adapter: "editing-integer", minimum: "1", maximum: "1000", initial: "1", required: true},
	{name: "last", label: "manage_zone_last", control: "number", adapter: "editing-integer", minimum: "1", maximum: "1000", initial: "1", required: true},
]

#CompetitionMemberships: M={
	groupID: string
	out:     """
<section class="competition-section"><h4 data-text="{msg.manage_memberships}"></h4>
 <form class="edit competition-create" data-form="competition-member-new-\(M.groupID)" data-entity="team_group" data-action="create">
  <input type="hidden" name="group_id" data-value="\(M.groupID)">
  <div class="fields">
   \((#EditingChoice & {key: "competition-member-new-\(M.groupID)-team", field: "team_id", table: "team", label: "manage_team", required: true}).out)
   \((#CompetitionFields & {fields: _competitionMembershipFields}).out)
  </div>
  \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_add_membership}"></button>
 </form>
 <ul class="competition-records" data-live="team_group" data-select="*,team(name)" data-filter="group_id=eq.\(M.groupID)" data-order="team_id.asc,id.asc" data-empty="{msg.manage_memberships_empty}"><template data-item><li><details>
  <summary><span data-text="{team.name}"></span><small><span data-text="{add_sub}" data-text-format="number"></span> · <span data-text="{bias}" data-text-format="number"></span></small></summary>
  <form class="edit" data-form="competition-member-{id}" data-entity="team_group" data-action="update"><div class="fields">
   \((#CompetitionFields & {fields: _competitionMembershipFields, current: true}).out)
  </div>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button></form>
  \((#EditingDelete & {table: "team_group", key: "competition-member-{id}"}).out)
 </details></li></template></ul>
</section>
"""
}

#CompetitionZones: Z={
	groupID: string
	out:     """
<section class="competition-section"><h4 data-text="{msg.manage_zones}"></h4>
 <p class="hint" data-text="{msg.manage_zone_overlap_hint}"></p>
 <form class="edit competition-create" data-form="competition-zone-new-\(Z.groupID)" data-entity="zone" data-action="create">
  <input type="hidden" name="group_id" data-value="\(Z.groupID)">
  <div class="fields">\((#CompetitionFields & {fields: _competitionZoneFields}).out)<label class="field wide"><span data-text="{msg.manage_zone_positions}"></span><input name="positions" type="text" maxlength="4999"></label></div>
  <p class="hint" data-text="{msg.manage_zone_positions_hint}"></p>
  \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_add_zone}"></button>
 </form>
 <ul class="competition-records" data-live="zone" data-filter="group_id=eq.\(Z.groupID)" data-order="first.asc,last.asc,id.asc" data-empty="{msg.manage_zones_empty}"><template data-item><li><details>
  <summary><span data-text="{name}"></span><small><span data-text="{first}" data-text-format="number"></span>–<span data-text="{last}" data-text-format="number"></span> · <span data-text="{positions}"></span></small></summary>
  <form class="edit" data-form="competition-zone-{id}" data-entity="zone" data-action="update"><div class="fields">
   \((#CompetitionFields & {fields: _competitionZoneFields, current: true}).out)<label class="field wide"><span data-text="{msg.manage_zone_positions}"></span><input name="positions" type="text" maxlength="4999" data-value="{positions}"></label>
  </div><p class="hint" data-text="{msg.manage_zone_positions_hint}"></p>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button></form>
  \((#EditingDelete & {table: "zone", key: "competition-zone-{id}"}).out)
 </details></li></template></ul>
</section>
"""
}

#CompetitionGroups: G={
	phaseID: string
	out:     """
<section class="competition-section"><h3 data-text="{msg.manage_groups}"></h3>
 <form class="edit competition-create" data-form="competition-group-new-\(G.phaseID)" data-entity="stage_group" data-action="create">
  <input type="hidden" name="phase_id" data-value="\(G.phaseID)">
  <div class="fields">\((#CompetitionFields & {fields: _competitionGroupFields}).out)</div>
  \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_add_group}"></button>
 </form>
 <ul class="competition-groups" data-live="stage_group" data-filter="phase_id=eq.\(G.phaseID)" data-order="position.asc,name.asc,id.asc" data-empty="{msg.manage_groups_empty}"><template data-item><li><details class="competition-record">
  <summary><span data-text="{name}"></span><small><span data-text="{msg.manage_order}"></span> <span data-text="{position}" data-text-format="number"></span></small></summary>
  <form class="edit" data-form="competition-group-{id}" data-entity="stage_group" data-action="update"><div class="fields">
   \((#CompetitionFields & {fields: _competitionGroupFields, current: true}).out)
  </div>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button></form>
  \((#CompetitionMemberships & {groupID: "{id}"}).out)
  \((#CompetitionZones & {groupID: "{id}"}).out)
  \((#EditingDelete & {table: "stage_group", key: "competition-group-{id}"}).out)
 </details></li></template></ul>
</section>
"""
}

#CompetitionClone: C={
	phaseID: string
	out:     """
<details class="edit-sec competition-clone"><summary data-text="{msg.manage_clone_phase}"></summary>
 <p class="hint" data-text="{msg.manage_clone_hint}"></p>
 <form class="edit" data-form="competition-clone-\(C.phaseID)" data-entity="phase_clone" data-action="create">
  <input type="hidden" name="source_phase_id" data-value="\(C.phaseID)">
  <input type="hidden" name="name" data-value="{championship.name} - {name}">
  <input type="hidden" name="begins" data-value="{championship.begins}">
  <input type="hidden" name="ends" data-value="{championship.ends}">
  <p class="competition-clone-target"><span data-text="{msg.manage_clone_name}"></span>: <b><span data-text="{championship.name}"></span> - <span data-text="{name}"></span></b></p>
  <label class="field competition-confirm"><input type="checkbox" required><span data-text="{msg.manage_clone_confirm}"></span></label>
  \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_clone_phase}"></button>
 </form>
 <div class="competition-clone-result" data-live="phase_clone" data-filter="source_phase_id=eq.\(C.phaseID)&limit=1" data-order="created_at.desc,id.desc" data-empty=""><template data-item>
  <p><span data-live="championship" data-filter="id=eq.{target_championship_id}&limit=1" data-empty=""><template data-item><a data-route="editar-competicao" data-param-slug="{slug}"><span data-text="{msg.manage_view_competition}"></span>: <b data-text="{full_name}"></b></a></template></span></p>
 </template></div>
</details>
"""
}

_competitionDirectoryMarkup: """
<section class="screen" data-screen="gerenciar-competicoes">
\((#Masthead & {route: "gerenciar-competicoes"}).out)
<h1 class="band" data-text="{msg.manage_competitions}"></h1>
<div class="page"><div class="content">
 <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
  <p class="hint" data-text="{msg.manage_competitions_hint}"></p>
  <nav class="buttons"><a class="btn" data-route="nova-competicao" data-text="{msg.manage_new_competition}"></a><a class="btn-quiet" data-route="gerenciar" data-text="{msg.manage_home}"></a></nav>
  \((#PagedRead & {key: "competition-catalog", owner: "00000000-0000-0000-0000-000000000000", table: "championship", filter: "search_key=like.*{q_key}*", order: "region_name.asc,name.asc,begins.desc,id.asc", context: {q: "", q_key: ""}, events: {"input@competition-catalog-q": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}}, controls: "<label class=\"field competition-search\"><span data-text=\"{msg.choice_search}\"></span><input id=\"competition-catalog-q\" type=\"search\" maxlength=\"80\" value=\"{q}\"></label>", content: """
	 <ul class="competition-catalog" data-live="championship" data-filter="search_key=like.*{q_key}*&offset={offset}&limit=40" data-order="region_name.asc,name.asc,begins.desc,id.asc" data-empty="{msg.manage_competitions_empty}"><template data-item><li><a data-route="editar-competicao" data-param-slug="{slug}"><b data-text="{full_name}"></b><small><span data-text="{begins}"></span>–<span data-text="{ends}"></span></small></a></li></template></ul>
	"""}).out)
 </div></template></div>
</div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
</section>
"""

_competitionNewMarkup: """
<section class="screen" data-screen="nova-competicao">
\((#Masthead & {route: "nova-competicao"}).out)
<h1 class="band" data-text="{msg.manage_new_competition}"></h1>
<div class="page"><div class="content">
 <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
  <form class="edit" data-form="competition-create" data-entity="championship" data-action="create"><fieldset class="edit-sec"><legend data-text="{msg.edit_facts}"></legend><div class="fields">
   \((#CompetitionFields & {fields: _competitionChampionshipFields}).out)
   \((#EditingChoice & {key: "competition-category-new", field: "category_id", table: "category", label: "manage_category", search: "name"}).out)
  </div></fieldset>\(_editingFormMessages)<div class="buttons"><button class="btn" type="submit" data-text="{msg.manage_new_competition}"></button><a class="btn-quiet" data-route="gerenciar-competicoes" data-text="{msg.manage_competitions}"></a></div></form>
 </div></template></div>
</div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
</section>
"""

_competitionEditMarkup: """
<section class="screen" data-screen="editar-competicao">
\((#Masthead & {route: "editar-competicao", params: " data-param-slug=\"{param.slug}\""}).out)
<h1 class="band" data-text="{msg.manage_edit_competition}"></h1>
<div class="page"><div class="content">
 <div data-live="editor" data-filter="limit=1" data-empty="{msg.manage_editor_required}"><template data-item><div class="editing-workspace"><p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
 <div data-live="championship" data-filter="slug=eq.{param.slug}&limit=1" data-empty="{msg.manage_record_gone}"><template data-item><article class="competition-admin">
  <nav class="buttons"><a class="btn-quiet" data-route="gerenciar-competicoes" data-text="{msg.manage_competitions}"></a><a class="btn-quiet" data-route="campeonato" data-param-slug="{slug}" data-text="{msg.manage_view_competition}"></a></nav>
  <form class="edit" data-form="competition-update" data-entity="championship" data-action="update"><fieldset class="edit-sec"><legend data-text="{msg.manage_championship_rules}"></legend><div class="fields">
   \((#CompetitionFields & {fields: _competitionChampionshipFields, current: true}).out)
   \((#EditingChoice & {key: "competition-category-{id}", field: "category_id", table: "category", label: "manage_category", search: "name", selected: "{category_id}"}).out)
  </div></fieldset>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button></form>
  <section class="competition-phases"><h2 data-text="{msg.manage_phases}"></h2><p class="hint" data-text="{msg.manage_tiebreaks_hint}"></p>
   <form class="edit competition-create" data-form="competition-phase-new-{id}" data-entity="phase" data-action="create"><input type="hidden" name="championship_id" data-value="{id}"><div class="fields">
    \((#CompetitionFields & {fields: _competitionPhaseFields}).out)
   </div>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.manage_add_phase}"></button></form>
   <ul class="competition-phase-list" data-live="phase" data-select="*,championship(name,begins,ends)" data-filter="championship_id=eq.{id}" data-order="position.asc,id.asc" data-empty="{msg.manage_phases_empty}"><template data-item><li><details class="competition-record" open>
    <summary><span data-text="{name}"></span><small><span data-text="{msg.manage_order}"></span> <span data-text="{position}" data-text-format="number"></span></small></summary>
    <form class="edit" data-form="competition-phase-{id}" data-entity="phase" data-action="update"><div class="fields">
     \((#CompetitionFields & {fields: _competitionPhaseFields, current: true}).out)
    </div><p class="hint" data-text="{msg.manage_tiebreaks_hint}"></p>\(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button></form>
    \((#CompetitionClone & {phaseID: "{id}"}).out)
    \((#CompetitionGroups & {phaseID: "{id}"}).out)
    \((#EditingDelete & {table: "phase", key: "competition-phase-{id}"}).out)
   </details></li></template></ul>
  </section>
  \((#EditingDelete & {table: "championship", key: "competition", hint: "manage_competition_delete_hint"}).out)
 </article></template></div>
 </div></template></div>
</div><aside class="side"><p data-text="{msg.about}"></p></aside></div>
</section>
"""

_competitionHubLinkMarkup: """
	<section class="edit-sec"><h2 data-text="{msg.manage_competitions}"></h2><p><a class="btn-quiet" data-route="gerenciar-competicoes" data-text="{msg.manage_competitions_open}"></a></p></section>
	"""

_competitionMarkups: {
	"gerenciar-competicoes": _competitionDirectoryMarkup
	"nova-competicao":       _competitionNewMarkup
	"editar-competicao":     _competitionEditMarkup
}
