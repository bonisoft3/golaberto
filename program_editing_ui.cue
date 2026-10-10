package golaberto

import "strings"

code: state: entities: {
	EditingChoice: {
		id: "0xbec870d131152065"
		table:      "editing_choice"
		durability: "tab"
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "state", type: "string", default: "'choosing'", cel: "this == 'choosing'"},
			{ordinal: 3, name: "q", type: "string", default: "''", cel: "this.size() <= 80"},
			{ordinal: 4, name: "q_key", type: "string", default: "''", cel: "this.size() <= 160"},
			{ordinal: 5, name: "selected_id", type: "uuid", required: false},
			{ordinal: 6, name: "home_score", type: "int32", required: false, cel: "this >= 0 && this < 100"},
			{ordinal: 7, name: "away_score", type: "int32", required: false, cel: "this >= 0 && this < 100"},
			{ordinal: 8, name: "played", type: "bool", default: "false"},
			{ordinal: 9, name: "excluded_id", type: "uuid", required: false},
		]
	}

}

code: surface: handlers: "editing-played": {
	ir:   "handler-editing-played"
	of:   "editar-jogo"
	src:  "shell/handlers/editing-played.js"
	note: "A native match form submits played as true exactly when both score controls hold a whole number."
}

code: surface: screens: {
	for screenRoute, screenMarkup in _editingMarkups {
		(screenRoute): {
			title:  screenRoute
			route:  "/\(screenRoute)\([if strings.HasPrefix(screenRoute, "editar-") || screenRoute == "gols-jogo" || screenRoute == "escalacao-jogo" || screenRoute == "inscricoes-jogador" {"/:slug"}, ""][0])"
			strip:  false
			keep:   0
			markup: screenMarkup
			forms: []
			states: ["loading", "populated", "gone", "validation-error", "network-error", "form-submit", "success", "populated-dark"]
			paths: {
				grant: {states: ["loading", "populated"], accepts: ["accept-everyday-editing"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-editing-grant"]}
				save: {states: ["populated", "form-submit", "success", "populated"], accepts: ["accept-everyday-editing"]}
				refused: {states: ["populated", "form-submit", "validation-error"], accepts: ["accept-editing-grant"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: renderers: ["shell/renderers/media-image.js"]
			files: shared: ["shell/shared/chrome.css", "shell/shared/games.css", "shell/shared/editing.css", "shell/shared/community.css"]
		}
	}
}
