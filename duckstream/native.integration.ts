import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  RisingWave,
  type RisingWaveProgram,
} from "@bonisoft3/mecha/services/compute/risingwave.ts";
import * as teamRatings from "../computations/team_ratings.js";
import * as playerRatings from "../computations/player_ratings.js";
import * as chances from "../computations/chances.js";
import { uid, World } from "../computations/tests/world.ts";
import { inputs } from "../computations/tests/compute.ts";
import { ordered } from "./order.js";
import { calendarWorld } from "./calendar-fixture.ts";

const endpoint = Deno.env.get("RISINGWAVE_TEST_URL") ??
  Deno.env.get("RISINGWAVE_URL");
for (
  const [name, program] of [
    ["team_ratings", teamRatings],
    ["player_ratings", playerRatings],
    ["chances", chances],
  ] as const
) {
  Deno.test({
    name:
      `native ${name} matches snapshot queries across bootstrap, updates and deletes`,
    ignore: !endpoint,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const pipeline = `golaberto-${name}-integration`;
      const descriptor: RisingWaveProgram = JSON.parse(
        await Deno.readTextFile(
          new URL(`${name}.risingwave.json`, import.meta.url),
        ),
      );
      const native = new RisingWave(endpoint!, pipeline, descriptor);
      try {
        let world = new World();
        const seedTeamRatings = (w: World) =>
          w.teams.flatMap((team, i) =>
            ["2026-04-01", "2026-05-24"].map((day, j) => ({
              id: uid(12, i * 10 + j),
              team_id: team,
              measure_date: day,
              offense: String(1.23456789 + j),
              defense: String(0.98765432 + j),
              rating: "50",
            }))
          );
        world.rows.team_rating = seedTeamRatings(world);
        const games = world.rows.game.filter((g) => g.played === "false");
        games[0].kickoff = "2026-05-24T00:00:00.000000Z";
        games[1].kickoff = "2026-05-24T00:00:00.000001Z";
        const played = world.rows.game.find((g) => g.played === "true")!;
        played.kickoff = "2024-02-29T23:59:59.500001Z";
        const isRatings = name !== "chances";
        for (let stage = 0; stage < (isRatings ? 6 : 4); stage++) {
          if (stage === 1) {
            games[0].played = "true";
            games[0].home_score = "3";
            games[0].away_score = "1";
            world.rows.team_rating.at(-1)!.offense = "5.67890123";
          }
          if (stage === 2) {
            world.rows.game.splice(world.rows.game.indexOf(played), 1);
            world.rows.team_rating.pop();
          }
          if (isRatings && stage === 3) {
            world = calendarWorld(7);
            world.rows.team_rating = seedTeamRatings(world);
          }
          if (isRatings && stage === 4) {
            world = calendarWorld(4);
            world.rows.team_rating = seedTeamRatings(world);
          }
          if (stage === (isRatings ? 5 : 3)) world.rows.game = [];
          const lake = await world.lake();
          const expected = await inputs(program.queries, lake);
          const actual = await native.capture(lake);
          assertEquals(
            ordered(name, actual),
            ordered(name, expected),
            `stage ${stage}`,
          );
          assertEquals(
            program.plan(actual, 17, []),
            program.plan(expected, 17, []),
          );
          console.log(`${name}: stage ${stage} matched`);
        }
        world = new World();
        world.rows.team_rating = seedTeamRatings(world);
        const teams = world.rows.team;
        const players = world.rows.player;
        for (const missing of [true, false]) {
          world.rows.team = missing ? teams.slice(1) : teams;
          world.rows.player = missing ? [] : players;
          world.rows.team_rating = missing ? [] : seedTeamRatings(world);
          const lake = await world.lake();
          const actual = await native.capture(lake);
          assertEquals(
            ordered(name, actual),
            ordered(name, await inputs(program.queries, lake)),
          );
          program.plan(actual, 17, []);
          if (name === "chances" && missing) assertEquals(actual.groups, []);
          if (name === "player_ratings" && missing) assertEquals(actual.games, []);
        }
      } finally {
        await native.close();
      }
    },
  });
}
