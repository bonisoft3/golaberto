@extern(embed)

package golaberto

import (
	"list"
	"strings"
)

// Raw streams own their event filters. Keep their sources alongside the
// computations' inputs; final projections and request-time views need no bus.
_cdcTables: [
	"championship", "phase", "game", "team", "player", "player_game", "goal",
	"stage_group", "team_group", "zone", "team_rating", "standing", "stadium", "referee",
]

// The same membership applies to fresh databases and existing volumes.
_cdcOutputsSql: """
	-- tier: container
	ALTER PUBLICATION golaberto_cdc SET TABLE \(strings.Join(_cdcTables, ", "));
	-- tier: any
	"""

// What wakes a drain and is not already above: its queues, and the sources of
// the projections it recomputes whole. Change feed only; Electric's
// publication and the tables' policies are untouched.
_drainTables: list.SortStrings([for t, _ in {
	for _, d in code.state.drains for t in d.on if !list.Contains(_cdcTables, t) {(t): _}
} {t}])
_feedTables: list.Concat([_cdcTables, _drainTables])

_drainKeySql: string @embed(file="services/database/sql/045_drain_feed.sql", type=text)
_drainFeedSql: strings.Replace(strings.Replace(_drainKeySql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1) + """
	-- tier: container
	ALTER PUBLICATION golaberto_cdc SET TABLE \(strings.Join(_feedTables, ", "));
	-- tier: any
	"""
code: state: migrations: "045_drain_feed": {operations: [{sql: {up: _drainFeedSql, onComplete: true}}]}

cluster: meta: conduitTemplate: "docker/golaberto-cdc.yaml"

out: files: "docker/golaberto-cdc.yaml": {
	format: "yaml"
	data: {
		let template = out.files["docker/conduit-pipeline.yaml"].data
		version: template.version
		pipelines: [for p in template.pipelines {
			for k, v in p if k != "connectors" {(k): v}
			connectors: [for c in p.connectors {
				for k, v in c if k != "settings" {(k): v}
				settings: {
					for k, v in c.settings if c.type != "source" || k != "tables" {(k): v}
					if c.type == "source" {tables: strings.Join(_feedTables, ",")}
				}
			}]
		}]
	}
}
