# CONTRACT — Disha Dira v1
Version: 2026-11-04 (v16: ticket 47, the owner's requests of 4 Nov 2026: the team's notes for each customer (before, during and after a call or session) and a gist above each chat; v15: ticket 46, the owner's decision of 4 Nov 2026: customers' numbers visible in /app to the owner and to the practitioner for her own customers; v14: ticket 45, the owner's request of 4 Nov 2026: a phone alert (Web Push) to the owner and the practitioner when a customer books and pays; v13: ticket 41, the owner's requests of 4 Nov 2026: calls and sessions are voice calls only, the three questions after a paid ₹99 call, out-of-scope concerns, the media reply, and safety-chat photos for the practitioner; v12: ticket 40, the owner's decision of 4 Nov 2026 ("Build all"): the after-call session reminder, the review and referral ask, and the team's session link; v11: ticket 38: customer photos and files viewed on demand, never stored, and /app the live console; v10: ticket 37: the owner's chat export for analysis; v9: ticket 36: the team's "Take over this chat", and the time step's second miss goes to the team; v8: the owner's requests of 1 Nov 2026, ticket 35: automatic follow-ups; v7: Monday to Saturday, holidays and "she calls you", the owner's requests of 29 Oct 2026, ticket 30; v6: console decisions of 27 Oct 2026, ticket 26; v5: sessions ₹799 and packages; chat wipe by env; v4: English + Hindi, gatekeeper, AI answers; see docs/AGENT.md). Governs implementation; owner decisions govern live activation.
Precedence: CONTRACT.md > the assigned ticket > CLAUDE.md > STATUS.md. Conflict: see "Escalate".
Roles: Amma (Shantha Rao) = practitioner; uses ONE page (/amma), which shows no chats. In the console (/app) a practitioner may read,
  read-only, the chats of customers booked with them, never anyone else's. Rohit = owner, sole operator.
  v11 (owner, 4 Nov 2026): the console (/app, CONSOLE_V2 "true" on live) is everyone's daily tool; /admin and /amma redirect to it and
  come back only as the rollback (CONSOLE_V2 "false").
Goal: turn Click-to-WhatsApp ad enquiries into paid sessions; Amma only ever speaks to people who have paid.
Scope: one practice, one practitioner, two services (PROTECTION, HEALING), INR, Asia/Kolkata, English + Hindi.
Journey: pick a call slot -> pay ₹99 -> Amma calls (15 min) -> Session | Not right fit | Missed | Rude ->
  v13 (owner, 4 Nov 2026): every call and session is a voice call by phone (audio only), never video, and the bot says so wherever it
  describes one (templates: a new version each, docs/TEMPLATES.md).
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
AI: Anthropic API (Claude Haiku) answers typed questions only, behind the AI_REPLIES flag, grounded only in docs/KNOWLEDGE.md
  (v16: and, behind the same flag, writes the team's chat gist, which never goes to the customer).
Not in v1: voice, broadcasts, marketing templates (v12 exception below), queues, Durable Objects, ORMs, React frameworks,
vector DBs, third-party CRMs, Supabase, Next.js. Official Meta WhatsApp Cloud API only; no WhatsApp Web automation.
Reference only: github.com/ArnasDon/wacrm (MIT) for webhook verification, dedupe, template-status and handoff patterns.
Copy small pieces only, keep its MIT notice in a NOTICE file, never vendor the app.
Browser-only development (Claude Code web + GitHub Actions). Nothing runs on Rohit's Chromebook.
v14 (ticket 45): Web Push (RFC 8030, VAPID RFC 8292, aes128gcm RFC 8291) is sent by the Worker itself with Web Crypto, to the team's
  own devices only; no third-party push service or library. Secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: the owner makes the pair with
  /app Settings → "Make alert keys" (owner only, only while they are missing, POST with token + Origin; a fresh pair shown once on a
  no-store page, never stored in D1/KV, logs or audit text; audited MAKE_PUSH_KEYS with no value) and pastes it into Cloudflare;
  `npm run vapid-keys` is the terminal alternative (never in a chat or Actions). Without them alerts are off.
Payments go through a PaymentProvider interface: createLink, getStatus, verifyWebhook, refund.
Razorpay (Payment Links) is the one provider, behind that interface. Only one provider may be in the code at a time.

States
Conversation: BOT | HUMAN | BLOCKED. Typed text goes through the gatekeeper (docs/AGENT.md §3.2) before any AI call; "Talk to a person" -> HUMAN
  (buttons still work in HUMAN; free text waits for Rohit; resolving the attention item returns the chat to BOT).
  v9: the same HUMAN mode also from the team's "Take over this chat" (owner/staff with the Inbox's rights; audited; nothing sent to the
  customer, no item; Hand back or Done returns it to BOT), and from a second miss in a row at the time step (as "Talk to a person").
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
  credits (ledger: +N on purchase, -1 per booking, +1 on timely cancel, refunds); v16: notes, gists.
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
  Media (ticket 38, v11): messages.media_id and media_mime: Meta's id and type of a file a customer sent, never the file or a link.
  v13 (ticket 41): intros.profession (short, as typed) and intros.help_area (a code: STRESS | SLEEP | RELATIONSHIPS | WORK | ENERGY |
  PHYSICAL | OTHER); conversations.name_given_at (a typed name is kept over the WhatsApp profile name). All three wiped with the name.
  v14 (ticket 45): push_subs (a team member's device: its push-service endpoint, https on the known push-service hosts only, its keys, a
  "Chrome on Android" label, dates; deleted on 404/410, Turn off or Remove) and push_outbox (one alert per booking and member: ids,
  times, state; deleted after 30 days). Never customer data.
  v16 (ticket 47): notes (person, optional booking CALL|SESSION + id, phase BEFORE | DURING | AFTER | ABOUT (one pinned per person), text up
  to config.notes.maxChars = 2,000, author member, created, edited) and gists (per chat: the AI lines as JSON in English and Hindi, made at,
  last message id and count, held-for-safety flag, last try).

Flow invariants
Bot is button-led: max 3 reply buttons, lists max 10 rows, CTA URL label max 20 chars. The AI may only choose a reply and one
  `next` action from a fixed list; it never creates holds, links, refunds or bookings. Every AI reply passes the output check.
Safety: crisis and medical-emergency detection runs in code before the AI and sends fixed messages (docs/KNOWLEDGE.md §9).
Noise: strikes, quiet periods and blocks per docs/AGENT.md §4. Existing customers and safety messages are never filtered.
Age: booking asks once whether the person is 18+; under-18s are asked to have a parent or guardian message.
After a paid ₹99 call (v13, owner's decision 4 Nov 2026): after the confirmation, inside the 24-hour window, while the bot has the chat,
  three short questions one at a time, each with Skip: the name she should use (the WhatsApp name on a button, or typed), their work
  (typed), and what they'd like help with (a fixed list; "Something else" then a few typed words, kept only as chat text). Once per call;
  never chased, no reminders; an answer that isn't one (a question, noise) ends them. Shown on /app's Today card and person page to the
  owner, the practitioner for their own customers, and staff while they may read chat text; never on /amma.
Out of scope (v13): a sexual-function concern gets a fixed reply (not something we help with; a qualified doctor; pranic healing
  complements medical care), never the AI, never a strike, block or flirt line, no booking push. From a paying customer (a paid call or
  booked session not yet held) it, or a request to cure a serious illness by name, raises OUT_OF_SCOPE on that booking ("consider a
  refund"); never an automatic refund. The outcome settles the item. Before payment only the reply changes.
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
Notes and the gist (v16, owner's decision 4 Nov 2026): notes are the practice's own record, written and read by the owner and the practitioner
  for her own customers (permission row `notes`), never staff; the author or the owner edits or deletes; audited NOTE_ADD / NOTE_EDIT /
  NOTE_DELETE with ids only. The gist above a chat (person page, Inbox) shows facts from our own records to whoever may read that chat's
  text, plus a few AI lines (what they ask, concerns, anything promised, a next step) made from the stored chat text only by the 2-minute cron
  (new messages, 5 quiet minutes, 2+ customer messages, at most every 10 minutes, config.gist.dailyCap a day) or Refresh (owner,
  practitioner); a page never calls the AI. Only while AI_REPLIES is on and not paused, and the owner's "Chat gist (AI)" switch is on
  (default on, audited GIST_SWITCH); otherwise facts only.
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
After the call (v12, owner's decision 4 Nov 2026; each a 1:1 message to one customer about their own call or session, never a broadcast):
  one session reminder 48 hours after an untaken session offer (the same options; never after a payment or booking), and one review and
  referral ask the morning after a paid session (from 10:00 IST; a Google review link from config and a wa.me link to the business number;
  at most once per person in 90 days; never after Not right fit, a refund, a complaint, rudeness or a safety message; no incentive for a
  review). Both: exclusions and night hours as the automatic follow-ups, claimed atomically, once; owner switches in Settings (reminder on,
  review off by default). The team may also send a customer who had (or has) a ₹99 call a ₹799 session link from /app, with a held time
  (the same guarded hold and link) or for the customer to choose; audited. These are the only marketing templates allowed:
  session_reminder and review_ask (both `approved: false` until Meta approves them; skipped and counted until then).
Outside the 24-hour window only approved templates: call_booked, session_offer, session_confirmed, reminder,
  payment_update, package_confirmed, session_booked, follow_up (no variables; Hindi follow_up_hi), and v12's session_reminder,
  review_ask (MARKETING) and session_link (UTILITY). All others UTILITY. follow_up stays
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
v14 (owner, 4 Nov 2026): a phone alert (Web Push, from the home-screen app) for a paid ₹99 call, a paid ₹799 session, a paid package and a
  session booked from a package; never a hold, a refund, a duplicate or mismatched payment. The owner: every one, at once. The practitioner:
  her own customers' only, and from 21:00 to 08:00 IST they wait until 08:00 (several as one summary). Staff: none. The words name the
  kind, the amount and the time, never a name, a number or a help area (lock screens are seen by others); the payload is encrypted for
  the device, the push service sees only ciphertext. Each device is turned on in /app Settings → Alerts on this phone (owner and
  practitioner; token + Origin; audited). Sent and failed counts in the digest. The Settings page and /app/sw.js alone carry
  script-src 'self' (one same-origin script, no inline script, no eval); every other console page stays script-free.

Privacy and safety
Never store or send: home address, private phone numbers, medical advice, diagnoses, cure claims, "black magic"/"evil eye" (full banned list: docs/KNOWLEDGE.md §8).
Never send to the AI: phone numbers, names, payment ids, emails, links, digit runs of 6+; never notes (v16), never media. First message and privacy page
  disclose the automated assistant and the AI provider.
Never ask for health details (v13 exception, the owner's decision of 4 Nov 2026: the "what would you like help with" list after a paid
  ₹99 call, above). Inbound media is never stored (v11: only Meta's media id and type, wiped with the text); the team may view
  a file on demand: a POST (CSRF + Origin), audited VIEW_MEDIA (the chat and the kind, never content), fetched from Meta with WA_TOKEN
  and streamed with no-store, nosniff and a script-free CSP; never cached in D1/KV/R2, never to the AI, never in the export (a name
  like "[photo]" only). Who: the owner; staff while they may read chat text; a practitioner for their own customers; a chat that had
  a safety message (v13): the owner and the practitioner for their own customers, as its text; staff never. v13: the bot's reply to a
  file says "Thank you — our team will take a look and reply here if needed." (the payment-screenshot item is unchanged). First message states booking-only use, that it is an
  automated assistant, and that messages are processed by the AI provider (docs/KNOWLEDGE.md §10).
Safety messages (crisis, medical emergency) are sent to everyone, including blocked, quiet and HUMAN chats, and even when
  the SENDS switch is paused (never when the SENDS env flag is "false").
Store only name, WhatsApp number, bookings, payments (v13: and the work and help area given after paying, wiped with the name; v16: the
  team's notes and the chat gist, as below). Wipe message text (and media ids, v11) CHAT_RETENTION_MINUTES after the person's last message (live 10080 = 7 days,
  test 10) and
personal fields 90 days after last booking; keep dedupe keys, payment, refund and audit rows.
Secrets, real phone numbers and customer data stay out of git, PRs, logs, fixtures and coding prompts.
  Live chat text may go to the AI provider only through src/ai.ts, redacted as above. Fixtures are synthetic.
  v10: the owner alone may download recent chats as one file (/admin/export, /app for the owner; audited EXPORT_CHATS with counts only):
  chats active in the last 1-30 days, a code and the last 4 digits (never the number or the name), text only while the wipe keeps it,
  every text redacted as above plus UPI ids and the person's name; crisis/emergency chats and blocked numbers counts only. The owner may
  analyse it (e.g. in a Claude chat) once the privacy page says so; the file never goes into git, PRs, logs, tickets or coding prompts.
v15 (ticket 46, the owner's decision of 4 Nov 2026, replacing the masked number with an audited reveal in /app): the console shows a customer's
  full WhatsApp number, formatted ("+91 98765 43210") and as a tel: link with a one-tap Call, to the owner everywhere the person appears
  (the calendar's small blocks may keep the last 4), and to a practitioner for her own customers at any time; no reveal step. Staff keep
  the last 4 digits only, and search by the last 4 only. /admin's audited reveal (ADMIN_REVEAL_NUMBER) is unchanged. The number is still
  never in emails, the digest, phone alerts, logs or the chat export.
  v16: the gist's AI lines go to the AI provider through src/ai.ts (the same client, redacted as the export: names, numbers, emails, links,
  UPI and payment ids), leaving out messages kept from the AI for safety (crisis or emergency, a sexual-health concern, a threat, a sexual
  message) and the bot's replies to them; each call audited with its token counts and cost (GIST_MADE / GIST_FAILED, never text). The
  gist is wiped with the chat text (CHAT_RETENTION_MINUTES) and by People → Remove their data. Notes are not wiped with the chat text;
  they are deleted by Remove their data. Neither goes into the export, the AI (notes), emails, the digest, notifications or logs. The
  privacy page must say both before AI_REPLIES is turned on in live (wording: STATUS.md, docs/GO-LIVE.md §19).
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
