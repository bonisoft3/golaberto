export interface TeamPrior {
  id: number;
  offense: number;
  defense: number;
  team: number;
}

export interface SpiRating {
  Id: number;
  Offense: number;
  Defense: number;
  Team: number;
}

export interface HistoricalRating {
  team_id: number;
  off_rating: number;
  def_rating: number;
  rating: number;
  measure_date: string;
}

export interface HistoricCheckpoint {
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastOrdinal: number;
  nextOffset: number;
  complete: boolean;
  ratings: readonly TeamPrior[];
}

export interface HistoricGame {
  ordinal: number;
  timestamp: number;
  last: boolean;
}

/** Select games in their original order, including both window boundaries. */
export interface HistoricWindow {
  minimumTimestamp: number;
  throughOrdinal: number;
}

export type FitHistoric = (
  window: HistoricWindow,
  ratings: readonly TeamPrior[],
) => Promise<Record<string, SpiRating | null>>;

export function initialHistoric(
  ratings: readonly TeamPrior[],
): HistoricCheckpoint {
  const ids = new Set<number>();
  for (const r of ratings) {
    if (
      !Number.isSafeInteger(r.id) || ids.has(r.id) ||
      ![r.offense, r.defense, r.team].every(Number.isFinite)
    ) {
      throw new Error("invalid initial historic ratings");
    }
    ids.add(r.id);
  }
  return {
    firstTimestamp: null,
    lastTimestamp: null,
    lastOrdinal: -1,
    nextOffset: 4 * 52 * 7 * 86400,
    complete: false,
    ratings: ratings.map((r) => ({ ...r })).sort((a, b) => a.id - b.id),
  };
}

/** Persist rows and checkpoint together against the same immutable input snapshot. */
export async function advanceHistoric(
  previous: HistoricCheckpoint,
  game: HistoricGame,
  fit: FitHistoric,
): Promise<{ checkpoint: HistoricCheckpoint; rows: HistoricalRating[] }> {
  if (
    previous.complete || game.ordinal !== previous.lastOrdinal + 1 ||
    !Number.isSafeInteger(game.timestamp) ||
    !Number.isFinite(new Date(game.timestamp * 1000).getTime()) ||
    (previous.lastTimestamp !== null && game.timestamp < previous.lastTimestamp)
  ) {
    throw new Error(
      "historic games must continue in chronological ordinal order",
    );
  }
  const firstTimestamp = previous.firstTimestamp ?? game.timestamp;
  const checkpoint: HistoricCheckpoint = {
    ...previous,
    firstTimestamp,
    lastTimestamp: game.timestamp,
    lastOrdinal: game.ordinal,
    complete: game.last,
  };
  if (game.timestamp - firstTimestamp <= previous.nextOffset && !game.last) {
    return { checkpoint, rows: [] };
  }

  const result = await fit({
    minimumTimestamp: game.timestamp - 4 * 365 * 86400,
    throughOrdinal: game.ordinal,
  }, previous.ratings.map((r) => ({ ...r })));
  if (Object.keys(result).length !== previous.ratings.length) {
    throw new Error("SPI returned different historic team IDs");
  }
  const rows: HistoricalRating[] = [];
  const date = new Date(game.timestamp * 1000).toISOString().slice(0, 10);
  checkpoint.ratings = previous.ratings.map(({ id }) => {
    if (!Object.hasOwn(result, id)) {
      throw new Error("SPI returned different historic team IDs");
    }
    const r = result[id];
    // SPI initializes absent priors to zero; its request cannot encode None.
    if (r === null) return { id, offense: 0, defense: 0, team: 0 };
    if (r.Id !== id || ![r.Offense, r.Defense, r.Team].every(Number.isFinite)) {
      throw new Error("SPI returned invalid historic ratings");
    }
    if (r.Team !== 0) {
      rows.push({
        team_id: id,
        off_rating: r.Offense,
        def_rating: r.Defense,
        rating: r.Team,
        measure_date: date,
      });
    }
    return { id, offense: r.Offense, defense: r.Defense, team: r.Team };
  });
  // Upstream advances once per game, even when sparse dates leave it behind.
  checkpoint.nextOffset += 86400;
  return { checkpoint, rows };
}
