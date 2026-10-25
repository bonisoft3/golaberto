/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "npm:linkedom@0.18.4";
import { ensureSes, createStore, interpretScreen } from "./platform.ts";

await ensureSes();

Deno.test("odds inspection stays local while source changes still refresh the chart", async () => {
  const app = new URL("../", import.meta.url);
  const config = JSON.parse(await Deno.readTextFile(new URL("shell/shell.json", app)));
  const markup = await Deno.readTextFile(new URL("shell/screens/equipe-campeonato.html", app));
  const source = parseHTML(markup.slice(markup.indexOf('<div class="team-odds-source"'))).document;
  const chart = source.querySelector(".team-odds-source")!;
  const group = "10000000-0000-4000-8000-000000000001";
  const team = "10000000-0000-4000-8000-000000000002";
  const id = `${group}:${team}`;
  const html = `<section class="screen" data-screen="odds"><div data-live="owner">${chart.outerHTML}</div></section>`;
  const { document, window } = parseHTML("<html><head></head><body><div id='app'></div></body></html>");
  // Linkedom only supplies the getter; the renderer binds native selects too.
  const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!;
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    ...selectValue,
    set(value: string) {
      for (const option of this.querySelectorAll("option")) option.selected = option.value === value;
    },
  });
  const ambient = { document: globalThis.document, fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage };
  Object.assign(globalThis, { document, sessionStorage: { getItem: () => null } });
  let requests = 0;
  const zones = [{ id: "10000000-0000-4000-8000-000000000003", group_id: group, name: "Champion", color: "champion", first: 1, last: 1, positions: "" }];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://odds.test/");
    if (url.pathname === "/crud/zone") {
      requests++;
      if (init?.method === "PATCH") Object.assign(zones[0], JSON.parse(String(init.body)));
      return Response.json(zones);
    }
    if (url.pathname === "/chart.html") return new Response(html);
    if (url.pathname === "/chart.css") return new Response("");
    return new Response(await Deno.readTextFile(new URL(url.pathname.slice(1), app)));
  };
  const local = { owner: "tab", team_odds_progress_source: "tab", team_odds_progress_state: "tab", position_chance: "tab", team_odds_progress: "tab" };
  const schema = Object.fromEntries(Object.keys(local).filter(t => t !== "owner").concat("zone").map(t => [t, config.schema[t]]));
  const store = createStore("http://odds.test", { carriers: config.carriers, schema, local });
  let handle: Awaited<ReturnType<typeof interpretScreen>> | undefined;
  try {
    await store.write("owner", [{ key: id, row: { group_id: group, team_id: team } }]);
    const positions = [
      { id: "10000000-0000-4000-8000-000000000004", group_id: group, team_id: team, position: 1, percent: 75, current: true, reach: "" },
      { id: "10000000-0000-4000-8000-000000000005", group_id: group, team_id: team, position: 2, percent: 25, current: false, reach: "" },
    ];
    const route = config.routes.find((r: any) => r.screen === "equipe-campeonato");
    handle = await interpretScreen(document.getElementById("app"), "http://odds.test/", {
      screen: "odds", files: { ...route.files, html: "chart.html", css: "chart.css", shared: [] },
    }, store, {}, {
      messages: JSON.parse(await Deno.readTextFile(new URL("messages/pt-BR.json", app))), locale: "pt-BR",
    });
    await store.write("position_chance", positions.map(row => ({ key: row.id, row })));
    const row = async () => (await store.query("team_odds_progress_state"))[0];
    // Browsers rely on subscriptions; settle() also wakes auxiliary reads.
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await row();
      if (view && JSON.parse(view.current_json).positions?.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(await row(), "source arrival must initialize inspection without explicit settlement");
    assertEquals(JSON.parse((await row()).current_json).positions.length, 2);
    await handle.settle();
    assert(requests > 0, "initial chart data must exercise the server read");
    const loaded = requests;
    const point = async (x: number, kind = "position") => {
      const graph = document.getElementById(`${kind}-graph-${group}-${team}`)!;
      graph.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 200 } as DOMRect);
      const event = new window.Event("pointermove", { bubbles: true });
      Object.assign(event, { clientX: x, clientY: 80 });
      graph.dispatchEvent(event);
      await handle!.settle();
    };
    for (const x of [100, 101, 102, 500, 501, 502, 100, 500]) await point(x);
    assertEquals((await row()).position_number, 2);
    assertEquals(requests, loaded, "hover must not reread server data, including rejected same-bar moves");
    await store.patch("position_chance", [{ key: positions[1].id, changes: { percent: 30 } }]);
    await handle.settle();
    assertEquals(JSON.parse((await row()).current_json).positions[1].percent, 30);
    assertEquals((await row()).position_number, 2);
    const history = {
      version: 1, kind: "odds-progress", positionCount: 2, sourceCount: 2, retainedCount: 2, omittedCount: 0,
      zones,
      positions: [{ position: 2, color: null, zoneIds: [] }, { position: 1, color: "champion", zoneIds: [zones[0].id] }],
      snapshots: ["2026-02-02", "2026-02-03"].map(day => ({
        day, capturedAt: `${day}T12:00:00Z`, source: "imported", percentages: { "1": 75, "2": 25 },
        lastGame: null, zoneValues: { [zones[0].id]: 75 },
      })),
    };
    await store.write("team_odds_progress", [{ key: id, row: { group_id: group, team_id: team, series_json: JSON.stringify(history) } }]);
    await handle.settle();
    assertEquals((await row()).snapshot_index, 1);
    const historyLoaded = requests;
    for (const x of [100, 101, 500, 501, 100]) await point(x, "odds");
    assertEquals((await row()).snapshot_index, 0);
    assertEquals(requests, historyLoaded, "history inspection must also stay local");
    await store.patch("zone", [{ key: zones[0].id, changes: { color: "#123456" } }]);
    await handle.settle();
    assertEquals(JSON.parse((await row()).current_json).zones[0].color, "#123456");
    assertEquals((await row()).snapshot_index, 0, "source updates preserve an inspected historical day");
    const zonesLoaded = requests;
    await point(100);
    assertEquals(requests, zonesLoaded);
  } finally {
    handle?.stop();
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", selectValue);
    Object.assign(globalThis, ambient);
  }
});
