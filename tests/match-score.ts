/// <reference lib="dom" />
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { evaluateRole } from "omnishell/interpreter/jessie.js";
import { buildNodes } from "omnishell/interpreter/render.js";
import { parseHTML } from "npm:linkedom@0.18.4";

Deno.test("match scores add extra time while shootouts remain a separate result", async () => {
  const score = await evaluateRole(await Deno.readTextFile(new URL('../shell/renderers/match-final-score.js', import.meta.url)), 'renderer');
  const penalties = await evaluateRole(await Deno.readTextFile(new URL('../shell/renderers/match-shootout.js', import.meta.url)), 'renderer');
  assertEquals(score('||Extra time'), ['']);
  assertEquals(score('0||Extra time'), ['0']);
  assertEquals(score('1|1|Extra time'), [{tag: 'abbr', attrs: {title: 'Extra time'}, children: ['2']}]);
  assertEquals(score('1|0|Extra time'), [{tag: 'abbr', attrs: {title: 'Extra time'}, children: ['1']}]);
  assertEquals(penalties('||Penalties'), []);
  const { document } = parseHTML('<html><body><div id="score"></div></body></html>');
  Object.assign(globalThis, { document });
  const target = document.getElementById('score')!;
  buildNodes([...score('1|1|Extra time'), ...penalties('4|3|Penalties')], target);
  assertEquals(target.querySelector('abbr')?.textContent, '2');
  assertEquals(target.querySelector('.shootout')?.textContent, 'Penalties: (4–3)');
  assertEquals(target.querySelector('.visually-hidden')?.textContent, 'Penalties: ');
  assertThrows(() => penalties('4||Penalties'));
  assertThrows(() => score('one||Extra time'));
});
