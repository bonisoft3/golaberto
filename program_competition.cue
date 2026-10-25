@extern(embed)

package golaberto

import "strings"

_competitionAdminSql:     string @embed(file="services/database/sql/037_competition_admin.sql", type=text)
_competitionAdminUpgrade: strings.Replace(strings.Replace(_competitionAdminSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)

code: state: entities: {
	PhaseClone: {
		id: "0x9cd5d0c3f466c354"
		table:      "phase_clone"
		durability: "server"
		access: {scope: "private", owner: "app_user_id"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "app_user_id", type: "uuid", ref: "app_user", default: "auth_uid()"},
			{ordinal: 3, name: "source_phase_id", type: "uuid"},
			{ordinal: 4, name: "target_championship_id", type: "uuid", default: "gen_random_uuid()"},
			{ordinal: 5, name: "target_phase_id", type: "uuid", default: "gen_random_uuid()"},
			{ordinal: 6, name: "name", type: "string", cel: "this.size() > 0 && this.size() <= 120"},
			{ordinal: 7, name: "begins", type: "date"},
			{ordinal: 8, name: "ends", type: "date"},
			{ordinal: 9, name: "created_at", type: "timestamp", default: "now()"},
		]
		invariant: {cel: "this.ends >= this.begins"}
	}
}

code: state: migrations: "037_competition_admin": {operations: [{sql: {up: _competitionAdminUpgrade, onComplete: true}}]}
