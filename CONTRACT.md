# CONTRACT — Disha Dira v1
Version: 2026-11-01 (v8: the owner's requests of 1 Nov 2026, ticket 35: automatic follow-ups; v7: Monday to Saturday, holidays and "she calls you", the owner's requests of 29 Oct 2026, ticket 30; v6: console decisions of 27 Oct 2026, ticket 26; v5: sessions ₹799 and packages; chat wipe by env; v4: English + Hindi, gatekeeper, AI answers; see docs/AGENT.md). Governs implementation; owner decisions govern live activation.
Precedence: CONTRACT.md > the assigned ticket > CLAUDE.md > STATUS.md. Conflict: see "Escalate".
Roles: Amma (Shantha Rao) = practitioner; uses ONE page (/amma), which shows no chats. In the console (/app) a practitioner may read,
  read-only, the chats of customers booked with them, never anyone else's. Rohit = owner, sole operator.
Goal: turn Click-to-WhatsApp ad enquiries into paid sessions; Amma only ever speaks to people who have paid.
Scope: one practice, one practitioner, two services (PROTECTION, HEALING), INR, Asia/Kolkata, English + Hindi.
Journey: pick a call slot -> pay ₹99 -> Amma calls (15 min) -> Session | Not right fit | Missed | Rude ->
  Session: single ₹799, or a package (10 for ₹5,000 / 20 for ₹9,000) -> confirmed -> day-before reminder.
Also from the menu at any time (with a soft nudge to the ₹99 call first): single session, or a package. Package sessions
  are booked later from credits, with no payment per session; max 2 upcoming per buyer; packages never expire.
Defaults (config holds them; the owner may change prices in Settings; never in code): intro 9900 paise, single session 79900 paise, packages 10 x 500000 paise
  and 20 x 900000 paise, both services;
  hours Mon-Sat 14:00-19:00 IST, except holidays the owner or practitioner marks (no new bookings that day; existing ones stay);
  call slots 15 min; session slots 60 min, max 5/day; holds 20 min.
Hours, copy, FAQ answers, limits and the default prices live in one config module; the owner's price changes from Settings live
  in the settings table (config is the fallback). Disha Dira specifics never hard-coded elsewhere.

Stack
One TypeScript Worker (Hono) + D1 + Cron Triggers + Cloudflare Access + Cloudflare email (send only to verified addresses:
DIGEST_TO, and member addresses the owner has verified in Cloudflare Email Routing). Invites are never emailed: the team page
shows the one-time link, with a "Send on WhatsApp" link and a field to copy it. Static site is separate (Cloudflare Pages). Native fetch/Web Crypto. Runtime libs: hono, zod, jose.
Vitest + wrangler in GitHub Actions. Pin versions, commit the lockfile.
AI: Anthropic API (Claude Haiku) answers typed questions only, behind the AI_REPLIES flag, grounded only in docs/KNOWLEDGE.md.
Not in v1: voice, broadcasts, marketing templates, queues, Durable Objects, ORMs, React frameworks,
vector DBs, third-party CRMs, Supabase, Next.js. Official Meta WhatsApp Cloud API only; no WhatsApp Web automation.
Reference only: github.com/ArnasDon/wacrm (MIT) for webhook verification, dedupe, template-status and handoff patterns.
Copy small pieces only, keep its MIT notice in a NOTICE file, never vendor the app.
Browser-only development (Claude Code web + GitHub Actions). Nothing runs on Rohit's Chromebook.
Payments go through a PaymentProvider interface: createLink, getStatus, verifyWebhook, refund.
Razorpay (Payment Links) is the one provider, behind that interface. Only one provider may be in the code at a time.

States
Conversation: BOT | HUMAN | BLOCKED. Typed text goes through the gatekeeper (docs/AGENT.md §3.2) before any AI call; "Talk to a person" -> HUMAN
  (buttons still work in HUMAN; free text waits for Rohit; resolving the attention item returns the chat to BOT).
Intro (₹99): HELD -> PAID -> CALLED_SESSION | CALLED_NOT_FIT | MISSED | RUDE; HELD -> EXPIRED;
  MISSED -> RESCHEDULED (once) -> ...; PAID -> CANCELLED_BY_US.
Session: OFFERED -> HELD -> CONFIRMED -> COMPLETED | NO_SHOW; HELD -> EXPIRED; CONFIRMED -> CANCELLED (single, paid per session)
  or CREDIT_BOOKED -> COMPLETED | NO_SHOW | CANCELLED (package; cancel >= 3 h before returns the credit).
Package: CREATING -> PENDING -> PAID (credits added) -> CLOSED (all used, or refunded: unused x package rate, Rohit approves;
  payments older than 6 months are refunded by hand and marked in /admin).
After CALLED_SESSION the bot offers single / 10 / 20. A buyer who skipped the ₹99 call and is marked Not right fit at their
  first session gets the whole purchase refunded, once per person. Credits change only through the credits ledger, atomically.
Payment: CREATING -> PENDING -> PAID | FAILED | UNKNOWN; PAID -> REFUND_PENDING -> REFUNDED | REFUND_FAILED.
PAID and REFUNDED never move backwards. A verified later success supersedes FAILED/UNKNOWN.

Data (D1)
Tables: conversations, events, messages, slots, intros, sessions, payments, refunds, blocks, outcomes, attention, audit_log, settings,
  person_state (strikes, quiet_until, AI reply counters, no_sell_until, opt-out), packages (buyer, size, price, payment),
  credits (ledger: +N on purchase, -1 per booking, +1 on timely cancel, refunds).
conversations: unique wa_id, display name, locale, mode, last_user_at, source_ad_id, ad_click_id, ad_headline (first ad only, ticket 15), consent_at.
events: unique(provider, event_key); minimal payload; status; error. Receipt is not processing.
slots: kind (CALL|SESSION), UNIQUE(kind, start_utc), owner id, hold_until. Availability by conditional SQL only.
  Amma has ONE calendar: a CALL and a SESSION must never overlap in time. An active booking or hold of either kind blocks
  every overlapping slot of the other kind. Enforced in the hold write itself, not just in the list shown to customers.
payments: provider, purpose (INTRO|SESSION), target id, unique order/link/payment ids, amount, state.
refunds: unique(payment_id); reason; requested_by; state; provider refund id. Never two refunds for one payment.
blocks: wa_id and/or UPI handle/payer ref; reason; by. Checked before any link is created.
outcomes: intro id, value, tapped_at, undo_until, applied_at. Effects run only after undo_until.
attention: kind, target, created_at, resolved_at. Feeds Rohit's queue and the 9pm digest.
Console v4 (ticket 19, docs/CONSOLE-PRD.md): workspaces, members (one role each: OWNER | PRACTITIONER | STAFF, exactly one owner),
  invites (one-time, 7 days, token hash only), requests (ask owner); practitioner_id on slots, intros, sessions; audit_log member_id.
  Inbox (ticket 22): conversations.claimed_by / claimed_at ("Assign to me", lapses after 30 min) and inbox_mail_at (one 2-hour email per handoff).
  Settings (ticket 24): the owner's prices (price.*_paise; config is the default and the fallback), email recipients (mail.*),
  privacy.staff_read_chat and business.* live in the settings table; a payment is checked against the price when its link was made.

Flow invariants
Bot is button-led: max 3 reply buttons, lists max 10 rows, CTA URL label max 20 chars. The AI may only choose a reply and one
  `next` action from a fixed list; it never creates holds, links, refunds or bookings. Every AI reply passes the output check.
Safety: crisis and medical-emergency detection runs in code before the AI and sends fixed messages (docs/KNOWLEDGE.md §9).
Noise: strikes, quiet periods and blocks per docs/AGENT.md §4. Existing customers and safety messages are never filtered.
Age: booking asks once whether the person is 18+; under-18s are asked to have a parent or guardian message.
Greeting says it is Disha Dira's booking assistant and that Shantha Rao calls personally; first choice is language.
Customer sees real call slots BEFORE paying. Holding a slot and creating a link happen in one guarded step.
Payment links expire no later than the hold and no earlier than the provider minimum.
Only a verified provider webhook or a provider status read marks PAID, or the owner recording money received outside Razorpay
  (or approving a staff member's request for it), which confirms the booking through the same paid-booking code and is audited
  with a reason. Screenshots and customer text never do.
After a pay tap: "Payment in progress, please don't pay again." Poll status if no webhook within 2 minutes.
A second payment for the same target is refunded automatically (reason DUPLICATE).
Late payment after hold expiry never takes another slot; it raises attention for Rohit (new slot or refund).
Outcome taps: Session -> send session_offer; Not right fit -> refund ₹99 after 10-min undo (once per person, daily cap 5);
  Missed -> one reschedule offer; Rude -> block immediately, refund waits for Rohit's approval.
Amma not tapping within 3 hours of a call -> attention item. "Amma away" switch: pause new bookings and raise attention
  for every affected booking (offer new time or refund).
Duplicates/reordered events never duplicate bookings, money, links, refunds or outbound messages.
Verify raw-body signatures (Meta X-Hub-Signature-256, Razorpay X-Razorpay-Signature) before trusting or storing.
Before returning 200, commit the event and its business change plus any reply intent, or return a retriable error.
Outbound sends: PENDING -> SENDING -> SENT | FAILED | UNKNOWN, claimed atomically. No blind resend after a timeout.
Automatic follow-ups (v8), on the channel the person wrote on (WhatsApp, Instagram, Messenger), to someone who sent a real message
  (not spam, rude, or only a reaction) and has not booked: one 60 minutes and one 20 hours after their last real message (a new one
  starts again), at most 2 per person per channel in 7 days; nothing 21:00-08:00 IST (one due then goes at 08:00 only if still within
  23 hours of their message); free text inside the 24-hour window only, never a template. An illness named: only a gentle check-in at
  20 hours, no price, no booking button. Never after a paid booking (ever), "I booked/paid", stop/opt-out, a block or an insult, a safety
  message, human takeover, while SENDS is off or paused, or while Amma is away; an Instagram/Messenger contact whose code opened a
  WhatsApp chat gets WhatsApp's only. Prices, minutes and hours from the prices and config in force.
Outside the 24-hour window only approved templates: call_booked, session_offer, session_confirmed, reminder,
  payment_update, package_confirmed, session_booked, follow_up (no variables; Hindi follow_up_hi). All UTILITY. follow_up stays
  `approved: false` in config until Meta approves it. If a needed template isn't approved, raise attention instead of sending.

Amma's page (/amma)
Behind Cloudflare Access (Amma's Google account) plus Worker JWT check. Big text, one column, phone-first.
Today's and tomorrow's calls and sessions: time, first name, service, call language, who it is for
  (self/family/pet), big tap-to-call (tel:) button.
Outcome buttons: Session / Not right fit / Missed; "Report rude" separate. Every tap: confirm, then undo for 10 min.
No chat content, no free text, no health details on this page.

Rohit (/admin) and alerts
Behind Cloudflare Access + JWT check + CSRF/origin checks + output escaping.
Needs-attention queue with reply box (sends within 24h window only), block/unblock, approve rude refunds,
override offers, switches (NEW_BOOKINGS, AMMA_AWAY, SENDS, AI_REPLIES). 9pm IST email digest. Health alert email if no webhook
or cron run seen for a set period, or any REFUND_FAILED / UNKNOWN payment.

Privacy and safety
Never store or send: home address, private phone numbers, medical advice, diagnoses, cure claims, "black magic"/"evil eye" (full banned list: docs/KNOWLEDGE.md §8).
Never send to the AI: phone numbers, names, payment ids, emails, links, digit runs of 6+. First message and privacy page
  disclose the automated assistant and the AI provider.
Never ask for health details; do not download inbound media. First message states booking-only use, that it is an
  automated assistant, and that messages are processed by the AI provider (docs/KNOWLEDGE.md §10).
Safety messages (crisis, medical emergency) are sent to everyone, including blocked, quiet and HUMAN chats, and even when
  the SENDS switch is paused (never when the SENDS env flag is "false").
Store only name, WhatsApp number, bookings, payments. Wipe message text CHAT_RETENTION_MINUTES after the person's last message (live 10080 = 7 days,
  test 10) and
personal fields 90 days after last booking; keep dedupe keys, payment, refund and audit rows.
Secrets, real phone numbers and customer data stay out of git, PRs, logs, fixtures and coding prompts.
  Live chat text may go to the AI provider only through src/ai.ts, redacted as above. Fixtures are synthetic.
Test and live credentials and data never mix; going live switches the Worker to a fresh live D1.

Release and process
Release-test families: inventory/holds; money/refunds; replay/recovery; access; window/templates; switches/blocks.
Runtime flags default safe: OWNER_APPROVED=false, NEW_BOOKINGS=false, SENDS=false, AI_REPLIES=false, PAYMENT_MODE=test.
Only Rohit changes flags, outside a coding session.
One small PR per ticket; honest commits, no squash, no backdating; never merge or deploy without Rohit's direction.
Each session: read CONTRACT.md, STATUS.md, the assigned ticket and only the files it needs. Stop at ticket scope.
Report changed files, exact checks run and results, open assumptions, next action; update STATUS.md.
No live ads, live messages, live charges or account changes from a coding prompt.
Escalate: if contract and ticket conflict, stop, write it under "Blocked" in STATUS.md, commit, ask Rohit one question.
