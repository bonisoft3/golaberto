---
type: howto
title: Release the archive to Cloudflare
description: "GolAberto with its full archive on Cloudflare: a data directory restored from the archive trial's database, checked locally under wrangler dev, then deployed and loaded into the app's one Durable Object."
---

# Release the archive to Cloudflare

GolAberto's edge release is pronto's [edge target](../../../plugins/pronto/docs/release-targets.md#cloudflare):
a Worker in front of one Durable Object that renders documents and runs mecha's
[edge cluster](../../../libraries/mecha/packages/mecha-edge/README.md) over
PGlite, its data directory in the object's SQLite. The archive is too big to
rebuild from the migrations, so its data directory comes from the archive
trial's database ([archive import](archive-import.md)), derived tables
included, and ships as that trial computed them: nothing at the edge
recomputes standings, chances or odds. Guests only.

The release enables [[../../../plugins/omnishell/docs/native-worker-ssr|native M-SSR]]
at `https://golaberto.bonisoft3.com`. Public pages render against the existing
database object's current read-only snapshot; enabling SSR preserves its
namespace and storage format. `meta.edgeClock: "disabled"` keeps the archive’s
stored cron schedules inactive on this frozen edge release; container clocks
continue to run normally.

The app-owned [[../tools/publish-cloudflare.ts|publisher]] composes the generated
renderer with the existing database class. Reads stay in the same object and
snapshot, avoiding a cross-object RPC for every query. Renderer asset fetching
is scoped to its asynchronous render context; database and import requests
retain native fetching. The generated standalone renderer remains deployed for
compatibility, but public page rendering uses the database object.

Speculative requests use existing cached HTML without starting a render or
refreshing a stale entry. A prefetch cache miss returns `204` with `no-store`;
actual navigation retains the generated cache and revalidation behavior.

It needs Docker, mise and a Cloudflare account on Workers Paid: the archive is
about 7 GB in the object's SQLite (10 GB per object), and loading it writes
about 900,000 rows.

## 1. The data directory

Dump the trial's database without writing to it, then restore the dump into a
PGlite data directory, the roles first (a dump carries none):

```sh
docker exec golaberto-archive-golaberto-database-1 pg_dump -U postgres -d golaberto \
  --schema=public --schema=mecha --schema=golaberto_history --schema=golaberto_upload --schema=pgroll \
  --no-owner --no-publications --no-subscriptions --no-security-labels > <work>/golaberto.sql
cd libraries/mecha/packages/pglite-workerd
mise exec -- deno run -A restore.ts <work>/golaberto.sql <work>/pgdata \
  --roles ../../../../apps/golaberto/services/database/migrations/001_roles.sql
```

`legacy`, the import's staging, stays out; `golaberto_upload` comes along
because `team`'s logo triggers and foreign key name it, and `pgroll` because
its ledger says which migrations the trial ran. The restore takes about 12
minutes for 7.1 GB.

## 2. The release

```sh
cd apps/golaberto
./saytw release@cloudflare --from=<work>/pgdata --snapshot
```

`--snapshot` builds `dist/cloudflare` and stops before publishing. The build
is pronto's [`edge.ts`](../../../plugins/pronto/bundle/edge.ts): the page,
PGlite for workerd (baked from mecha's pinned sources, about 9 minutes the
first time), and `dist/cloudflare/pgdata`, a copy of the directory with the
cluster's pgroll migrations its ledger lacks applied, as the trial's migrate
step would ([`migrate.ts`](../../../libraries/mecha/packages/pglite-workerd/migrate.ts));
`900_seed.sql` is no pgroll migration, and the archive holds its rows.

For a local publish, supply the existing `JWT_SECRET` or keep the existing
`dist/.jwt-secret`. In CI, the shared publisher verifies the deployed secret
and preserves it when no `JWT_SECRET` is supplied. A first CI release must
provide the secret. Never commit a secret.

## 3. Check it locally

Under the wrangler mecha pins, with local secrets, behind a TLS door:
browsers open six HTTP/1.1 connections to an origin, and each tab holds one
shape request open per table it syncs, so over plain `http` a screen's reads
queue behind them. Cloudflare serves HTTP/2.

```sh
W="$(mise -C libraries/mecha/packages/pglite-workerd where npm:wrangler)/node_modules/.bin/wrangler"
$W dev --config apps/golaberto/dist/cloudflare/wrangler.jsonc \
  --config apps/golaberto/dist/cloudflare/renderer.jsonc --port 8798 \
  --var JWT_SECRET:local --var IMPORT_TOKEN:local --persist-to <work>/state
# another shell: a TLS door with HTTP/2 (caddy is GolAberto's pin)
"$(mise -C apps/golaberto where github:caddyserver/caddy)/caddy" run --adapter caddyfile --config <work>/Caddyfile
```

The door's certificate is the locally trusted mkcert pair GolAberto's own
launch writes to `apps/golaberto/.certs/`, so a browser opens it without a
warning; `<work>/Caddyfile`, with that directory's absolute path:

```caddyfile
{
	admin off
	auto_https disable_redirects
}
https://localhost:8443 {
	tls <golaberto>/.certs/localhost.pem <golaberto>/.certs/localhost-key.pem
	reverse_proxy 127.0.0.1:8798
}
```

Load the directory into the object through `/import`, with
[`load.ts`](../../../libraries/mecha/packages/pglite-workerd/load.ts) given
`http://127.0.0.1:8798` and the bearer `local`; it resumes where a run stopped
and ends by hashing every chunk in the object, then marks the directory
complete. On 2026-10-10: 7.1 GB in 79 s, verified in 33 s, and a cold object
answered its first guest in 0.7 s. Then browse `https://localhost:8443`.

## 4. Publish

```sh
cd apps/golaberto
./saytw release@cloudflare --from=<work>/pgdata
```

The generated release builds the archive and calls the app publisher, which
restores the existing Durable Object migration history and applies both
deployment policies. To publish an already built snapshot instead, run:

```sh
mise exec -- deno run -A --config ../../plugins/pronto/bundle/deno.json \
  tools/publish-cloudflare.ts dist/cloudflare
```

The app publisher applies both deployment policies to the fresh snapshot build,
then invokes [`publish-edge.ts`](../../../plugins/pronto/bundle/publish-edge.ts):
`wrangler deploy` under the pinned wrangler (a `wrangler login` first), then
`JWT_SECRET` once, a new `IMPORT_TOKEN`, and the load into the deployed
object. A release after the first loads nothing: the object's directory is
complete, and it is live data from then on. Rebuild with the snapshot command
before each publish; the composition rejects an already transformed artifact
or changed generator output. To inspect the composition locally, add
`--prepare-only` and rebuild again before publishing.

`release@cloudflare` uses the same app publisher for subsequent releases.
The app publisher and release rule refuse a reset of the archive. On 2026-10-10
the first publish loaded 7.1 GB in 695 s (10.2 MiB/s from the releasing machine) and verified it
in the object in 70 s; a guest's first request reached an object the platform
had evicted in about 2 s, a warm one in 0.25 s, with no memory or CPU kill.

## 5. Check it

The public hostname is `golaberto.bonisoft3.com`, declared in
`code.meta.domain` so generated releases retain the Worker's custom domain.
Enable Early Hints in the `bonisoft3.com` zone under Speed → Settings → Content
Optimization. The [[../../../plugins/pronto/docs/release-targets#cloudflare|edge target]]
already emits the route's content-addressed preload headers. Check a repeated
HTML request over HTTP/2 for an interim `103` before the final `200`; headers on
the final response alone do not prove Early Hints is active. Cloudflare may omit
103 if the final headers arrive first.

```sh
cd apps/golaberto
mise exec -- deno run -A tools/edge_check.ts https://golaberto.bonisoft3.com --idle 300
```

[`tools/edge_check.ts`](../tools/edge_check.ts) reads what the screens read, as
a guest, derived tables, campaign points and player pages included, each twice
(the second from the Worker's cache), after waiting for the platform to evict
the object, and fails on any empty or failed read. An empty recent feed is
accepted only when the played games also fall outside its 14-day, 3-hour window;
historical played games must still return rows.

## What it does not do

- **Nothing recomputes.** A write recounts no standing, chance or odds; the
  derived tables are the trial's.
- **Guests only**, no passkeys, and no blobs: logos are the archive's own URLs.
