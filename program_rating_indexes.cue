@extern(embed)

package golaberto

import "strings"

_ratingIndexesSQL: string @embed(file="services/database/sql/051_rating_indexes.sql", type=text)

code: state: migrations: "051_rating_indexes": operations: [{sql: {
	up:         strings.Replace(strings.Replace(_ratingIndexesSQL, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
	onComplete: true
}}]
