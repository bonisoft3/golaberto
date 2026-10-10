package golaberto

code: capabilities: auth: self: {route: "usuario"}

code: state: entities: {
	CommunityAccess: {
		id: "0xc35aa4f75ed38d69"
		table:      "community_access"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "record_id", type: "uuid"},
			{ordinal: 3, name: "kind", type: "string", cel: "this in ['profile','comment','team_comment']"},
			{ordinal: 4, name: "biography_id", type: "uuid", required: false},
			{ordinal: 5, name: "avatar_id", type: "uuid", required: false},
		]
	}
}

code: surface: screens: {
	for screenRoute, screenMarkup in {usuarios: _communityDirectoryMarkup, usuario: _communityProfileMarkup, "historico-jogo": _communityGameHistoryMarkup} {
		(screenRoute): {
			title: screenRoute
			route: [if screenRoute == "usuario" {"/usuario/:id"}, if screenRoute == "historico-jogo" {"/historico-jogo/:slug"}, "/usuarios"][0]
			ssr:    "ssr"
			// The directory joins the strip beside the other archive directories; a
			// profile and a game's history are reached from it and from bylines.
			strip: screenRoute == "usuarios"
			if screenRoute == "usuarios" {label: "community_title"}
			keep:   0
			markup: screenMarkup
			forms: []
			states: ["loading", "populated", "gone", "validation-error", "network-error", "form-submit", "success", "populated-dark"]
			paths: {
				read: {states: ["loading", "populated"], accepts: ["accept-community-profile", "accept-community-history"]}
				missing: {states: ["loading", "gone"], accepts: ["accept-community-profile", "accept-community-media"]}
				save: {states: ["populated", "form-submit", "success", "populated"], accepts: ["accept-community-profile", "accept-community-media"]}
				refused: {states: ["populated", "form-submit", "validation-error"], accepts: ["accept-community-ownership"]}
				night: {states: ["populated", "populated-dark"], accepts: ["accept-dark"]}
			}
			files: {shared: ["shell/shared/chrome.css", "shell/shared/games.css", "shell/shared/editing.css", "shell/shared/community.css"], renderers: ["shell/renderers/community-history.js", "shell/renderers/media-image.js"]}
		}
	}
}

code: meta: tests: {
	"test-community-media": {of: "usuario", says: "native avatar and logo uploads enforce owner and editor authority", given: {role: "owner"}, when: "upload and remove a profile image and team logo", then: "output.persisted && output.public && output.owner_only"}
	"test-community-profile": {of: "usuario", says: "public biographies have counters and only their signed-in owner can create or edit them", given: {role: "owner"}, when: "save a biography and open it as another account", then: "output.persisted && output.public && output.owner_only"}
	"test-community-ownership": {of: "usuario", says: "guests and other accounts cannot edit a biography or delete another author's comment", given: {role: "reader"}, when: "view another account's profile and comments", then: "output.refused && output.unchanged"}
	"test-community-history": {of: "historico-jogo", says: "game edits retain their author and field changes across public pages", given: {edits: 41}, when: "read both history pages and the author's profile", then: "output.paginated && output.attributed && output.safe_text"}
}

build: checks: "community-access": {
	priority: 1
	database: true
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-net --allow-read tests/community-access-tests.ts"]
	note: "community controls follow signed-in ownership, guest status and the biography lifecycle"
}
loop: surface: checks: "community-controls": {
	verb: "test"
	cmds: ["\(_dependencyTest) omnishell --config tests/deno.json --no-lock --allow-read --allow-env tests/community-controls.ts"]
	note: "native profile forms address the biography row and immutable diffs render untrusted values as text"
}
