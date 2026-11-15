import { type ProjectionHost, projectionStep } from "./bounded-projection.ts";
export const step = (host: ProjectionHost, checkpoint: unknown) =>
  projectionStep(host, ["player_stat"], checkpoint);
