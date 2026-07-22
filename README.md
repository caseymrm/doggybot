# 🐶 doggybot

**Fetch your Google Takeout out of Google Drive and into Cloudflare R2 — automatically, serverless, and with zero egress fees.**

A doggy bag is the takeout you carry home. `doggybot` is the little bot that
carries your *Google* Takeout home: point it at a Google Drive folder, and on a
schedule it streams every new export into an R2 bucket and clears it out of
Drive — so your scheduled Takeout backups stop filling up your Drive, and land
somewhere durable and cheap instead.

## Why

If you set up a **scheduled Google Takeout** (Settings → every 1–2 months) with
delivery to Drive, Google drops big multi-gigabyte zips into your Drive every
cycle — and they pile up against your storage quota until you manually download
and delete them. The existing options each miss something:

- **Downloading by hand** through a browser is slow and easy to get wrong.
- [`google-takeout-sucks`](https://github.com/Fallenstedt/google-takeout-sucks)
  and similar scripts download to **local disk** — you need a machine with room
  for the whole export.
- **rclone** works, but needs an always-on box and pays **egress** on every
  byte it moves.

`doggybot` is the piece that was missing: **serverless and zero-egress.**

## How it works

`doggybot` is a single [Cloudflare Worker](https://workers.cloudflare.com/) that
you deploy into **your own** Cloudflare account:

1. A **cron trigger** lists your Drive for new Takeout archives (with a settle
   guard, so it never grabs an export that's still uploading).
2. For each new file it starts a **[Cloudflare Workflow](https://developers.cloudflare.com/workflows/)** —
   durable, resumable execution — that streams the file from Drive into R2 with
   a **multipart upload**, one ranged chunk at a time. Nothing is ever buffered
   whole; a crash resumes mid-file instead of restarting it.
3. When the object is safely in R2 (verified byte-for-byte), it **trashes** the
   file in Drive (recoverable for ~30 days), freeing your quota.

Because the Worker writes to R2 through the R2 binding — **inside the same
Cloudflare account** — the transfer is internal: **no per-gigabyte egress
charge**, on either leg. Drive→Worker is free ingress; Worker→R2 is free
internal. You bring your own Google OAuth client and your own R2 bucket, so
**your tokens and your data never touch anyone else's servers** — `doggybot` is
code you run, not a service someone else operates.

## What you'll need

- A **Cloudflare account** (the free plan is enough for a personal backup; R2
  storage past the free 10 GB bills at ~$0.015/GB-month, still with zero egress).
  Workflows are included on the Workers free plan.
- An **R2 bucket** (you create it; `doggybot` writes to it).
- A **Google Cloud OAuth client (Desktop type)** with the Drive scope, for your
  own Google account.
- [**Bun**](https://bun.sh) (or npm) and Cloudflare's `wrangler` CLI, locally.

---

## Setup & deploy

### 1. Clone and install

```sh
git clone https://github.com/caseymrm/doggybot
cd doggybot
bun install
```

### 2. Create the R2 bucket

```sh
bunx wrangler r2 bucket create doggybot-takeout
```

Use any name you like; if you change it, update `bucket_name` under
`r2_buckets` in `wrangler.jsonc` to match.

### 3. Create a Google OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project.
2. **APIs & Services → Enable APIs → enable the Google Drive API.**
3. **APIs & Services → OAuth consent screen** — configure it (User type
   *External* is fine for a personal account). While it is in *Testing*, add
   your own Google account under **Test users**. (Test-mode refresh tokens
   expire after 7 days — publish the app to *Production* for a token that lasts.
   You don't need Google verification for a personal, unlisted app.)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type: Desktop app.** Note the **Client ID** and **Client secret**.

### 4. Get a refresh token

`doggybot` runs unattended, so it needs a long-lived **refresh token**. A small
zero-dependency helper runs the standard Desktop loopback flow on your machine
and prints one — the token is never written to disk:

```sh
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=your-secret \
bun run get-refresh-token
```

It opens your browser, you approve access, and it prints the refresh token.

### 5. Configure and store secrets

Edit `wrangler.jsonc`:

- set `vars.GOOGLE_CLIENT_ID` to your client id (not sensitive — safe to commit
  in your own fork);
- optionally set `vars.DRIVE_QUERY` to restrict to one folder
  (`"'YOUR_FOLDER_ID' in parents and trashed = false"`), tune `R2_KEY_PREFIX`,
  or adjust `SETTLE_AGE_SECONDS`.

Then store the two secrets (these go into Cloudflare, never the repo):

```sh
bunx wrangler secret put GOOGLE_CLIENT_SECRET      # paste the client secret
bunx wrangler secret put GOOGLE_REFRESH_TOKEN      # paste the token from step 4
```

### 6. Deploy

```sh
bun run deploy
```

That's it. On the next cron tick (or immediately, if you enable the scan
endpoint below), `doggybot` starts moving settled Takeout zips into R2.

---

## How the cron and settle guard work

The Worker's cron (`23 */6 * * *` — at :23 every 6 hours, editable under
`triggers.crons` in `wrangler.jsonc`) lists your Drive for matching files and,
for each **new, settled** one, spawns a per-file Workflow.

- **Idempotency.** Each Workflow instance's id **is the Drive file id**.
  Cloudflare rejects a second instance with the same id, so a file already
  in-flight is never started twice — no locks, no state to keep. If a previous
  run uploaded a file to R2 but crashed before trashing it, the next discovery
  pass notices the object is already present at the right size, trashes the
  Drive original, and skips the re-upload.
- **The settle guard.** Google delivers a large export as many zips, file by
  file, with no "done" manifest. `doggybot` groups zips by their export
  timestamp and waits until a batch's newest file has been untouched for
  `SETTLE_AGE_SECONDS` (default one hour) before transferring any of it — so it
  never grabs an export that's still being written.
- **Verify before trash.** Every transfer confirms the staged R2 object exists
  and is exactly the expected size before the Drive original is trashed. Trash
  is only ~30-day reversible, so nothing is deleted on an unverified copy.

### Forcing a pass now (optional)

To trigger discovery on demand (handy for testing) instead of waiting for the
cron, set a control token and POST to `/scan`:

```sh
bunx wrangler secret put CONTROL_TOKEN                 # any random string
curl -X POST https://doggybot.<your-subdomain>.workers.dev/scan \
  -H "Authorization: Bearer <that token>"
```

It returns a JSON summary of the pass. Without `CONTROL_TOKEN` set, `/scan` is
disabled (404). `GET /` is a public health check.

## Monitoring

- **Live logs:** `bunx wrangler tail` streams the Worker. Discovery logs a
  one-line summary each pass (`created`, `skippedSettling`, `skippedInFlight`,
  `finishedAlreadyStaged`, `errors`); each completed file logs
  `staged … → r2:… ; trashed from Drive`.
- **Workflow instances:** the Cloudflare dashboard (Workers & Pages → your
  Worker → Workflows) shows every per-file instance and its step timeline; a
  terminal failure lands an instance in `errored` with the failing step.
  `bunx wrangler workflows instances list doggybot-takeout-transfer` does the
  same from the CLI.
- **Observability** is enabled in `wrangler.jsonc`, so logs are queryable in the
  dashboard without extra setup.

## Cost

`doggybot` promises **zero egress**, not zero cost — to be honest up front:

- **Moving** the data (Drive→Worker→R2) costs nothing: Drive ingress is free,
  and Worker→R2 is a free internal write. This is the thing that racks up bills
  on egress-charging setups, and here it is $0.
- **Storing** it is what you pay for: R2 is free up to 10 GB, then ~$0.015/GB-
  month, with no egress fees when you later read it back. A one-time bootstrap
  of a large photo library is real storage; incremental monthly exports are
  small.
- **Compute** for a personal backup fits comfortably in the Workers free plan
  (a handful of cron ticks and a few Workflow instances per export cycle).

## Reading the staged data (downstream consumers)

Once a file is transferred, it lives in **your** R2 bucket under:

```
<R2_KEY_PREFIX><batchKey>/<originalName>
# e.g.  takeout/takeout-20260721t100000z/takeout-20260721T100000Z-001.zip
```

- `R2_KEY_PREFIX` is the `takeout/` prefix you set in `wrangler.jsonc`.
- `batchKey` is the export's timestamp (`takeout-YYYYMMDDTHHMMSSZ`), so every zip
  of one export shares a folder and same-named zips from different exports never
  collide.
- The original Drive `md5Checksum`, when Google provides one, is stamped on each
  object as the `driveMd5` custom metadata field for downstream verification.

Because it's your own bucket, read it with whatever you already use — the
`wrangler r2 object get` CLI, `rclone` against an R2 S3 endpoint, the S3 API, or
another Worker with an R2 binding (also zero-egress). A batch is fully present
once every zip of that timestamp shows up under its folder.

> **Design note.** `doggybot` deliberately stops at "the bytes are in your
> bucket." The private project this engine was extracted from adds a D1-backed
> ledger and a presigned-URL handoff API so an ingest pipeline can pull whole
> settled batches; that seam depends on a database and R2 S3 credentials that a
> standalone backup tool shouldn't need. Keeping `doggybot` to the transfer
> itself means no extra moving parts — you own the bucket, so you read it
> directly. If you need the batch-ledger seam, it's a straightforward addition
> on top of the `onFileComplete` hook in `src/index.ts`.

## Development

```sh
bun run typecheck   # tsc, no emit
bun run test        # vitest — the engine's unit tests
bun run dev         # local wrangler dev
```

The transfer engine lives in `src/transfer/` (Drive client, OAuth, the durable
Workflow, discovery, batching) and is deployment-agnostic; `src/index.ts` is the
thin wiring that binds it to your Google credentials and R2 bucket.

## License

[MIT](./LICENSE) © Casey Muller
