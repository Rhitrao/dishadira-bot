# Disha Dira v1 — tickets
One Claude Code session per ticket, on Sonnet, in order. Check the Usage page before and after each session.
Stop any session that passes 1.5x its cap and ask it to write its state into STATUS.md.

| # | Ticket | Delivers | Done when | Cap |
|---|---|---|---|---|
| 01 | Foundation | Repo layout, Hono Worker, wrangler.toml with D1 binding, config module, CI (typecheck, vitest, gitleaks, wrangler deploy --dry-run), NOTICE file, health route | CI green on a PR with no secrets | $8 |
| 02 | Data + slots | Migrations for every contract table; slot generator (Mon-Fri 2-7pm, call 15 min, session 60 min, 5/day); guarded hold that always gives exactly one winner; expiry by timestamp | Concurrency, expiry and "one active hold per person" tests pass | $12 |
| 03 | WhatsApp bot | Webhook verify + signature check + event dedupe; greeting, language, menu, FAQ list, free text -> attention; outbound send claim; 24h window rule; template registry | Replayed events create no duplicates; nothing sent outside 24h without an approved template; works on Meta test number | $20 |
| 04 | ₹99 booking | Call-slot list -> hold -> PaymentProvider + Cashfree link -> webhook + status poll -> PAID -> call_booked message; duplicate auto-refund; blocklist check | Wrong amount, duplicate, late and out-of-order events all handled; sandbox end to end | $20 |
| 05 | Amma's page | /amma behind Access + JWT; today/tomorrow list; tap-to-call; outcome buttons with confirm + 10-min undo | Logged-out and wrong-user requests blocked; undo works; page readable at 360px | $15 |
| 06 | Outcomes + ₹700 | Apply outcomes after undo; session_offer -> session slot hold -> ₹700 link -> CONFIRMED; refunds with caps and unique per payment; rude -> block + approval queue; missed -> one reschedule | A double tap or webhook retry never refunds twice; late payment never steals a slot | $20 |
| 07 | Rohit's console | /admin queue with reply box, blocks, approvals, switches; 9pm digest; health alerts | Every action audited; switches stop bookings and sends | $12 |
| 08 | Reminders + go-live | Day-before reminder cron; release-test pass; manual deploy workflow; test -> live switch to a fresh D1; owner checklist | Owner runs one real ₹99 end to end | $10 |
| | **Subtotal** | | | **$117** |
| | Fix-up reserve | | | $40 |

---

## Ticket 01 — Foundation (cap $8)

Read CONTRACT.md and STATUS.md first. Build only this ticket.

Deliver:
1. `package.json` (pinned: hono, zod, jose; dev: typescript, vitest, wrangler, @cloudflare/workers-types), lockfile.
2. `wrangler.toml`: Worker `dishadira-bot`, D1 binding `DB` (placeholder id), cron `30 15 * * *` (9pm IST digest, unused yet), vars for the runtime flags at safe defaults. No secrets.
3. `src/index.ts`: Hono app with `GET /health` -> `{ ok: true, version }`. Route stubs returning 501: `/wa/webhook`, `/pay/cashfree/webhook`, `/amma`, `/admin`.
4. `src/config.ts`: prices (paise), hours, slot lengths, daily caps, hold minutes, undo minutes, languages, and FAQ ids. Typed and exported. No Disha Dira values anywhere else.
5. `src/env.ts`: typed bindings and the list of secrets the Worker will need (names only): WA_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_PHONE_ID, CASHFREE_APP_ID, CASHFREE_SECRET, CASHFREE_WEBHOOK_SECRET, ACCESS_AUD, ACCESS_TEAM, DIGEST_TO.
6. `.github/workflows/ci.yml`: on PR and push: install, typecheck, vitest, gitleaks, `wrangler deploy --dry-run`.
7. Tests: health route returns ok; config values are positive and consistent (session slots per day x 60 <= 300 minutes).
8. `NOTICE` (empty section for third-party code), `README.md` (one paragraph, how to run tests in CI), `STATUS.md` updated.

Do not: create real Cloudflare resources, add secrets, add other libraries, or start ticket 02.
Report: files changed, CI result link, open questions.
