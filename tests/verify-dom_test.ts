/// <reference lib="dom" />
import assert from 'node:assert/strict'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { standingVisible } from './verify.ts'

Deno.test('hosted standings proof reads row identity through the real championship template', async () => {
  const markup = await Deno.readTextFile(new URL('../shell/screens/campeonato.html', import.meta.url))
  const { document } = parseHTML('<html><body></body></html>')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  try {
    const args = { group: 'fixture-group', teamId: 'fixture-team', goals: 0, origin: performance.timeOrigin }
    const source = document.createElement('template')
    source.innerHTML = markup
    const championship = source.content.querySelector('[data-live="championship"] > template') as HTMLTemplateElement
    const phase = championship.content.querySelector('.phases > template') as HTMLTemplateElement
    const groups = phase.content.querySelector('.groups > template') as HTMLTemplateElement
    const section = groups.content.firstElementChild!.cloneNode(true) as HTMLElement
    section.dataset.id = args.group
    const body = section.querySelector('.standings tbody')!
    const template = body.querySelector('template') as HTMLTemplateElement
    const row = template.content.firstElementChild!.cloneNode(true) as HTMLElement
    row.dataset.id = `${args.group}:${args.teamId}`
    row.querySelector('.team-name')!.textContent = 'Cyprus'
    const cell = row.querySelector('[data-text="{goals_for}"]')!
    cell.textContent = '0'
    for (const preview of row.querySelectorAll('.team-match-preview-read')) preview.textContent = 'No matches'
    body.replaceChildren(row)
    document.body.append(section)
    assert.equal(body.getAttribute('data-filter'), 'group_id=eq.{id}')
    assert.equal(row.querySelector('.team-name')!.textContent, 'Cyprus')
    assert.notEqual(row.querySelector('.name')!.textContent!.trim(), 'Cyprus')
    assert.equal(standingVisible(args), true)
    assert.equal(standingVisible({ ...args, group: 'another-group' }), false)
    assert.equal(standingVisible({ ...args, teamId: 'another-team' }), false)
    assert.equal(standingVisible({ ...args, goals: 1 }), false)
    for (const goals of [1, 0]) {
      cell.textContent = String(goals)
      assert.equal(standingVisible({ ...args, goals }), true)
      assert.equal(standingVisible({ ...args, goals: 1 - goals }), false)
    }
    assert.throws(() => standingVisible({ ...args, origin: args.origin - 1 }), /Statistics required a document reload/)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
