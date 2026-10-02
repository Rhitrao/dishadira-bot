# CONTRACT — Disha Dira v1
Version: 2026-10-02 (v3). Governs implementation; owner decisions govern live activation.
Precedence: CONTRACT.md > the assigned ticket > CLAUDE.md > STATUS.md. Conflict: see "Escalate".
Roles: Amma (Shantha Rao) = practitioner; uses ONE page (/amma) and never sees chats. Rohit = owner, sole operator.
Goal: turn Click-to-WhatsApp ad enquiries into paid sessions; Amma only ever speaks to people who have paid.
Scope: one practice, one practitioner, two services (PROTECTION, HEALING), INR, Asia/Kolkata, English + Kannada.
Journey: pick a call slot -> pay ₹99 -> Amma calls (15 min) -> Session | Not right fit | Missed | Rude ->
  Session: ₹700 session slot + payment -> confirmed -> day-before reminder.
Defaults (owner may change in config, never in code): intro 9900 paise, session 70000 paise, both services;
  hours Mon-Fri 14:00-19:00 IST; call slots 15 min; session slots 60 min, max 5/day; holds 20 min.
Prices, hours, copy, FAQ answers and limits live in one config module; Disha Dira specifics never hard-coded elsewhere.

Stack
One TypeScript Worker (Hono) + D1 + Cron Triggers + Cloudflare Access + Cloudflare email (send to Rohit's verified
address only). Static site is separate (Cloudflare Pages). Native fetch/Web Crypto. Runtime libs: hono, zod, jose.
Vitest + wrangler in GitHub Actions. Pin versions, commit the lockfile.
Not in v1: AI/LLM replies, voice, broadcasts, marketing templates, queues, Durable Objects, ORMs, React frameworks,
vector DBs, third-party CRMs, Supabase, Next.js. Official Meta WhatsApp Cloud API only; no WhatsApp Web automation.
Reference only: github.com/ArnasDon/wacrm (MIT) for webhook verification, dedupe, template-status and handoff patterns.
Copy small pieces only, keep its MIT notice in a NOTICE file, never vendor the app.
Browser-only development (Claude Code web + GitHub Actions). Nothing runs on Rohit's Chromebook.
Payments go through a PaymentProvider interface: createLink, getStatus, verifyWebhook, refund.
Implement Cashfree first; Razorpay may be added later behind the same interface. Never both in one flow.

States
Conversation: BOT | HUMAN | BLOCKED. Free text that isn't a menu choice -> stays BOT, raises a "needs attention" item.
Intro (₹99): HELD -> PAID -> CALLED_SESSION | CALLED_NOT_FIT | MISSED | RUDE; HELD -> EXPIRED;
  MISSED -> RESCHEDULED (once) -> ...; PAID -> CANCELLED_BY_US.
Session (₹700): OFFERED -> HELD -> CONFIRMED -> COMPLETED | NO_SHOW; HELD -> EXPIRED; CONFIRMED -> CANCELLED.
A session may only be offered after CALLED_SESSION, or by an audited operator override.
Payment: CREATING -> PENDING -> PAID | FAILED | UNKNOWN; PAID -> REFUND_PENDING -> REFUNDED | REFUND_FAILED.
PAID and REFUNDED never move backwards. A verified later success supersedes FAILED/UNKNOWN.

Data (D1)
Tables: conversations, events, messages, slots, intros, sessions, payments, refunds, blocks, outcomes, attention, audit_log, settings.
conversations: unique wa_id, display name, locale, mode, last_user_at, source_ad_id, consent_at.
events: unique(provider, event_key); minimal payload; status; error. Receipt is not processing.
slots: kind (CALL|SESSION), UNIQUE(kind, start_utc), owner id, hold_until. Availability by conditional SQL only.
  Amma has ONE calendar: a CALL and a SESSION must never overlap in time. An active booking or hold of either kind blocks
  every overlapping slot of the other kind. Enforced in the hold write itself, not just in the list shown to customers.
payments: provider, purpose (INTRO|SESSION), target id, unique order/link/payment ids, amount, state.
refunds: unique(payment_id); reason; requested_by; state; provider refund id. Never two refunds for one payment.
blocks: wa_id and/or UPI handle/payer ref; reason; by. Checked before any link is created.
outcomes: intro id, value, tapped_at, undo_until, applied_at. Effects run only after undo_until.
attention: kind, target, created_at, resolved_at. Feeds Rohit's queue and the 9pm digest.

Flow invariants
Bot is menu-driven: max 3 reply buttons, lists max 10 rows, CTA URL label max 20 chars.
Greeting says it is Disha Dira's booking assistant and that Shantha Rao calls personally; first choice is language.
Customer sees real call slots BEFORE paying. Holding a slot and creating a link happen in one guarded step.
Payment links expire no later than the hold and no earlier than the provider minimum.
Only a verified provider webhook or a provider status read marks PAID. Screenshots and customer text never do.
After a pay tap: "Payment in progress, please don't pay again." Poll status if no webhook within 2 minutes.
A second payment for the same target is refunded automatically (reason DUPLICATE).
Late payment after hold expiry never takes another slot; it raises attention for Rohit (new slot or refund).
Outcome taps: Session -> send session_offer; Not right fit -> refund ₹99 after 10-min undo (once per person, daily cap 5);
  Missed -> one reschedule offer; Rude -> block immediately, refund waits for Rohit's approval.
Amma not tapping within 3 hours of a call -> attention item. "Amma away" switch: pause new bookings and raise attention
  for every affected booking (offer new time or refund).
Duplicates/reordered events never duplicate bookings, money, links, refunds or outbound messages.
Verify raw-body signatures (Meta X-Hub-Signature-256, Cashfree webhook signature) before trusting or storing.
Before returning 200, commit the event and its business change plus any reply intent, or return a retriable error.
Outbound sends: PENDING -> SENDING -> SENT | FAILED | UNKNOWN, claimed atomically. No blind resend after a timeout.
Outside the 24-hour window only approved templates: call_booked, session_offer, session_confirmed, reminder,
  payment_update. All UTILITY. If a needed template isn't approved, raise attention instead of sending.

Amma's page (/amma)
Behind Cloudflare Access (Amma's Google account) plus Worker JWT check. Big text, one column, phone-first.
Today's and tomorrow's calls and sessions: time, first name, service, big tap-to-call (tel:) button.
Outcome buttons: Session / Not right fit / Missed; "Report rude" separate. Every tap: confirm, then undo for 10 min.
No chat content, no free text, no health details on this page.

Rohit (/admin) and alerts
Behind Cloudflare Access + JWT check + CSRF/origin checks + output escaping.
Needs-attention queue with reply box (sends within 24h window only), block/unblock, approve rude refunds,
override offers, switches (NEW_BOOKINGS, AMMA_AWAY, SENDS). 9pm IST email digest. Health alert email if no webhook
or cron run seen for a set period, or any REFUND_FAILED / UNKNOWN payment.

Privacy and safety
Never store or send: home address, private phone numbers, medical advice, diagnoses, cure claims, "black magic"/"evil eye".
Never ask for health details; do not download inbound media. First message states booking-only use.
Store only name, WhatsApp number, bookings, payments. Delete conversation text 30 days after last activity and
personal fields 90 days after last booking; keep dedupe keys, payment, refund and audit rows.
Secrets, real phone numbers and customer data stay out of git, PRs, logs, fixtures and prompts. Fixtures are synthetic.
Test and live credentials and data never mix; going live switches the Worker to a fresh live D1.

Release and process
Release-test families: inventory/holds; money/refunds; replay/recovery; access; window/templates; switches/blocks.
Runtime flags default safe: OWNER_APPROVED=false, NEW_BOOKINGS=false, SENDS=false, PAYMENT_MODE=test.
Only Rohit changes flags, outside a coding session.
One small PR per ticket; honest commits, no squash, no backdating; never merge or deploy without Rohit's direction.
Each session: read CONTRACT.md, STATUS.md, the assigned ticket and only the files it needs. Stop at ticket scope.
Report changed files, exact checks run and results, open assumptions, next action; update STATUS.md.
No live ads, live messages, live charges or account changes from a coding prompt.
Escalate: if contract and ticket conflict, stop, write it under "Blocked" in STATUS.md, commit, ask Rohit one question.
