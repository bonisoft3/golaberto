// A round or event response, or an event's paired lineups and incidents,
// reconciled against the source's bindings, stages, games and players without
// I/O: the port of runtime.py's response checks and reconcile.py's event_patch
// and details_patch. Detail eligibility reads instants, so it stays SQL's
// (sofa.receive). An id the patch cannot know is `{derive: parts}`, which
// sofa.derive_ids turns into the same uuid for the same parts.

const fail = (message) => { throw new TypeError(message); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, missing = null) => (has(o, k) ? o[k] : missing);
const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fail("identifier must be text or a number"));

const review = (result, kind, externalId, reason, evidence) => {
  result.reviews.push({ kind, external_id: str(externalId), reason, evidence });
};

const bindings = (ctx, kind, externalId) => {
  const found = ctx.index.bindings.get(`${kind}:${str(externalId)}`);
  if (!found) return null;
  if (found.size > 1) fail(`conflicting ${kind} bindings for ${externalId}`);
  return [...found][0];
};

const findGame = (event, ctx) => {
  const eid = str(event.external_id);
  const bound = bindings(ctx, "game", eid);
  const matches = [...(bound ? ctx.index.gamesById.get(bound) || [] : []), ...(ctx.index.gamesByExternal.get(eid) || [])];
  if (new Set(matches.map((g) => str(g.id))).size > 1) fail(`conflicting games for ${eid}`);
  if (bound && !matches.length) fail(`game binding ${eid} references missing game`);
  return matches.length ? matches[0] : null;
};

// Lookups by key, built once per response: a round's events would otherwise
// each scan every binding and game of the championship.
const indexed = (ctx) => {
  const group = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const k = key(item);
      if (k === null) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  };
  const bindingSets = new Map();
  for (const b of ctx.bindings) {
    const k = `${b.kind}:${str(b.external_id)}`;
    if (!bindingSets.has(k)) bindingSets.set(k, new Set());
    bindingSets.get(k).add(str(b.local_id));
  }
  return {
    bindings: bindingSets,
    gamesById: group(ctx.games, (g) => str(g.id)),
    gamesByExternal: group(ctx.games, (g) => (g.external_id === null || g.external_id === undefined ? null : str(g.external_id))),
  };
};

const TERMINAL = ["cancelled", "abandoned", "awarded"];

const eventPatch = (event, ctx) => {
  const result = { rows: [], bindings: [], reviews: [], collections: [], event };
  const eid = str(event.external_id);
  const game = findGame(event, ctx);
  const stageKey = has(event, "stage_key") ? event.stage_key : str(event.stage_id);
  const stage = get(ctx.stages, stageKey);
  const teams = { home: bindings(ctx, "team", event.home_external_id), away: bindings(ctx, "team", event.away_external_id) };
  if (!stage) review(result, "stage", event.stage_id, "stage is not bound", { event_id: eid, stage_key: stageKey });
  for (const side of ["home", "away"]) {
    if (!teams[side]) {
      review(result, "team", event[`${side}_external_id`], "team is not bound",
        { name: event[side], side, event_id: eid, candidate_ids: game ? [str(game[`${side}_id`])] : [] });
    }
  }
  if (result.reviews.length) return result;
  if (teams.home === teams.away) {
    review(result, "game", eid, "both teams resolve to the same team", { team_id: teams.home });
    return result;
  }
  if (game && (str(game.phase_id) !== str(stage) || str(game.home_id) !== teams.home || str(game.away_id) !== teams.away)) {
    review(result, "game", eid, "bound fixture conflicts with stage or teams", { game_id: str(game.id) });
    return result;
  }
  if (!game) {
    const candidates = ctx.games.filter((g) => str(g.phase_id) === str(stage) && str(g.home_id) === teams.home &&
      str(g.away_id) === teams.away && !g.external_id);
    if (candidates.length) {
      review(result, "game", eid, "unbound fixture may already exist", { candidate_ids: candidates.map((g) => str(g.id)) });
      return result;
    }
  }
  // A new fixture has no local id yet: sofa.apply_source_patch creates the game
  // and binds it to the provider event in the same commit.
  const gid = game ? str(game.id) : null;
  const status = event.status;
  if (game && game.played && (status !== "finished" || !event.played)) {
    review(result, "game", eid, "provider no longer reports a played final", { game_id: gid, status });
    return result;
  }
  if (TERMINAL.includes(status)) review(result, "game", eid, "terminal outcome requires review", { game_id: gid, status });
  const fields = { phase_id: str(stage), home_id: teams.home, away_id: teams.away, day: event.day, kickoff: event.kickoff };
  // Legacy NULL already means finished for played games, scheduled otherwise.
  const effective = game ? (game.sync_status || (game.played ? "finished" : "scheduled")) : null;
  if (!game || [...TERMINAL, "postponed", "unknown"].includes(status) || !["scheduled", "in_progress", "finished"].includes(effective) ||
    (status === "finished" && !game.played)) {
    if (effective !== status) fields.sync_status = status;
  }
  if (Number.isInteger(event.round_key) && event.round_key > 0) fields.round = event.round_key;
  if (status === "finished" && event.played) {
    for (const k of ["played", "home_score", "away_score", "home_aet", "away_aet", "home_pen", "away_pen"]) fields[k] = event[k];
  } else if (status === "finished") {
    review(result, "game", eid, "final score is incomplete", { game_id: gid });
  }
  result.rows.push({ table: "game", id: gid, fields });
  if (!bindings(ctx, "game", eid)) result.bindings.push({ kind: "game", external_id: eid, local_id: gid });
  return result;
};

// Names compare as reconcile.py's _fold: NFKC, case-folded, spaces collapsed.
const fold = (value) => (typeof value === "string" ? value : "").normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const candidate = (player, other) => {
  const names = new Set(["name", "full_name"].map((k) => fold(get(player, k))).filter(Boolean));
  const otherNames = ["name", "full_name"].map((k) => fold(get(other, k))).filter(Boolean);
  return otherNames.some((n) => names.has(n)) && (!get(player, "birth") || !get(other, "birth") || player.birth === other.birth);
};
const derive = (...parts) => ({ derive: parts });
// An incident with no provider id is named by what it says.
const incidentId = (kind, eid, incident) => {
  if (get(incident, "external_id")) return derive(kind, str(incident.external_id));
  const content = {};
  for (const k of Object.keys(incident).sort()) if (k !== "external_id" && k !== "source_order") content[k] = incident[k];
  return derive(kind, eid, content);
};
const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const detailsPatch = (detail, event, ctx) => {
  const result = { rows: [], bindings: [], reviews: [], collections: [], event };
  const eid = str(event.external_id);
  const game = findGame(event, ctx);
  if (!game) { review(result, "game", eid, "game must exist before importing details", {}); return result; }
  const gid = str(game.id);
  if (!detail.complete) { review(result, "game", eid, "details are incomplete", { missing: get(detail, "missing", []) }); return result; }
  if (!event.played || event.status !== "finished") { review(result, "game", eid, "details require a played final", {}); return result; }
  const source = ctx.source;
  const resolved = new Map();
  const pendingRows = [];
  const pendingBindings = [];
  for (const player of detail.players) {
    const pid = str(player.external_id);
    const bound = bindings(ctx, "player", pid);
    const direct = new Set(ctx.players.filter((p) => p.external_id !== null && p.external_id !== undefined && str(p.external_id) === pid).map((p) => str(p.id)));
    if (bound) direct.add(bound);
    if (direct.size > 1) fail(`conflicting player bindings for ${pid}`);
    let local;
    if (direct.size) {
      local = [...direct][0];
      if (!bound) pendingBindings.push({ kind: "player", external_id: pid, local_id: local });
    } else {
      const candidates = ctx.players.filter((p) => candidate(player, p)).map((p) => str(p.id));
      if (candidates.length) { review(result, "player", pid, "possible existing player requires review", { name: player.name, candidate_ids: candidates }); continue; }
      if (!source.create_players) { review(result, "player", pid, "player is not bound", { name: player.name }); continue; }
      local = derive("player", pid);
      const fields = {};
      for (const k of ["name", "full_name", "birth", "country", "height"]) fields[k] = get(player, k);
      pendingRows.push({ table: "player", id: local, fields });
      pendingBindings.push({ kind: "player", external_id: pid, local_id: local });
    }
    resolved.set(pid, local);
  }
  if (result.reviews.length) return result;
  result.rows.push(...pendingRows);
  result.bindings.push(...pendingBindings);
  const ids = { player_game: [], goal: [], substitution: [] };
  for (const app of detail.appearances) {
    const playerId = resolved.get(str(app.player_external_id));
    const teamId = str(game[`${app.side}_id`]);
    const membership = { championship_id: str(source.championship_id), team_id: teamId, player_id: playerId };
    result.rows.push({ table: "team_player", id: derive("team_player", membership.championship_id, teamId, playerId), fields: membership });
    const rid = derive("player_game", gid, playerId);
    ids.player_game.push(rid);
    const fields = { game_id: gid, player_id: playerId };
    for (const k of ["side", "on_minute", "off_minute", "bench", "yellow", "red"]) fields[k] = app[k];
    result.rows.push({ table: "player_game", id: rid, fields });
  }
  for (const [kind, plural] of [["goal", "goals"], ["substitution", "substitutions"]]) {
    for (const incident of detail[plural]) {
      const rid = incidentId(kind, eid, incident);
      if (ids[kind].some((known) => sameId(known, rid))) {
        review(result, kind, eid, "indistinguishable incidents require review", { incident });
        continue;
      }
      ids[kind].push(rid);
      const fields = { game_id: gid, side: incident.side, minute: incident.minute };
      if (kind === "goal") {
        fields.player_id = resolved.get(str(incident.player_external_id));
        for (const k of ["penalty", "own_goal", "aet"]) fields[k] = incident[k];
      } else {
        fields.player_off_id = resolved.get(str(incident.player_off_external_id));
        fields.player_on_id = resolved.get(str(incident.player_on_external_id));
      }
      fields.added_time = get(incident, "added_time");
      fields.period = get(incident, "period");
      fields.source_order = get(incident, "source_order");
      result.rows.push({ table: kind, id: rid, fields });
    }
  }
  if (result.reviews.length) { result.rows = []; result.bindings = []; return result; }
  result.collections = Object.entries(ids).map(([table, list]) => ({ game_id: gid, table, ids: list }));
  return result;
};

const checkSources = (input) => {
  const { raw_events: raws, events, source } = input;
  if (!Array.isArray(raws) || !Array.isArray(events) || raws.length !== events.length) fail("events must be a list");
  raws.forEach((raw, i) => {
    if (!isObject(raw)) fail("event must be an object");
    const tournament = get(raw, "tournament", {});
    if (!isObject(tournament) || (has(raw, "season") && !isObject(raw.season)) ||
      (has(tournament, "uniqueTournament") && !isObject(tournament.uniqueTournament))) {
      fail("invalid response source metadata");
    }
    const event = events[i];
    if (has(raw, "season") && event.season_id === null) fail("invalid response season id");
    if (has(tournament, "uniqueTournament") && event.unique_tournament_id === null) fail("invalid response tournament id");
    if (has(tournament, "id") && event.stage_id === null) fail("invalid response stage id");
    if (event.season_id !== null && Number(event.season_id) !== source.season_id) fail("response season differs from configured source");
    if (event.unique_tournament_id !== null && Number(event.unique_tournament_id) !== source.unique_tournament_id) {
      fail("response tournament differs from configured source");
    }
  });
};

(input) => {
  if (!isObject(input) || !isObject(input.source) || !isObject(input.ctx)) fail("input must carry a source and a context");
  if (input.family === "details") {
    if (!isObject(input.detail) || !isObject(input.event)) fail("details need the detail and its event");
    const ctx = { ...input.ctx, source: input.source, players: get(input.ctx, "players", []), index: indexed(input.ctx) };
    return detailsPatch(input.detail, input.event, ctx);
  }
  if (!["round", "event"].includes(input.family)) fail("family must be round, event or details");
  checkSources(input);
  const scope = input.source.event_scope;
  if (!["competition", "stages", "fixtures"].includes(scope)) fail("invalid event scope");
  const ctx = { ...input.ctx, index: indexed(input.ctx) };
  const bound = new Set(ctx.games.filter((g) => g.external_id !== null && g.external_id !== undefined).map((g) => str(g.external_id)));
  const stages = new Set(Object.keys(ctx.stages).map((key) => key.split("|")[0]).filter((base) => /^[0-9]+$/.test(base) && Number(base) > 0));
  let events = input.events;
  const requested = input.requested_event;
  if (input.family === "event" && requested && events.some((e) => e.external_id !== requested)) {
    fail("response event differs from requested fixture");
  }
  if (scope === "stages") events = events.filter((e) => stages.has(e.stage_id) || bound.has(e.external_id));
  else if (scope === "fixtures") events = events.filter((e) => bound.has(e.external_id));
  return { events, patches: events.map((event) => eventPatch(event, ctx)) };
};
