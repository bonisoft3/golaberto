// A program with a computation, pinned where lint loads its module: the
// service loads every computation at startup and dies on one SES's
// Compartment refuses, so lint loads each the same way first.
package emit

import "strings"

import pronto "bonisoft.org/plugins/pronto"

_computed: _code & {
	state: {
		entities: Chance: {
			table:      "chance"
			durability: "live"
			fields: [{name: "id", type: "uuid", pk: true}, {name: "odds", type: "int"}]
		}
		computations: chances: {
			to: ["Chance"]
			onComplete: "capture_team_odds_history"
		}
	}
}

_computedLoop: (pronto.#DefaultLoop & {
	code: _computed
	terminal: (pronto.#DefaultTerminal & {code: _computed}).out
	cluster: (pronto.#DefaultCluster & {code: _computed, statics: []}).out
}).out
_computedCluster: (pronto.#DefaultCluster & {code: _computed, statics: []}).out
_admit: _computedLoop.surface.checks.admit

admitLints:               _admit.verb & "lint"
admitLoadsModule:         strings.HasSuffix(_admit.cmds[0], #"admit.ts) "computations/chances.js""#) & true
admitUnderPins:           strings.Contains(_admit.cmds[0], "services compute deno.json") & true
completionRpcIsForwarded: strings.Contains(_computedCluster.surface.targets.compute.compose.environment.COMPUTATIONS, #""onComplete":"capture_team_odds_history""#) & true
