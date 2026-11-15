package golaberto

import "strings"

#LocalLink: {
	let L = self
	key:      string
	label:    string
	route:    *"" | string
	fragment: *"" | string
	params:   *"" | string
	current:  *false | bool
	out:      "<a" + [if L.route != "" {" data-route=\"\(L.route)\""}, ""][0] + [if L.fragment != "" {" data-route-fragment=\"\(L.fragment)\""}, ""][0] + L.params + [if L.current {" aria-current=\"page\""}, ""][0] + " data-text=\"{msg.\(L.label)}\"></a>"
}

#LocalNavigation: {
	let N = self
	label:  string
	active: *"" | string
	links:  [...#LocalLink]
	out: """
		<nav class="local-navigation" aria-label="{msg.\(N.label)}">
		  <h2 data-text="{msg.\(N.label)}"></h2>
		  <div class="local-links">
		\(strings.Join([for link in N.links {(#LocalLink & link & {current: link.key == N.active}).out}], "\n"))
		  </div>
		</nav>
		"""
}

#SectionNavigation: {
	let N = self
	links:  [...#LocalLink]
	route:  string
	params: string
	back:   string
	out: """
		<aside class="side local-side"><div class="local-nav-stack">
		\((#LocalNavigation & {label: "local_page", links: [for link in N.links {link & {route: N.route, params: N.params}}]}).out)
		  <p class="local-back">\(N.back)</p>
		  <p class="local-about" data-text="{msg.about}"></p>
		</div></aside>
		"""
}

#ChampionshipNavigation: {
	let N = self
	active: string
	slug:   *"{param.slug}" | string
	stages: *false | bool
	_nav: (#LocalNavigation & {
		label:  "local_championship"
		active: N.active
		_items: [
			{key: "table", label: "team_table", route: "campeonato"},
			{key: "games", label: "games_title", route: "arquivo-campeonato"},
			{key: "players", label: "players_title", route: "campeonato-jogadores"},
			{key: "attendance", label: "archive_attendance_title", route: "publico"},
		]
		links: [for link in _items {link & {params: " data-param-slug=\"\(N.slug)\""}}]
	}).out

	out: """
		<aside class="side local-side">
		  <div class="local-nav-stack">
		\(N._nav)
		\([if N.stages {"""
			<nav class="local-navigation local-stages" aria-label="{msg.phases_label}">
			  <h2 data-text="{msg.phases_label}"></h2>
			  <div class="local-links" data-live="phase" data-filter="championship_id=eq.{id}" data-order="position.desc,id.desc" data-empty="{msg.no_phases}">
			    <template data-item><a data-route="campeonato" data-param-slug="\(N.slug)" data-route-fragment="fase-{id}" data-text="{name}"></a></template>
			  </div>
			</nav>
			"""}, ""][0])
		    <p class="local-back"><a data-route="campeonatos" data-text="{msg.back_catalog}"></a></p>
		    <p class="local-about" data-text="{msg.about}"></p>
		  </div>
		</aside>
		"""
}
