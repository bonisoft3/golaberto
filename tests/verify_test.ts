import assert from 'node:assert/strict'
import { liveStatistics } from './verify.ts'

for (const failure of ['none', 'publication', 'lost insert response', 'lost response restored edit', 'receipt without row', 'concurrent metadata', 'restoration', 'stale read', 'pending insert', 'own parent update', 'concurrent txid', 'date representation', 'concurrent day', 'concurrent kickoff', 'timestamp representation'] as const) {
  Deno.test(`hosted verification compensation: ${failure}`, async () => {
    const originalFetch = globalThis.fetch
    const originalLog = console.log
    const game = { id: crypto.randomUUID(), day: '2026-10-05', home_id: crypto.randomUUID(), away_id: crypto.randomUUID() }
    const records = new Map<string, Record<string, any>>()
    let recovery: string | undefined
    console.log = (...args: unknown[]) => {
      const match = String(args[0]).match(/^Live statistics recovery record: (.+)$/)
      if (match) recovery = match[1]
    }
    const screenshots: string[] = []
    let checks = 0
    let sequence = 0
    let staleReads = 0
    let pendingInsert: (() => void) | undefined
    const json = (body: unknown) => Response.json(body)
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const defaults: Record<string, Record<string, unknown>> = {
          championship: { region: 'national', point_win: 3, point_draw: 1, point_loss: 0, show_country: false, featured: false, slug: 'fixture' },
          phase: { position: 0, sort: 'pt,w,gd,gf,gp,g_away,name', bonus_points: 0, bonus_points_threshold: 0 },
          stage_group: { position: 0 }, team_group: { add_sub: 0, bias: 0, comment: null },
          game: { round: null, kickoff: null, home_field: 'left', home_aet: null, away_aet: null, home_pen: null, away_pen: null, stadium_id: null, referee_id: null, attendance: null },
        }
        const row = { ...defaults[table], ...body, created_by: 'editor', updated_by: 'editor', txid: ++sequence }
        if (table === 'game' && failure === 'pending insert') {
          pendingInsert = () => records.set(`${table}:${body.id}`, row)
          throw new Error('insert response timed out before commit')
        }
        if (table === 'game' && failure === 'timestamp representation') row.created_at = '2026-10-05'
        records.set(`${table}:${body.id}`, row)
        if (table === 'game' && (failure === 'lost insert response' || failure === 'lost response restored edit')) {
          if (failure === 'lost response restored edit') row.txid = ++sequence
          throw new Error('insert response lost after commit')
        }
        if (table === 'game' && failure === 'receipt without row') return new Response('[', { headers: { 'x-txid': String(sequence) } })
        const returned = failure === 'date representation' ? table === 'championship' ? { ...row, begins: row.begins+'T00:00:00.000Z', ends: row.ends+'T00:00:00.000Z' } : table === 'game' ? { ...row, day: row.day+'T00:00:00.000Z' } : row : failure === 'timestamp representation' && table === 'game' ? { ...row, created_at: '2026-10-05T00:00:00.000Z' } : row
        return Response.json([returned], { headers: { 'x-txid': String(sequence) } })
      }
      if (init?.method === 'DELETE') {
        const id = url.searchParams.get('id')!.slice(3), key = `${table}:${id}`, row = records.get(key)
        if (!row || url.searchParams.get('txid') !== `eq.${row.txid}`) return json([])
        records.delete(key)
        const txid = ++sequence
        if (failure === 'own parent update' && table === 'team_group') records.get(`stage_group:${row.group_id}`)!.txid = txid
        return Response.json([row], { headers: { 'x-txid': String(txid) } })
      }
      if (table === 'editor') return json([{ app_user_id: 'editor' }])
      if (table === 'category') return json([{ id: crypto.randomUUID() }])
      if (table === 'team') return json([{ name: 'Home' }])
      if (table === 'game_change') return json([])
      if (table === 'standing') {
        const changed = [...records.keys()].some(k => k.startsWith('game:'))
        if (failure === 'stale read' && changed && staleReads++ === 0) return json([{ id: 'standing', goals_for: 0 }])
        return json([{ id: 'standing', goals_for: changed ? 1 : 0 }])
      }
      const id = url.searchParams.get('id')?.slice(3)
      if (table === 'game' && id === game.id) return json([game])
      const row = records.get(`${table}:${id}`)
      return json(row ? [row] : [])
    }
    const page = {
      goto: () => Promise.resolve({ status: () => 200 }), evaluate: () => Promise.resolve(123),
      screenshot: async ({ path }: { path: string }) => { screenshots.push(path.match(/-(before|changed|restored)\.png$/)![1]) },
      waitForFunction: async (_fn: unknown, args: { goals: number }) => {
        checks++
        if (args.goals === 0 && checks > 1 && failure === 'restoration') throw new Error('restoration deadline exceeded')
        if (args.goals === 1 && failure === 'publication') throw new Error('publication deadline exceeded')
        if (args.goals === 1 && (failure === 'concurrent day' || failure === 'concurrent kickoff')) {
          const row = [...records.entries()].find(([key]) => key.startsWith('game:'))![1]
          if (failure === 'concurrent day') row.day = '2026-10-06'
          else row.kickoff = '2026-10-05T00:00:00.000Z'
        }
        if (args.goals === 1 && (failure === 'concurrent metadata' || failure === 'concurrent txid')) {
          const row = [...records.entries()].find(([key]) => key.startsWith('game:'))![1]
          if (failure === 'concurrent metadata') row.stadium_id = crypto.randomUUID()
          row.txid = ++sequence
        }
      },
    }
    try {
      const run = liveStatistics(game.id).run(page, { baseUrl: 'https://verify.invalid', token: JSON.stringify({ token: 'test', user: { id: 'editor', guest: false } }) })
      if (failure === 'none' || failure === 'stale read' || failure === 'own parent update' || failure === 'date representation') await run
      else await assert.rejects(run, failure === 'timestamp representation' || failure === 'concurrent day' || failure === 'concurrent kickoff' || failure === 'concurrent metadata' || failure === 'concurrent txid' ? /was edited/ : failure === 'publication' ? /publication deadline/ : failure === 'restoration' ? /restoration deadline/ : failure === 'pending insert' ? /insert outcome is unknown/ : failure === 'receipt without row' ? /JSON|end/i : /no matching transaction receipt/)
      if (failure === 'pending insert') {
        assert.equal(records.size, 5)
        assert.ok(recovery)
        const held = JSON.parse(await Deno.readTextFile(recovery))
        assert.equal(held.fixtures.at(-1).submitted, true)
        pendingInsert!()
      }
      assert.equal(records.size, failure === 'timestamp representation' || failure === 'concurrent day' || failure === 'concurrent kickoff' || failure === 'concurrent metadata' || failure === 'concurrent txid' || failure === 'pending insert' || failure === 'lost insert response' || failure === 'lost response restored edit' ? 6 : 0)
      assert.ok(checks >= 1)
      if (failure === 'stale read') assert.equal(staleReads, 2)
      if (failure === 'none') assert.deepEqual(screenshots, ['before', 'changed', 'restored'])
      if (failure === 'restoration') assert.deepEqual(screenshots, ['before', 'changed'])
    } finally {
      globalThis.fetch = originalFetch
      console.log = originalLog
      if (recovery) await Deno.remove(recovery).catch(() => {})
    }
  })
}

for (const scenario of ['accepted', 'own parent receipt', 'wrong actor', 'wrong base', 'external edit', 'restored edit', 'game present', 'game history', 'game submitted', 'game saved', 'partial fixture', 'wrong layout', 'wrong relationship', 'extra child', 'extra zone', 'extra registration', 'unsafe receipt', 'unsafe row txid', 'inverse accepted', 'inverse date representation', 'inverse actor', 'inverse base', 'inverse saved actor', 'inverse saved receipt', 'inverse unknown insert', 'inverse day edit', 'inverse timestamp edit', 'inverse external txid', 'inverse own unrelated txid', 'inverse missing game', 'inverse extra game', 'inverse goal', 'inverse player_game', 'inverse comment', 'inverse game history', 'inverse baseline failure', 'inverse disappeared', 'inverse delete refused', 'inverse delete race', 'inverse lost delete', 'inverse delete receipt missing', 'inverse publication failure', 'inverse lost insert', 'inverse pending insert', 'inverse insert receipt without row', 'inverse restoration failure'] as const) {
  Deno.test(`hosted verification recovery: ${scenario}`, async () => {
    const inverse = scenario.startsWith('inverse')
    const originalFetch = globalThis.fetch, originalLog = console.log
    const originalRecovery = Deno.env.get('GOLABERTO_VERIFY_RECOVERY')
    Deno.env.delete('GOLABERTO_VERIFY_RECOVERY')
    const actor = 'editor', base = 'https://verify.invalid'
    const game = { id: crypto.randomUUID(), day: '2026-10-05', home_id: crypto.randomUUID(), away_id: crypto.randomUUID() }
    const category = crypto.randomUUID()
    const records = new Map<string, Record<string, any>>()
    const mutations: string[] = [], observations: number[] = [], screenshots: string[] = [], logs: string[] = []
    let recovery: string | undefined, preparing = true, sequence = 0
    const context = { baseUrl: base, token: JSON.stringify({ token: 'test', user: { id: actor, guest: false } }) }
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0]))
      const match = String(args[0]).match(/^Live statistics recovery record: (.+)$/)
      if (match) recovery = match[1]
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!
      if (init?.method === 'POST') {
        mutations.push(`POST ${table}`)
        const body = JSON.parse(String(init.body))
        const defaults: Record<string, Record<string, unknown>> = {
          championship: { region: 'national', point_win: 3, point_draw: 1, point_loss: 0, show_country: false, featured: false, slug: 'fixture' },
          phase: { position: 0, sort: 'pt,w,gd,gf,gp,g_away,name', bonus_points: 0, bonus_points_threshold: 0 },
          stage_group: { position: 0 }, team_group: { add_sub: 0, bias: 0, comment: null },
          game: { round: null, kickoff: null, home_field: 'left', home_aet: null, away_aet: null, home_pen: null, away_pen: null, stadium_id: null, referee_id: null, attendance: null },
        }
        const row = { ...defaults[table], ...body, created_by: actor, updated_by: actor, txid: ++sequence }
        if (!preparing && scenario === 'inverse pending insert') throw new Error('restore insert still pending')
        records.set(`${table}:${body.id}`, row)
        if (!preparing && scenario === 'inverse lost insert') throw new Error('restore insert response lost')
        if (!preparing && scenario === 'inverse insert receipt without row') return new Response('[', { headers: { 'x-txid': String(sequence) } })
        return Response.json([row], { headers: { 'x-txid': String(sequence) } })
      }
      if (init?.method === 'DELETE') {
        mutations.push(`DELETE ${table}`)
        const id = url.searchParams.get('id')!.slice(3), key = `${table}:${id}`, row = records.get(key)
        if (!row || url.searchParams.get('txid') !== `eq.${row.txid}`) return Response.json([])
        const forward = !preparing && inverse && mutations.filter(m => m === 'DELETE game').length === 1
        if (forward && scenario === 'inverse delete refused') return new Response('refused', { status: 503 })
        if (forward && scenario === 'inverse delete race') return Response.json([], { headers: { 'x-txid': String(++sequence) } })
        records.delete(key)
        if (forward && scenario === 'inverse lost delete') throw new Error('delete response lost')
        if (forward && scenario === 'inverse delete receipt missing') return Response.json([row])
        return Response.json([row], { headers: { 'x-txid': String(++sequence) } })
      }
      if (table === 'editor') return Response.json([{ app_user_id: actor }])
      if (table === 'category') return Response.json([{ id: category }])
      if (table === 'team') return Response.json([{ name: 'Home' }])
      if (table === 'game_change') return Response.json(scenario === 'game history' || scenario === 'inverse game history' ? [{ id: 'history' }] : [])
      if (table === 'standing') {
        const goals = [...records.keys()].some(key => key.startsWith('game:')) ? 1 : 0
        if (!preparing && scenario === 'inverse disappeared' && observations.length === 1) for (const key of records.keys()) if (key.startsWith('game:')) records.delete(key)
        return Response.json([{ id: 'standing', goals_for: goals }])
      }
      if (table === 'game' && url.searchParams.get('id') === `eq.${game.id}`) return Response.json([game])
      const found = [...records.entries()].filter(([key, row]) => key.startsWith(`${table}:`) &&
        [...url.searchParams].every(([field, value]) => ['select', 'limit'].includes(field) || String(row[field]) === value.slice(3))).map(([, row]) => row)
      return Response.json(found)
    }
    const page = {
      goto: () => Promise.resolve({ status: () => 200 }), evaluate: () => Promise.resolve(123), screenshot: async ({ path }: { path: string }) => { screenshots.push(path.match(/-(before|changed|restored)\.png$/)![1]) },
      waitForFunction: async (_fn: unknown, args: { goals: number }) => {
        if (preparing) {
          if (inverse && args.goals === 0) return
          throw new Error('paused before the baseline')
        }
        if (!observations.length) assert.deepEqual(mutations, [], 'adoption must not write before the baseline')
        observations.push(args.goals)
        if (scenario === 'inverse baseline failure' && observations.length === 1) throw new Error('baseline failed')
        if (scenario === 'inverse publication failure' && observations.length === 2) throw new Error('delete publication failed')
        if (scenario === 'inverse restoration failure' && observations.length === 3) throw new Error('restore publication failed')
      },
    }
    try {
      await assert.rejects(liveStatistics(game.id).spec.execute(page, context), /paused before the baseline/)
      assert.deepEqual(mutations, ['POST championship', 'POST phase', 'POST stage_group', 'POST team_group', 'POST team_group', ...(inverse ? ['POST game'] : [])])
      assert.ok(recovery)
      const held = JSON.parse(await Deno.readTextFile(recovery))
      const fixtureGame = held.fixtures[5], phase = held.fixtures[1], group = held.fixtures[2]
      const fixtureKey = `game:${fixtureGame.input.id}`
      if (scenario === 'inverse date representation') fixtureGame.saved.day += 'T00:00:00.000Z'
      if (scenario === 'inverse saved actor') fixtureGame.saved.created_by = 'other-editor'
      if (scenario === 'inverse saved receipt') fixtureGame.saved.txid = '999'
      if (scenario === 'inverse unknown insert') delete fixtureGame.saved
      if (scenario === 'inverse actor') held.actor = 'other-editor'
      if (scenario === 'inverse base') held.base = 'https://other.invalid'
      if (scenario === 'inverse day edit') records.get(fixtureKey)!.day = '2026-10-06'
      if (scenario === 'inverse timestamp edit') records.get(fixtureKey)!.kickoff = '2026-10-05T00:00:00.000Z'
      if (scenario === 'inverse external txid') records.get(fixtureKey)!.txid = 99
      if (scenario === 'inverse own unrelated txid') records.get(fixtureKey)!.txid = 1
      if (scenario === 'inverse missing game') records.delete(fixtureKey)
      if (scenario === 'inverse extra game') records.set('game:extra', { id: 'extra', phase_id: phase.input.id })
      for (const table of ['goal', 'player_game', 'comment']) if (scenario === `inverse ${table}`) records.set(`${table}:extra`, { id: 'extra', game_id: fixtureGame.input.id })
      if (scenario === 'wrong actor') held.actor = 'other-editor'
      if (scenario === 'wrong base') held.base = 'https://other.invalid'
      if (scenario === 'external edit') records.get(`phase:${phase.input.id}`)!.name = 'Edited'
      if (scenario === 'restored edit') records.get(`phase:${phase.input.id}`)!.txid = 99
      if (scenario === 'game present') records.set(`game:${fixtureGame.input.id}`, { ...fixtureGame.input, txid: 99 })
      if (scenario === 'game submitted') fixtureGame.submitted = true
      if (scenario === 'game saved') fixtureGame.saved = { ...fixtureGame.input, txid: 99 }
      if (scenario === 'partial fixture') delete group.saved
      if (scenario === 'wrong layout') held.fixtures.reverse()
      if (scenario === 'wrong relationship') held.fixtures[3].input.group_id = crypto.randomUUID()
      if (scenario === 'extra child') records.set('team_group:extra', { id: 'extra', group_id: group.input.id })
      if (scenario === 'extra zone') records.set('zone:extra', { id: 'extra', group_id: group.input.id })
      if (scenario === 'extra registration') records.set('team_player:extra', { id: 'extra', championship_id: held.fixtures[0].input.id })
      if (scenario === 'unsafe receipt') held.transactions[0] = '4294967296'
      if (scenario === 'unsafe row txid') records.get(`phase:${phase.input.id}`)!.txid = Number.MAX_SAFE_INTEGER + 1
      if (scenario === 'own parent receipt') records.get(`stage_group:${group.input.id}`)!.txid = Number(held.transactions[4])
      await Deno.writeTextFile(recovery, JSON.stringify(held))
      const before = await Deno.readTextFile(recovery), stored = JSON.stringify([...records])
      preparing = false
      mutations.length = 0
      screenshots.length = 0
      Deno.env.set('GOLABERTO_VERIFY_RECOVERY', recovery)
      const run = liveStatistics(game.id).run(page, context)
      const inverseRun = inverse && ['inverse accepted', 'inverse date representation', 'inverse baseline failure', 'inverse disappeared', 'inverse delete refused', 'inverse delete race', 'inverse lost delete', 'inverse delete receipt missing', 'inverse publication failure', 'inverse lost insert', 'inverse pending insert', 'inverse insert receipt without row', 'inverse restoration failure'].includes(scenario)
      if (inverseRun) {
        const success = scenario === 'inverse accepted' || scenario === 'inverse date representation'
        if (success) await run
        else await assert.rejects(run, /baseline failed|deletion was not confirmed|delete publication failed|restore publication failed|insert|JSON|end/i)
        const retained = ['inverse baseline failure', 'inverse disappeared', 'inverse delete refused', 'inverse delete race', 'inverse lost delete', 'inverse delete receipt missing', 'inverse lost insert', 'inverse pending insert'].includes(scenario)
        if (retained) {
          assert.ok(records.size >= 5)
          const after = JSON.parse(await Deno.readTextFile(recovery))
          assert.ok(!mutations.some(m => m.startsWith('DELETE ') && m !== 'DELETE game'))
          if (scenario === 'inverse lost insert' || scenario === 'inverse pending insert') assert.equal(after.fixtures[5].saved, undefined)
          else {
            assert.ok(!mutations.includes('POST game'), 'unconfirmed delete never authorizes recreation')
            assert.equal(mutations.filter(m => m === 'DELETE game').length, scenario === 'inverse baseline failure' || scenario === 'inverse disappeared' ? 0 : 1)
          }
        } else {
          assert.equal(records.size, 0)
          await assert.rejects(Deno.stat(recovery), Deno.errors.NotFound)
          assert.deepEqual(mutations, ['DELETE game', 'POST game', 'DELETE game', 'DELETE team_group', 'DELETE team_group', 'DELETE stage_group', 'DELETE phase', 'DELETE championship'])
        }
        assert.equal(logs.some(log => log.includes('1 → 0 → 1 verified')), success)
        if (success) {
          assert.deepEqual(observations, [1, 0, 1])
          assert.deepEqual(screenshots, ['before', 'changed', 'restored'])
        }
      } else if (scenario === 'accepted' || scenario === 'own parent receipt') {
        await run
        assert.deepEqual(observations, [0, 1, 0])
        assert.deepEqual(mutations, ['POST game', 'DELETE game', 'DELETE team_group', 'DELETE team_group', 'DELETE stage_group', 'DELETE phase', 'DELETE championship'])
        assert.equal(records.size, 0)
        await assert.rejects(Deno.stat(recovery), Deno.errors.NotFound)
      } else {
        await assert.rejects(run, /recovery refused|Invalid verification transaction receipt/)
        assert.deepEqual(mutations, [], 'unvalidated fixtures must never be written or cleaned up')
        assert.deepEqual(observations, [])
        assert.equal(await Deno.readTextFile(recovery), before)
        assert.equal(JSON.stringify([...records]), stored)
      }
    } finally {
      globalThis.fetch = originalFetch
      console.log = originalLog
      if (originalRecovery === undefined) Deno.env.delete('GOLABERTO_VERIFY_RECOVERY')
      else Deno.env.set('GOLABERTO_VERIFY_RECOVERY', originalRecovery)
      if (recovery) {
        try { await Deno.remove(recovery) } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
      }
    }
  })
}
