// golaberto-odds.wasm under the compute service's WASI host. The oracles:
// ratings-go-oracle.json is the Go service's spi/eval/historic output (as
// odds-rust/tests/ratings.rs) on teamsRequest; player-*.json are the stats
// service's frozen f32 bits (stats/core/tests/calculation.rs); the .json.gz
// keep the native odds-rust `estimate` at seed 808 on 4 workers with
// RUST_ODDS_RARE_TAIL=0, as the module runs it.
import { assert, assertEquals } from "@std/assert";
import { runWasm } from "../../../../libraries/mecha/services/compute/wasi.ts";

const here = new URL(".", import.meta.url);
const fixtures = new URL("fixtures/", here);
const module = new WebAssembly.Module(
	Deno.readFileSync(new URL("../golaberto-odds.wasm", here)),
);

function call(
	op: string,
	request: unknown,
	extra: Record<string, unknown> = {},
) {
	const out = runWasm(
		module,
		new TextEncoder().encode(JSON.stringify({ op, request, ...extra })),
		"golaberto-odds",
	);
	return JSON.parse(new TextDecoder().decode(out));
}

const json = (name: string) =>
	JSON.parse(Deno.readTextFileSync(new URL(name, fixtures)));
async function gz(name: string) {
	const stream = (await Deno.open(new URL(name, fixtures))).readable
		.pipeThrough(new DecompressionStream("gzip"));
	return JSON.parse(await new Response(stream).text());
}

/** Largest absolute difference; keys, lengths and non-numbers must match exactly. */
function maxError(actual: unknown, expected: unknown): number {
	if (typeof expected === "number") {
		return Math.abs((actual as number) - expected);
	}
	if (Array.isArray(expected)) {
		assertEquals((actual as unknown[]).length, expected.length);
		return Math.max(
			0,
			...expected.map((e, i) => maxError((actual as unknown[])[i], e)),
		);
	}
	if (expected !== null && typeof expected === "object") {
		assertEquals(
			Object.keys(actual as object).sort(),
			Object.keys(expected).sort(),
		);
		return Math.max(
			0,
			...Object.entries(expected).map(([k, e]) =>
				maxError((actual as Record<string, unknown>)[k], e)
			),
		);
	}
	assertEquals(actual, expected);
	return 0;
}

/** 360 round-robin games of teams 1–3 every 5 days; team 4 never plays. */
function teamsRequest(phases: number[]) {
	const HOME_ADV = 0.16133676871779334;
	const games = Array.from({ length: 360 }, (_, i) => ({
		phase_id: i < 300 ? 1 : 2,
		home_id: 1 + i % 3,
		away_id: 1 + (i + 1) % 3,
		home_score: i % 5,
		away_score: i * 7 % 4,
		timestamp: 1500000000 + i * 5 * 86400,
		length: i % 17 === 0 ? 4 / 3 : 1,
		advantage: [0, HOME_ADV, -HOME_ADV][i % 3],
	}));
	const ratings = [1, 2, 3, 4].map((id) => ({
		id,
		offense: id % 2 === 0 ? 1.4 : 0,
		defense: id % 2 === 0 ? 1.2 : 0,
		team: 0,
	}));
	return { games, ratings, phases_to_eval: phases };
}

const oracle = json("ratings-go-oracle.json");

Deno.test("spi matches the Go oracle", () => {
	const result = call("spi", teamsRequest([]));
	assertEquals(result["4"], null);
	assert(maxError(result, oracle.spi) <= 1e-10);
});

Deno.test("eval matches the Go oracle", () => {
	assert(maxError(call("eval", teamsRequest([2])), oracle.eval) <= 1e-12);
});

Deno.test("historic rows, upserted as the service persists them, match the Go oracle", () => {
	const rows: Record<string, number | string>[] = call(
		"historic",
		teamsRequest([]),
	);
	// The last row per (team, day) wins, at the six decimals of the SQL values.
	const last = new Map(rows.map((r) => [`${r.team_id} ${r.measure_date}`, r]));
	const order = (
		a: Record<string, number | string>,
		b: Record<string, number | string>,
	) =>
		(a.team_id as number) - (b.team_id as number) ||
		String(a.measure_date).localeCompare(String(b.measure_date));
	const persisted = [...last.values()].sort(order).map((r) => {
		const round = (v: unknown) => Number((v as number).toFixed(6));
		return {
			...r,
			off_rating: round(r.off_rating),
			def_rating: round(r.def_rating),
			rating: round(r.rating),
		};
	});
	assertEquals(persisted.length, 204);
	assert(maxError(persisted, oracle.historic) <= 0.500001e-6);
});

Deno.test("player ratings reproduce the stats service's frozen f32 bits", () => {
	const input = json("player-input.json");
	const expected = json("player-legacy-output.json");
	const r = call("player_ratings", {
		games: input.games,
		goals: input.goals,
		appearances: input.appearances.map(({ pos, ...a }: { pos: string }) => ({
			...a,
			position: pos,
		})),
		historical_ratings: input.ratings,
		now: input.now,
	});
	const bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];
	assertEquals(
		r.player_id.map((
			id: number,
			i: number,
		) => [
			id,
			...[r.player_off, r.player_def, r.player_minutes].map((c) => bits(c[i])),
		]),
		expected.players,
	);
	assertEquals(
		r.appearance_id.map((id: number, i: number) => [
			id,
			r.appearance_game_id[i],
			...[r.appearance_off, r.appearance_def, r.appearance_minutes].map((c) =>
				bits(c[i])
			),
		]),
		expected.appearances,
	);
});

Deno.test("odds is the native binary's response at the same seed", async () => {
	const fixture = await gz("small8-gd.json.gz");
	const out = runWasm(
		module,
		new TextEncoder().encode(
			JSON.stringify({ op: "odds", request: fixture.request, seed: 808 }),
		),
		"golaberto-odds",
	);
	assertEquals(new TextDecoder().decode(out), fixture.response);
});

Deno.test("odds game importance is the native binary's at the same seed", async () => {
	for (const name of ["small6-head.json.gz", "small6-name.json.gz"]) {
		const fixture = await gz(name);
		assertEquals(
			call("odds", fixture.request, { seed: 808 }).game_importance,
			fixture.game_importance,
		);
	}
});
