import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { fixturePath } from "./addresses.ts";

const config = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));

Deno.test("every navigable route declares an address in every site language", () => {
  assertEquals(config.routes.filter((route: { path: string; paths?: unknown }) => route.path !== "/" && !route.paths), []);
  const locales = Object.keys(config.i18n.locales).sort();
  for (const route of config.routes) {
    if (route.path === "/") continue;
    assertEquals(Object.keys(route.paths).sort(), locales, route.screen);
    assertEquals(route.paths[config.i18n.default], route.path, route.screen);
    const parameters = (route.path.match(/:\w+/g) ?? []).sort();
    for (const [locale, pattern] of Object.entries(route.paths)) {
      assert(typeof pattern === "string");
      assertEquals((pattern.match(/:\w+/g) ?? []).sort(), parameters, `${route.screen}: ${locale}`);
      assert(pattern.split("/").every(segment => !segment || /^:\w+$|^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment)), pattern);
    }
  }
});

Deno.test("context, collection actions and record actions use one resource hierarchy", () => {
  assert(!config.routes.some((route: { screen: string }) => route.screen === "campeonato-equipes"));
  for (const locale of Object.keys(config.i18n.locales)) {
    const at = (name: string): string => config.routes.find((route: { screen: string }) => route.screen === name).paths[locale];
    const championship = at("campeonato");
    for (const name of ["arquivo-campeonato", "campeonato-jogadores", "publico", "editar-competicao"]) {
      assert(at(name).startsWith(championship + "/"), `${locale}: ${name}`);
      assertEquals(at(name).split("/").length, championship.split("/").length + 1);
    }
    const context = championship.replace(":slug", ":championship");
    assertEquals(at("equipe-campeonato"), context + at("equipe"));
    assertEquals(at("jogador-campeonato"), context + at("equipe").replace(":slug", ":team") + at("jogador"));
    const edit = at("editar-jogo").slice(at("jogo").length);
    assert(/^\/[^/]+$/.test(edit));
    for (const [screen, parent] of [["editar-arbitro", "arbitro"], ["editar-estadio", "estadio"], ["editar-equipe", "equipe"], ["editar-jogador", "jogador"], ["editar-competicao", "campeonato"]]) {
      assertEquals(at(screen), at(parent) + edit);
    }
    const create = at("novo-jogo").slice(at("jogos").length);
    assert(/^\/[^/]+$/.test(create));
    for (const [screen, parent] of [["novo-arbitro", "arbitros"], ["novo-estadio", "estadios"], ["novo-equipe", "equipes"], ["novo-jogador", "jogadores"], ["nova-competicao", "campeonatos"]]) {
      assertEquals(at(screen), at(parent) + create);
    }
  }
});

Deno.test("nested fixture addresses resolve each resource without swapping context", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const reads: string[] = [];
  const actual = await fixturePath(`/campeonato/${id}/equipe/${id}/jogador/${id}?lang=pt-BR#stats`, async sql => {
    const table = /FROM (\w+)/.exec(sql)![1];
    reads.push(table);
    return `${table}-slug`;
  });
  assertEquals(reads, ["championship", "team", "player"]);
  assertEquals(actual, "/campeonato/championship-slug/equipe/team-slug/jogador/player-slug?lang=pt-BR#stats");
});
