package golaberto

import "strings"

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
					if c.type == "source" {tables: strings.Join(_cdcTables, ",")}
				}
			}]
		}]
	}
}
