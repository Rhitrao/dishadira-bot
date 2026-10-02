# STATUS
Updated: 2026-10-02 (Ticket 08 session)

## Payment provider
Cashfree (KYC submitted by owner: pending). Razorpay: not used.

## Owner setup
- [x] Domain disha-dira.com registered (Hostinger), moving DNS to Cloudflare
- [ ] Website v1.1 uploaded to Cloudflare Pages; custom domain attached
- [ ] Cashfree KYC approved
- [ ] Meta business portfolio + developer app + test number
- [ ] Airtel SIM bought; registered on Cloud API (not the WhatsApp app)
- [ ] 5 utility templates submitted / approved
- [ ] Amma's sign-off on the decisions list

## Tickets
- [x] 01 Foundation (PR https://github.com/Rhitrao/dishadira-bot/pull/1, CI green)
- [x] 02 Data + slots (PR https://github.com/Rhitrao/dishadira-bot/pull/2, CI green)
- [x] 03 WhatsApp bot (PR https://github.com/Rhitrao/dishadira-bot/pull/3, CI green)
- [x] 04 ₹99 booking (PR https://github.com/Rhitrao/dishadira-bot/pull/4, CI green)
- [x] 05 Amma's page (PR https://github.com/Rhitrao/dishadira-bot/pull/5, CI green)
- [x] 06 Outcomes + ₹700 (PR https://github.com/Rhitrao/dishadira-bot/pull/6, CI green)
- [x] 07 Rohit's console (PR https://github.com/Rhitrao/dishadira-bot/pull/7, CI green)
- [ ] 08 Reminders + go-live (PR: see session notes; tick when Actions are green)

## Credits
Budget $157 (tickets $117 + reserve $40). Hard stop at $190 total. Spent so far: not visible to Claude; Rohit to update from the Usage page.

## Blocked
(none)

## Session notes (Ticket 08)
- Fixes from Ticket 07: (a) migration 0004 adds `payments.paid_paise`; a mismatch (wrong amount, partial, unsupported) stores what was really paid, and the refund engine refunds `COALESCE(paid_paise, amount_paise)`, never the expected price (the 7-day refund total uses the same). (b) refunds gain state `DECLINED` (table rebuilt in 0004); "Keep (no refund)" sets it, keeps the row (so the payment can never get a second refund) and audit_log `ADMIN_KEEP_NO_REFUND` records the Access e-mail as actor and in the detail ("declined by ...").
- Reminders (`src/remind.ts`): cron `0 13 * * *` (18:30 IST). Everyone with a PAID/RESCHEDULED call or a CONFIRMED session tomorrow (IST) gets `copy.reminder` as text inside 24h or the `reminder` template (params: call|session, day, time) outside it. Dedupe key `reminder:<call|session>:<id>:<slot id>` = once per booking (a moved call is a new booking). While SENDS is paused (env or settings) it returns before writing anything, so a later run can still send. Blocked people and unapproved templates are handled by `sendMessage` (nothing sent / attention).
- Deploy: `.github/workflows/deploy.yml` (workflow_dispatch, input environment test|live): typecheck, tests, gitleaks, dry run, `wrangler d1 migrations apply DB --remote --env <env>`, `wrangler deploy --env <env>`. Uses GitHub secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID. `wrangler.toml` has `[env.test]` (`dishadira-bot-test`, PAYMENT_MODE test) and `[env.live]` (`dishadira-bot-live`, PAYMENT_MODE live), each with its own D1 (placeholder ids ...0001 / ...0002), crons, flags all "false", and the EMAIL binding. Bindings are not inherited by wrangler environments, hence repeated. `test/release.test.ts` checks all of this.
- Docs: `docs/GO-LIVE.md` (Rohit's checklist), `docs/TEMPLATES.md` (5 Meta templates, text matches the code's params), `docs/COPY.md` (all copy.ts text, Kannada column empty; generated from copy.ts once, not kept in sync by code).
- Release-test families (contract) and where each is covered:
  - inventory/holds: `test/slots.test.ts` (simultaneous holds, call/session overlap both ways, expiry, one hold per person, replay) and `test/pay.test.ts` (late payment never takes another's slot).
  - money/refunds: `test/outcomes.test.ts` "NOT_FIT refunds", "refund safety" (same refund_id, lost answer, REFUNDED never backwards), `test/pay.test.ts` (wrong amount, duplicate refund), `test/admin.test.ts` "refunds" (approve once, DECLINED, mismatch refunds the amount paid).
  - replay/recovery: `test/pay.test.ts` (webhook replay, webhook vs cron race, reconciliation), `test/outcomes.test.ts` (outcome applied once), `test/whatsapp.test.ts` (replayed message sends nothing new), `test/remind.test.ts` (once per booking).
  - access: `test/admin.test.ts` and `test/amma.test.ts` "access" (no JWT, wrong audience/issuer/key/e-mail, fail closed, Origin + CSRF), `test/health.test.ts`.
  - window/templates: `test/whatsapp.test.ts` "sendMessage" (free text outside 24h refused, unapproved template, payload limits), `test/outcomes.test.ts` (session_offer outside window), `test/remind.test.ts` (text vs template).
  - switches/blocks: `test/admin.test.ts` "switches" (env master, SENDS, AMMA_AWAY), `test/pay.test.ts` and `test/whatsapp.test.ts` (blocked contact gets no hold/link/message), `test/outcomes.test.ts` RUDE, `test/remind.test.ts` (SENDS paused).
  - Nothing was missing; added `test/release.test.ts` (deploy config) as an extra.
- Checks (local): typecheck, vitest all passed, `wrangler deploy --dry-run` for the top level, `--env test` and `--env live` passed. GitHub Actions: see PR.
- Credits: not visible to Claude; check the Usage page.
- Open questions: (1) `session_offer` outside 24h: the template has no button, and the code does not read template quick-reply taps, so the customer replies in text, which becomes a "needs attention" item for Rohit to answer inside the new window. Do you want a quick-reply button wired in a later ticket? (2) Access for /amma and /admin needs a custom domain (docs assume `bot.disha-dira.com` and `bot-test.disha-dira.com`); `wrangler.toml` has no `routes`, so please confirm a dashboard-added custom domain survives a deploy. (3) Sandbox payments are recognised as test mode only if Cashfree's sandbox link URL contains `payments-test.` (code assumption); step 11 of GO-LIVE.md tests it. (4) `OWNER_APPROVED` is not read by any code yet. (5) Real business number is still the placeholder in `src/config.ts`.
- Next: Rohit follows `docs/GO-LIVE.md`; Kannada copy from `docs/COPY.md`.

## Session notes (Ticket 07)
- /admin (`src/admin.ts`): Access JWT via the /amma checker with `ROHIT_EMAIL` only (Amma's e-mail gets 403), POST-only changes, Origin + per-form CSRF, escaped output, no-store, CSP, no JavaScript. Sections: switches (top), needs attention (newest first, plain-English text, actions that fit the kind), today/tomorrow (Completed / No-show on started CONFIRMED sessions), 7-day scoreboard. Every change writes `audit_log` with the Access e-mail (ADMIN_REPLY / RESOLVE / REFUND / APPROVE_REFUND / KEEP_NO_REFUND / BLOCK / UNBLOCK / SWITCH / SESSION). Result messages come from a fixed list via `?m=code`, never from user input.
- Refunds: one engine. New in `src/pay/refund.ts`: reason `ADMIN` goes through `requestRefund` (immediate, requested_by = Rohit's e-mail); `approveRefund` (PENDING_APPROVAL -> PENDING once, then `settleRefund`); `declineRefund` (deletes the waiting row: "Keep, no refund"; the states have no DECLINED value and I added no migration); `retryFailedRefund` (FAILED -> PENDING, same `refund-<id>`, provider is looked up first). Refund is offered only if the payment is PAID or UNKNOWN and has no refund row (or a FAILED one).
- Switches (`src/switches.ts`, settings table): `NEW_BOOKINGS="false"` pauses, `SENDS="false"` pauses, `AMMA_AWAY="true"` pauses new bookings and raises `AMMA_AWAY_CALL` / `AMMA_AWAY_SESSION` items for calls/sessions still ahead today and tomorrow (on switch and from the 2-minute cron, once per target ever). Env stays master: effective = env on AND not paused; "resume" only removes a pause and is refused (`envoff`) when the env flag is off. booking.ts, session.ts, outcomes.ts (reschedule) and send.ts now ask `bookingsOpen` / `sendsOn`.
- Cron: `*/2` also records the heartbeat (settings `HEARTBEAT`), raises `AMMA_NO_TAP` (call started over `ammaTapReminderHours` ago, no outcome, last 7 days; once per call), and sends alerts. `30 15 * * *` (9pm IST) sends the digest, then alerts including the heartbeat check; opening /admin also checks the heartbeat.
- Email (`src/mail.ts`): Cloudflare Email Service `send_email` binding `EMAIL` (`[[send_email]]` in wrangler.toml, structured `env.EMAIL.send({to, from, subject, text})`, no library), recipient = secret `DIGEST_TO`, sender `config.mail.from` (`bot@disha-dira.com`, the public site domain). Missing binding or DIGEST_TO: logged and skipped. Alerts: REFUND_FAILED, REFUND_STUCK, PAYMENT_MISMATCH, UNKNOWN_PAYMENT_LINK, OUTCOME_FAILED, HEARTBEAT_STALE (15 min); one email per kind per IST day (a settings row claimed before sending, released if the send fails).
- Checks (local): typecheck, vitest 116/116 (17 new in test/admin.test.ts), wrangler dry-run: all passed. GitHub Actions: passed on PR 7.
- Credits: not visible to Claude; check the Usage page.
- Open questions: (1) Is `disha-dira.com` (or another address) onboarded and verified as a sender in Cloudflare Email Service? The code uses `bot@disha-dira.com`; change `config.mail.from` if not. (2) Refunding a PAYMENT_MISMATCH payment uses the expected amount (₹99 / ₹700), not what was actually paid; check the paid amount in Cashfree first. (3) Replies are deduplicated by item + text, so the identical text sent twice to one item is blocked on purpose. (4) Admin replies are not stored beyond the normal `messages` row; the audit row has no text.
- Next: Ticket 08 (Reminders + go-live), after Rohit merges the Ticket 07 PR.

## Session notes (Ticket 06)
- Cron (`*/2`) now runs three jobs, each safe to repeat: `applyDueOutcomes` (src/outcomes.ts), `retryRefunds` (src/pay/refund.ts), `reconcile` (now also polls SESSION payments).
- Outcomes: claimed with `UPDATE outcomes SET applied_at … WHERE applied_at IS NULL AND undo_until <= now`; effects are idempotent, a thrown error releases the claim and raises attention. SESSION -> CALLED_SESSION + sessions row OFFERED + button "Choose a time" (session_offer template outside 24h). NOT_FIT -> refund (once per person by conversation/wa_id or payer ref, `notFitRefundsPerDay` per IST day, enforced inside the INSERT) + kind message; refused -> attention `NOT_FIT_REFUND_REFUSED`, nothing sent. MISSED -> list of free call slots; pick -> same guarded hold, then intro RESCHEDULED + slot BOOKED + old slot freed in one batch, free of charge; second miss -> intro MISSED (reschedule_count 1) + polite message, no refund. RUDE -> conversation BLOCKED + blocks row, refund row `PENDING_APPROVAL` (payment stays PAID), attention `RUDE_REFUND_APPROVAL`, nothing sent. Rude is applied after the undo window, like the others.
- ₹700 (src/session.ts): `sess_offer_<id>` -> next 5 weekdays, max 10 SESSION slots -> `sess_<id>_<start>` -> hold -> session HELD + payment SESSION 70000 -> link expiring with the hold. Only after intro CALLED_SESSION (or `override_by`) and only for the person it was offered to. `applyStatus` now prices by purpose; paid -> session CONFIRMED + slot BOOKED + `session_confirmed`; a late payment never takes a slot (session EXPIRED, attention `LATE_PAYMENT_NO_SLOT`).
- Refunds: one engine (`requestRefund`). refund_id is always `refund-<payment id>`, plus an `x-idempotency-key` header. Cashfree's create-refund page does not say what a repeated refund_id returns, so a retry first GETs the refund (`/orders/{id}/refunds/{refund_id}`) and only POSTs if it is 404. A transport error leaves it PENDING (retried every ~2 min, lease 60 s); only the provider saying REJECTED/CANCELLED makes it FAILED (-> REFUND_FAILED + attention); not confirmed after 30 min -> attention `REFUND_STUCK`. Refund webhook (`REFUND_STATUS_WEBHOOK`) is handled with the same signature check. Payment moves are conditional on the previous state; a late SUCCESS may repair FAILED, nothing goes backwards from REFUNDED.
- Migration 0003: `payments.payer_ref`, `outcomes.slot_id` (+ unique with intro, so a rescheduled call gets its own outcome), `refunds` rebuilt (states add PENDING_APPROVAL, new `attempt_at`). Amma's page now also lists RESCHEDULED calls and shows "Done: <outcome>" with no buttons once applied.
- Behaviour change in an older test: a refund POST that errors used to become FAILED at once; now it stays PENDING and is retried (see above). The old test checks REJECTED instead.
- Checks (local): typecheck, vitest 99/99, wrangler dry-run: all passed. GitHub Actions: see PR.
- Credits: not visible to Claude; check the Usage page.
- Open questions: (1) `payment_update` template (used for the NOT_FIT notice outside 24h, one parameter "₹99") and `session_offer` (no parameters) need matching wording when Rohit submits them to Meta. (2) The payer UPI handle is not returned by the Payment Links endpoints, so `payer_ref` stays empty unless a later change reads it from the order payments API; the once-per-person rule works on wa_id today. (3) Session confirmation text ("distance session… she calls you at the booked time") is my wording; Amma should check it. (4) If Amma's three-hour no-tap reminder and "Amma away" are Ticket 07/08, nothing here covers them.
- Next: Ticket 07 (Rohit's console: approve rude refunds, resolve attention), after Rohit merges the Ticket 06 PR.

## Session notes (Ticket 05)
- Fix from Ticket 04: one open intro per person. A PAID intro, or a HELD intro whose hold is still live, makes "Book a ₹99 call" reply "Your call is already booked for {day} {time}" and nothing else (`src/booking.ts`, check 1b). Tests in `test/amma.test.ts`.
- Built `src/amma.ts` (mounted at /amma): Worker verifies `Cf-Access-Jwt-Assertion` with jose (JWKS at `https://<ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, audience `ACCESS_AUD`, issuer from team); only `AMMA_EMAIL` / `ROHIT_EMAIL` pass; empty vars fail closed (403). `ACCESS_TEAM` may be the team name or full domain.
- Page: Today / Tomorrow (IST), PAID call intros and CONFIRMED sessions only; first name, service, kind, tel: button. Outcome buttons -> GET confirm screen -> POST Yes -> `outcomes` row (undo_until = now + 10 min, no effects) -> POST undo. A second outcome on the same call is refused (atomic insert). Ticket 06 must apply effects only when `undo_until` has passed and `applied_at` is null.
- Safety: POST-only changes, Origin must equal the Worker's origin (missing = 403), per-form CSRF token = SHA-256 of form scope + the visitor's own Access JWT (no new secret; a stale page after Access re-issues the JWT gives 403 -> reload), escaped output via hono/html, `Cache-Control: no-store`, CSP, no JavaScript.
- Copy: `amma` section in `src/copy.ts` (English final, Kannada KN_TODO). The page uses English for now.
- Env: `AMMA_EMAIL`, `ROHIT_EMAIL` added to `SECRET_NAMES`. They and ACCESS_TEAM / ACCESS_AUD are Cloudflare secrets only (README note); nothing in wrangler.toml.
- Checks (local and GitHub Actions on PR 5): typecheck, vitest 78/78, wrangler dry-run: all passed.
- Credits: not visible to Claude; check the Usage page.
- PR 5 follow-ups (Rohit's review): placeholders removed from wrangler.toml; every outcome and undo is written to `audit_log` (actor = Access email, actions AMMA_OUTCOME / AMMA_UNDO, target `intro:<id>`, detail = outcome value; only successful changes); outcome buttons show only once the call's start time (IST) has passed, and the confirm screen and POST refuse a call that has not started; "How did it go?" line, Report rude separate (red, smaller, gap); header "Today · Mon 5 Oct", Refresh button, "No calls today/tomorrow".
- Open questions: Rohit's e-mail can also see /amma and tap outcomes (for support); it is logged in audit_log. OK?
- Next: Ticket 06 (Outcomes + ₹700), after Rohit merges the Ticket 05 PR.

## Session notes (Ticket 04)
- Fixed Ticket 02 bug: the "one active hold per person" check in `holdSlot` now counts only unexpired HELD rows (BOOKED no longer blocks a later session hold). Test added. Overlap check unchanged.
- Built: `src/pay/provider.ts` (interface), `src/pay/cashfree.ts` (Payment Links; doc pages listed in its header comment), `src/pay/apply.ts` (one apply function for webhook and cron, plus `reconcile`), `src/pay/webhook.ts` (POST /pay/cashfree/webhook), `src/booking.ts` (service -> slot list -> guarded hold/link step), cron `*/2 * * * *` in wrangler.toml, copy in `src/copy.ts`.
- Booking respects the NEW_BOOKINGS switch: while it is not "true", "Book a ₹99 call" still replies "Booking opens soon." (contract: flags default safe).
- **Webhook secret:** Cashfree signs webhooks (base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body) with the payment gateway secret key, i.e. the same value as `CASHFREE_SECRET`. There is no separate webhook secret, so `CASHFREE_WEBHOOK_SECRET` is NOT used by the code and can stay unset.
- Provider ids: payment `provider_payment_id` and `provider_order_id` both store the Cashfree order id (a webhook gives order id + transaction id, the status read gives only order ids; one id keeps both paths consistent). Refunds go to `POST /pg/orders/{order_id}/refunds` with `refund_id = refund-<payment id>`.
- Assumptions to check in the Cashfree sandbox (not confirmable from docs): minimum link expiry (assumed 15 min, `config.cashfree.minLinkExpiryMinutes`; hold is 20), API version `2025-01-01` in config, `GET /pg/links/{id}` returns the same fields as the create response, `GET /pg/links/{id}/orders` returns an array. The webhook doc says "form data format" in one line but shows JSON; the code expects JSON.
- Owner steps (not done here): set the webhook URL in the Cashfree dashboard to `<worker url>/pay/cashfree/webhook` (Payment Link events); set `config.businessNumber` (currently a placeholder); flip `call_booked` approved when Meta approves it (outside the 24h window the confirmation uses that template).
- Known gaps (Ticket 06/07): refund completion webhooks are not handled (refunds stay REFUND_PENDING unless the provider answers SUCCESS at once); a crash between inserting a refunds row and calling the provider leaves it PENDING with no retry; `REFUND_FAILED`/`UNKNOWN` payments only raise attention items (email alerts come in Ticket 07).
- Checks (local): typecheck, vitest 55/55, wrangler dry-run: all passed. GitHub Actions on PR 4: check passed.
- Credits: not visible to Claude; check the Usage page.
- Open questions: the branch was named `t04-booking` as instructed (the session header named another branch); a person who already has a PAID intro can still book another call. Acceptable until Ticket 06?
- Next: Ticket 05 (Amma's page), after Rohit merges the Ticket 04 PR.

## Session notes (Ticket 03)
- Built: /wa/webhook (verify + signed POST + zod + dedupe), menu bot, src/send.ts (single send path, 24h window, template registry), src/copy.ts (English final; Kannada KN_TODO placeholders).
- Migration 0002 rebuilds `messages` (adds SKIPPED/RECEIVED statuses and a `delivery` column).
- All 5 templates are approved:false in config.ts until Meta approves them (owner flips).
- Checks (local and GitHub Actions on PR 3): typecheck, vitest 35/35, wrangler dry-run: all passed.
- Credits: not visible to Claude; check the Usage page.
- Open questions: a greeting recorded as SKIPPED (SENDS off) is not re-sent when SENDS is turned on. Acceptable?
- Next: Ticket 04 (₹99 booking), after Rohit merges PR 3. Kannada copy (KN_TODO) needs a family member.

## Session notes (Ticket 02)
- Built: migrations/0001_init.sql (all contract tables), src/slots.ts (generator, guarded hold, availability list), tests on a real local D1.
- Contract change (owner's instruction): one calendar; calls and sessions never overlap; enforced in the hold write. Added to CONTRACT.md Data section.
- Hold is one conditional INSERT ... ON CONFLICT; expiry by hold_until, no cron; a replay is refused as ALREADY_HOLDING.
- Slot rows exist only once held or booked (the generator is the source of available times). Booking (HELD -> BOOKED) comes in Ticket 04/06.
- Test helper added: miniflare 4.20260730.0 (dev only), pinned. The 5.x alpha bundled with wrangler has an incompatible options API.
  `npm audit` reports 3 high advisories in its dev-only tree (sharp, undici); nothing ships in the Worker.
- Checks (local and GitHub Actions on PR 2): typecheck, vitest 20/20, gitleaks, wrangler dry-run: all passed.
- Credits: not visible to Claude; check the Usage page.
- Open questions: none.
- Next: Ticket 03 (WhatsApp bot), after Rohit merges PR 2.

## Session notes (Ticket 01)
- Checks (local and GitHub Actions on PR 1): typecheck, vitest 10/10, gitleaks (no leaks), wrangler deploy --dry-run: all passed.
- Cashfree KYC left unticked (owner said dashboard live, Payment Links activation unconfirmed).
- Credits: not visible from inside the session; check the Usage page.
- Open questions: none.
- Next: Ticket 02 (Data + slots), after Rohit merges PR 1.
