/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { assertEquals } from "jsr:@std/assert@1.0.11";
import {
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "npm:playwright@1.61.1";
import { SignJWT } from "npm:jose@6.0.11";
import { baseUrl } from "omnishell/base-url.ts";
import { address } from "./addresses.ts";
import { query } from "./db.ts";

const base = await baseUrl(Deno.args[0] ?? ".");
const timeout = 30_000;
const active = ".shell-screen:not([hidden]):not([data-served])";

async function account(handle: string, grant: boolean) {
  const id = crypto.randomUUID();
  await query(`INSERT INTO app_user(id,handle) VALUES ('${id}','${handle}');
    ${grant ? `INSERT INTO editor(app_user_id) VALUES ('${id}');` : ""}`);
  const secret = Deno.env.get("PGRST_JWT_SECRET");
  if (secret === undefined) throw new Error("PGRST_JWT_SECRET is unset");
  const token = await new SignJWT({ role: "app_user", handle, guest: false })
    .setProtectedHeader({ alg: "HS256" }).setSubject(id).setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  return { token, user: { id, handle } };
}

async function persisted(sql: string, expected?: string) {
  const deadline = Date.now() + timeout;
  let actual = "";
  do {
    actual = await query(sql);
    if (expected === undefined ? actual !== "" : actual === expected) {
      return actual;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `Persistence did not converge: ${sql}\nExpected ${
      expected ?? "a row"
    }; got ${JSON.stringify(actual)}`,
  );
}

async function visit(page: Page, route: string, editor = true) {
  await page.goto(`${base}/${route}`);
  await page.locator(`${active} [data-screen="${route.split("/")[0]}"]`)
    .waitFor({ timeout });
  const grant = page.locator(`${active} .content [data-live="editor"]`).first();
  if (editor) {
    await grant.locator(".editing-workspace").waitFor({ timeout });
  } else {
    await page.waitForFunction(
      (selector) => {
        const region = document.querySelector(selector);
        return region && !region.querySelector(".editing-workspace") &&
          region.textContent?.trim() ===
            "Entre com uma conta de editor para gerenciar o arquivo.";
      },
      `${active} .content [data-live="editor"]`,
      { timeout },
    );
  }
}

const form = (page: Page, name: string) =>
  page.locator(`${active} form[data-form="${name}"]`);
const submit = (target: Locator) =>
  target.locator('button[type="submit"]').click();
async function reveal(target: Locator) {
  const sections = target.locator("xpath=ancestor::details");
  for (let i = await sections.count() - 1; i >= 0; i--) {
    const section = sections.nth(i);
    if (
      !await section.evaluate((element) => (element as HTMLDetailsElement).open)
    ) {
      await section.locator(":scope > summary").click();
    }
  }
}

async function choose(
  target: Locator,
  field: string,
  search: string,
  id: string,
) {
  const choice = target.locator(".editing-choice").filter({
    has: target.page().locator(`select[name="${field}"]`),
  });
  await choice.locator('input[type="search"]').fill(search);
  await choice.locator(`optgroup[data-order] option[value="${id}"]`).waitFor({
    state: "attached",
    timeout,
  });
  await choice.locator("select").selectOption(id);
}

async function fixture() {
  const prefix = `Competition ${crypto.randomUUID().slice(0, 8)}`;
  const team = crypto.randomUUID();
  const editor = await account(
    `competition-editor-${crypto.randomUUID()}`,
    true,
  );
  const reader = await account(
    `competition-reader-${crypto.randomUUID()}`,
    false,
  );
  await query(
    `INSERT INTO team(id,name,country) VALUES ('${team}','${prefix} team','Brasil')`,
  );
  const browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const open = async (session?: typeof editor) => {
    const context: BrowserContext = await browser.newContext({
      locale: "pt-BR",
      viewport: { width: 1366, height: 900 },
    });
    if (session) {
      await context.addInitScript(
        (value) =>
          sessionStorage.setItem("pronto-token", JSON.stringify(value)),
        session,
      );
    }
    return await context.newPage();
  };
  return {
    prefix,
    team,
    editor,
    reader,
    open,
    async close() {
      await browser.close();
      await query(`BEGIN;
        DELETE FROM phase_clone WHERE app_user_id='${editor.user.id}';
        DELETE FROM zone WHERE created_by='${editor.user.id}';
        DELETE FROM team_group WHERE created_by='${editor.user.id}';
        DELETE FROM stage_group WHERE created_by='${editor.user.id}';
        DELETE FROM phase WHERE created_by='${editor.user.id}';
        DELETE FROM championship WHERE created_by='${editor.user.id}';
        DELETE FROM team WHERE id='${team}';
        DELETE FROM app_user WHERE id IN ('${editor.user.id}','${reader.user.id}');
        COMMIT;`);
    },
  };
}

Deno.test("accept-everyday-editing: an editor builds and clones competition structure", async () => {
  const f = await fixture();
  try {
    const page = await f.open(f.editor);
    await visit(page, "nova-competicao");
    const create = form(page, "competition-create");
    await create.locator('[name="name"]').fill(`${f.prefix} season`);
    await create.locator('[name="region_name"]').fill("Brasil");
    await create.locator('[name="begins"]').fill("2028-01-01");
    await create.locator('[name="ends"]').fill("2028-12-31");
    await submit(create);
    const championship = await persisted(
      `SELECT id FROM championship WHERE name='${f.prefix} season' AND created_by='${f.editor.user.id}'`,
    );
    const championshipSlug = await address("championship", championship);

    await visit(page, "gerenciar-competicoes");
    await page.locator(`${active} #competition-catalog-q`).fill(
      f.prefix.toUpperCase(),
    );
    await page.locator(
      `${active} .competition-catalog a[data-param-slug="${championshipSlug}"]`,
    ).waitFor({ timeout });

    await visit(
      page,
      `editar-competicao/${championshipSlug}`,
    );
    const update = form(page, "competition-update");
    await update.locator('[name="point_win"]').fill("2");
    await update.locator('[name="point_draw"]').fill("1");
    await update.locator('[name="point_loss"]').fill("0");
    await submit(update);
    await persisted(
      `SELECT point_win||':'||point_draw||':'||point_loss FROM championship WHERE id='${championship}'`,
      "2:1:0",
    );

    const addPhase = form(page, `competition-phase-new-${championship}`);
    await addPhase.locator('[name="name"]').fill("League phase");
    await addPhase.locator('[name="position"]').fill("7");
    await addPhase.locator('[name="sort"]').fill("pt,head,bias,name");
    await addPhase.locator('[name="bonus_points"]').fill("1");
    await addPhase.locator('[name="bonus_points_threshold"]').fill("3");
    await submit(addPhase);
    const phase = await persisted(
      `SELECT id FROM phase WHERE championship_id='${championship}' AND name='League phase'`,
    );

    const addGroup = form(page, `competition-group-new-${phase}`);
    await addGroup.waitFor({ state: "attached", timeout });
    await reveal(addGroup);
    await addGroup.locator('[name="name"]').fill("A");
    await addGroup.locator('[name="position"]').fill("2");
    await submit(addGroup);
    const group = await persisted(
      `SELECT id FROM stage_group WHERE phase_id='${phase}' AND name='A'`,
    );

    const addMember = form(page, `competition-member-new-${group}`);
    await addMember.waitFor({ state: "attached", timeout });
    await reveal(addMember);
    await choose(addMember, "team_id", `${f.prefix} team`, f.team);
    await addMember.locator('[name="add_sub"]').fill("-3");
    await addMember.locator('[name="bias"]').fill("4");
    await addMember.locator('[name="comment"]').fill("Administrative ruling");
    await submit(addMember);
    await persisted(
      `SELECT add_sub||':'||bias||':'||comment FROM team_group WHERE group_id='${group}' AND team_id='${f.team}'`,
      "-3:4:Administrative ruling",
    );

    const addZone = form(page, `competition-zone-new-${group}`);
    await addZone.waitFor({ state: "attached", timeout });
    await reveal(addZone);
    for (
      const [name, color, first, last, positions] of [
        ["Promotion", "#AABBCC", "1", "5", "1,3,5"],
        ["Playoff", "qualify", "3", "4", "3,4"],
      ]
    ) {
      await addZone.locator('[name="name"]').fill(name);
      await addZone.locator('[name="color"]').fill(color);
      await addZone.locator('[name="first"]').fill(first);
      await addZone.locator('[name="last"]').fill(last);
      await addZone.locator('[name="positions"]').fill(positions);
      await submit(addZone);
      await persisted(
        `SELECT positions FROM zone WHERE group_id='${group}' AND name='${name}'`,
        positions,
      );
    }
    assertEquals(
      await query(
        `SELECT count(*) FROM zone a JOIN zone b ON a.group_id=b.group_id AND a.id<b.id WHERE a.group_id='${group}' AND competition_zone_positions(a.positions)&&competition_zone_positions(b.positions)`,
      ),
      "1",
    );

    const clone = form(page, `competition-clone-${phase}`);
    await reveal(clone);
    await clone.locator('input[type="checkbox"]').check();
    await submit(clone);
    const [clonedChampionship, clonedPhase] = (await persisted(
      `SELECT target_championship_id||'|'||target_phase_id FROM phase_clone WHERE source_phase_id='${phase}' AND app_user_id='${f.editor.user.id}'`,
    )).split("|");
    assertEquals(
      await query(
        `SELECT p.position||':'||(SELECT count(*) FROM stage_group WHERE phase_id=p.id)||':'||(SELECT count(*) FROM game WHERE phase_id=p.id)||':'||(SELECT count(*) FROM team_player WHERE championship_id=p.championship_id) FROM phase p WHERE p.id='${clonedPhase}' AND p.championship_id='${clonedChampionship}'`,
      ),
      "1:1:0:0",
    );
    assertEquals(
      await query(
        `SELECT count(*) FROM stage_group g JOIN team_group m ON m.group_id=g.id JOIN zone z ON z.group_id=g.id WHERE g.phase_id='${clonedPhase}' AND m.team_id='${f.team}'`,
      ),
      "2",
    );
    const clonedSlug = await address("championship", clonedChampionship);
    const cloneLink = clone.locator("xpath=ancestor::details[1]").locator(
      `.competition-clone-result a[data-route="editar-competicao"]`,
    );
    await cloneLink.waitFor({ timeout });
    assertEquals(await cloneLink.getAttribute("data-param-slug"), clonedSlug);
    await cloneLink.click();
    await page.locator(
      `${active} [data-screen="editar-competicao"] form[data-form="competition-update"]`,
    ).waitFor({ timeout });
    assertEquals(
      await form(page, "competition-update").locator('[name="name"]')
        .inputValue(),
      `${f.prefix} season - League phase`,
    );
  } finally {
    await f.close();
  }
});

Deno.test("accept-editing-grant: competition administration exposes no forms without an editor grant", async () => {
  const f = await fixture();
  try {
    for (const session of [undefined, f.reader]) {
      const page = await f.open(session);
      for (const route of ["gerenciar-competicoes", "nova-competicao"]) {
        await visit(page, route, false);
        assertEquals(await page.locator(`${active} form`).count(), 0);
      }
    }
  } finally {
    await f.close();
  }
});
