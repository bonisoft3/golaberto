import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8'
import { Statechart } from '@bonisoft3/omnishell/interpreter/statechart.js'
import { batchMachine } from '@bonisoft3/pronto/compute/machine.ts'
import { createSnapshotCoordinator, type BatchMachine, type Database } from '@bonisoft3/mecha/packages/compute-snapshot/src/index.ts'
import { bootstrapComputations, bootstrapRelease, fingerprintSource, withBootstrapLock, type BootstrapManifest } from './bootstrap-cloudflare.ts'

// pronto as mise resolves it, through the platform links.
const root = import.meta.resolve('@bonisoft3/pronto/')
const read = (file: string) => Deno.readTextFile(new URL(file, root))
const runtime = await read('mecha-runtime.js')
const rules = await read('compute/rules.js')
const machine: BatchMachine = { execute: new Function('harden', 'spec', 'Statechart', `return (${runtime})(spec, (() => {${rules}})(), Statechart)`)((value: unknown) => value, batchMachine.machine, Statechart) }
const definition = { name: 'first', version: 'one', reads: ['source'], to: ['sink'], coalesceMs: 0 }

async function fixture() {
  const directory = await Deno.makeTempDir()
  const db = new PGlite()
  await db.exec("CREATE ROLE service; CREATE TABLE source(id text PRIMARY KEY,value integer); CREATE TABLE sink(id text PRIMARY KEY,value integer CHECK(value>=0)); GRANT ALL ON ALL TABLES IN SCHEMA public TO service; INSERT INTO source VALUES('a',7)")
  const contents = '{"id":"a","value":7}\n'
  const file = directory + '/output.jsonl'
  await Deno.writeTextFile(file, contents)
  const proof = { file, sha256: createHash('sha256').update(contents).digest('hex') }
  const manifest: BootstrapManifest = { computations: [{ name: 'first', version: 'one', inputEvidence: [proof], sources: { source: await fingerprintSource(db, 'source') }, sinks: { sink: { ...proof, rows: 1 } } }] }
  return { db, manifest, directory, options: { db, machine, definitions: [definition], manifest }, close: async () => { await db.close(); await Deno.remove(directory, { recursive: true }) } }
}

async function chanceFixture() {
  const f = await fixture()
  await f.db.exec(`CREATE TABLE team(id uuid PRIMARY KEY,name text);
    CREATE TABLE team_chance(id uuid PRIMARY KEY,team_id uuid,team_name text,value double precision);
    GRANT ALL ON team,team_chance TO service;
    INSERT INTO team SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'Team ' || i FROM generate_series(1,129) i`)
  const rows = (await f.db.query<{ id: string; team_id: string; team_name: string; value: number }>('SELECT id,id AS team_id,name AS team_name,0.25::double precision AS value FROM team ORDER BY id')).rows
  rows.at(-1)!.team_name = 'physical-probe'
  const contents = rows.map(row => JSON.stringify(row) + '\n').join('')
  const file = f.directory + '/chance.jsonl'
  await Deno.writeTextFile(file, contents)
  const proof = { file, sha256: createHash('sha256').update(contents).digest('hex'), rows: rows.length }
  const definition = { name: 'chances', version: 'one', reads: ['team'], to: ['team_chance'], coalesceMs: 0 }
  const manifest: BootstrapManifest = { computations: [{ name: definition.name, version: definition.version, inputEvidence: [proof], sources: { team: await fingerprintSource(f.db, 'team') }, sinks: { team_chance: proof } }] }
  return { ...f, rows, options: { db: f.db, machine, definitions: [definition], manifest } }
}

Deno.test('correct file and source hashes cannot qualify chance labels from a different team snapshot', async () => {
  const f = await chanceFixture()
  try {
    const lookups: number[] = []
    const db: Database = {
      exec: sql => f.db.exec(sql), transaction: fn => f.db.transaction(fn),
      query: async <T>(sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT id::text AS id,name FROM public.team')) lookups.push((params![0] as string[]).length)
        return await f.db.query<T>(sql, params)
      },
    }
    await assert.rejects(() => bootstrapComputations({ ...f.options, db }), /team_chance name differs from source/)
    assert.deepEqual(lookups, [128, 1])
    assert.deepEqual((await f.db.query('SELECT * FROM team_chance')).rows, [])
    assert.deepEqual((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, [])
  } finally { await f.close() }
})

Deno.test('a completed legacy receipt cannot bypass source-label validation on reuse', async () => {
  const f = await chanceFixture()
  try {
    await assert.rejects(() => bootstrapComputations(f.options), /team_chance name differs from source/)
    const coordinator = await createSnapshotCoordinator({ db: f.db, machine, computations: f.options.definitions, serialize: fn => fn(), retainSnapshot: async () => {} })
    try {
      const capture = await coordinator.claim()
      assert.ok(capture)
      await coordinator.outputChunk(capture, 'offline-bootstrap', 'team_chance', 0, f.rows.slice(0, 128))
      await coordinator.outputChunk(capture, 'offline-bootstrap', 'team_chance', 1, f.rows.slice(128))
      await coordinator.sealOutput(capture, 'offline-bootstrap', { team_chance: { chunks: 2, rows: 129 } })
      await coordinator.publishStaged(capture, 'offline-bootstrap')
    } finally { await coordinator.stop() }
    await assert.rejects(() => bootstrapComputations(f.options), /team_chance name differs from source/)
    assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::integer AS n FROM compute_snapshot_private.receipts')).rows[0].n, 1)
  } finally { await f.close() }
})

Deno.test('the chance-name repair changes only mismatched labels and is physically idempotent', async () => {
  const f = await chanceFixture()
  try {
    await f.db.exec("INSERT INTO team_chance SELECT id,id,CASE WHEN name='Team 129' THEN 'physical-probe' ELSE name END,0.25 FROM team")
    const before = (await f.db.query('SELECT id,team_id,value FROM team_chance ORDER BY id')).rows
    const sql = await Deno.readTextFile(new URL('../services/database/sql/052_chance_team_names.sql', import.meta.url))
    await f.db.exec(sql)
    assert.deepEqual((await f.db.query('SELECT id,team_id,value FROM team_chance ORDER BY id')).rows, before)
    assert.deepEqual((await f.db.query('SELECT chance.id FROM team_chance chance JOIN team ON team.id=chance.team_id WHERE chance.team_name IS DISTINCT FROM team.name')).rows, [])
    const stamp = () => f.db.query('SELECT id,team_name,xmin::text,xmax::text,ctid::text FROM team_chance ORDER BY id')
    const repaired = (await stamp()).rows
    await f.db.exec(sql)
    assert.deepEqual((await stamp()).rows, repaired)
  } finally { await f.close() }
})

Deno.test('offline publication creates real restart-safe coverage while later source writes invalidate it', async () => {
  const f = await fixture()
  try {
    const first = await bootstrapComputations(f.options)
    assert.equal(first.wakeAt, null)
    assert.deepEqual((await f.db.query('SELECT * FROM sink')).rows, [{ id: 'a', value: 7 }])
    assert.deepEqual(await bootstrapComputations(f.options), first)
    assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::integer AS n FROM compute_snapshot_private.receipts')).rows[0].n, 1)
    const coordinator = await createSnapshotCoordinator({ db: f.db, machine, computations: [definition], serialize: fn => fn(), retainSnapshot: async () => {} })
    assert.equal(await coordinator.claim(), null)
    await f.db.exec("UPDATE source SET value=8 WHERE id='a'")
    assert.ok(await coordinator.claim())
    await coordinator.stop()
    await assert.rejects(() => bootstrapComputations(f.options), /source differs/)
    assert.equal((await f.db.query<{ value: number }>('SELECT value FROM sink')).rows[0].value, 7)
  } finally { await f.close() }
})

Deno.test('source proofs cover payload columns and are rechecked after staging', async () => {
  const f = await fixture()
  try {
    const proof = f.manifest.computations[0].sources.source
    proof.columns = ['id']
    await assert.rejects(() => bootstrapComputations(f.options), /source differs/)
    f.manifest.computations[0].sources.source = await fingerprintSource(f.db, 'source')
    await assert.rejects(() => bootstrapComputations({ ...f.options, progress: async event => {
      if (event.phase === 'publish') await f.db.exec("UPDATE source SET value=99 WHERE id='a'")
    } }), /source differs/)
    assert.deepEqual((await f.db.query('SELECT * FROM sink')).rows, [])
    assert.deepEqual((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, [])
  } finally { await f.close() }
})

Deno.test('an interrupted sealed publication resumes with the same proof and receipt', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => bootstrapComputations({ ...f.options, progress: event => {
      if (event.phase === 'publish') return Promise.reject(Error('interrupted'))
      return Promise.resolve()
    } }), /interrupted/)
    assert.deepEqual((await f.db.query('SELECT * FROM sink')).rows, [])
    const result = await bootstrapComputations(f.options)
    assert.equal(result.wakeAt, null)
    assert.equal(result.receipts.length, 1)
    assert.deepEqual((await f.db.query('SELECT * FROM sink')).rows, [{ id: 'a', value: 7 }])
  } finally { await f.close() }
})

Deno.test('wrong artifact versions and changed output files are refused before coverage changes', async () => {
  const f = await fixture()
  try {
    f.manifest.computations[0].version = 'other'
    await assert.rejects(() => bootstrapComputations(f.options), /version differs/)
    f.manifest.computations[0].version = 'one'
    await Deno.writeTextFile(f.manifest.computations[0].sinks.sink.file, '{"id":"a","value":8}\n')
    await assert.rejects(() => bootstrapComputations(f.options), /file differs/)
    assert.equal((await f.db.query<{ relation: string | null }>("SELECT to_regclass('compute_snapshot_private.receipts') AS relation")).rows[0].relation, null)
  } finally { await f.close() }
})

Deno.test('invalid preparation manifests release the exclusive directory lock', async () => {
  const directory = await Deno.makeTempDir()
  try {
    const manifest = directory + '/invalid.json'
    await Deno.writeTextFile(manifest, '{')
    await assert.rejects(() => bootstrapRelease([directory, directory + '/pgdata', manifest]), SyntaxError)
    await withBootstrapLock(directory + '/pgdata', () => Promise.resolve())
  } finally { await Deno.remove(directory, { recursive: true }) }
})

Deno.test('an output changed after preflight cannot publish under the original proof', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => bootstrapComputations({ ...f.options, progress: async event => {
      if (event.phase === 'stage-start') await Deno.writeTextFile(f.manifest.computations[0].sinks.sink.file, '{"id":"a","value":8}\n')
    } }), /staged file differs/)
    assert.deepEqual((await f.db.query('SELECT * FROM sink')).rows, [])
    assert.deepEqual((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, [])
  } finally { await f.close() }
})

Deno.test('complete bootstrap refuses an omitted computation even when its work cannot be scheduled', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => bootstrapComputations({ ...f.options, definitions: [definition, { ...definition, name: 'omitted' }], requireComplete: true }), /requires every computation/)
  } finally { await f.close() }
})

Deno.test('a terminated process releases its offline directory lock', async () => {
  const directory = await Deno.makeTempDir()
  const entry = new URL('./bootstrap-cloudflare.ts', import.meta.url).href
  // A URL's pathname keeps %20 and a Windows drive's leading slash; deno's flags take paths.
  // Under the config this test runs under, pronto's, which maps the platform.
  const child = new Deno.Command(Deno.execPath(), { args: ['eval', '--config', fileURLToPath(new URL('deno.json', root)), '--lock', fileURLToPath(new URL('deno.lock', root)), '--frozen', `import {withBootstrapLock} from ${JSON.stringify(entry)};await withBootstrapLock(${JSON.stringify(directory)},async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{})})`], stdout: 'piped', stderr: 'inherit' }).spawn()
  try {
    const reader = child.stdout.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /locked/)
    reader.releaseLock()
    child.kill('SIGKILL')
    await child.status
    await withBootstrapLock(directory, () => Promise.resolve())
  } finally {
    await child.stdout.cancel()
    await Deno.remove(directory + '.bootstrap-lock')
    await Deno.remove(directory, { recursive: true })
  }
})
