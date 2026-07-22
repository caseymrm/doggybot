# 🐶 doggybot

**Fetch your Google Takeout out of Google Drive and into Cloudflare R2 — automatically, serverless, and with zero egress fees.**

A doggy bag is the takeout you carry home. `doggybot` is the little bot that
carries your *Google* Takeout home: point it at a Google Drive folder, and on a
schedule it streams every new export into an R2 bucket and clears it out of
Drive — so your scheduled Takeout backups stop filling up your Drive, and land
somewhere durable and cheap instead.

> **Status: under construction.** The design is complete and implementation is
> in progress. Stars and patience welcome; deploy instructions are coming.

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
3. When the object is safely in R2, it **trashes** the file in Drive (recoverable
   for ~30 days), freeing your quota.

Because the Worker writes to R2 through the R2 binding — **inside the same
Cloudflare account** — the transfer is internal: **no per-gigabyte egress
charge**, on either leg. Drive→Worker is free ingress; Worker→R2 is free
internal. You bring your own Google OAuth client and your own R2 bucket, so
**your tokens and your data never touch anyone else's servers** — `doggybot` is
code you run, not a service someone else operates.

## What you'll need (when it ships)

- A Cloudflare account (the free plan is enough for a personal backup; R2 storage
  past the free 10 GB bills at ~$0.015/GB-month, still with zero egress).
- An R2 bucket.
- A Google Cloud OAuth client (Desktop type) with the Drive scope, for your own
  Google account.

## Zero-egress, not free

To be honest up front: `doggybot` promises **zero egress**, not zero cost. R2
storage past the free tier bills for what you keep (a one-time bootstrap of a
large photo library is real storage; incremental monthly exports are small).
The win is that *moving* the data — the thing that racks up bills on other
setups — costs nothing.

## License

[MIT](./LICENSE) © Casey Muller
