//! galo2099/golaberto's odds-rust endpoints as a WASI command: one JSON
//! request on stdin, one JSON response on stdout; an error is a message on
//! stderr and exit status 1. It mirrors `odds-rust/src/http.rs::execute`
//! without HTTP or MySQL, so persistence shaping belongs to the caller.
//!
//! - `{"op":"odds","request":<model::Request>,"seed":<i64>}` → the /odds
//!   response: `{"team_odds":{"<team>":{"Pos":[percent per rank]}},
//!   "game_importance":{"<game>":[home|null,away|null]},
//!   "rare_position_estimates":{"<team>":{"<rank>":<pool::Estimate>}}}`.
//! - `{"op":"spi"|"eval"|"historic","request":<ratings::Request>}` →
//!   spi: `{"<team>":{"Id","Offense","Defense","Team"}|null}`;
//!   eval: `{"rps":f64,"team_rps":{"<team>":f64}}`, its day-of-month gate
//!   in chrono's `Local`, which is UTC on wasm32-wasip1;
//!   historic: the rows /historic_ratings would upsert, unrounded and in
//!   computation order, `[{"team_id","off_rating","def_rating","rating","measure_date":"YYYY-MM-DD"}]`.
//! - `{"op":"player_ratings","request":<Players>}` with `Players` =
//!   `{"games":[{"id","home_id","away_id","date":"YYYY-MM-DD HH:MM:SS","home_field":0|1|2,"home_aet":int|null}],
//!   "goals":[{"game_id","player_id","team_id","time","penalty","own_goal"}],
//!   "appearances":[{"id","game_id","player_id","team_id","on","off","red","position":string|null}],
//!   "historical_ratings":[{"team_id","measure_date":"YYYY-MM-DD","off_rating","def_rating"}],
//!   "now":unix seconds}` — the legacy stats service's query rows (played
//!   category-1 games within 4*52 weeks of `now`, chronological; their
//!   appearances with off > 0 in query order; the teams' rating histories by
//!   (team_id, measure_date)) → the raw totals as columns:
//!   `{"player_id","player_off","player_def","player_minutes"}` by player id
//!   and `{"appearance_id","appearance_game_id","appearance_off","appearance_def","appearance_minutes"}`
//!   by (appearance id, game id); each total is an f32 printed at its
//!   shortest round-tripping decimal.
use chrono::{NaiveDate, NaiveDateTime};
use golaberto_odds::{api, model, ratings};
use player_ratings::{Game, Goal, HistoricalRating, PlayerGame, PlayerGamePos};
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};

type Error = Box<dyn std::error::Error>;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Call {
    Odds { request: model::Request, seed: i64 },
    Spi { request: ratings::Request },
    Eval { request: ratings::Request },
    Historic { request: ratings::Request },
    PlayerRatings { request: Players },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Players {
    games: Vec<PlayerRatingGame>,
    goals: Vec<GoalRow>,
    appearances: Vec<Appearance>,
    historical_ratings: Vec<HistoryRow>,
    now: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlayerRatingGame {
    id: i32,
    home_id: i32,
    away_id: i32,
    date: String,
    home_field: i32,
    home_aet: Option<i32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GoalRow {
    game_id: i32,
    player_id: i32,
    team_id: i32,
    time: i32,
    penalty: bool,
    own_goal: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Appearance {
    id: i32,
    game_id: i32,
    player_id: i32,
    team_id: i32,
    on: i32,
    off: i32,
    red: bool,
    position: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryRow {
    team_id: i32,
    measure_date: String,
    off_rating: f32,
    def_rating: f32,
}
#[derive(Serialize, Default)]
struct PlayerTotals {
    player_id: Vec<i32>,
    player_off: Vec<f32>,
    player_def: Vec<f32>,
    player_minutes: Vec<f32>,
    appearance_id: Vec<i32>,
    appearance_game_id: Vec<i32>,
    appearance_off: Vec<f32>,
    appearance_def: Vec<f32>,
    appearance_minutes: Vec<f32>,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Error> {
    let mut body = Vec::new();
    std::io::stdin().read_to_end(&mut body)?;
    let mut out = std::io::stdout().lock();
    match serde_json::from_slice(&body)? {
        // http.rs runs /odds on 4 workers; the batches are seeded per index, so 1 gives the same draws.
        // The rare-position tail is funded by a share of the wall time the
        // stages before it took, so its draws hang on the clock; off, as
        // upstream's RUST_ODDS_RARE_TAIL=0, the response is the seed's alone.
        Call::Odds { request, seed } => {
            std::env::set_var("RUST_ODDS_RARE_TAIL", "0");
            serde_json::to_writer(&mut out, &api::calculate(request, seed, 1, 20000)?.0)?
        }
        Call::Spi { request } => {
            request.validate()?;
            serde_json::to_writer(&mut out, &ratings::spi(&request.games, &request.initial())?)?
        }
        Call::Eval { request } => serde_json::to_writer(&mut out, &ratings::evaluate(&request)?)?,
        Call::Historic { request } => {
            serde_json::to_writer(&mut out, &ratings::historical(&request)?)?
        }
        Call::PlayerRatings { request } => serde_json::to_writer(&mut out, &players(request)?)?,
    }
    out.flush()?;
    Ok(())
}

fn players(input: Players) -> Result<PlayerTotals, Error> {
    let games = input
        .games
        .into_iter()
        .map(|g| {
            Ok(Game {
                id: g.id,
                home_id: g.home_id,
                away_id: g.away_id,
                date: NaiveDateTime::parse_from_str(&g.date, "%Y-%m-%d %H:%M:%S")?,
                home_field: g.home_field,
                home_aet: g.home_aet,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let mut goals: HashMap<i32, SmallVec<[Goal; 4]>> = HashMap::new();
    for g in input.goals {
        goals.entry(g.game_id).or_default().push(Goal {
            player_id: g.player_id,
            team_id: g.team_id,
            time: g.time,
            penalty: g.penalty,
            own_goal: g.own_goal,
        });
    }
    let mut history: HashMap<i32, VecDeque<HistoricalRating>> = HashMap::new();
    for r in input.historical_ratings {
        history
            .entry(r.team_id)
            .or_default()
            .push_back(HistoricalRating {
                team_id: r.team_id,
                measure_date: NaiveDate::parse_from_str(&r.measure_date, "%Y-%m-%d")?,
                off_rating: r.off_rating,
                def_rating: r.def_rating,
            });
    }
    let mut appearances: HashMap<i32, Vec<PlayerGamePos>> = HashMap::new();
    for a in input.appearances {
        appearances
            .entry(a.game_id)
            .or_default()
            .push(PlayerGamePos {
                pg: PlayerGame {
                    id: a.id,
                    game_id: a.game_id,
                    player_id: a.player_id,
                    team_id: a.team_id,
                    on: a.on,
                    off: a.off,
                    red: a.red,
                },
                pos: a.position.unwrap_or_default(),
            });
    }
    let computed = player_ratings::calculate(&games, &goals, history, &appearances, input.now)?;
    let mut totals = PlayerTotals::default();
    let mut by_player: Vec<_> = computed.player_ratings.into_iter().collect();
    by_player.sort_by_key(|(id, _)| *id);
    for (id, r) in by_player {
        totals.player_id.push(id);
        totals.player_off.push(r.off);
        totals.player_def.push(r.def);
        totals.player_minutes.push(r.minutes);
    }
    let mut by_appearance: Vec<_> = computed.player_game_ratings.into_iter().collect();
    by_appearance.sort_by_key(|(key, _)| *key);
    for ((id, game_id), r) in by_appearance {
        totals.appearance_id.push(id);
        totals.appearance_game_id.push(game_id);
        totals.appearance_off.push(r.off);
        totals.appearance_def.push(r.def);
        totals.appearance_minutes.push(r.minutes);
    }
    Ok(totals)
}
