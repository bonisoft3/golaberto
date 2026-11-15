@extern(embed)

package golaberto

_chanceTeamNamesSQL: string @embed(file="services/database/sql/052_chance_team_names.sql", type=text)

code: state: migrations: "052_chance_team_names": operations: [{sql: {
	up: _chanceTeamNamesSQL
	onComplete: true
}}]
