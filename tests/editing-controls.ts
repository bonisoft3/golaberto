/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { parseHTML } from "npm:linkedom@0.18.4";
import { evaluateRole } from "omnishell/interpreter/jessie.js";
import { batched } from "omnishell/interpreter/batched-store.js";
import { interpretScreen } from "omnishell/interpreter/screen.js";
import { parseFilter, parseLimit } from "omnishell/interpreter/fragment.js";

const app = new URL("../", import.meta.url);
const screens = [
  "gerenciar",
  "novo-equipe",
  "editar-equipe",
  "novo-jogador",
  "editar-jogador",
  "novo-estadio",
  "editar-estadio",
  "novo-arbitro",
  "editar-arbitro",
  "novo-jogo",
  "editar-jogo",
  "gols-jogo",
  "escalacao-jogo",
  "inscricoes-jogador",
];
const adapterNames = [
  "editing-text",
  "editing-integer",
  "editing-uuid",
  "editing-timestamp",
];
const id = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function requiredElement<T extends Element>(
  scope: ParentNode,
  selector: string,
): T {
  const element = scope.querySelector<T>(selector);
  assert(element, `Missing editing control: ${selector}`);
  return element;
}

async function source(screen: string) {
  return await Deno.readTextFile(new URL(`shell/screens/${screen}.html`, app));
}

async function mountScreen(
  screen: string,
  initial: Record<string, Record<string, unknown>[]> = {},
  editor = true,
  refuseDelete = false,
) {
  const html = await source(screen);
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=app></div></body></html>",
  );
  const selectPrototype = Object.getPrototypeOf(
    document.createElement("select"),
  );
  Object.defineProperty(selectPrototype, "value", {
    configurable: true,
    get(this: HTMLSelectElement & { _editingUnselected?: boolean }) {
      return this.querySelector<HTMLOptionElement>("option[selected]")?.value ??
        (this._editingUnselected
          ? ""
          : this.querySelector<HTMLOptionElement>("option")?.value ?? "");
    },
    set(
      this: HTMLSelectElement & { _editingUnselected?: boolean },
      value: string,
    ) {
      const options = [...this.querySelectorAll<HTMLOptionElement>("option")];
      for (const option of options) option.selected = option.value === value;
      this._editingUnselected = !options.some((option) =>
        option.value === value
      );
    },
  });
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  globalThis.document = document;
  const rows = new Map<string, Record<string, unknown>[]>(
    Object.entries({
      editor: editor ? [{ id: id(1), app_user_id: id(2) }] : [],
      ...initial,
    }),
  );
  const subscriptions = new Map<string, Set<() => void>>();
  const calls: {
    table: string;
    action: string;
    key?: string;
    row?: Record<string, unknown>;
  }[] = [];
  const reads: { table: string; filter: string }[] = [];
  const notify = (table: string) => {
    for (const callback of subscriptions.get(table) ?? []) callback();
  };
  const store = batched({
    query: (
      table: string,
      _order: unknown,
      options: { filter?: string } = {},
    ) => {
      const filter = options.filter ?? "";
      reads.push({ table, filter });
      const inProbe = /^id=in\.\(([^)]*)\)/.exec(filter);
      let selected = [...(rows.get(table) ?? [])];
      if (inProbe !== null) {
        selected = selected.filter((row) => String(row.id) === inProbe[1]);
      } else {
        const predicates = parseFilter(filter);
        if (predicates !== null) {
          selected = selected.filter((row) =>
            predicates.every((predicate: (row: unknown) => boolean) =>
              predicate(row)
            )
          );
        }
      }
      const offset = Number(/(?:^|&)offset=(\d+)/.exec(filter)?.[1] ?? 0);
      const limit = parseLimit(filter);
      return Promise.resolve(selected.slice(
        offset,
        limit === undefined ? undefined : offset + limit,
      ));
    },
    subscribe: (table: string, callback: () => void) => {
      const listeners = subscriptions.get(table) ?? new Set();
      listeners.add(callback);
      subscriptions.set(table, listeners);
      return () => listeners.delete(callback);
    },
    create: (table: string, row: Record<string, unknown>) =>
      Promise.resolve(calls.push({ table, action: "create", row })),
    update: (table: string, key: string, row: Record<string, unknown>) =>
      Promise.resolve(calls.push({ table, action: "update", key, row })),
    remove: (table: string, key: string) => {
      calls.push({ table, action: "delete", key });
      if (refuseDelete) {
        return Promise.reject(
          Object.assign(new Error("record still has dependent games"), {
            name: "NonRetriableError",
          }),
        );
      }
      return Promise.resolve();
    },
    put: (table: string, row: Record<string, unknown>) => {
      const saved = rows.get(table) ?? [];
      const index = saved.findIndex((prior) => prior.id === row.id);
      if (index === -1) saved.push(row);
      else saved[index] = { ...saved[index], ...row };
      rows.set(table, saved);
      notify(table);
      return Promise.resolve();
    },
  });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(".html")) return new Response(html);
    if (path.endsWith(".css")) return new Response("");
    if (path.endsWith(".js")) {
      return new Response(
        await Deno.readTextFile(
          new URL(path.replace(/^\/shell\//, "shell/"), app),
        ),
      );
    }
    throw new Error(`Unexpected editing fixture request: ${url}`);
  };
  const messages = Object.fromEntries(
    [...html.matchAll(/\{msg\.([\w.]+)\}/g)].map((
      match,
    ) => [match[1], match[1]]),
  );
  const { routes } = JSON.parse(
    await Deno.readTextFile(new URL("shell/shell.json", app)),
  );
  const route = routes.find((entry: { screen: string }) =>
    entry.screen === screen
  );
  assert(route, `Missing generated route: ${screen}`);
  const mounted = document.getElementById("app");
  assert(mounted);
  const runtime = await interpretScreen(
    mounted,
    "http://editing.fixture/",
    route,
    store,
    { slug: "record" },
    { routes, messages, locale: "pt-BR", timeZone: "UTC" },
  );
  for (const form of mounted.querySelectorAll("form")) {
    form.checkValidity = () => true;
    form.reset = () => {
      form.dispatchEvent(
        new Event("reset", { bubbles: true, cancelable: true }),
      );
    };
  }
  return {
    mounted,
    Event,
    calls,
    reads,
    close: () => {
      runtime.stop();
      globalThis.document = priorDocument;
      globalThis.fetch = priorFetch;
    },
  };
}

Deno.test("editing adapters preserve zero, null and typed references", async () => {
  const adapters = new Map();
  for (const name of adapterNames) {
    adapters.set(
      name,
      await evaluateRole(
        await Deno.readTextFile(new URL(`shell/handlers/${name}.js`, app)),
        "adapter",
      ),
    );
  }
  assertEquals(adapters.get("editing-integer").parse("0"), 0);
  assertEquals(adapters.get("editing-integer").parse(" 003 "), 3);
  assertEquals(adapters.get("editing-integer").format(null), "");
  for (const value of ["1.5", "NaN", "2147483648", "-2147483649"]) {
    assertThrows(() => adapters.get("editing-integer").parse(value));
  }
  assertEquals(adapters.get("editing-uuid").parse(""), null);
  assertEquals(adapters.get("editing-uuid").parse(id(3)), id(3));
  assertThrows(() => adapters.get("editing-uuid").parse("unknown"));
  assertEquals(adapters.get("editing-text").parse("  "), null);
  assertEquals(adapters.get("editing-text").parse("  João  "), "João");
});

Deno.test("the UTC kickoff adapter converts offsets and validates native local datetimes", async () => {
  const adapter = await evaluateRole(
    await Deno.readTextFile(
      new URL("shell/handlers/editing-timestamp.js", app),
    ),
    "adapter",
  );
  assertEquals(adapter.format(null), "");
  assertEquals(
    adapter.format("2026-10-07T20:00:05.000000+00:00"),
    "2026-10-07T20:00:05",
  );
  assertEquals(
    adapter.format("2026-10-07T20:00:05.125000-03:00"),
    "2026-10-07T23:00:05.125",
  );
  assertEquals(
    adapter.format("2026-01-01T00:15:00+01:00"),
    "2025-12-31T23:15:00",
  );
  assertEquals(adapter.parse("2026-10-07T20:00"), "2026-10-07T20:00:00Z");
  assertEquals(
    adapter.parse("2026-10-07T20:00:05.125"),
    "2026-10-07T20:00:05.125Z",
  );
  for (
    const value of [
      "0000-01-01T12:00",
      "2025-02-29T12:00",
      "2026-01-01T24:00",
      "2026-01-01 12:00",
      "2026-01-01T12:00:00.1234",
      "2026-01-01T12:00:00.1234567",
    ]
  ) assertThrows(() => adapter.parse(value), Error, "Invalid kickoff instant");
  for (
    const value of [
      "2025-02-29T12:00:00Z",
      "2026-01-01T12:00:00+00:60",
      "2026-01-01T12:00:00+24:00",
      "2026-01-01T12:00:00.123456Z",
      "2026-01-01T12:00:00.1234567Z",
      "0001-01-01T00:00:00+00:01",
    ]
  ) assertThrows(() => adapter.format(value), Error, "Invalid kickoff instant");
});

Deno.test("played requires two known scores including zero after clearing the other side", async () => {
  const played = await evaluateRole(
    await Deno.readTextFile(new URL("shell/handlers/editing-played.js", app)),
    "handler",
  );
  for (const unknown of [null, undefined, ""]) {
    assertEquals(
      played({ items: [{ away_score: unknown }] }, { value: "0" }, {
        other: "away_score",
      }),
      false,
    );
  }
  assertEquals(
    played({ items: [{ away_score: 0 }] }, { value: "0" }, {
      other: "away_score",
    }),
    true,
  );
  assertEquals(
    played({ items: [{ away_score: 0 }] }, { value: "" }, {
      other: "away_score",
    }),
    false,
  );
});

Deno.test("editing item templates have exactly one root and immutable merge offers create only", async () => {
  for (const screen of screens) {
    const { document } = parseHTML(await source(screen));
    const visit = (scope: ParentNode) => {
      for (
        const template of scope.querySelectorAll<HTMLTemplateElement>(
          "template[data-item]",
        )
      ) {
        assertEquals(
          template.content.children.length,
          1,
          `${screen}: ${template.innerHTML.slice(0, 80)}`,
        );
        visit(template.content);
      }
    };
    visit(document);
  }
  const { document } = parseHTML(await source("editar-jogador"));
  const findMerge = (scope: ParentNode): HTMLFormElement[] => {
    const found = [
      ...scope.querySelectorAll<HTMLFormElement>(
        "form[data-entity=player_merge]",
      ),
    ];
    for (
      const template of scope.querySelectorAll<HTMLTemplateElement>("template")
    ) found.push(...findMerge(template.content));
    return found;
  };
  const forms = findMerge(document);
  assertEquals(forms.length, 1);
  assertEquals(forms[0].dataset.action, "create");
});

Deno.test({
  name:
    "editing routes hide every mutation from readers without an Editor grant",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    for (const screen of screens) {
      const fixture = await mountScreen(screen, {}, false);
      try {
        assertEquals(
          fixture.mounted.querySelectorAll("form[data-entity]").length,
          0,
          screen,
        );
      } finally {
        fixture.close();
      }
    }
  },
});

Deno.test({
  name:
    "a match form submits paired typed scores and derived played through ordinary native CRUD",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fixture = await mountScreen("novo-jogo");
    try {
      const form = requiredElement<HTMLFormElement>(
        fixture.mounted,
        "form[data-entity=game]",
      );
      const home = requiredElement<HTMLInputElement>(
        form,
        "input[name=home_score]",
      );
      const away = requiredElement<HTMLInputElement>(
        form,
        "input[name=away_score]",
      );
      home.value = "0";
      home.dispatchEvent(new fixture.Event("input", { bubbles: true }));
      await tick();
      away.value = "0";
      away.dispatchEvent(new fixture.Event("input", { bubbles: true }));
      await tick();
      assertEquals(
        requiredElement<HTMLInputElement>(form, "input[name=played]").checked,
        true,
      );
      form.addEventListener("reset", (event) => event.preventDefault(), {
        once: true,
      });
      form.reset();
      await tick();
      assertEquals(home.value, "0");
      assertEquals(away.value, "0");
      form.dispatchEvent(
        new fixture.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      const call = fixture.calls.find((entry) => entry.table === "game");
      assertEquals(call?.action, "create");
      assertEquals(call?.row?.home_score, 0);
      assertEquals(call?.row?.away_score, 0);
      assertEquals(call?.row?.played, true);
      assertEquals(call?.row?.attendance, null);
      assertEquals(home.value, "");
      assertEquals(away.value, "");
      assertEquals(
        requiredElement<HTMLInputElement>(form, "input[name=played]").checked,
        false,
      );
      home.value = "1";
      home.dispatchEvent(new fixture.Event("input", { bubbles: true }));
      await tick();
      assertEquals(
        requiredElement<HTMLInputElement>(form, "input[name=played]").checked,
        false,
      );
      away.value = "";
      away.dispatchEvent(new fixture.Event("input", { bubbles: true }));
      await tick();
      assertEquals(
        requiredElement<HTMLInputElement>(form, "input[name=played]").checked,
        false,
      );
    } finally {
      fixture.close();
    }
  },
});

Deno.test({
  name:
    "a bounded asynchronous reference retains an existing selection outside the first forty choices",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stadiums = Array.from(
      { length: 41 },
      (_, index) => ({
        id: id(index + 10),
        name: `Stadium ${index}`,
        search_key: `stadium ${index}`,
      }),
    );
    const fixture = await mountScreen("editar-equipe", {
      team: [{
        id: id(3),
        slug: "record",
        name: "Team",
        full_name: null,
        city: null,
        country: "Brasil",
        foundation: null,
        team_type: "club",
        stadium_id: id(50),
        logo_key: null,
      }],
      stadium: stadiums,
    });
    try {
      const select = requiredElement<HTMLSelectElement>(
        fixture.mounted,
        "select[name=stadium_id]",
      );
      assertEquals(select.value, id(50));
      assert(
        fixture.reads.some((read) =>
          read.table === "stadium" && read.filter.includes("limit=40")
        ),
      );
      assert(fixture.reads.some((read) =>
        read.table === "stadium" &&
        read.filter.includes(`id=in.(${id(50)})&limit=1`)
      ));
      const search = requiredElement<HTMLInputElement>(
        select.closest(".editing-choice")!,
        "input[type=search]",
      );
      search.value = "stadium 0";
      search.dispatchEvent(new fixture.Event("input", { bubbles: true }));
      await tick();
      assert(
        fixture.reads.some((read) =>
          read.table === "stadium" &&
          new URLSearchParams(read.filter).get("search_key") ===
            "like.*stadium 0*"
        ),
        "typing must change the bounded picker query",
      );
      assertEquals(select.value, id(50));
      select.value = "";
      select.dispatchEvent(new fixture.Event("change", { bubbles: true }));
      await tick();
      const form = requiredElement<HTMLFormElement>(
        fixture.mounted,
        "form[data-action=update]",
      );
      form.dispatchEvent(
        new fixture.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      const call = fixture.calls.find((entry) => entry.table === "team");
      assertEquals(call?.key, id(3));
      assertEquals(call?.row?.stadium_id, null);
    } finally {
      fixture.close();
    }
  },
});

Deno.test({
  name:
    "native catalogue create and update retain the typed record when dependent deletion is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const create = await mountScreen("novo-jogador");
    let created: Record<string, unknown> | undefined;
    try {
      const form = requiredElement<HTMLFormElement>(
        create.mounted,
        "form[data-entity=player]",
      );
      requiredElement<HTMLInputElement>(form, "input[name=name]").value =
        "João";
      requiredElement<HTMLInputElement>(form, "input[name=height]").value =
        "180";
      form.dispatchEvent(
        new create.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      created = create.calls.find((call) => call.table === "player")?.row;
      assert(created);
      assertEquals(created.name, "João");
      assertEquals(created.height, 180);
      assertEquals(created.position, null);
    } finally {
      create.close();
    }
    assert(created);
    const edit = await mountScreen(
      "editar-jogador",
      { player: [{ ...created, slug: "record" }] },
      true,
      true,
    );
    try {
      const form = requiredElement<HTMLFormElement>(
        edit.mounted,
        "form[data-entity=player][data-action=update]",
      );
      const name = requiredElement<HTMLInputElement>(form, "input[name=name]");
      assertEquals(name.value, "João");
      name.value = "João da Silva";
      form.dispatchEvent(
        new edit.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      const update = edit.calls.find((call) => call.action === "update");
      assert(update?.row);
      assertEquals(update.key, created.id);
      assertEquals(update.row.name, "João da Silva");
      const remove = requiredElement<HTMLFormElement>(
        edit.mounted,
        "form[data-entity=player][data-action=delete]",
      );
      requiredElement<HTMLInputElement>(remove, "input[type=checkbox]")
        .checked = true;
      remove.dispatchEvent(
        new edit.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      assertEquals(
        requiredElement<HTMLElement>(remove, ".store-error").hasAttribute(
          "hidden",
        ),
        false,
      );
      assertEquals(
        requiredElement<HTMLElement>(edit.mounted, ".screen").dataset.state,
        "validation-error",
      );
      assertEquals(name.value, "João da Silva");
    } finally {
      edit.close();
    }
  },
});
