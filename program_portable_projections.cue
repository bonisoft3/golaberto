@extern(embed)

package golaberto

_portableProjectionsSQL: string @embed(file="services/database/sql/050_portable_projections.sql", type=text)

code: state: {
	migrations: "050_portable_projections": operations: [{sql: {up: _portableProjectionsSQL, onComplete: true}}]
	pipelines: {
		rounds: portableDrain: {on: ["game", "phase"], call: "refresh_phase_rounds"}
	}
}
