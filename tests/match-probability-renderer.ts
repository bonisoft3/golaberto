import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1.0.11";
import { evaluateRole } from "./platform.ts";
import renderNodes from "../shell/renderers/match-probability.js";
import { built } from "./terminal-nodes.ts";

const render = (value: string) => built(renderNodes(value));

const hasClass = (node: any, name: string) =>
  String(node?.attrs?.class ?? "").split(" ").includes(name);
const childWithClass = (node: any, name: string) =>
  node.children.find((child: any) => hasClass(child, name));
const coordinates = (node: any): Array<[number, number]> =>
  node.attrs.points.split(" ").map((pair: string) =>
    pair.split(",").map(Number) as [number, number]
  );

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
  words = labels,
) =>
  [
    JSON.stringify(payload),
    scenario[0],
    scenario[1],
    JSON.stringify(scenario[2]),
    ...words,
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

Deno.test("the Jessie renderer produces prematch odds, accessible minute samples and scenario changes", async () => {
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
  assertEquals(
    svg.children.filter((node: any) => node.tag === "polygon").map((node: any) => node.attrs.class),
    [
      "match-probability__area match-probability__area--home",
      "match-probability__area match-probability__area--draw",
      "match-probability__area match-probability__area--away",
    ],
  );
  const samples = svg.children.filter((node: any) =>
    hasClass(node, "match-probability__sample")
  );
  assertEquals(samples.length, 96);
  const points = samples.flatMap((node: any) =>
    node.children.filter((child: any) => hasClass(child, "match-probability__point"))
  );
  assert(points.length > 10);
  assert(points.length < samples.length);
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

Deno.test("stacked areas keep raw cumulative boundaries and minute-wide inspectors", () => {
  const rawPowers = { home: 10, away: 10 };
  const payload = {
    ...available,
    home_power: rawPowers.home,
    away_power: rawPowers.away,
    goals: [],
    red_cards: [],
  };
  const root = render(input(payload))[0] as any;
  const svg = root.children.at(-1).children[1];
  assertEquals(svg.attrs.viewBox, "0 0 640 300");
  assertEquals(
    svg.children.filter((node: any) =>
      hasClass(node, "match-probability__minute-label")
    ).map((node: any) => node.children[0]),
    ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "95"],
  );
  assertEquals(
    svg.children.filter((node: any) =>
      hasClass(node, "match-probability__minute-tick")
    ).length,
    11,
  );
  const earlyWhistle = (render(input(payload, ["30", "2", []]))[0] as any)
    .children.at(-1).children[1];
  assertEquals(
    earlyWhistle.children.filter((node: any) =>
      hasClass(node, "match-probability__minute-label")
    ).map((node: any) => node.children[0]),
    ["0", "10", "20", "30", "40", "50", "60", "70", "80", "92"],
  );
  const areas = ["home", "draw", "away"].map((key) =>
    svg.children.find((node: any) =>
      hasClass(node, `match-probability__area--${key}`)
    )
  );
  const lines = ["home", "draw", "away"].map((key) =>
    svg.children.find((node: any) =>
      hasClass(node, `match-probability__line--${key}`)
    )
  );
  const timeline = math.scenarioTimeline(rawPowers);
  const count = timeline.length;
  const yAt = (probability: number) => 18 + (1 - probability) * 248;
  const cumulative = timeline.map((point) => [
    point.odds.home,
    point.odds.home + point.odds.draw,
    point.odds.home + point.odds.draw + point.odds.away,
  ]);

  for (let layer = 0; layer < areas.length; layer++) {
    const polygon = coordinates(areas[layer]);
    const upper = coordinates(lines[layer]);
    assertEquals(polygon.length, count * 2);
    assertEquals(polygon.slice(0, count), upper);
    for (const minute of [0, 30, count - 1]) {
      assertAlmostEquals(upper[minute][1], yAt(cumulative[minute][layer]), 1e-9);
    }
    const lower = polygon.slice(count).reverse();
    if (layer === 0) {
      assert(lower.every(([, y]) => y === 266));
    } else {
      assertEquals(lower, coordinates(lines[layer - 1]));
    }
  }
  assert(
    coordinates(lines[2])[0][1] > 18,
    "the finite Poisson tail remains visible instead of being normalized",
  );

  const samples = svg.children.filter((node: any) =>
    hasClass(node, "match-probability__sample")
  );
  assertEquals(samples.length, count);
  const hits = samples.map((sample: any) =>
    childWithClass(sample, "match-probability__hit")
  );
  assert(hits.every((hit: any) => hit.tag === "rect"));
  assert(hits.every((hit: any) => hit.attrs.y === 18 && hit.attrs.height === 248));
  assertEquals(hits[0].attrs.x, 48);
  assertAlmostEquals(
    hits.at(-1).attrs.x + hits.at(-1).attrs.width,
    624,
  );
  for (let minute = 1; minute < hits.length; minute++) {
    assertAlmostEquals(
      hits[minute - 1].attrs.x + hits[minute - 1].attrs.width,
      hits[minute].attrs.x,
    );
  }
  for (const sample of samples) {
    assertEquals(
      childWithClass(sample, "match-probability__crosshair").tag,
      "line",
    );
    const tooltip = childWithClass(sample, "match-probability__tooltip");
    assertEquals([tooltip.tag, tooltip.attrs.role], ["g", "tooltip"]);
  }

  const tooltip = childWithClass(samples[30], "match-probability__tooltip");
  assertEquals(
    childWithClass(tooltip, "match-probability__tooltip-minute").children,
    ["Minute 30 · 0–0"],
  );
  assertEquals(
    tooltip.children.filter((node: any) =>
      hasClass(node, "match-probability__tooltip-name")
    ).map((node: any) => node.children[0]),
    ["Away", "Draw", "Home"],
  );
  const snapshot = root.children.find((node: any) =>
    hasClass(node, "match-probability__snapshot")
  ).children[0];
  assertEquals(
    tooltip.children.filter((node: any) =>
      hasClass(node, "match-probability__tooltip-value")
    ).map((node: any) => node.children[0]),
    snapshot.match(/[0-9.]+%/g)!.reverse(),
  );
  const firstBox = childWithClass(
    childWithClass(samples[0], "match-probability__tooltip"),
    "match-probability__tooltip-box",
  );
  const lastBox = childWithClass(
    childWithClass(samples.at(-1), "match-probability__tooltip"),
    "match-probability__tooltip-box",
  );
  assert(firstBox.attrs.x >= 48);
  assertEquals(lastBox.attrs.x + lastBox.attrs.width, 624);
});

Deno.test("event labels combine simultaneous changes and separate nearby minutes", () => {
  const payload = {
    ...available,
    goals: [
      { side: "home", minute: 10 },
      { side: "away", minute: 10 },
      { side: "home", minute: 11 },
    ],
    red_cards: [
      { side: "home", minute: 10 },
      { side: "home", minute: 10 },
      { side: "away", minute: 11 },
    ],
  };
  const svg = (render(input(payload))[0] as any).children.at(-1).children[1];
  const eventLabels = svg.children.filter((node: any) =>
    hasClass(node, "match-probability__event-label")
  );
  assertEquals(eventLabels.map((node: any) => node.children[0]), [
    "1–1 🟥×2",
    "2–1 🟥",
  ]);
  assertEquals(eventLabels.map((node: any) => node.attrs["aria-label"]), [
    "Minute 10: Home 1–1 Away · Home 🟥×2",
    "Minute 11: Home 2–1 Away · Away 🟥",
  ]);
  assertEquals(new Set(eventLabels.map((node: any) => node.attrs.y)).size, 2);
  assertEquals(
    svg.children.filter((node: any) =>
      hasClass(node, "match-probability__event-leader")
    ).length,
    eventLabels.length,
  );
  const [, top, , height] = svg.attrs.viewBox.split(" ").map(Number);
  assert(top < 0);
  assertEquals(top + height, 300);
  assert(eventLabels.every((node: any) => node.attrs.y >= top));
});

Deno.test("dense event labels all fit in nonoverlapping lanes above the plot", () => {
  const goals = Array.from({ length: 40 }, (_, index) => ({
    side: index % 2 === 0 ? "home" : "away",
    minute: index + 1,
  }));
  const payload = { ...available, goals, red_cards: [] };
  const svg = (render(input(payload))[0] as any).children.at(-1).children[1];
  const eventLabels = svg.children.filter((node: any) =>
    hasClass(node, "match-probability__event-label")
  );
  assertEquals(eventLabels.length, goals.length);
  assertEquals(eventLabels[0].attrs["aria-label"], "Minute 1: Home 1–0 Away");
  assertEquals(eventLabels.at(-1).attrs["aria-label"], "Minute 40: Home 20–20 Away");

  const lanes = Map.groupBy(eventLabels, (node: any) => node.attrs.y);
  assert(lanes.size > 1);
  for (const labels of lanes.values()) {
    const ranges = labels.map((node: any) => {
      const width = String(node.children[0]).length * 8 + 8;
      return [node.attrs.x - width / 2, node.attrs.x + width / 2];
    }).sort((left: number[], right: number[]) => left[0] - right[0]);
    for (let index = 1; index < ranges.length; index++) {
      assert(ranges[index][0] >= ranges[index - 1][1] + 6);
    }
  }
  const [, top, , height] = svg.attrs.viewBox.split(" ").map(Number);
  assert(top < 0);
  assertEquals(top + height, 300);
  assert(eventLabels.every((node: any) => node.attrs.y >= top && node.attrs.y < 18));
});

Deno.test("tooltip scores include recorded and hypothetical goals at their minute", () => {
  const payload = {
    ...available,
    goals: [{ side: "home", minute: 10 }, { side: "away", minute: 31 }],
    red_cards: [],
  };
  const hypothetical = [{
    id: "game:hyp:1",
    sequence: 1,
    kind: "goal",
    side: "home",
    minute: 31,
  }];
  const scenario: [string, string, Array<Record<string, unknown>>] = [
    "30",
    "5",
    hypothetical,
  ];
  const root = render(input(payload, scenario))[0] as any;
  const samples = root.children.at(-1).children[1].children.filter((node: any) =>
    hasClass(node, "match-probability__sample")
  );
  const heading = (minute: number) =>
    childWithClass(
      childWithClass(samples[minute], "match-probability__tooltip"),
      "match-probability__tooltip-minute",
    ).children[0];
  assertEquals(
    [heading(30), heading(31), heading(32)],
    ["Minute 30 · 1–0", "Minute 31 · 2–1", "Minute 32 · 2–1"],
  );
  for (const minute of [30, 31, 32]) {
    const expected = `${heading(minute)}:`;
    assert(String(childWithClass(samples[minute], "match-probability__hit").attrs["aria-label"]).startsWith(expected));
    const point = childWithClass(samples[minute], "match-probability__point");
    if (point) assert(String(point.attrs["aria-label"]).startsWith(expected));
  }

  const portuguese = [...labels];
  portuguese[11] = "pt-BR";
  portuguese[12] = "Minuto";
  const localized = render(input(payload, scenario, portuguese))[0] as any;
  const localizedSamples = localized.children.at(-1).children[1].children.filter((node: any) =>
    hasClass(node, "match-probability__sample")
  );
  assertEquals(
    childWithClass(
      childWithClass(localizedSamples[30], "match-probability__tooltip"),
      "match-probability__tooltip-minute",
    ).children,
    ["Minuto 30 · 1–0"],
  );
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
