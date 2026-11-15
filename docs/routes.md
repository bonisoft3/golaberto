# Page routes

[[../program_routes.cue]] owns every page's path and its translation keys.
Screen assemblies refer to screen names through `data-route`; they do not
construct URLs. Catalogues translate individual resource and action segments,
so the same word has the same spelling wherever it occurs.

Collections use plural nouns; record pages use a singular resource and its
identifier. Subpages and actions follow their owning resource. A scoped record
follows its parent context, with parameters addressed by name.

| Page | English pattern |
| --- | --- |
| Championship | `/championship/:slug` |
| Championship views | `/championship/:slug/matches`, `/championship/:slug/players`, `/championship/:slug/attendance` |
| Team in a championship | `/championship/:championship/team/:slug` |
| Player in a team and championship | `/championship/:championship/team/:team/player/:slug` |
| Record editor | `/match/:slug/edit` |
| Score editor | `/match/:slug/score/edit` |
| Child editor | `/match/:slug/goals/edit`, `/match/:slug/lineup/edit` |
| New record | `/matches/new` |
| Match history | `/match/:slug/history` |
| Match archive | `/matches/archive` |
| Group odds | `/group/:slug/chances` |
| Championship management | `/manage/championships` |

The selected locale prefixes these patterns; Portuguese is unprefixed.
Each page has one address per language. Removed page patterns return 404.
Canonical locale-prefix and entry-document normalization belong to the terminal.

[[../tests/route-localization.ts]] checks the hierarchy in every language and
the named parameters in scoped fixture addresses. Browser acceptance exercises
language switching, contextual navigation and removal of discarded patterns.
