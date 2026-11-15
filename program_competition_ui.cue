package golaberto

_competitionScreenTitles: {
	"gerenciar-competicoes": "Manage championships"
	"nova-competicao": "New championship"
	"editar-competicao": "Edit championship"
}

code: surface: screens: {
	for screenRoute, spec in _competitionScreenTitles {
		(screenRoute): {
			title:  spec

			strip:  false
			keep:   0
			markup: _competitionMarkups[screenRoute]
			forms: []
			states: ["loading", "populated", "gone", "validation-error", "network-error", "form-submit", "success", "populated-dark"]
			paths: {
				grant: {states: ["loading", "populated"], accepts: ["accept-everyday-editing"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-editing-grant"]}
				save: {states: ["populated", "form-submit", "success", "populated"], accepts: ["accept-everyday-editing"]}
				refused: {states: ["populated", "form-submit", "validation-error"], accepts: ["accept-editing-grant"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: shared: ["shell/shared/chrome.css", "shell/shared/editing.css", "shell/shared/competition.css"]
		}
	}
}

code: meta: tests: {
	"test-competition-admin": {
		of:   "gerenciar-competicoes"
		says: "an editor maintains a championship's structure and clones it into a fresh championship"
		given: {role: "editor"}
		when: "create and search a championship, edit its rules, phases, groups, members and zones, then clone it"
		then: "output.persisted && output.clone_has_no_games && output.clone_opens"
	}
	"test-competition-grant": {
		of:   "gerenciar-competicoes"
		says: "readers get no competition forms and the database refuses their writes"
		given: {role: "reader"}
		when: "open competition administration and submit a source mutation"
		then: "output.refused && output.dependents_preserved"
	}
}

code: surface: screens: "editar-competicao": files: renderers: ["shell/renderers/zone-positions.js"]
