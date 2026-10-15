# KiloWattX — KYC

Identity verification for Investors, Land Owners and Commercial Users, built
from the KiloWattX KYC Guide (8 Oct 2026) against the Production Tech Stack
(7 Oct 2026).

**Scope: KYC and nothing else.** It establishes who somebody is, whether a
business is real, whether the person signing may bind it, and whether a plot
of land is theirs to lease. It does not move money, hold a bank account or
run a payout, and no cloud provider is named anywhere in it — the object
store, the virus scanner, the OCR service and the key management service are
all interfaces with a development stand-in behind them, each of which refuses
to start in production.

## What is real, and what is not

Real: the architecture, the database, the decision logic, the webhook security,
the guards, the offline validators, the screens.

Not real: **no Aadhaar or PAN is actually verified.** Every legal
route to Aadhaar needs an approval nobody has yet — a DigiLocker requester
registration from NeGD, an OVSE registration with UIDAI, or MeitY sign-off for
OTP eKYC — and a signed vendor contract behind any of them. So the vendor layer
sits behind an adapter interface, currently backed by `FakeKycProvider`, which
simulates vendor responses faithfully enough that the production code path is
the one being exercised. When credentials arrive, `KYC_PROVIDER=hyperverge` is
the change.

`KYC_PROVIDER=fake` is refused outright in production.

## Running it

```bash
pnpm install
pnpm db:up          # Postgres on 5433 (dev) and 5434 (test, tmpfs)
pnpm test:setup     # one test database per package, migrated
pnpm db:migrate     # DATABASE_URL=...5433/kilowattx

pnpm dev:api        # :4000
pnpm dev:web        # :3000
pnpm dev:worker     # drains the outbox, no port
```

### Environment

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

`.env` is gitignored; `.env.example` is not and must never hold a real key.
Both the API and the worker read it at startup through Node's own
`process.loadEnvFile` — no dependency, and nothing to install.

A variable already set in the real environment **wins** over the same name in
the file. That ordering was measured, not assumed, and it is the one you want:
a stray `.env` left in a production image cannot override what the platform
injected. A missing file is not an error either, because production has none.

The process still refuses to start on a missing or bad value rather than
discover it on the first request.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres, as the `kilowattx_app` role (never the owner) |
| `KYC_PROVIDER` | `fake`, `sandbox` (primary) or `cashfree` (failover) |
| `KYC_VENDOR_CLIENT_ID` | The gateway's API key. Needed once a real provider is named |
| `KYC_VENDOR_CLIENT_SECRET` | The gateway's API secret |
| `KYC_WEBHOOK_SECRET` | Verifies the KYC vendor's callbacks |
| `KYC_BLIND_INDEX_KEY` | 32 bytes, base64. Keys the duplicate-PAN blind index |
| `FILE_SIGNING_SECRET` | Signs document URLs. Must differ from the webhook secret |
| `FILE_BASE_URL` | Optional. Where signed URLs point; the bucket's host in production |

The last three are **not issued by anybody** — generate them yourself. Naming a
real provider without its two credentials fails at boot, with a message saying
which one is missing: the alternative is an adapter that constructs, fails every
call at the gateway, and presents as "verification is broken" rather than
"nobody set the key".

Generating the three local secrets:

```bash
node -e "console.log('whsec_' + require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('filesign_' + require('crypto').randomBytes(24).toString('hex'))"
```

The separation is deliberate rather than tidy. One key that both verifies
vendor callbacks and grants access to land deeds means a leak of either is a
leak of both, so `loadConfig` refuses a `FILE_SIGNING_SECRET` equal to the
webhook secret.

## Walking the land-document flow

```bash
pnpm dev:api              # in one shell, with the environment above
pnpm walkthrough:land     # in another
```

It drives the whole thing over HTTP: upload, virus scan, OCR, Legal's
approval, a co-owner declaration, a duplicate khasra claim, and
`can('ESIGN_LEASE')` at every step. It makes no assertions — it prints what
the system does, which is the point.

Run it twice without clearing the database. That is how the first-claimant
rule was found: the earlier claimant only *appeared* protected on a first run,
because nothing had re-decided their parcel yet.

## The worker

Three jobs on pg-boss schedules, in UTC:

| Job | Cron | What |
|---|---|---|
| `outbox.drain` | `* * * * *` | drains the outbox, looping until a batch comes back empty |
| `kyc.reconcile` | `*/5 * * * *` | finds sessions a webhook never came back for, and heals them |
| `webhooks.purge` | `17 * * * *` | drops expired replay-protection keys |

```bash
pnpm pgboss:setup      # once per database, as the owner
pnpm dev:worker
```

The setup step is separate because pg-boss installs ~21KB of its own DDL, and
the application role deliberately has no DDL rights — migration 0002 exists to
take them away. So the owner installs the schema and creates the queues, and
the worker connects with `migrate: false`. An un-set-up database fails loudly
at start instead of quietly installing itself.

These were three `setInterval` loops, whose own comment named the problem: *if
the process dies, nothing runs, and nothing tells you.* Those are two faults
and they needed two answers.

**Nothing runs** — the schedule lives in `pgboss.schedule`, so a restart
resumes it, and several worker processes share one schedule rather than each
running their own timer. Verified by running two: the once-a-minute job fired
once a minute, not twice.

**Nothing tells you** — `job_heartbeats`. Every pass writes down that it
finished, because the failure here is an *absence*: no error, no log line, just
a job that stopped happening, and you cannot query for a thing that did not
occur. `staleJobs()` is driven by the list of jobs we expect, not by the rows
that exist, so a job that has never run once is reported rather than read as
silence-meaning-health.

`last_run_at` and `last_success_at` are kept apart on purpose. A job failing
every minute is alive but achieving nothing; a job that has stopped is a
different incident. One timestamp cannot tell them apart.

The transactional outbox is untouched. Its rows are written in the same
transaction as the business change, which is the whole reason "data saved but
notification missing" cannot happen. pg-boss schedules the pass; the outbox
still decides what the pass does.

## Probes

| Route | Question | On failure |
|---|---|---|
| `GET /healthz` | is this process alive? | restart it |
| `GET /readyz` | should it get traffic? | take it out of rotation |

Two routes, because the right response to each failing is different and
opposite. One endpoint that checks the database, wired to a liveness probe,
means a database blip fails every container at once, the orchestrator restarts
all of them, and the restarts do nothing for a database that is down — while
also killing the containers still serving the requests that never touch it.
The outage you had becomes a crash loop. So `/healthz` checks nothing.

`/readyz` checks the database and only the database. The KYC vendor is
deliberately not checked: most endpoints never call it, and pulling every
container from rotation because a third party is down is an outage inflicted on
ourselves on top of theirs. Its `select 1` is bounded at two seconds, because a
probe that hangs tells the orchestrator nothing until its own timeout fires
while holding a connection the real traffic needs.

Unversioned, since a probe is infrastructure configuration rather than an API
client and should not need reconfiguring the day `/v2` appears. Both are
unauthenticated, so neither returns a version, a hostname, a database error or
which KYC provider is configured — `fake` would tell an anonymous caller the
verification behind the deployment is simulated. The reason a check failed goes
to the logs.

Writing these turned up that nothing closed the connection pool on shutdown:
`enableShutdownHooks()` was on, but the handle is a plain `useValue` provider,
so no hook existed. Every e2e file was leaving ten connections open for the run,
and a SIGTERM ended with sockets dropped rather than closed — leaving Postgres
backends holding the abandoned transaction's locks while the replacement
container started up competing with them. `DatabaseLifecycle` closes it.

## Signing a PPA

Three facts, and they are genuinely three:

1. the business is verified (`organisations.kyb_status`)
2. the person signing is verified (their own KYC)
3. somebody has approved **that person's authority to bind the business**
   (`org_members.authority_approved_at`)

The third was enforced by nothing. The column existed and the KYB view
displayed it, but no guard read it — so a finance clerk with perfect personal
KYC and no board resolution would have been allowed to commit their employer to
a 25-year agreement. Found while wiring the first two, which had been hardcoded
to `NOT_STARTED`.

`GET /v1/kyc/can/ESIGN_PPA` takes `?orgId=`. A PPA binds one organisation, so
somebody who signs for two companies is asked which — the endpoint answers
`ORGANISATION_REQUIRED` and lists them, rather than picking whichever happens
to be verified.

## Tunable thresholds

The face-match bar, the name-match bar, the OCR confidence floor and the
minimum age live in the `settings` table so Ops can retune them without a
release:

```sql
INSERT INTO settings (key, value) VALUES ('kyc.threshold.faceMatch', '0.82')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

Read on every decision, never cached — a retune that only takes effect on the
next deploy is not a retune. One loader in `packages/kyc-pipeline`, used by the
API on a webhook and by the worker when reconciliation heals a case, because
two copies meant the same case got a different answer depending on which path
reached it.

Values that would disable a check are refused and logged at error level, and
the default stays in force: a `faceMatch` of `0` passes every face while the
audit trail still records the check as having run, and `75` (meaning 75%) is a
likelier typo than somebody meaning 7500%. `minimumAge` may be raised above 18
but never lowered — that one is the law, not a preference.

## Pages

| Route | Who | What |
|---|---|---|
| `/` | customer | Pick a dev identity, start a verification |
| `/status` | customer | Where their KYC stands |
| `/commercial` | customer | The business (KYB) flow |
| `/documents` | customer | Upload land records; their plots and why each is held |
| `/admin` | staff | The personal / KYB review queue |
| `/admin/land` | Legal | Two lists: is the scan legible, and may this land be leased |

`/admin/land` keeps those two questions apart deliberately. A flawless
Jamabandi can sit above a plot that cannot be leased — because the record names
four siblings, or because a neighbour registered the same khasra number first.
One combined list would invite a reviewer to answer the first question and
believe they had answered the second.

Compliance can read the land queue and open the documents (every view is
logged) but is shown "not yours to record" instead of the decision buttons.
The API refuses either way; the UI not offering a button it knows will fail is
the difference between a boundary and a bug.

## Layout

```
packages/validation   Zod schemas + offline validators (Verhoeff, GSTIN mod-36,
                      PAN holder type, CIN, LLPIN, name matching)
packages/core         decideKyc(), decideLand(), the status state machine,
                      can() guards, the duplicate-PAN blind index.
                      No framework, no I/O.
packages/db           Drizzle schema, migrations, RLS, repositories
packages/integrations KycProvider / KybProvider / DocumentScanner /
                      DocumentExtractor / FileStore, webhook verification,
                      replay protection, and a faithful fake for each
packages/kyc-pipeline  vendor result -> persisted decision; KYB, documents
                      and land parcels. Used by the API and the worker.
apps/api              NestJS: consents, sessions, status, webhooks, documents,
                      land parcels, the signed-URL object store
apps/web              Next.js: the customer flow, the review queues
```

## Things worth knowing before changing anything

**There is nowhere to put an Aadhaar number.** No column can hold one. Only
`aadhaar_last4` and a vendor reference token are kept.

**`decideKyc()` is the only thing that decides a status.** It is pure — `now`
and the thresholds are injected — so any decision can be re-derived from its
stored inputs. The browser never decides; the vendor never decides.

**Query RLS tables through `withContext`.** A query that forgets its context is
not rejected with an error, it quietly returns nothing, and the caller then
draws a wrong conclusion. Two bugs during development were exactly this.

**The app must not connect as a superuser.** Superusers bypass RLS
unconditionally; `FORCE ROW LEVEL SECURITY` only covers the table owner.
Migration 0002 creates `kilowattx_app` with `NOSUPERUSER NOBYPASSRLS`, and
`assert_app_role_cannot_bypass_rls()` fails loudly if that ever changes.

**Verify webhooks against the raw bytes.** The signature covers exactly what
was sent, so `JSON.stringify(req.body)` passes locally and fails against the
real vendor. `express.json({ verify })` keeps the buffer.

**`kyc_checks`, `audit_log` and `consent_records` are append-only**, enforced
by triggers. Fix a mistake by adding a row.

**Hand-written SQL needs explicit timestamp casts.** `${date}` fails on a
prepared statement; use `${date.toISOString()}::timestamptz`. Drizzle's query
builder is unaffected.

**Nobody decides their own case.** Staff are customers too. `applyReviewDecision`
refuses a self-review inside the transaction, not in a UI that hides a button.

**Review permissions are per case type, not per role alone.** Support and
compliance clear personal cases; only Legal decides a business check or land
papers. The case type is derived from the record — level `KYB`, or registry
documents attached — so attaching a sale deed moves a case to Legal's queue.

**An event describes what happened, not what is true now.** Notification
handlers take the status from the event payload, never by re-reading the
record. The worker can run minutes behind, and a reviewer may have moved the
case on — reading it live produces a message whose template and data disagree.

**Notifications are recorded, not sent.** WhatsApp needs a BSP and approved
templates, SMS needs MSG91 with DLT templates, push needs FCM and APNs keys.
`notification_deliveries` rows are real, so "did you tell me?" has an answer;
the transport is one class swap.

## Still open

Nothing in the code. What is left needs somebody else: the Aadhaar route
(DigiLocker needs NeGD approval, OVSE needs UIDAI registration, OTP eKYC needs
MeitY), a signed KYC vendor contract and a KYB one behind it, an object store
with a virus scanner and an OCR service, a key for the PAN encryption, who
owns manual review, the re-KYC policy, NRI investors, and retention sign-off.
Each swaps behind an adapter that already exists or a `settings` row, and every
fake refuses to run in production.

`can()` now reads every gate from the database. The last two —
`kybStatus` and `signatoryKycStatus` — were hardcoded to `NOT_STARTED`, which
meant `ESIGN_PPA` refused everybody: correct by accident, and permanently.
Wiring them up turned up a third gate that nothing enforced at all. See
**Signing a PPA** below.

One operational gap worth naming: the heartbeat is checked by the worker
itself, inside the reconcile pass. That catches the common failure — the
process is up and one job has stopped while the others carry on — and cannot
catch the one where the process is gone, because a dead process reports
nothing. An external check that reads `job_heartbeats` and alerts on
`staleJobs()` closes it, and belongs with whatever already watches the API —
the same place `/readyz` is polled from.

## Placeholders that are deliberately loud

- `SessionGuard` trusts request headers and **throws in production**. Better
  Auth replaces it; deleting the file is the whole migration.
- PAN encryption writes `UNENCRYPTED_PLACEHOLDER_DO_NOT_SHIP:` rather than
  something that looks like working envelope encryption. The blind index
  beside it is real.
- `LocalDiskBucket` keeps uploads on the container's own disk and **refuses to
  construct in production**. A document that vanishes on the next deploy while
  the record still says VERIFIED is worse than one never accepted.
- The document scanner and the OCR extractor are fakes that also **refuse in
  production**. The scanner's refusal is the sharpest of the set: one that
  finds nothing is indistinguishable from no scanner at all, right up until it
  matters.
- Land parcel geometry is GeoJSON text, not PostGIS. Nothing on the KYC path
  reads a geometry.
