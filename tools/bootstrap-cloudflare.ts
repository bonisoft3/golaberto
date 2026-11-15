import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextLineStream } from 'jsr:@std/streams@1.0.9/text-line-stream'
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8'
import { icuDataDir } from 'npm:@electric-sql/pglite-icu-full@0.0.2'
import { createSnapshotCoordinator, type BatchMachine, type Computation, type Database } from '@bonisoft3/mecha/packages/compute-snapshot/src/index.ts'

interface FileProof { file: string; sha256: string }
interface SinkProof extends FileProof { rows: number }
export interface SourceProof { columns: string[]; rows: number; sha256: string }
export interface BootstrapComputation {
  name: string
  version: string
  inputEvidence: FileProof[]
  sources: Record<string, SourceProof>
  sinks: Record<string, SinkProof>
}
export interface BootstrapManifest { computations: BootstrapComputation[] }
const ident = (name: string) => { assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/); return `"${name}"` }

export async function fingerprintSource(db: Database, table: string): Promise<SourceProof> {
  const columns = (await db.query<{ name: string }>('SELECT attname AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum', [`public.${ident(table)}`])).rows.map(row => row.name)
  assert.ok(columns.includes('id'), `source requires id: ${table}`)
  const selected = columns.map(name => `${ident(name)}::text`).join(',')
  return await db.transaction(async tx => {
    await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='iso_8601'; SET LOCAL bytea_output='hex'")
    const hash = createHash('sha256'); let after: string | undefined, rows = 0
    while (true) {
      const page = (await tx.query<{ cursor: string; value: string }>(`SELECT id::text AS cursor,json_build_array(${selected})::text AS value
        FROM public.${ident(table)} ${after === undefined ? '' : 'WHERE id>$1'} ORDER BY id LIMIT 256`, after === undefined ? [] : [after])).rows
      for (const row of page) { hash.update(row.value + '\n'); rows++ }
      if (page.length < 256) break
      after = page.at(-1)!.cursor
    }
    return { columns, rows, sha256: hash.digest('hex') }
  })
}

async function verifySources(db: Database, supplied: BootstrapComputation) {
  for (const [table, expected] of Object.entries(supplied.sources)) {
    assert.deepEqual(await fingerprintSource(db, table), expected, `source differs: ${supplied.name}/${table}`)
  }
}

function proofHash(supplied: BootstrapComputation) {
  return createHash('sha256').update(JSON.stringify({ name: supplied.name, version: supplied.version,
    inputs: supplied.inputEvidence.map(proof => proof.sha256).sort(),
    sources: Object.entries(supplied.sources).sort(),
    sinks: Object.entries(supplied.sinks).sort().map(([name, proof]) => [name, proof.rows, proof.sha256]),
  })).digest('hex')
}

async function digest(file: string) {
  const hash = createHash('sha256')
  const handle = await Deno.open(file)
  for await (const bytes of handle.readable) hash.update(bytes)
  return hash.digest('hex')
}

async function outputPages(proof: SinkProof, consume: (page: Record<string, unknown>[], ordinal: number, rows: number) => Promise<void>) {
  let rows = 0, chunks = 0, bytes = 2
  let page: Record<string, unknown>[] = []
  const flush = async () => {
    if (!page.length) return
    await consume(page, chunks++, rows)
    page = []; bytes = 2
  }
  const streamed = createHash('sha256')
  const file = await Deno.open(proof.file)
  const checked = file.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(bytes, controller) {
    streamed.update(bytes); controller.enqueue(bytes)
  } }))
  for await (const line of checked.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())) {
    if (!line) continue
    const row = JSON.parse(line)
    const size = new TextEncoder().encode(JSON.stringify(row)).length
    assert.ok(size + 2 <= 256 * 1024, `oversized row: ${proof.file}`)
    if (page.length === 128 || bytes + size + 1 > 256 * 1024) await flush()
    bytes += size + (page.length ? 1 : 0)
    page.push(row); rows++
  }
  await flush()
  assert.equal(streamed.digest('hex'), proof.sha256, `staged file differs: ${proof.file}`)
  assert.equal(rows, proof.rows, `row count differs: ${proof.file}`)
  return { chunks, rows }
}

async function verifyTeamNames(db: Database, supplied: BootstrapComputation, page: Record<string, unknown>[]) {
  assert.ok(supplied.sources.team, 'team_chance requires its declared team source')
  const ids = [...new Set(page.map(row => row.team_id))]
  assert.ok(ids.every(id => typeof id === 'string'), 'team_chance requires team_id')
  const teams = (await db.query<{ id: string; name: string | null }>('SELECT id::text AS id,name FROM public.team WHERE id=ANY($1::uuid[])', [ids])).rows
  const names = new Map(teams.map(team => [team.id, team.name]))
  for (const row of page) {
    assert.ok(names.has(row.team_id as string), `team_chance references missing team: ${row.team_id}`)
    assert.equal(row.team_name, names.get(row.team_id as string), `team_chance name differs from source: ${row.team_id}`)
  }
}

export async function validateBootstrap(definitions: Computation[], manifest: BootstrapManifest) {
  const names = new Set<string>()
  for (const supplied of manifest.computations) {
    const definition = definitions.find(item => item.name === supplied.name)
    assert.ok(definition, `unknown computation ${supplied.name}`)
    assert.equal(supplied.version, definition.version, `version differs: ${supplied.name}`)
    assert.ok(!names.has(supplied.name), `duplicate computation ${supplied.name}`)
    names.add(supplied.name)
    assert.deepEqual(Object.keys(supplied.sinks).sort(), [...definition.to].sort(), `sink set differs: ${supplied.name}`)
    assert.deepEqual(Object.keys(supplied.sources).sort(), [...definition.reads].sort(), `source set differs: ${supplied.name}`)
    assert.ok(supplied.inputEvidence.length, `input evidence required: ${supplied.name}`)
    for (const proof of [...supplied.inputEvidence, ...Object.values(supplied.sinks)]) {
      assert.match(proof.sha256, /^[0-9a-f]{64}$/)
      assert.equal(await digest(proof.file), proof.sha256, `file differs: ${proof.file}`)
    }
    for (const sink of Object.values(supplied.sinks)) assert.ok(Number.isSafeInteger(sink.rows) && sink.rows >= 0)
  }
}

export async function bootstrapComputations(options: {
  db: Database
  machine: BatchMachine
  definitions: Computation[]
  manifest: BootstrapManifest
  requireComplete?: boolean
  progress?: (event: Record<string, unknown>) => Promise<void>
}) {
  const { db, machine, definitions, manifest } = options
  await validateBootstrap(definitions, manifest)
  if (options.requireComplete) assert.deepEqual(manifest.computations.map(item => item.name).sort(), definitions.map(item => item.name).sort(), 'complete bootstrap requires every computation manifest')
  const report = options.progress ?? (() => Promise.resolve())
  const coordinator = await createSnapshotCoordinator({ db, machine, computations: definitions, serialize: fn => fn(), retainSnapshot: async identity => {
    const supplied = manifest.computations.find(item => item.name === identity.name)
    assert.ok(supplied, `missing source proof: ${identity.name}`)
    await verifySources(db, supplied)
  } })
  const receipts: { name: string; version: string; id: string }[] = []
  const pending = new Map(manifest.computations.map(item => [item.name, item]))
  try {
    await db.exec('CREATE SCHEMA IF NOT EXISTS golaberto_bootstrap; REVOKE ALL ON SCHEMA golaberto_bootstrap FROM PUBLIC; CREATE TABLE IF NOT EXISTS golaberto_bootstrap.manifests(capture text PRIMARY KEY,name text NOT NULL,version text NOT NULL,proof text NOT NULL)')
    await coordinator.wakeAt()
    for (const supplied of manifest.computations) {
      const completed = (await db.query<{ id: string; proof: string }>(`SELECT receipt.id,manifest.proof FROM compute_snapshot_private.batches batch
        JOIN compute_snapshot_private.receipts receipt ON receipt.name=batch.name AND receipt.version=batch.version AND receipt.revision=(batch.state->>'completed')::bigint
        JOIN golaberto_bootstrap.manifests manifest ON manifest.capture=receipt.id
        WHERE batch.name=$1 AND batch.version=$2 AND batch.state->>'completed'=batch.state->>'requested'`, [supplied.name, supplied.version])).rows[0]
      if (!completed) continue
      assert.equal(completed.proof, proofHash(supplied), `completed bootstrap proof differs: ${supplied.name}`)
      await verifySources(db, supplied)
      if (supplied.sinks.team_chance) await outputPages(supplied.sinks.team_chance, page => verifyTeamNames(db, supplied, page))
      receipts.push({ name: supplied.name, version: supplied.version, id: completed.id })
      pending.delete(supplied.name)
    }
    while (pending.size) {
      const due = await coordinator.wakeAt()
      if (due !== null && due > Date.now()) await new Promise(resolve => setTimeout(resolve, due - Date.now()))
      const identity = await coordinator.claim()
      assert.ok(identity, 'no ready computation for the supplied outputs')
      const supplied = pending.get(identity.name)
      assert.ok(supplied, `next computation ${identity.name} needs its own verified output manifest`)
      await db.query('INSERT INTO golaberto_bootstrap.manifests VALUES($1,$2,$3,$4) ON CONFLICT(capture) DO NOTHING', [identity.id, identity.name, identity.version, proofHash(supplied)])
      const saved = (await db.query<{ proof: string }>('SELECT proof FROM golaberto_bootstrap.manifests WHERE capture=$1', [identity.id])).rows[0]
      assert.equal(saved.proof, proofHash(supplied), 'retained bootstrap proof differs')
      const attempt = 'offline-bootstrap'
      const seal: Record<string, { chunks: number; rows: number }> = {}
      for (const [sink, proof] of Object.entries(supplied.sinks)) {
        await report({ phase: 'stage-start', name: identity.name, sink })
        seal[sink] = await outputPages(proof, async (page, ordinal, rows) => {
          if (sink === 'team_chance') await verifyTeamNames(db, supplied, page)
          await coordinator.outputChunk(identity, attempt, sink, ordinal, page)
          if ((ordinal + 1) % 128 === 0) await report({ phase: 'stage', name: identity.name, sink, rows, chunks: ordinal + 1 })
        })
      }
      await coordinator.sealOutput(identity, attempt, seal)
      await report({ phase: 'publish', identity })
      await verifySources(db, supplied)
      await coordinator.publishStaged(identity, attempt)
      assert.equal(await coordinator.publication(identity), 'published')
      receipts.push({ name: identity.name, version: identity.version, id: identity.id })
      pending.delete(identity.name)
      await report({ phase: 'published', identity })
    }
    const wakeAt = await coordinator.wakeAt()
    const covered = (await db.query<{ name: string; version: string }>(`SELECT batch.name,batch.version FROM compute_snapshot_private.batches batch
      JOIN compute_snapshot_private.receipts receipt ON receipt.name=batch.name AND receipt.version=batch.version AND receipt.revision=(batch.state->>'completed')::bigint
      WHERE batch.state->>'requested'=batch.state->>'completed'`)).rows
    const complete = definitions.every(definition => covered.some(item => item.name === definition.name && item.version === definition.version))
    if (options.requireComplete) assert.ok(complete, 'release still has pending or exhausted computation work')
    return { receipts, wakeAt, complete }
  } finally {
    await coordinator.stop()
  }
}

export async function withBootstrapLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lock = await Deno.open(directory + '.bootstrap-lock', { create: true, write: true })
  try {
    await lock.lock(true)
    return await operation()
  } finally { lock.close() }
}

export async function bootstrapRelease(args: string[]) {
  const [releaseArg, directoryArg, manifestArg, ...flags] = args
  assert.ok(releaseArg && directoryArg && manifestArg && flags.every(flag => flag === '--require-complete'),
    'bootstrap-cloudflare.ts <fresh-release> <owned-native-pgdata> <manifest.json> [--require-complete]')
  const release = path.resolve(releaseArg), directory = path.resolve(directoryArg)
  await withBootstrapLock(directory, async () => {
    let db: PGlite | undefined
    try {
      const manifest = JSON.parse(await Deno.readTextFile(manifestArg)) as BootstrapManifest
      const definitions = JSON.parse(await Deno.readTextFile(path.join(release, 'src/compute.json'))).definitions as Computation[]
      const machine = (await import(pathToFileURL(path.join(release, 'src/compute-machine.js')).href)).default.compute_batch as BatchMachine
      const stats = await statfs(directory)
      assert.ok(stats.bavail * stats.bsize >= 15 * 1024 ** 3, 'bootstrap requires 15 GiB free disk')
      await validateBootstrap(definitions, manifest)
      db = await PGlite.create({ dataDir: directory, icuDataDir: await icuDataDir(), initialMemory: 256 * 1024 ** 2,
        startParams: [...PGlite.defaultStartParams, '-c', 'shared_buffers=64MB', '-c', 'work_mem=32MB', '-c', 'maintenance_work_mem=64MB'] })
      const result = await bootstrapComputations({ db, machine, definitions, manifest, requireComplete: flags.includes('--require-complete'), progress: async event => {
        const free = await statfs(directory)
        assert.ok(free.bavail * free.bsize >= 15 * 1024 ** 3, 'bootstrap disk floor reached')
        console.log(JSON.stringify({ at: new Date().toISOString(), ...event }))
      } })
      await db.exec('CHECKPOINT')
      await Deno.writeTextFile(path.join(path.dirname(directory), 'bootstrap-result.json'), JSON.stringify({
        definitions, manifest, ...result,
        scope: 'Native offline publication; input evidence files are provenance supplied by the computation producer, not an independent recomputation.',
      }, null, 2) + '\n')
    } finally {
      await db?.close()
    }
  })
}

if (import.meta.main) await bootstrapRelease(Deno.args)
