import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  Feldera,
  type FelderaProgram,
} from "@bonisoft3/mecha/services/compute/feldera.ts";
import * as ratings from "../computations/ratings.js";
import * as chances from "../computations/chances.js";
import { uid, World } from "../computations/tests/world.ts";
import { inputs } from "../computations/tests/compute.ts";
import { ordered } from "./order.js";
import { calendarWorld } from "./calendar-fixture.ts";

const endpoint = Deno.env.get("FELDERA_TEST_URL");
for (
  const [name, program] of [["ratings", ratings], ["chances", chances]] as const
) {
  Deno.test({
    name:
      `native ${name} matches snapshot queries across bootstrap, updates and deletes`,
    ignore: !endpoint,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const pipeline = `golaberto-${name}-integration`;
      const descriptor: FelderaProgram = JSON.parse(
        await Deno.readTextFile(
          new URL(`${name}.feldera.json`, import.meta.url),
        ),
      );
      const native = new Feldera(endpoint!, pipeline, descriptor);
      const api = async (suffix: string, method = "GET") => {
        const response = await fetch(
          `${endpoint}/v0/pipelines/${pipeline}${suffix}`,
          { method },
        );
        if (!response.ok) {
          throw new Error(`${method} ${suffix}: ${await response.text()}`);
        }
        return await response.json();
      };
      const wait = async (field: string, wanted: string) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if ((await api(""))[field] === wanted) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`cleanup did not reach ${wanted}`);
      };
      try {
        let world = new World();
        world.rows.team_rating = world.teams.flatMap((team, i) =>
          ["2026-04-01", "2026-05-24"].map((day, j) => ({
            id: uid(12, i * 10 + j),
            team_id: team,
            measure_date: day,
            offense: String(1.23456789 + j),
            defense: String(0.98765432 + j),
            rating: "50",
          }))
        );
        const games = world.rows.game.filter((g) => g.played === "false");
        games[0].kickoff = "2026-05-24T00:00:00.000000Z";
        games[1].kickoff = "2026-05-24T00:00:00.000001Z";
        const played = world.rows.game.find((g) => g.played === "true")!;
        played.kickoff = "2024-02-29T23:59:59.500001Z";
        for (let stage = 0; stage < (name === "ratings" ? 6 : 4); stage++) {
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
          if (name === "ratings" && stage === 3) world = calendarWorld(7);
          if (name === "ratings" && stage === 4) world = calendarWorld(4);
          if (stage === (name === "ratings" ? 5 : 3)) world.rows.game = [];
          const lake = await world.lake();
          const expected = await inputs(program.queries, lake);
          const actual = await native.capture(lake);
          assertEquals(
            ordered(name, actual),
            ordered(name, expected),
            `stage ${stage}`,
          );
          if (name === "chances") {
            assertEquals(chances.plan(actual, 17), chances.plan(expected, 17));
          } else {assertEquals(
              ratings.plan(actual, 17, []),
              ratings.plan(expected, 17, []),
            );}
          console.log(`${name}: stage ${stage} matched`);
        }
        world = new World();
        const teams = world.rows.team;
        const players = world.rows.player;
        for (const missing of [true, false]) {
          world.rows.team = missing ? teams.slice(1) : teams;
          world.rows.player = missing ? [] : players;
          const lake = await world.lake();
          const actual = await native.capture(lake);
          assertEquals(
            ordered(name, actual),
            ordered(name, await inputs(program.queries, lake)),
          );
          if (name === "ratings") ratings.plan(actual, 17, [[]]);
          else {
            chances.plan(actual, 17);
            if (missing) assertEquals(actual.groups, []);
          }
        }
      } finally {
        await api("/stop?force=true", "POST");
        await wait("deployment_status", "Stopped");
        await api("/clear", "POST");
        await wait("storage_status", "Cleared");
        const response = await fetch(`${endpoint}/v0/pipelines/${pipeline}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error(`cleanup: ${await response.text()}`);
        }
        await response.text();
      }
    },
  });
}
