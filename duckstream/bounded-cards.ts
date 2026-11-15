import { type ProjectionHost, projectionStep } from "./bounded-projection.ts";
export const step = (host: ProjectionHost, checkpoint: unknown) =>
  projectionStep(host, ["game_card", "team_game"], checkpoint);
