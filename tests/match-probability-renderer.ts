import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1.0.11";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";
import renderNodes from "../shell/renderers/match-probability.js";
import { built } from "./terminal-nodes.ts";

const render = (value: string) => built(renderNodes(value));

const math = renderNodes as typeof renderNodes & {
  prematchOdds: (powers: { home: number; away: number }) => {
    home: number;
    draw: number;
    away: number;
  };
  scenarioAt: (
    powers: { home: number; away: number },
    options?: Record<string, unknown>,
  ) => Record<string, any>;
  scenarioTimeline: (
    powers: { home: number; away: number },
    options?: Record<string, unknown>,
  ) => Array<Record<string, any>>;
};
// The view computes powers (tests/match-probability.ts pins them to the Rails
// oracle); the renderer starts from them.
const powers = { home: 1.7132705603476661, away: 0.7115873134210589 };
const vector = (odds: { home: number; draw: number; away: number }) => [
  odds.home,
  odds.draw,
  odds.away,
];
const close = (actual: number[], expected: number[], tolerance = 1e-12) => {
  assertEquals(actual.length, expected.length);
  actual.forEach((value, index) =>
    assertAlmostEquals(value, expected[index], tolerance)
  );
};
const oracle = [
  {
    field: "left",
    powers: [1.7132705603476661, 0.7115873134210589],
    odds: [0.614394274140822, 0.23406503439584928, 0.15154069146332472],
  },
  {
    field: "neutral",
    powers: [1.523382677768666, 0.8707733723982072],
    odds: [0.5260457184027223, 0.2588704288386923, 0.21508385275858527],
  },
  {
    field: "right",
    powers: [1.3334947951896658, 1.0299594313753555],
    odds: [0.43625887144106273, 0.2750885693827666, 0.28865255917617083],
  },
];

Deno.test("prematch probabilities match the independent Rails oracle", () => {
  for (const expected of oracle) {
    const [home, away] = expected.powers;
    close(vector(math.prematchOdds({ home, away })), expected.odds);
  }
});

Deno.test("the ceiling power keeps the finite Rails probability tail visible", () => {
  const odds = vector(math.prematchOdds({ home: 10, away: 10 }));
  close(odds, [0.4516637044368814, 0.08977583965300974, 0.4516637044368814]);
  assert(odds.reduce((sum, value) => sum + value, 0) < 0.994);
});

const repeated = (counts: number[], minute: number) =>
  counts.flatMap((count, index) =>
    Array.from(
      { length: count },
      () => ({ minute, side: index === 0 ? "home" : "away" }),
    )
  );

Deno.test("time, goals, red cards and added time match Rails live-graph fixtures", () => {
  const scenarios = [
    [0, 5, [0, 0], [0, 0], [
      0.6143942743924131,
      0.23406503449169747,
      0.15154069152537972,
    ]],
    [30, 5, [1, 0], [0, 0], [
      0.8463349517742135,
      0.12173537018848626,
      0.03192967831747981,
    ]],
    [45, 5, [1, 1], [1, 0], [
      0.37224873806537256,
      0.416164024877475,
      0.21158723725803164,
    ]],
    [75, 8, [2, 1], [2, 1], [
      0.8561252952361719,
      0.12910118137525314,
      0.01477352348097892,
    ]],
    [95, 5, [1, 0], [0, 0], [1, 0, 0]],
  ] as const;
  for (const [minute, addedTime, score, reds, odds] of scenarios) {
    const result = math.scenarioAt(powers, {
      minute,
      addedTime,
      goals: repeated([...score], 10),
      redCards: repeated([...reds], 20),
    });
    close(vector(result.odds), [...odds], 1e-9);
  }
});

Deno.test("future and simultaneous events affect only their minute and later", () => {
  const redCards = [{ side: "home", minute: 60 }];
  assertEquals(
    math.scenarioAt(powers, { minute: 59, redCards }),
    math.scenarioAt(powers, { minute: 59 }),
  );
  const later = math.scenarioAt(powers, { minute: 60, redCards });
  const noRed = math.scenarioAt(powers, { minute: 60 });
  assertAlmostEquals(
    later.remainingPower.home / noRed.remainingPower.home,
    0.8,
  );
  assertAlmostEquals(
    later.remainingPower.away / noRed.remainingPower.away,
    1.25,
  );
  assertEquals(
    math.scenarioAt(powers, {
      minute: 37,
      goals: [{ side: "away", minute: 37 }, { side: "home", minute: 37 }],
    }).score,
    { home: 1, away: 1 },
  );
});

Deno.test("the final whistle resolves the observed score without normalization", () => {
  assertEquals(
    math.scenarioAt(powers, {
      minute: 95,
      goals: [{ side: "away", minute: 37 }],
    }).odds,
    { home: 0, draw: 0, away: 1 },
  );
  assertEquals(
    math.scenarioAt(powers, {
      minute: 95,
      goals: repeated([25, 0], 10),
    }).odds,
    { home: 1, draw: 0, away: 0 },
  );
});

Deno.test("added-time edits recompute the horizon without mutating source events", () => {
  const goals = Object.freeze([Object.freeze({ side: "home", minute: 96 })]);
  const snapshot = JSON.stringify(goals);
  const short = math.scenarioTimeline(powers, { goals, addedTime: 5 });
  const extended = math.scenarioTimeline(powers, { goals, addedTime: 8 });
  assertEquals(short.length, 96);
  assertEquals(extended.length, 99);
  assertEquals(short[95].score, { home: 0, away: 0 });
  assertEquals(extended[96].score, { home: 1, away: 0 });
  assertEquals(JSON.stringify(goals), snapshot);
});

Deno.test("invalid powers, times, event sides and event volume fail explicitly", () => {
  assertThrows(() => math.prematchOdds({ home: NaN, away: 1 }), TypeError);
  assertThrows(() => math.scenarioAt(powers, { minute: 96 }), RangeError);
  assertThrows(
    () => math.scenarioAt(powers, { goals: [{ side: "other", minute: 2 }] }),
    RangeError,
  );
  assertThrows(
    () =>
      math.scenarioAt(powers, {
        redCards: Array.from(
          { length: 121 },
          () => ({ side: "home", minute: 2 }),
        ),
      }),
    RangeError,
  );
});

const SEP = "\u001f";
const labels = [
  "Home",
  "Away",
  "Draw",
  "Prematch",
  "Ratings measured on",
  "Probability by minute",
  "Historical ratings unavailable.",
  "Historical ratings are ambiguous.",
  "Timeline unavailable because an event minute is unknown.",
  "Timeline unavailable because the event limit was exceeded.",
  "Choose a valid scenario.",
  "en-GB",
  "Minute",
];
const input = (
  payload: Record<string, unknown>,
  scenario: [string, string, Array<Record<string, unknown>>] = ["30", "5", []],
) =>
  [
    JSON.stringify(payload),
    scenario[0],
    scenario[1],
    JSON.stringify(scenario[2]),
    ...labels,
  ].join(SEP);
const available = {
  home_power: powers.home,
  away_power: powers.away,
  home_measure_date: "2026-01-01",
  away_measure_date: "2026-01-02",
  rating_status: "available",
  timeline_status: "available",
  goals: [{ side: "home", minute: 10 }],
  red_cards: [{ side: "away", minute: 20 }],
};

Deno.test("the Jessie renderer produces prematch odds, accessible minute points and scenario changes", async () => {
  const baseline = render(input(available))[0] as any;
  assertEquals(baseline.tag, "div");
  assertEquals(baseline.attrs.class, "match-probability");
  assertEquals(baseline.children[1].children.length, 3);
  const figure = baseline.children.at(-1);
  assertEquals(figure.tag, "figure");
  const svg = figure.children[1];
  assertEquals(svg.tag, "svg");
  assertEquals(svg.attrs.role, "img");
  assertEquals(
    svg.children.filter((node: any) => node.tag === "polyline").length,
    3,
  );
  const points = svg.children.filter((node: any) => node.tag === "circle");
  assert(points.length > 10);
  assert(points.every((node: any) => node.attrs.tabindex === 0));
  const changed = render(
    input(available, ["30", "8", [{
      id: "game:hyp:1",
      sequence: 1,
      kind: "goal",
      side: "home",
      minute: 30,
    }, {
      id: "game:hyp:2",
      sequence: 2,
      kind: "red_card",
      side: "away",
      minute: 30,
    }]]),
  )[0] as any;
  assert(changed.children[3].children[0] !== baseline.children[3].children[0]);
  const caged = await evaluateRole(
    await Deno.readTextFile(
      new URL("../shell/renderers/match-probability.js", import.meta.url),
    ),
    "renderer",
  );
  assertEquals(caged(input(available)), render(input(available)));
});

Deno.test("individual hypothetical events can be retimed, reassigned and removed", () => {
  const event = {
    id: "game:hyp:1",
    sequence: 1,
    kind: "goal",
    side: "home",
    minute: 31,
  };
  const snapshot = (
    scenario: [string, string, Array<Record<string, unknown>>],
  ) => (render(input(available, scenario))[0] as any).children[3].children[0];
  const baseline = snapshot(["30", "5", []]);
  assertEquals(snapshot(["30", "5", [event]]), baseline);
  const atMinute = snapshot(["30", "5", [{ ...event, minute: 30 }]]);
  assert(atMinute !== baseline);
  assert(
    snapshot(["30", "5", [{ ...event, minute: 30, side: "away" }]]) !==
      atMinute,
  );
  assertEquals(snapshot(["30", "5", []]), baseline);
});

// The combined list was once bounded like the recorded one, so a full payload
// plus hypotheticals crashed the chart; a late hypothetical was silently ignored.
Deno.test("a full payload accepts every hypothetical, and one after the whistle is refused", () => {
  const hypotheticals = Array.from({ length: 20 }, (_, index) => ({
    id: `game:hyp:${index + 1}`, sequence: index + 1, kind: "goal", side: "away", minute: 40,
  }));
  const full = { ...available, goals: Array.from({ length: 100 }, () => ({ side: "home", minute: 5 })) };
  const chart = render(input(full, ["30", "5", hypotheticals]))[0] as any;
  assert(chart.children.some((node: any) => node.tag === "figure"));
  const late = render(input(available, ["30", "5", [{ ...hypotheticals[0], minute: 96 }]]))[0] as any;
  assertEquals(late.children.at(-1).attrs.class, "match-probability__scenario-error");
});

Deno.test("a scenario row awaiting the game's probabilities renders nothing", () => {
  const pending = input(available).split(SEP);
  pending[0] = "";
  assertEquals(render(pending.join(SEP)), []);
});

Deno.test("unavailable ratings and event timing never fabricate a graph", () => {
  for (
    const [rating, timeline, message] of [
      ["missing-rating", "missing-rating", "Historical ratings unavailable."],
      [
        "ambiguous-rating",
        "ambiguous-rating",
        "Historical ratings are ambiguous.",
      ],
    ]
  ) {
    const node = render(
      input({ ...available, rating_status: rating, timeline_status: timeline }),
    )[0] as any;
    assertEquals(
      node.attrs.class,
      "match-probability match-probability--unavailable",
    );
    assertEquals(node.children[0].children, [message]);
  }
  const unknown = render(
    input({
      ...available,
      timeline_status: "unknown-event-minute",
      goals: null,
      red_cards: null,
    }),
  )[0] as any;
  assertEquals(
    unknown.children.at(-1).attrs.class,
    "match-probability__timeline-unavailable",
  );
  assertEquals(
    unknown.children.some((node: any) => node.tag === "figure"),
    false,
  );
  const invalid = render(
    input(available, ["100", "5", []]),
  )[0] as any;
  assertEquals(invalid.children.at(-1).children, ["Choose a valid scenario."]);
});
