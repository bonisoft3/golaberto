@extern(embed)

package golaberto

import "strings"

_communitySql:     string @embed(file="services/database/sql/040_community.sql", type=text)
_communityUpgrade: strings.Replace(strings.Replace(_communitySql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
code: state: migrations: "040_community": {operations: [{sql: {up: _communityUpgrade, onComplete: true}}]}

loop: surface: checks: "community-import": {
 verb: "test"
 cmds: ["python3 -m unittest discover -s tools -p community_import_test.py"]
 note: "historical public biographies and field changes preserve source identities without account claims"
}

loop: surface: checks: "community-standalone": {
 verb: "test"
 cmds: ["\(_dependencyTest) --no-config --unstable-sloppy-imports --no-lock --allow-read tests/community-standalone.ts"]
 note: "standalone migrations retain biography ownership and immutable game history"
}
