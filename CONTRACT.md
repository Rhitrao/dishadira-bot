# CONTRACT — Disha Dira v1
Version: 2026-11-26 (v29: ticket 61: the tarot home screen shows the three themes, each with a free "Today's message" card a day (tarot_messages); the daily card and the messages are always free; a person's first reading in each theme is free once (tarot_free), then a theme reading needs a pass (tarot_passes, sold in a later ticket; /api/start answers 402) except for testers; "Delete my history"; an optional email in the details; testers on the test Worker may log in with their number and the TAROT_TESTER_PIN secret; two love readings framed as possibilities and energies, never predictions; v28: ticket 60: the Android app (app/, a Capacitor shell opening /tarot, built as a test APK by the "Android app" workflow; no store publishing); logging in by sending "TAROT <code>" on WhatsApp (table tarot_codes); "Delete my account" removes every tarot row; a daily reminder from the phone in the app; v27: ticket 59: each tarot reading gets "What this means for you" in plain words that answer the question, written once by the assistant from the card library (TAROT_AI, test only; checked, kept in tarot_readings.story, 300 a day) or built by rules, and a Listen button that reads it in a calm female voice (Workers AI, Deepgram Aura 2, TAROT_VOICE and the test-only [ai] binding; else the phone's voice); the summary and labels in everyday words; v26: ticket 58: the tarot game asks for a profile on first login (name as at birth, date of birth, optional birth time, time zone and place, consent, 18+) and shows the person's numerology, Western, Vedic and Chinese astrology and tarot birth cards on the home screen; spreads per theme; the person's own question, checked by the crisis, reading-safety and abuse rules; unlimited turns for the numbers in the TAROT_TESTERS secret; table tarot_profiles, tarot_readings rebuilt; v25: ticket 57: the tarot game at /tarot behind the TAROT_GAME env flag (top level and live "false", test "true"): the word TAROT gets a one-time "Open your cards" login button; one free daily card and one free three-card reading a day; tables tarot_logins, tarot_sessions, tarot_readings, tarot_seen; v24: ticket 56: with KARMIC_FRONT_DOOR "true" the Karmic Clarity Call (and the ₹799 session reached from the topic menu) no longer asks "Healing or Energy cleansing?" (HEALING kept as the filler; the console names such a call the Karmic Clarity Call), the FAQ answers (What is this, How it works, a new Who is it for) and Instagram/Messenger's describe Karmic Coaching and its three pathways, and the AI gets the Karmic Coaching knowledge (docs/KNOWLEDGE.md §18) with the live list of bookable services and more banned words; with the flag "false" the prompt is byte for byte as before; v23: ticket 55: time off for part of a day: the owner, or the practitioner for her own calendar, blocks a range inside the working hours on a day (Calendar → Days off), stored as a settings row `timeoff:<day>:<HHMM>-<HHMM>`; in the block nothing is offered, held or booked (the list, holdSlot, move, package credit, the team's session link and book-for-them), bookings already there stay and show a warning, nobody is messaged; the stated hours do not change, so no template, knowledge or message does; v22: ticket 54: the package tracker on People: "Has a package" shows each person's sessions left and last package session, and a new filter "Package, not booked" lists people with sessions left, none booked ahead and nothing for 14 days, with People's own rights and numbers; nothing is sent to customers; v21: ticket 53: the CARD test's numbers (people who tried CARD, on 3+ days, paid ₹99 calls from them and all paid ₹99 calls, the last 14 days) as one line on Today for the owner only and one in the 9 pm summary, only while someone has tried CARD in those days; counts only; v20: ticket 52: the Karmic Coaching front door behind the KARMIC_FRONT_DOOR env flag: the bot asks what the person would like help with (five fixed topics, kept on the booking as "Came for", not health data), recommends the ₹99 call first as the "Karmic Clarity Call", and names it so; Instagram and Messenger get the reading-safety replies; the booking_confirmed template drafted, off until approved; v19: ticket 49 (catalogue services; main also has a ticket 49, the CARD test): the bot may offer catalogue services behind the NEW_SERVICES env flag, with a question after payment and two health questions before booking; two fixed reading-safety replies on every bot; v18: ticket 49: the 14-day CARD test: a person who sends the bare word CARD gets three pre-written cards for one theme a day (WORK, RELATIONSHIPS or ENERGY), the same cards again the same IST day, never unprompted, never the AI, nothing about Pranic Healing; table card_draws; v17: ticket 48: services and their price and length come from a catalogue the owner edits in /app Settings; seeded with today's ₹99 call and ₹799 session; new services stay off and unoffered until a later ticket and Rohit's go-ahead; v16: ticket 47, the owner's requests of 4 Nov 2026: the team's notes for each customer (before, during and after a call or session) and a gist above each chat; v15: ticket 46, the owner's decision of 4 Nov 2026: customers' numbers visible in /app to the owner and to the practitioner for her own customers; v14: ticket 45, the owner's request of 4 Nov 2026: a phone alert (Web Push) to the owner and the practitioner when a customer books and pays; v13: ticket 41, the owner's requests of 4 Nov 2026: calls and sessions are voice calls only, the three questions after a paid ₹99 call, out-of-scope concerns, the media reply, and safety-chat photos for the practitioner; v12: ticket 40, the owner's decision of 4 Nov 2026 ("Build all"): the after-call session reminder, the review and referral ask, and the team's session link; v11: ticket 38: customer photos and files viewed on demand, never stored, and /app the live console; v10: ticket 37: the owner's chat export for analysis; v9: ticket 36: the team's "Take over this chat", and the time step's second miss goes to the team; v8: the owner's requests of 1 Nov 2026, ticket 35: automatic follow-ups; v7: Monday to Saturday, holidays and "she calls you", the owner's requests of 29 Oct 2026, ticket 30; v6: console decisions of 27 Oct 2026, ticket 26; v5: sessions ₹799 and packages; chat wipe by env; v4: English + Hindi, gatekeeper, AI answers; see docs/AGENT.md). Governs implementation; owner decisions govern live activation.
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
  v17 (ticket 48): services and their price and length come from a catalogue the owner edits in /app Settings (`services`; slots, intros and
  sessions record their service_key); seeded with today's ₹99 call and ₹799 session; new services stay off and unoffered until a later ticket
  and Rohit's go-ahead.
  v19 (ticket 49, catalogue services, Rohit 20 Nov 2026): behind the env flag NEW_SERVICES (top level and live "false", test "true"; only Rohit changes it, after
  Razorpay's written approval) the bot offers a catalogue service that is active and public ("Offered by the bot" in Settings → Services, only
  while the flag is "true"); with the flag "false" its menus and replies are exactly as before. Book then shows one list (the ₹99 call, the
  ₹799 session, then the offered services by pathway, max 10 rows), and a service books through the session's own steps and rules (day,
  time, guarded hold, link naming it, paid, confirmation, move/cancel/refund as a single session) at its own length, price and daily cap;
  "only after the first call" needs a ₹99 call that took place. Per service, the owner may set one question asked after payment (its typed answer
  kept on the session, shown to the owner and the practitioner only, wiped with the name) and two yes/no health questions before the hold
  (a mental-health condition under treatment now; seizures or epilepsy ever): any "yes" ends the booking with a kind fixed reply
  recommending the ₹99 call, and no answer is stored, only an audited outcome code (SCREENED_TO_CALL; the owner's decision, another
  exception to "never ask for health details"). On every bot, whatever the flag: before any AI, the gatekeeper answers "someone did
  something to me" (black magic, nazar, jadoo, tona, bhoot-pret …) and asks to predict death, illness, pregnancy, exam or court results
  or exact dates with fixed calm replies (English and Hindi; nothing confirmed, removed or predicted; a doctor for health; no strike or
  block); crisis and emergency come first (docs/AGENT.md §3.2 step 11c).
  v20 (ticket 52, Karmic Coaching, Rohit 21 Nov 2026): behind the env flag KARMIC_FRONT_DOOR (top level and live "false", test "true"; only
  Rohit changes it) the bot asks "What would you like help with?" after the language choice and on Book (five fixed topics: relationships and
  family, feeling heavy or drained, a decision or direction, a habit or pattern, not sure yet; plus Sessions & packages and Help), and every
  topic recommends the ₹99 call first, which its own words then call the "Karmic Clarity Call (₹99, 15 min)" (greeting brand line "Disha Dira ·
  Karmic Coaching with Shantha Rao", menu button "Book", pay message, confirmation, My bookings, its own reminder text, phone alerts; approved
  templates and which one is sent never change). With NEW_SERVICES on too, the topic's pathways' offered services (and the ₹799 session,
  RELEASE) can be booked directly. The tapped topic (a fixed key, never free text, not health data, no exception to "never ask for health
  details") is kept on the booking it led to (within 24 hours) and shown to the owner and the booking's practitioner as "Came for: …"; it is
  wiped with the name. With the flag "false" every message is exactly as before. Instagram and Messenger give the two reading-safety replies
  at once, whatever the flags.
  v24 (ticket 56, Rohit 22 Nov 2026): with KARMIC_FRONT_DOOR "true": the Karmic Clarity Call, and the ₹799 single session when a topic was tapped
  (within topicHours), skip "Healing or Energy cleansing?" (service HEALING stored as the filler; "Who is this for?" unchanged); a call with a
  topic is "Karmic Clarity Call" (not "Healing") on Today, the calendar and the person page. Help's "What is this?" and "How it works", a new
  "Who is it for?" row, and Instagram/Messenger's "what"/"how" replies describe Karmic Coaching (Release, Understand, Rewire) and end with the
  Karmic Clarity Call. The assistant also gets docs/KNOWLEDGE.md §18 (Karmic Coaching: what each pathway and tool is and is not) and, in the
  trusted facts, the catalogue services it may name as bookable (active, public and NEW_SERVICES "true"; any other tool: "on the Karmic
  Clarity Call"); its output check also bans config.ai.karmicBannedWords (therapy, predict, years of experience …). No new certificate, year
  or credential claim; the existing Pranic Healing credential wording is unchanged. With the flag "false" the prompt, the output check and
  every message are exactly as before.
  v25 (ticket 57, Rohit 24 Nov 2026, "go ahead"): the tarot game, behind the env flag TAROT_GAME (top level and live "false", test "true";
  "false": /tarot is a 404 and TAROT goes to the CARD test as before). With it on, the bare word TAROT (a short list, src/tarot/bot.ts), typed
  or as the first message, gets one service-window message with a CTA URL button "Open your cards" to <PUBLIC_URL>/tarot/in?t=<token>: a random
  32-byte token, only its SHA-256 kept, valid 15 minutes and once, swapped for a session cookie (HttpOnly, Secure, SameSite=Lax, Path=/tarot,
  90 days; only its hash kept; a blocked person's session stops working). CARD is unchanged. The game (src/tarot/): one free daily card and one
  free past-present-future reading a day (3 themes × 6 fixed questions), a full 78-card deck of the 1909 Waite–Smith art (public domain),
  Fisher–Yates with secure random numbers, each card reversed with chance 1/2, a cut and picks from a fan of 22 that are the real deck order,
  fixed once picked (no re-roll); meanings from a reviewed library (src/tarot/deck.ts) and a rule-based summary, no AI; the person's own note;
  a 7-day journal, the collection and a streak. Never predicts health, death, pregnancy or money; every screen says "A reflection tool for
  calm moments. Not advice or prediction." No payment in this version. Posts need JSON and this site's Origin. Readings, notes, sessions and
  the collection go with People → Remove their data and 90 days after a person's last reading.
  v26 (ticket 58, Rohit 25 Nov 2026): the first time a person logs in to /tarot they give their name as at birth, date of birth (18 or over),
  and if they know them, birth time with its UTC offset and birth place, and tick consent; nothing else in the game works until they do.
  From these, code alone (src/tarot/profile.ts, no AI) works out Pythagorean numerology (Life Path, Expression, Soul Urge, Personality,
  Personal Year, Month and Day, the Indian Mulank and Bhagyank), the tropical Sun sign, the Vedic Moon sign, nakshatra and pada and sidereal
  Sun sign (Lahiri ayanamsa; the Sun and Moon by Meeus), the Chinese year at Li Chun and Greer's tarot birth cards, shown on the home screen
  with "Today for you". The profile shapes only how a reading is explained (the "For you" lines: birth card, the Sun sign's card, the
  Personal Day number, the element, a card that keeps returning), never which cards are drawn. Each theme has its own spreads (3 to 10
  cards, laid out in their real shape). After a theme and spread, a person may type their own question (3 to 300 letters); a crisis gets
  Tele-MANAS 14416 and 112 and no reading, a prediction of health, death, pregnancy, exams or court or a question about spells gets a kind
  "we do not read for that", abuse is refused. The numbers in the Worker secret TAROT_TESTERS (never in git) may draw as often as they
  like each day; everyone else has one daily card and one reading a day. "Delete my details" removes the profile; People → Remove their
  data and 90 days without a visit remove it too.
  v27 (ticket 59, Rohit 25 Nov 2026, "a layman cannot understand this … a voice summary … in a sweet therapeutic female voice"): every
  finished reading opens with "What this means for you": plain, warm words that answer the person's question card by card, with two or three
  small suggestions and one question to sit with. With TAROT_AI "true" (test only) the assistant (config.ai.model) writes it once, from only
  the card library's lines, the positions and the question, under fixed rules (no jargon, reflection never prediction, no health, death,
  pregnancy, exams, court, money, spells or promises); the text is checked (src/tarot/story.ts storyIsSafe) and kept in tarot_readings.story;
  at most 300 a day (audit TAROT_STORY). Otherwise, or on any failure, the same explanation built by rules from the library (not stored).
  A Listen button reads it aloud: with TAROT_VOICE "true" and the Workers AI binding (test only), Deepgram Aura 2 (voice "cora") makes an MP3,
  cached at the edge for a day; otherwise the phone's own voice (a female English voice when the phone has one). The summary lines and labels
  use everyday words ("upside down", not "reversed"; no "Major Arcana", "suit" or "court card").
  v28 (ticket 60, Rohit 25 Nov 2026, "start now" on the Android and iOS app plan): the Android app lives in app/ (Capacitor 8): a native
  shell whose page is the game at /tarot (test by default), with the icon and splash drawn from the card back, a daily reminder scheduled on
  the phone by the person (local notifications; nothing sent by us; off until they turn it on), and an offline page. The "Android app"
  workflow builds a debug APK for testing; it publishes nothing and changes no Cloudflare, Meta or Google settings. Login without a link:
  the game (in the app or any browser) asks for a code (8 characters from 32, 10 minutes, a device secret of which only the SHA-256 is kept,
  at most 500 open across everyone) and opens WhatsApp with "TAROT <code>" typed; when the bot sees that message from a chat it ties the code
  to that chat and replies "You are logged in"; the device, asking with its secret, then gets the session cookie, once. An unknown or old
  code gets the usual "Open your cards" button. "Delete my account" removes the person's tarot details, readings, notes, collection,
  sessions, links and codes (their WhatsApp chat with the bot is untouched).
  v29 (ticket 61, Rohit 26 Nov 2026, eleven asks after trying the app): the home screen shows the three themes (love, career, self), each
  with "Today's message": one card per theme per IST day, drawn by the same fair shuffle, kept in tarot_messages (wiped after 90 days and with
  the account) and added to the collection. The daily card and the messages are always free. A person's first reading in each theme is
  free, once ever (tarot_free, kept when they delete their history, so it is not handed out again; removed with the account); after that a
  theme reading needs an active pass (tarot_passes: plan, start, end, source razorpay / play / apple / gift; nothing sells passes yet, the
  page says "Passes open soon" and offers the ₹99 call) and /api/start and /api/pick answer 402 "pass". Testers (TAROT_TESTERS) and pass
  holders read without limit. Passes, when sold, are paid once and never renew by themselves. "Delete my history" removes readings, notes
  and today's messages and keeps the details and collection. The details form takes an optional email (checked; for the account only, never
  shared or used for adverts). With the TAROT_TESTER_PIN secret set (test only), a number in TAROT_TESTERS plus that PIN logs in (5 wrong
  tries per number in 15 minutes, then a wait; nothing logs in when the secret is unset; the PIN is never in git). Love has two new
  readings, "Their heart" (their feelings, intention and message, each said as what the card suggests, a possibility, never a fact) and
  "The next three months" (the energy to work with in each month, never events or dates), and new ready questions in the same spirit; the
  assistant's rules say so and still forbid saying whether someone will come back, leave, marry or cheat. The page has a sticky top bar
  with a 48px back button, keeps clear of the phone's status and navigation bars (safe-area insets; the app's SystemBars set to light
  icons), fetches the recorded voice as soon as a reading opens, and stops it when the person leaves the reading or the screen goes off.

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
  credits (ledger: +N on purchase, -1 per booking, +1 on timely cancel, refunds); v16: notes, gists; v18: card_draws; v20: intros.topic,
  sessions.topic and conversations.topic_pick / topic_pick_at (the front door's topic, wiped with the name); v25: tarot_logins,
  tarot_sessions, tarot_readings, tarot_seen (the tarot game); v26: tarot_profiles, and tarot_readings rebuilt (kind daily or spread, the
  spread's id, custom question, n for testers' extra turns); v27: tarot_readings.story; v28: tarot_codes; v29: tarot_messages, tarot_free, tarot_passes, tarot_pin_tries, tarot_profiles.email.
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
The CARD test (v18, ticket 49, the owner's decision of 20 Nov 2026, a test of 14 days that ends when the owner turns the word off or a later ticket replaces it): the person starts it by sending the bare word CARD (or TAROT, कार्ड, टैरो; never inside a longer message, so "card payment failed" is not it) or by the ad's prefilled first message; the bot answers inside the 24-hour window only, with three theme buttons (Work, Relationships, Energy and calm), then three different cards from the 22 Major Arcana, upright, drawn with Web Crypto (Past, Present, Next step), a short pre-written line each, one question to think about and the footer "A calm moment for reflection. Not a prediction or advice." One draw and one theme per person per IST day (card_draws, primary key person and day): the same day gives the same cards, another theme gets "Today's theme is …". After a person's 1st, 3rd and 5th draw only, one soft line and the usual Book button. No AI, no streak, no loss or countdown wording, no message the person did not ask for; text never names Pranic Healing or heals, cures, predicts or names an illness, and passes the banned list of docs/KNOWLEDGE.md §8. Safety, blocks, the noise rules and "Talk to a person" run first; while nothing may be sold (7 days after a crisis message) there are no cards, only Help and Talk to a person. card_draws holds a person, a day, a theme and three card numbers: deleted 90 days after the draw and by People → Remove their data; never in the export, emails or notifications. The privacy page must say it before the test goes live (STATUS.md).
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
  review_ask (MARKETING) and session_link (UTILITY), and v20's booking_confirmed (UTILITY, a catalogue service's confirmation; drafted,
  `approved: false` until Meta approves it; until then Ticket 49's team item). All others UTILITY. follow_up stays
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
Runtime flags default safe: OWNER_APPROVED=false, NEW_BOOKINGS=false, SENDS=false, AI_REPLIES=false, NEW_SERVICES=false (v19), KARMIC_FRONT_DOOR=false (v20), TAROT_GAME=false (v25), TAROT_AI=false and TAROT_VOICE=false (v27), PAYMENT_MODE=test.
Only Rohit changes flags, outside a coding session.
One small PR per ticket; honest commits, no squash, no backdating; never merge or deploy without Rohit's direction.
Each session: read CONTRACT.md, STATUS.md, the assigned ticket and only the files it needs. Stop at ticket scope.
Report changed files, exact checks run and results, open assumptions, next action; update STATUS.md.
No live ads, live messages, live charges or account changes from a coding prompt.
Escalate: if contract and ticket conflict, stop, write it under "Blocked" in STATUS.md, commit, ask Rohit one question.
