# STATUS
Updated: 2026-10-02 (Ticket 04 session)

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
- [ ] 04 ₹99 booking
- [ ] 05 Amma's page
- [ ] 06 Outcomes + ₹700
- [ ] 07 Rohit's console
- [ ] 08 Reminders + go-live

## Credits
Budget $157 (tickets $117 + reserve $40). Hard stop at $190 total. Spent so far: not visible to Claude; Rohit to update from the Usage page.

## Blocked
(none)

## Session notes (Ticket 04)
- Fixed Ticket 02 bug: the "one active hold per person" check in `holdSlot` now counts only unexpired HELD rows (BOOKED no longer blocks a later session hold). Test added. Overlap check unchanged.
- Built: `src/pay/provider.ts` (interface), `src/pay/cashfree.ts` (Payment Links; doc pages listed in its header comment), `src/pay/apply.ts` (one apply function for webhook and cron, plus `reconcile`), `src/pay/webhook.ts` (POST /pay/cashfree/webhook), `src/booking.ts` (service -> slot list -> guarded hold/link step), cron `*/2 * * * *` in wrangler.toml, copy in `src/copy.ts`.
- Booking respects the NEW_BOOKINGS switch: while it is not "true", "Book a ₹99 call" still replies "Booking opens soon." (contract: flags default safe).
- **Webhook secret:** Cashfree signs webhooks (base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body) with the payment gateway secret key, i.e. the same value as `CASHFREE_SECRET`. There is no separate webhook secret, so `CASHFREE_WEBHOOK_SECRET` is NOT used by the code and can stay unset.
- Provider ids: payment `provider_payment_id` and `provider_order_id` both store the Cashfree order id (a webhook gives order id + transaction id, the status read gives only order ids; one id keeps both paths consistent). Refunds go to `POST /pg/orders/{order_id}/refunds` with `refund_id = refund-<payment id>`.
- Assumptions to check in the Cashfree sandbox (not confirmable from docs): minimum link expiry (assumed 15 min, `config.cashfree.minLinkExpiryMinutes`; hold is 20), API version `2025-01-01` in config, `GET /pg/links/{id}` returns the same fields as the create response, `GET /pg/links/{id}/orders` returns an array. The webhook doc says "form data format" in one line but shows JSON; the code expects JSON.
- Owner steps (not done here): set the webhook URL in the Cashfree dashboard to `<worker url>/pay/cashfree/webhook` (Payment Link events); set `config.businessNumber` (currently a placeholder); flip `call_booked` approved when Meta approves it (outside the 24h window the confirmation uses that template).
- Known gaps (Ticket 06/07): refund completion webhooks are not handled (refunds stay REFUND_PENDING unless the provider answers SUCCESS at once); a crash between inserting a refunds row and calling the provider leaves it PENDING with no retry; `REFUND_FAILED`/`UNKNOWN` payments only raise attention items (email alerts come in Ticket 07).
- Checks (local): typecheck, vitest 55/55, wrangler dry-run: all passed. GitHub Actions: see PR.
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
