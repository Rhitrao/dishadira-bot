# STATUS
Updated: 2026-10-02 (Ticket 06 session)

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
- [ ] 06 Outcomes + ₹700
- [ ] 07 Rohit's console
- [ ] 08 Reminders + go-live

## Credits
Budget $157 (tickets $117 + reserve $40). Hard stop at $190 total. Spent so far: not visible to Claude; Rohit to update from the Usage page.

## Blocked
(none)

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
