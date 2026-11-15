@extern(embed)

package golaberto

import "strings"

_heavyReadsSql:          string @embed(file="services/database/sql/044_heavy_reads.sql", type=text)
_heavyReadsUpgrade:      strings.Replace(strings.Replace(_heavyReadsSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
_playerDirectoryReadSql: string @embed(file="services/database/sql/062_player_directory_read.sql", type=text)
_playerDirectoryUpgrade: strings.Replace(strings.Replace(_playerDirectoryReadSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)

code: state: migrations: {
	"044_heavy_reads": {operations: [{sql: {up: _heavyReadsUpgrade, onComplete: true}}]}
	"20261113_player_directory_read": {operations: [{sql: {up: _playerDirectoryUpgrade, onComplete: true}}]}
}
