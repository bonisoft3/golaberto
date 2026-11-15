import { World } from "../computations/tests/world.ts";

export function calendarWorld(years: 4 | 7): World {
  const world = new World();
  const kickoffs = years === 7
    ? ["2021-02-28T18:00:00Z", "2028-02-28T21:00:00Z", "2028-02-29T15:00:00Z"]
    : ["2104-02-28T21:00:00Z", "2104-02-29T15:00:00Z", "2104-03-01T12:00:00Z"];
  world.rows.game = world.rows.game.slice(0, 3).map((game, i) => ({
    ...game,
    phase_id: world.phases["2026"],
    played: "true",
    kickoff: kickoffs[i],
    day: kickoffs[i].slice(0, 10),
  }));
  return world;
}
