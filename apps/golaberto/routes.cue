package golaberto

#PublicParam: {
	entity: "PublicAddress"
	id: "record_id"
	field: "slug"
	_kind: string
	filter: "kind=eq.\(_kind)"
}

code: surface: screens: {
	equipe: routeParams: id: (#PublicParam & {_kind: "team"})
	"equipe-campeonato": routeParams: {
		id: (#PublicParam & {_kind: "team"})
		championship: (#PublicParam & {_kind: "championship"})
	}
	campeonato: routeParams: id: (#PublicParam & {_kind: "championship"})
	jogo: routeParams: id: (#PublicParam & {_kind: "game"})
	editar: routeParams: id: (#PublicParam & {_kind: "game"})
	chances: routeParams: id: (#PublicParam & {_kind: "group"})
	jogador: routeParams: id: (#PublicParam & {_kind: "player"})
	estadio: routeParams: id: (#PublicParam & {_kind: "stadium"})
	arbitro: routeParams: id: (#PublicParam & {_kind: "referee"})
}

loop: surface: checks: "route-addresses-unit": {
	verb: "test"
	cmds: ["mise exec -- deno test --config ../../plugins/omnishell/test/deno.json --no-lock --allow-read --allow-env ../../plugins/omnishell/test/route-addresses.test.ts ../../plugins/omnishell/test/served-modules.test.ts"]
	note: "bounded public address lookup, link races, cache retries and module delivery"
}

loop: surface: checks: "slug-routes": {
	verb: "integrate"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=localhost tests/slug-routes.ts"]
	note: "readable routes, UUID aliases, localized deep links, selectors, graphs and navigation recovery"
}
