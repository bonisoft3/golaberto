// Relational outputs are unordered, including native RisingWave snapshots. Keep
// the numerical program's original stable archive order for seeded jobs.
const ordering = {
  standings: {groups: ["id"], members: ["group_id", "team_id"], form: [], zones: ["group_id", "id"]},
  cards: {game_card: ["id"], team_game: ["id"]},
  player_stats: {player_stat: ["id"]},
  ratings: {
    games: ["moment", "id"],
    phases: ["id"],
    teams: ["id"],
    players: ["id"],
    appearances: ["id"],
    goals: ["__order"],
  },
  chances: {
    groups: ["id"],
    members: ["group_id", "name", "team_id"],
    games: ["group_id", "__order", "id"],
    zones: ["group_id", "first", "last", "id"],
  },
};
const compare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return a < b ? -1 : 1;
  let left = 0, right = 0;
  while (left < a.length && right < b.length) {
    const l = a.codePointAt(left), r = b.codePointAt(right);
    if (l !== r) return l - r;
    left += l > 0xffff ? 2 : 1;
    right += r > 0xffff ? 2 : 1;
  }
  return (a.length - left) - (b.length - right);
};
export const ordered = (name, inputs) =>
  Object.fromEntries(
    Object.entries(inputs).map(([key, rows]) => [
      key,
      [...rows].sort((a, b) => {
        for (const field of ordering[name][key] || []) {
          if (a[field] === b[field]) continue;
          if (a[field] == null) return 1;
          if (b[field] == null) return -1;
          return compare(a[field], b[field]);
        }
        return 0;
      }),
    ]),
  );
