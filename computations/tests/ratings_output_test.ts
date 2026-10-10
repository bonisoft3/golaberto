import { assert, assertEquals } from "@std/assert";
import { finish } from "../ratings.js";

type PlayerRating = { id: string; rating: number; off_rating: number; def_rating: number };

Deno.test("current player components retain unsquashed per90 values and player identity", () => {
  const inputs = {
    games: [{ phase_id: "phase", recent: true }],
    teams: [],
    players: [{ id: "player-b" }, { id: "player-a" }, { id: "unplayed" }],
    phases: [],
  };
  const rows: PlayerRating[] = finish(inputs, [[], {
    player_id: [2, 1],
    player_off: [45, 7.5],
    player_def: [22.5, -2.5],
    player_minutes: [450, 225],
  }]).player_rating;
  assertEquals(rows.map(({ id, off_rating, def_rating }) => ({ id, off_rating, def_rating })), [
    { id: "player-b", off_rating: 9, def_rating: 4.5 },
    { id: "player-a", off_rating: 3.000000238418579, def_rating: -1 },
  ]);
  assert(rows.every((row) => row.rating < row.off_rating + row.def_rating));
  assert(rows.every((row) => [row.rating, row.off_rating, row.def_rating].every(
    (value) => Number.isFinite(value) && Math.fround(value) === value,
  )));
});

Deno.test("zero observed contribution remains zero while unplayed players stay absent", () => {
  const inputs = {
    games: [{ phase_id: "phase", recent: true }],
    teams: [],
    players: [{ id: "played" }, { id: "unplayed" }],
    phases: [],
  };
  assertEquals(finish(inputs, [[], {
    player_id: [1], player_off: [0], player_def: [0], player_minutes: [90],
  }]).player_rating, [{ id: "played", rating: 0, off_rating: 0, def_rating: 0 }]);
  assertEquals(finish(inputs, [[], {
    player_id: [], player_off: [], player_def: [], player_minutes: [],
  }]).player_rating, []);
});
