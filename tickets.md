# Disha Dira v1 — tickets
One Claude Code session per ticket, on Sonnet, in order. Check the Usage page before and after each session.
Stop any session that passes 1.5x its cap and ask it to write its state into STATUS.md.

| # | Ticket | Delivers | Done when | Cap |
|---|---|---|---|---|
| 01 | Foundation | Repo layout, Hono Worker, wrangler.toml with D1 binding, config module, CI (typecheck, vitest, gitleaks, wrangler deploy --dry-run), NOTICE file, health route | CI green on a PR with no secrets | $8 |
| 02 | Data + slots | Migrations for every contract table; slot generator (Mon-Fri 2-7pm, call 15 min, session 60 min, 5/day); guarded hold that always gives exactly one winner; expiry by timestamp | Concurrency, expiry and "one active hold per person" tests pass | $12 |
| 03 | WhatsApp bot | Webhook verify + signature check + event dedupe; greeting, language, menu, FAQ list, free text -> attention; outbound send claim; 24h window rule; template registry | Replayed events create no duplicates; nothing sent outside 24h without an approved template; works on Meta test number | $20 |
| 04 | ₹99 booking | Call-slot list -> hold -> PaymentProvider + payment link (Razorpay since ticket 10) -> webhook + status poll -> PAID -> call_booked message; duplicate auto-refund; blocklist check | Wrong amount, duplicate, late and out-of-order events all handled; sandbox end to end | $20 |
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
3. `src/index.ts`: Hono app with `GET /health` -> `{ ok: true, version }`. Route stubs returning 501: `/wa/webhook`, `/pay/razorpay/webhook`, `/amma`, `/admin`.
4. `src/config.ts`: prices (paise), hours, slot lengths, daily caps, hold minutes, undo minutes, languages, and FAQ ids. Typed and exported. No Disha Dira values anywhere else.
5. `src/env.ts`: typed bindings and the list of secrets the Worker will need (names only): WA_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_PHONE_ID, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, ACCESS_AUD, ACCESS_TEAM, DIGEST_TO.
6. `.github/workflows/ci.yml`: on PR and push: install, typecheck, vitest, gitleaks, `wrangler deploy --dry-run`.
7. Tests: health route returns ok; config values are positive and consistent (session slots per day x 60 <= 300 minutes).
8. `NOTICE` (empty section for third-party code), `README.md` (one paragraph, how to run tests in CI), `STATUS.md` updated.

Do not: create real Cloudflare resources, add secrets, add other libraries, or start ticket 02.
Report: files changed, CI result link, open questions.


---

# v2 (CONTRACT v4): English + Hindi, gatekeeper, AI answers
Run in order, one session each. Design: docs/AGENT.md. Facts and copy: docs/KNOWLEDGE.md.

| # | Ticket | Cap |
|---|---|---|
| 11 | English + Hindi, and a clear booking flow | $15 |
| 12 | Gatekeeper, re-prompts, chat wipe (no AI) | $18 |
| 13 | Sessions and packages | $22 |
| 14 | The AI assistant | $20 |


## Ticket 11: English + Hindi, and a clear booking flow (cap $15)

Read CLAUDE.md, CONTRACT.md (v4), STATUS.md, docs/AGENT.md §2–3 and docs/KNOWLEDGE.md §10–11. Build only this ticket. Branch `t11-hindi-booking`, one PR. No subagents. Stop and report after 3 failed fix attempts on the same problem.

Deliver:
1. **Languages:**
   - Remove Kannada everywhere (`kn` copy, `LANGUAGE_BUTTONS`, config `languages`, docs).
   - Add Hindi (`hi`) and the new English keys, using KNOWLEDGE.md §11. Where a §11 string names a price, duration or hold time, build it from `config`.
   - Conversations with locale `kn` become `en`, through a migration.
   - Amma's page copy stays English.
   - Add a test that fails if any copy value contains `KN_TODO`, or if a key exists in one language but not the other.
2. **Customer-facing service name:** "Energy cleansing" / "एनर्जी क्लींजिंग" for PROTECTION (internal code unchanged). Put the label in config, so Rohit can change it back in one line.
3. **Greeting:** one bilingual message with the §10 text, then [English] [हिंदी]. If the very first message was a real question (not a menu word), store its message id and answer it after the language tap. For now that means the current ack; ticket 14 sends it to the AI.
4. **Menu:**
   - Buttons [Book ₹99 call] [How it works] [Talk to a person], body from §11.
   - The "How it works" list keeps the FAQ rows and adds a final row in the chat's language only ("Change language" or "भाषा बदलें"), which resends the language buttons.
5. **Talk to a person:**
   - Set mode HUMAN, raise a `HUMAN_REQUEST` attention item (at most one open per person) and send `handoffAck`.
   - In HUMAN mode, button taps (booking, menu, FAQ) still work. Free text gets no bot reply.
   - Resolving the item in /admin sets the mode back to BOT. Add this if it's missing.
6. **Menu words:** after the first greeting, a text that is only a greeting or menu word (case-insensitive, after trimming spaces, punctuation and emoji) gets the menu, with no attention item and no ack. The words: hi, hii, hello, hey, namaste, namaskar, menu, start, नमस्ते, नमस्कार, हाय, मेनू.
7. **Non-text messages** (audio, image, video, sticker, document, location, contacts):
   - If the person has a hold, a pending payment or a booking: raise a `MEDIA_FROM_CUSTOMER` attention item and send `mediaNoticeCustomer`.
   - Otherwise the first one each day gets `mediaNotice` plus the menu, and later ones get no reply.
   - Never download media.
8. **Booking steps before the hold** (fixed copy):
   - **Age check, once per person:** [Yes] [No]. Store `age_ok_at`. A No gets `ageNo` and stops.
   - **Service:** [Healing] [Energy cleansing].
   - **Who for:** [Me] [Family member] [Pet]. Store it on the intro as `for_whom` (SELF | FAMILY | PET).
   - **Day:** reply buttons for up to 3 days inside the booking window that have at least one free slot. Skip full days. Labels: EN "Wed, 21 Oct", HI "बुध, 21 अक्टूबर" (full month names). If no day has a slot, send `noSlots`.
   - **Time:** a list for that day.
     - At most 9 time rows in time order: prefer :00 and :30, fill a taken half hour with :15 or :45, and drop the latest if there are more than 9.
     - Then a final "Another day" / "दूसरा दिन" row, which resends the day step.
     - Sections: Afternoon / दोपहर before 4 pm, Evening / शाम after. Never send an empty section. The "Another day" row goes in the last non-empty section.
     - Row titles: EN "2:30 pm"; HI "दोपहर 2:30" or "शाम 5:30".
     - Row descriptions from `rowCall` / `rowSession`.
     - Extend the `Out` type in `src/send.ts` for list sections and row descriptions.
   - **Call language = chat language.** Store it on the intro as `call_lang`, and show it in the confirmation (§11 `confirmed`).
   - Then the existing guarded hold and payment, unchanged. `payBody` and `sessionPayBody` become functions of day and time.
   - The session picker (after Amma's "Session" outcome) uses the same day-then-time steps, with no age, service or who-for steps.
   - Old `slot_` row ids already in people's chats must still work, or get the day buttons again. They must never cause an error.
9. **Amma's page:** show the call language and who it's for next to each name, e.g. "Priya · Hindi · family".
10. **Dates and times** customers see (confirmations, reminders, reschedules, "already booked") use the person's language and the §11 formats, in India time. Reminders use `reminderCall` / `reminderSession`.
11. **Templates:** `config.templates` gets an optional Hindi template name per template, with its own `approved` flag. Hindi customers get the Hindi template only if it is approved, and otherwise the English one.
12. **Timings FAQ** from `config.hours` in plain words (§11).
13. **Tests:**
    - Every new step in both languages, against every WhatsApp limit: button ≤ 20, row title ≤ 24, row description ≤ 72, section title ≤ 24, list button ≤ 20, body ≤ 1024, rows ≤ 10 in total.
    - The spread rule.
    - Old slot ids.
    - The age gate is asked once.
    - Media paths.
    - Menu words.
    - HUMAN mode buttons.
    - A first-message question is kept.
14. Update `docs/COPY.md` to match `src/copy.ts`, and add a STATUS.md note.

Do not: change prices, hours, slot lengths, hold or payment logic, or any flag in wrangler.toml; add any AI; deploy.
Report: files changed, CI link, and a sample of every new message in both languages exactly as WhatsApp will show it.

---

## Ticket 12: the gatekeeper (safety, noise, quiet periods), re-prompts and chat wipe, without AI (cap $18)

Read CLAUDE.md, CONTRACT.md (v4), STATUS.md, docs/AGENT.md §3.1a, §3.1c, §3.1d, §3.2, §3.3, §4 and §5, and docs/KNOWLEDGE.md §8–9 and §11. Build only this ticket. Branch `t12-gatekeeper`, one PR. No subagents. Stop after 3 failed fix attempts.

Background: ticket 14 adds the AI. This ticket builds everything around it, so the AI only ever sees messages that passed these checks. Until ticket 14, a text that reaches the end of the gate gets today's ack plus an attention item.

Deliver:
1. **`src/gate.ts`:**
   - `gate(env, conv, message)` runs the checks in exactly the order of AGENT.md §3.2. The safety check comes **first**: before the greeting, before the blocked check and before the HUMAN and quiet checks.
   - It returns one of: `CRISIS`, `EMERGENCY`, `IGNORE`, `GREETING`, `OPT_OUT`, `HANDOFF`, `HUMAN_WAIT`, `MEDIA`, `ACK_WORD`, `MENU`, `BOOKING_WORD`, `BUDGET_FALLBACK`, `TO_CLASSIFIER`.
   - Move the ticket 11 media, menu-word and first-message logic in here.
2. **Safety (`src/safety.ts`):**
   - The phrase lists from KNOWLEDGE.md §9 go into `config`.
   - Normalise before matching: lowercase, NFC, strip the nukta, map ँ to ं, strip punctuation, collapse spaces.
   - **CRISIS:**
     - Send the fixed crisis message in the person's language: English if unknown, or Hindi if the text has Devanagari.
     - Raise a `CRISIS` attention item and email Rohit at once. Subject "Urgent: crisis message"; the body has only the /admin link, never message text.
     - Set mode HUMAN and `no_sell_until` = now + 7 days.
     - It applies to everyone: blocked, quiet, HUMAN, over budget, a first-ever message. It also runs when the SENDS *switch* is paused, but not when the SENDS *env* flag is "false".
     - Never skipped by burst skip.
   - **EMERGENCY:** the fixed emergency message plus attention, same reach, no menu.
   - The safety check runs on every inbound text, including messages whose reply is burst-skipped.
3. **Per-person state:** a migration for `person_state` keyed by conversation id, with:
   - `strikes`, `last_strike_at`
   - `quiet_until`, `quiet_count_30d`, `last_quiet_at`
   - `smalltalk_day`, `smalltalk_count`
   - `ai_day`, `ai_count`
   - `media_notice_day`
   - `no_sell_until`
   - `ai_crisis_day`
   - `opted_out_at`

   All ISO UTC.
4. **Paying customer:** `isPayingCustomer(conv)` is true only for a PAID, CONFIRMED or RESCHEDULED intro or session, or a payment in state PAID, in the last 30 days. A hold alone doesn't count. Paying customers skip strikes and quiet, and get the higher AI cap.
5. **Strikes, quiet, blocks** (`applyLabel(env, conv, label, text)`), implementing the AGENT.md §4 table:
   - **3 strikes:** send `quietClose` once and set `quiet_until` = now + `config.noise.quietDays` (7). A second quiet period within 30 days becomes a block (`NOISE_REPEAT`).
   - **`flirt_or_sexual`:** one line plus a strike. Block (`NOISE_SEXUAL`) only if the text matches the config word list, or on a second offence.
   - **`abuse`:** no reply plus a strike. Block (`NOISE_ABUSE`) on a config word match, or on a second offence.
   - **`spam_or_promo`:** a strike, no reply.
   - **`smalltalk`:** the first 2 per IST day are free.
   - **Strikes clear** on payment, or 7 days after `last_strike_at`.
   - **During quiet,** `BOOKING_WORD` and booking button taps open the booking flow but don't end the quiet period. Payment ends it.
6. **Rule-based classifier for now:** `classifyWithoutAI()` returns `spam_or_promo` (a link plus "earn", "click" or "offer"), `flirt_or_sexual` or `abuse` from config word lists, and otherwise `TO_CLASSIFIER` → today's ack. Ticket 14 swaps in the AI.
7. **Short acknowledgements** ("ok", "okay", "thanks", "thank you", "ty", "ji", "👍", "🙏", "धन्यवाद", "शुक्रिया", "ठीक है"): no reply, no strike.
8. **Opt-out:** "stop", "unsubscribe", "बंद करो", "band karo" set `opted_out_at` and send `optOutConfirm` once. No template is sent to an opted-out person. Any later inbound message clears the opt-out.
9. **Burst skip:** before sending a reply to a typed message, if a newer inbound message exists from the same conversation, don't send. Record SKIPPED, reason `NEWER_MESSAGE`. Safety replies are exempt.
10. **Budgets in config:**
    - `aiRepliesPerPersonPerDay: 12`
    - `aiRepliesPerPayingCustomerPerDay: 40`
    - `aiRepliesPerDayTotal: 300`
    - Counted per IST day. Reaching a cap returns `BUDGET_FALLBACK`: the menu with "Talk to a person". The counters exist now; the AI isn't called yet.
11. **No selling while `no_sell_until` is active:** menus omit the Book button, and no message adds a booking button. Bookings the person starts themselves still work.
12. **9pm digest:** add counts (crisis, emergencies, blocks by reason, quiet periods, budget fallbacks, opt-outs) and a "warm leads" list. Warm leads are people with an expired hold or a booking tap in the last 24 hours and no payment, shown with first name and an /admin link only, never message text.
13. **/admin:** on the conversation page, show strikes, quiet-until, no-sell-until and opt-out, with "Clear strikes / end quiet" and "Clear no-sell" buttons (audited, CSRF-checked).
14. **Tests:**
    - Every gate path in both languages, including Roman Hinglish and nukta and chandrabindu variants of crisis phrases.
    - Crisis as a first message, in HUMAN mode, when blocked, during quiet and inside a burst.
    - Paying customers never filtered; a hold alone doesn't bypass.
    - 3 strikes → quiet; "book" during quiet; a second quiet → block.
    - Flirt and abuse block rules.
    - Ack words; opt-out.
    - Budgets.
    - No message text in logs or emails (extend the logging test).

14. **Already booked, checked at the tap:** "Book ₹99 call" from someone with an upcoming call sends `alreadyBookedStart` with [Keep it] [Talk to a person], and nothing else (AGENT §3.1a). Remove the late "already booked" check at the end of the flow, or keep it only as a safety net.
15. **Re-prompts (AGENT §3.1c):**
    - Store the open booking step on the conversation: `pending_step` plus the context needed to resend it.
    - A typed message while a step is open (and not safety, handoff, opt-out or a menu word) resends that step with `reprompt(hint)`, using `hintDays` for the day and time steps.
    - No strike. After 3 in a row, add "Talk to a person".
    - `TO_CLASSIFIER` keeps today's ack only when no step is open.
16. **Chat wipe (AGENT §3.1d):**
    - Add `CHAT_RETENTION_MINUTES` to env: top level and live `"10080"`, test `"10"`. The release test checks live is 10080.
    - The 2-minute cron blanks message bodies (inbound and outbound) for conversations whose last inbound message is older than that.
    - Move anything the code reads from old message rows (the greeted flag, the ack-once-per-24h check, the media-notice day, first-message question ids) onto `conversations` or `person_state` first, so the wipe never changes behaviour.
    - Keep dedupe keys and every money, booking, credit, audit and block row.
    - /admin shows "(message text removed)".
    - Remove names 90 days after the last booking, if that isn't already done.
17. **Tests for 14–16:**
    - Already booked at the tap.
    - Re-prompt at each step in both languages, including "Saturday please" at the day step.
    - The wipe: bodies blanked after the window on test settings, a returning customer isn't re-greeted, payments are untouched, and the language is kept.

Do not: call any AI API, add AI secrets, change booking or payment logic, change flags, or deploy.
Report: files changed, CI link, the exact crisis, emergency and re-prompt messages as sent in both languages, every config list you added, and the list of fields moved off `messages`.

---

## Ticket 13: sessions and packages (cap $22)

Read CLAUDE.md, CONTRACT.md (v5), STATUS.md, docs/AGENT.md §3.1b, and docs/KNOWLEDGE.md §2 ("Sessions and packages", "Refunds and changes") and the §11 package keys. Build only this ticket. Branch `t13-packages`, one PR. No subagents. Stop after 3 failed fix attempts.

Deliver:
1. **Prices in config:**
   - `intro` 9900, `single` 79900, `pack10` {sessions: 10, paise: 500000}, `pack20` {sessions: 20, paise: 900000} (paise).
   - Replace every use of `sessionPaise` (₹700).
   - The copy builds the prices and the per-session rates (₹500, ₹450) from config. A test checks the rates match price ÷ sessions.
2. **Menu:**
   - Buttons [Book ₹99 call] [Sessions & packages] [Help].
   - Help is a list: the 6 FAQ rows, then My bookings, Talk to a person, Change language. That's 9 rows.
   - Typed "human" and the other handoff words still work everywhere.
3. **Sessions & packages list and soft gate** (AGENT §3.1b steps 1–2).
4. **Single session purchase:**
   - Age check (once) → service → who for → day → time → guarded hold → ₹799 Razorpay link → confirmed.
   - This is the existing session machinery, so the same hold, overlap, webhook and refund rules apply.
5. **Packages:**
   - A migration for `packages` (conversation, size, price_paise, payment id, state, created_at) and `credits` (a ledger: package id, delta, reason PURCHASE | BOOK | CANCEL_RETURN | REFUND | ADJUST, session id, at, by).
   - **Balance** = sum of deltas, never stored separately.
   - **Buying:** a Razorpay link for the package price, with no slot held. Webhook PAID → +N credits (idempotent on the payment) → `packConfirmed` [Book a session].
6. **Booking with credits:**
   - Service → who for → day → time.
   - In **one** guarded write: check the balance is > 0 and the buyer has < 2 upcoming sessions, hold the slot, mark the session CREDIT_BOOKED, and add a −1 ledger row.
   - A double tap or a replay can never use two credits or book two slots.
   - Send `creditBooked`.
7. **My bookings:** list upcoming calls and sessions, with [Move] [Cancel] each, and the credits left.
   - Follow the AGENT §3.1b step 6 rules exactly, as checked by tests at 3 h and 24 h boundaries in IST.
   - **Move** reuses the day → time steps.
   - **Single-session cancel ≥ 24 h** refunds through the existing refund path (unique per payment).
8. **Amma's "Session" outcome:** the bot offers single, 10 or 20 (`sessionOfferBody`, a list).
   - On Amma's page, a booking shows "package 3/10" or "single".
   - "Not right fit" on a buyer's very first session (no prior intro) refunds the whole purchase, once per person, with the same undo window as today.
9. **Stopping a package:**
   - In /admin, on the conversation page: "Refund unused sessions" shows unused × rate, with a confirm step (audited).
   - It creates the refund through Razorpay if the payment is under 180 days old. Otherwise it raises `MANUAL_REFUND` and records a ledger row when Rohit marks it paid by hand.
   - Either way, the balance goes to 0.
10. **Reminders and templates:**
    - Credit-booked sessions get the existing day-before reminder.
    - Add template names `package_confirmed` and `session_booked` (UTILITY) to the registry, with `approved: false`. Outside the 24-hour window, raise attention instead of sending, as the contract says.
    - Draft their text in `docs/TEMPLATES.md` in both languages.
11. **Digest:** packages sold (count by size), credits used today, the outstanding credits total, and manual refunds pending.
12. **Tests:**
    - Purchase idempotency.
    - Credit booking under concurrency (two taps), the max-2 rule and a zero balance.
    - Cancel and move at the boundaries.
    - Not right fit at the first session.
    - The refund maths (unused × rate) for both packs.
    - The 180-day manual path.
    - Every new list and button within the WhatsApp limits in both languages.
13. **Docs:**
    - Update `docs/COPY.md`, and add to GO-LIVE.md that the website's fees, terms and refund page must show the same prices and rules before live (Rohit does this).
    - STATUS.md notes.

Do not: change the ₹99 flow's money logic, add AI, change flags, or deploy.
Report: files changed, CI link, the ledger design, and sample messages for buying a package, booking from credits, and moving and cancelling, in both languages.

---

## Ticket 14: the AI assistant (cap $20)

Read CLAUDE.md, CONTRACT.md (v5), STATUS.md, docs/AGENT.md §6–7 and all of docs/KNOWLEDGE.md. Build only this ticket. Branch `t14-ai-assistant`, one PR. No subagents. Stop after 3 failed fix attempts.

Deliver:
1. **Flag:**
   - Add `AI_REPLIES` to env, `"false"` everywhere in wrangler.toml.
   - The release test requires "false" at the top level and in live; test may be either.
   - Add an `AI_REPLIES` switch to /admin with the SENDS rules: the env is the master, and the switch can only pause.
   - Add `ANTHROPIC_API_KEY` to the secret names.
2. **`src/ai.ts`:** a plain `fetch` to the Anthropic Messages API, with no SDK.
   - **Config:** `config.ai.model` (look up the current Claude Haiku 5.5 model id in Anthropic's docs, and put the date checked in a comment), `maxTokens` 400, `timeoutMs` 8000.
   - **System block 1 (cached):** a short rules header plus the full `docs/KNOWLEDGE.md`, bundled at build time (wrangler text import, or a generated `src/knowledge.ts` that a test keeps in sync). Mark it with `cache_control`.
   - **System block 2 (not cached):** the trusted facts.
     - today's date in India
     - the chat language
     - `no_sell` true or false
     - booking facts: next call or session day, time, status and call language
     - package credits left, and whether the person has had a ₹99 call
     - `open_step`: the booking step waiting for a tap (from `pending_step`), or `none` (KNOWLEDGE.md §12, §17)
   - **Messages:** the last 10 messages of the conversation, oldest first.
     - Redact customer text before sending: digit runs of 6 or more, emails and URLs become `[removed]`, and any `<…>` tag is stripped.
     - Never send the phone number, WhatsApp name or payment ids.
   - **Output:** one tool matching AGENT.md §6, forced with `tool_choice`, validated with zod. Invalid output, a timeout or an HTTP error sends `aiFallback` plus the menu. Never retry the same message.
3. **Output check (`src/aicheck.ts`):**
   - **Normalise** as in ticket 12, and map Devanagari digits to 0–9.
   - **Reject** the reply and send the §11 fallback for its label group if any of these hold:
     - A banned word or phrase (config, seeded from KNOWLEDGE.md §8), matched as a **whole word or phrase**. "secure", "benefits" and "spiritual" must pass.
     - A URL, an email or a phone-like number.
     - A number not in the allowlist: config prices and per-session rates (also with commas, e.g. 5,000), package sizes, durations, hours, hold minutes, 2, 3 and 7; 18, 24, 30, 120 and 1980; the safety numbers 112, 108, 181, 1098 and 14416; numbers in the trusted booking facts. The full list is in KNOWLEDGE.md §8 ("Numbers you may write").
     - Characters outside Latin, Devanagari, digits, common punctuation, ₹ and 🙏 🌿.
     - Over 600 characters.
     - Mentions of "system prompt", "instructions" or "Anthropic".
   - Log only the rejection reason code.
4. **Wiring:**
   - `TO_CLASSIFIER`, and the stored first-message question after the language tap, → if AI is on, call the AI; otherwise keep today's ack.
   - `applyLabel()` (ticket 12) runs on the AI's label first. If a booking step is open (`pending_step`), send the checked reply as the body of that step's message, so it's one message, instead of the plain re-prompt. If it leads to a block, quiet or no reply, stop.
   - A `crisis` label → the fixed crisis path, at most once per person per IST day (`ai_crisis_day`). A `medical_emergency` label → the fixed emergency path. The AI's text is dropped in both cases.
   - Otherwise check the reply and send **one** message per AGENT.md §6 "How `next` is sent":
     - `show_booking` → interactive message, the reply as body, button [See call times]; just the reply if no-sell is active.
     - `show_menu` → the menu with the reply as its body.
     - `handoff` → the reply, then HUMAN plus attention (one open item at most).
     - `ask_more` / `none` → the reply only.
   - Count AI replies against the budgets.
5. **Eval set (`test/agent-evals/cases.json`):** all 145 scenarios from KNOWLEDGE.md §7, each with input text, a language, optional trusted facts, the labels allowed, the `next` values allowed, and `mustNotContain`.
   - **CI test with a fake AI:** canned outputs per case. It proves the wiring: gate, strikes, blocks, buttons, fallbacks, the output check, and the fake-facts case.
   - **Output-check unit tests:** whole-word matching, the number allowlist, Devanagari digits, the script check.
   - **Manual live eval workflow (`.github/workflows/eval.yml`):**
     - `workflow_dispatch` only, using the GitHub secret `ANTHROPIC_API_KEY` that Rohit adds.
     - It runs every non-code case against the real model and writes a table (case, label, next, pass/fail, the reply) to the job summary.
     - The cases are synthetic, so nothing real is published.
     - Pass bar: ≥ 95% labels, 100% of safety cases, 0 banned words.
     - It never sends anything to WhatsApp. It reports the average input, output and cached tokens per call.
6. **Handoff fixes, found in testing** (AGENT §3.2 step 6):
   - In HUMAN mode, menu words get the menu, and the mode stays HUMAN.
   - A new HUMAN_REQUEST emails Rohit at once, with the /admin link only and at most one per person per 6 hours.
   - The 2-minute cron returns HUMAN chats to BOT 24 hours after the handoff if no outbound reply from /admin has been sent since. The attention item stays open.
   - Tests for all three.
7. **Copy sync with KNOWLEDGE.md v3:** in `src/copy.ts`, update the crisis message (§9, now worded to fit someone worried about another person too) and the Hindi privacy FAQ (7 दिन, not 30, §11); regenerate `docs/COPY.md`.
8. **Docs:**
   - Put the privacy-page wording from KNOWLEDGE.md §10 into `docs/GO-LIVE.md` as a manual step.
   - In STATUS.md: how to turn AI on for test (key secret → flag in `[env.test.vars]` → deploy → switch), and the cost per reply measured by the live eval.

Do not: set `AI_REPLIES` to "true" anywhere, call the real API from CI tests, store AI replies outside the existing `messages` table and 30-day deletion, change booking or payment logic, or deploy.
Report: files changed, CI link, the system prompt header text, the tool schema, and any KNOWLEDGE.md line the eval showed was unclear.

---

## v3: Rohit's console redesign (council verdict, 23 Oct 2026)

Design: the council verdict in STATUS.md ("Console redesign"). Built in this session; each ticket is one PR.

### Ticket 15: save the ad click id and headline (cap $8)
- Migration `0009_ad_click.sql`: `conversations.ad_click_id`, `conversations.ad_headline`.
- The webhook keeps the first ad's `referral.ctwa_clid` (≤200 chars) and `referral.headline` (≤120 chars), like `source_ad_id`; a later ad never overwrites them.
- Test in `test/whatsapp.test.ts`. CONTRACT updated.

### Ticket 16: the console's look, and a new Home (cap $20)
- One layout (`src/ui.ts`): shared CSS (type scale, spacing, status colours, tabular numbers, 44px buttons, dark mode from the phone's setting), a bottom tab bar (Home · People · Payments), IST times and "x min ago", masked numbers (…4821).
- Home, top to bottom: a banner when anything is paused; a health line (cron, last send, AI replies today, last alert email); "Needs you" cards sorted crisis → human requests → money → the rest, each in plain words with who, what happened, what to do and the reply-window deadline; today and tomorrow; this week vs last in one line; the switches, each with a sentence on what stops and what still works.
- Dangerous buttons (Refund, Block, the switches) open a fold-out that names the exact action. No scripts; the CSP is unchanged.
- Email alert links open the exact item (`/admin#item-<id>`).

### Ticket 17: People, Person and Payments (cap $20)
- `/admin/people`: search by name, last 4 digits or booking id; filters All · Needs a person · Crisis · Quiet · Blocked.
- `/admin/conv/<id>`: header (name, …4821, mode, language, ad), reply box with time left or, when the window is closed, "Show number to call" (audited reveal + `tel:` link), the message thread with the assistant's answer type and replaced answers marked, bookings, payments, packages, safety state.
- `/admin/payments`: last 30 days, problems first, IST date, person, item, amount, status chip.

### Ticket 18: flow fixes from the test chat (cap $12)
From Rohit's test chat (17–26 Oct 2026). Bot flow only; no console or schema changes.
1. One rule for "already has a call", used at the Book tap, at the end of the flow and in My bookings: a paid call that has not ended yet (or a live hold). A past call still waiting for an outcome tap no longer blocks a new booking; it stays an AMMA_NO_TAP item for the practitioner.
2. The day step offers the first 3 working days that still have free times (a full day, or today late in the evening, is skipped), looking up to 10 working days ahead (`config.booking.lookaheadDays`).
3. A question typed during a booking step: a good answer does not count towards the "Talk to a person" offer (only unanswered turns do); an answer that fails or is rejected sends `repromptQuestion` (a warm line) above the step, never the bare "Please choose from the options below."; the rules header and KNOWLEDGE §13 say to end with a pointer to the step, never a question.
4. A Help answer comes with the menu buttons in one message when it fits the 1024-character body limit (`config.whatsapp.buttonBodyMax`).
5. "What is this?" says: no-touch pranic healing by phone with Shantha Rao, a certified MCKS Pranic Healer; the first step is a 15-minute ₹99 call (EN + HI).
6. While a person from the team has the chat (HUMAN), the first message gets one short acknowledgement (`humanWaitAck`), once per handoff (claimed by `last_ack_at` passing `human_since`; no migration).
Tests in `test/amma.test.ts`, `test/flow.test.ts`, `test/assistant.test.ts`, `test/copy.test.ts`. docs/COPY.md and src/knowledge.ts regenerated.

## v4: the role-based console, Phase 1 (PRD, 27 Oct 2026)

Spec: `docs/CONSOLE-PRD.md` (the PRD). Read it before any of these tickets; where a ticket and the PRD disagree, the ticket wins and you note it under "Blocked" in STATUS.md. Each ticket is one session, one branch, one PR; nothing is merged or deployed by the session.

**Order.** Tickets 19 and 20 first (they can run at the same time). Tickets 21–24 after both are merged; those four can run at the same time. Ticket 25 last. After 25, one review session reads every v4 PR for role leaks, masking and CSRF.

**Rules for all of v4.**
- No names in code, copy or tests: roles and settings only ("the practitioner", "{business}"). Existing `ROHIT_EMAIL`/`AMMA_EMAIL` are read only by the one-time member seed in ticket 19.
- Every console route lives under `/app`, behind `CONSOLE_V2` (env: `"false"` at the top level and in live, test may be `"true"`). The old `/admin` and `/amma` keep working until ticket 25.
- Every route and every button goes through `can(member, action, target)`. A hidden button and a refused POST must always agree; test both.
- Customer phone numbers: last 4 digits everywhere except an audited reveal. CSV exports are masked too.
- Server-rendered HTML, no scripts, the strict CSP (only `font-src 'self'` is added, in ticket 20). POST-only changes with Origin + per-form CSRF, as today.
- All console words come from the string catalogue (ticket 20), English and Hindi. No internal codes on screen (no "HUMAN", "SENDS", "AMMA_NO_TAP").

### Ticket 19: members, roles and the permission check (cap $22)
- Migration `0010_members.sql`:
  - `workspaces` (id, name, slug, time_zone, status), seeded with workspace 1.
  - `members` (workspace_id, email, display_name, role `OWNER|PRACTITIONER|STAFF`, locale, status `invited|active|removed`, last_seen_at); one role per membership; exactly one OWNER per workspace.
  - `invites` (workspace_id, email, role, token_hash, expires_at, invited_by).
  - `requests` (workspace_id, kind `REFUND|MARK_PAID|BLOCK`, target, amount_paise, asked_by, decided_by, decision, reason, created_at, decided_at).
  - `practitioner_id` on `slots`, `intros`, `sessions`; `workspace_id`, `member_id`, `reason` on `audit_log`.
- `src/auth.ts`: verify the Access JWT (as `allowedJwt` does today, but any verified email), load the active membership, refuse with a plain "No access" page otherwise. `can()` implements the PRD's permission table exactly (`yes | no | ask`), from one table in code.
- One-time seed on the first request when `members` is empty: `ROHIT_EMAIL` becomes the OWNER, `AMMA_EMAIL` the PRACTITIONER; existing slots, intros and sessions point to that practitioner.
- `/app` shell: the page frame, role-filtered tabs (placeholders for the screens), and `/app/settings/team`: invite by email (Cloudflare Email Service, one-time link, 7 days), change role, remove member, transfer ownership. All of it audited.
- Tests: every role × action in the permission table; a removed member is refused on the next request and their open forms fail; invite expiry and reuse; exactly one owner.

### Ticket 20: design system, fonts and strings (cap $18)
- Rewrite `src/ui.ts` to the PRD design system: the colour tokens (light and dark), 19 px body with nothing under 16 px, 48 px tap targets, tabular figures.
- Components: task card, appointment row, status chip, conversation bubble, confirm step (`details`), empty state, banner.
- Layout: under 900 px, a bottom tab bar (Today, Inbox, Calendar, People, More); from 900 px, a left rail and list-and-detail panes. Tabs come from the member's role.
- Self-host Jost and Noto Sans Devanagari (woff2, OFL; add them to NOTICE) at `/app/fonts/*` with a long cache; add `font-src 'self'` to the console's CSP only.
- `src/console-copy.ts`: the one string catalogue, English and Hindi, chosen by `members.locale`, with a language switch in the page frame.
- Hindi ships in Phase 1 for every screen a practitioner sees (decided 27 Oct 2026).
- Tests: every key has both languages; contrast of each token pair is at least 4.5:1 (computed in the test); the frame renders for each role with the right tabs.

### Ticket 21: Today (cap $22)
- `/app` (Today), in the PRD order: Safety, Waiting for a reply, Approvals (owner), Up next, Later, and Loose ends after the last call. Banners only for bookings paused, payments failing, bot not run for 15 minutes.
- Practitioner view: own calls and own customers' safety cards only; nothing about money.
- Up next rows: time, first name and last 4 digits, service, who it's for, call language. **Call** is an audited `tel:` reveal, shown only from 1 hour before to 1 hour after the call.
- **How did it go?** from the start time until 24 hours later. Three outcomes say what happens next; amounts come from settings. After a tap: "Saved. Undo until <time>" (`config.undoMinutes`). It reuses the existing outcome code, so behaviour matches `/amma`. "Report behaviour" sits under More.
- Approvals: one card per open `requests` row, with Approve and Decline. The decision runs the existing refund, block or mark-paid code and is audited.
- Tests: PRD acceptance checks 1, 2, 3 and 8; the role views; an empty day.

### Ticket 22: Inbox (cap $20)
- `/app/inbox`: chats in HUMAN mode and open safety follow-ups, oldest first, in three views: All, Mine and Unassigned. Each says why, how long they've waited and how long is left to reply.
- Thread with labelled bubbles. Reply inside the 24-hour window; after it, the approved follow-up template, ready to send. Staff never see the text of safety messages.
- Actions: Assign to me (others see who; the claim lapses after 30 minutes without a reply), Hand back to the bot, Done (one-line closing note), and Book or move for them. That last one is a real slot picker using the existing booking code: the payment link goes to the customer, or staff record money received, which creates a `requests` row.
- Email to staff and owner when a handed-over chat has had no reply for 2 hours in working hours (one email per chat).
- Tests: PRD checks 6 and 7; a staff member can't see safety text; booking for a customer holds a real slot.

### Ticket 23: People and the person page (cap $18)
- `/app/people`: search by name or last 4 digits; filters Waiting, Upcoming, Has a package, Blocked. A practitioner sees only customers booked with them.
- `/app/people/<id>`, top to bottom:
  - Header: name, last 4 digits, language, first contact, ad headline.
  - The next booking.
  - Package "N of M left", with a ledger from `credits`.
  - Payments.
  - The chat, with its deletion date.
  - The Safety panel, in plain words, with Allow bookings again (owner).
  - More (owner): show full number (reason required), block, remove their data.
- Record money received outside Razorpay (staff → a `requests` row; owner → applied directly). Opening the page is audited.
- Tests: PRD check 9; practitioner scoping; the plain-words safety panel for each state; the reveal needs a reason.

### Ticket 24: Payments, Settings and the audit log (cap $20)
- `/app/payments` (owner): problems first (failed or stuck refunds, amount mismatch, paid with no booking), each with its next step; any month's received, refunded and net, plus sessions owed on packages; masked CSV export; payment statuses in words.
- `/app/settings` (owner):
  - Business: name, accent, default language.
  - Services and prices: a `settings` table, which the bot reads with the config values as fallback.
  - The bot switches (moved from /admin, same env-is-master rule).
  - Daily summary recipients and the safety contact (alerts go to them; the default safety contact is the owner).
  - Privacy: chat retention shown, and whether staff can read chat text (on by default; safety messages are always hidden from staff).
  - System: today's health checks, moved here.
  - Audit log: filter by member and action; rows from before roles show "before roles".
- The 9 pm summary email uses the console's words.
- Tests: the bot quotes prices from settings; exports are masked; only the owner reaches these pages.

### Ticket 25: switch over (cap $10)
- With `CONSOLE_V2` on, `/admin` and `/amma` redirect to the matching `/app` page, and alert emails link to `/app`.
- With it off, nothing changes (the rollback).
- STATUS.md gets the owner's hand steps: test on the test bot, then change the Access policy to "any verified email" by hand (a Cloudflare setting, never a deploy), then switch on in live.
- The old pages are removed in a later release, not in this ticket.
- Tests: redirects with the flag on and off; an old email link lands on the right `/app` page.

### Ticket 26: console follow-ups and contract decisions (cap $20)
The owner decided every open v4 question in the session of 27 Oct 2026 ("yes to all"). One session, one branch, one PR.
1. CONTRACT.md updates, then clear the matching "Blocked" entries in STATUS.md:
   - a. Money received outside Razorpay: the owner may record it (or approve a staff request), and that confirms the booking, audited with a reason.
   - b. Prices: config holds the defaults; the owner's changes from Settings live in the settings table.
   - c. Practitioners may read (read-only) the chats of customers booked with them; never others'; staff never see safety-message text.
   - d. Templates: add `follow_up` (UTILITY, no variables) and `follow_up_hi` to the list; they stay `approved: false` until Meta approves them (a hand step in STATUS: submit the docs/TEMPLATES.md §8 draft in Meta, then flip the flag by PR).
   - e. Email: only to verified addresses (DIGEST_TO, and member addresses the owner has verified in Cloudflare Email Routing; say so next to the Settings recipient choice). Invites are not emailed: the team page shows the one-time link with a "Send on WhatsApp" link (`https://wa.me/?text=` + the encoded message and link) and a copy-able field.
2. Ticket 21's `decideRequest()` MARK_PAID approval runs ticket 23's `applyMoneyReceived()`, so approving confirms the booking (one shared path, in src/requests.ts). The Inbox staff cash booking whose 20-minute hold has lapsed follows the existing late-payment rule on approval (the same time if it is still free, otherwise the owner is told); never a double booking.
3. People: practitioners see their own customers' chats, read-only (`PRACTITIONER_CHAT`); staff safety masking unchanged.
4. Team page hand-over: the outgoing owner chooses Practitioner or Staff on the form (default Practitioner).
5. Settings apply everywhere: the workspace accent colour in `consoleFrame` on every /app page, and `privacy.staff_read_chat` (off: staff see "Chat text is hidden by the owner" instead of message text) in Today, Inbox and People.
6. The assistant and prices: the current prices (settings, config fallback) go into the AI trusted facts and the output-check number allowlist; the rules header and docs/KNOWLEDGE.md say prices come from the trusted facts; src/knowledge.ts regenerated the repo's way. The ai, aicheck and agent-evals tests keep passing.
7. Inbox: "Book or move for them" can also move a paid ₹99 call, on the existing call-reschedule code path (as for a missed call: one free move, same rules), audited.
8. The PRD's bundled "ask owner" email: one email to the owner at most every 30 minutes listing open `requests` rows (cron, claimed in settings like the other alerts), in plain words.
- Rules: keep edits to src/admin.ts, src/amma.ts, src/index.ts, src/report.ts, src/safety.ts and src/watch.ts minimal (ticket 25 changes redirects and email links there at the same time); no URL or link strings change. STATUS.md edits are additive (the session note and the Blocked clean-up).
- Tests for every item.

### Ticket 27: Calendar and a console polish pass (cap $16)
The owner's feedback from the test console (28 Oct 2026): "Calendar is not clean, both the screens aren't great, fix this and any other subtle things." One session, one branch, one PR.
1. **Calendar** (`src/calendar.ts`, replacing the placeholder): on `consoleFrame` like every other screen. Day and Week views (links, no script), this week by default, with previous / next and "Today" links. Each day lists its calls, sessions and live holds in time order (time, first name and last 4 digits, service, kind, status chip in words, a link to the person page), the free times left that day (from the existing slot generator) and the working hours line (Mon–Fri 2–7 pm India time, from config). Practitioners see only their own; owner and staff see all, with a practitioner filter only when there is more than one. Weekend and no-hours days say so plainly. An empty week says "Nothing booked this week. Next booking: …". Editing hours and time off stays Phase 2: one quiet line says so, no dead buttons.
2. **No page on the old look:** every remaining /app page (placeholders, the team page, invite accept, "No access", the moved-page notice, error pages) moves onto `consoleFrame` / src/ui.ts components and the Jost fonts. The old /app frame is deleted when nothing uses it.
3. **Chat threads (Inbox and the person page):** consecutive messages whose text was wiped collapse into one quiet line ("12 earlier messages were deleted after 7 days, for privacy"); taps show as their label ("Tapped: Book ₹99 call"); templates and interactive sends get a short description; never an empty bubble.
4. **Inbox detail:** the actions (reply box or the follow-up state, Assign to me, Hand back to the bot, Done, Book or move) sit right under the header, before the thread; the thread shows the latest 20 with a "Show earlier messages" link. The reply-window state shows once in the detail header and once in the list row, never twice in one pane; red is kept for safety only.
5. **Workspace name:** while the workspace still has the seeded default name, the frame shows a neutral label and the owner gets one quiet task on Today ("Add your business name in Settings"). No personal or business names in code.
6. **Polish sweep:** render every /app screen for owner, practitioner and staff, English and Hindi, 390 and 1366 px, light and dark, with realistic synthetic data, using Playwright from a scratch script outside the repo; fix spacing, alignment, chip wrapping, mixed button sizes, heading scale, empty areas, text under 16 px, tap targets under 48 px, horizontal scroll and dark-mode contrast. The PR lists the fixes.
- Rules: no names, secrets or real numbers; no merge or deploy; no Cloudflare, Meta or Razorpay changes.
- Tests: the Calendar (role scoping, day and week, empty week, weekend) and the thread collapsing; every existing test stays green.

### Ticket 28: one cron per Worker (cap $6)
The first Deploy → live (28 Oct 2026) failed at the last step: "This account has reached the Workers Free limit of 5 cron triggers per account." Test used 3 and live needs 3. Rohit chose to stay on the free plan for now.
1. Each environment has one cron, `*/2 * * * *`. The 6:30 pm IST reminders and the 9 pm IST digest run from it, once per IST day, on the first tick at or after their time (a missed tick only delays them by 2 minutes).
2. The day's run is claimed with one `settings` row (`daily:<job>:<IST day>`), given back if the job fails so the next tick tries again. Reminders are not claimed while SENDS is paused, so resuming sends the same evening still sends them (unchanged behaviour).
- Rules: no new migration; no merge or deploy; no Cloudflare, Meta or Razorpay changes.
- Tests: too early, on time, once a day, a missed tick, paused sends, the digest time, the next day, a failed job; every existing test stays green.

### Ticket 29: payment links that always open the payment page (cap $12)
Found on the live bot (29 Oct 2026): WhatsApp (India) re-rendered our `cta_url` pay button, whose URL was the Razorpay `rzp.io` short link, as its own "enhanced payment link" card ("₹99.00 · Pay with UPI/Visa/Mastercard · Pay now"). "Pay now" fired a UPI intent; on the owner's phone that opened WhatsApp's own UPI setup, which asked him to change his WhatsApp number, and the Razorpay page never opened. Meta's enhanced-payment-links doc: only links from Razorpay/PayU/Cashfree with supported prefixes get the card; "Wrapped or redirected links don't qualify". Customers abroad can't use UPI at all. The owner wants every customer to reach the Razorpay page and pay, with clear words, every time.
1. **Our own link.** Every payment message points at `<PUBLIC_URL>/p/<token>`, never the Razorpay URL. `token` = `<payments.id>-<first 16 hex of HMAC-SHA256(RAZORPAY_KEY_SECRET, "paylink:" + payments.id)>` (no new secret). The Razorpay short_url and the link's expiry are stored when the link is made, without a migration: one `settings` row per payment, key `paylink:<payments.id>`, value JSON `{url, until}`. Absolute links are built from PUBLIC_URL as for the email links.
2. **GET /p/:token**, public (not under /amma, /admin or /app). The HMAC is checked with a constant-time compare; a bad or unknown token gets a friendly 404 page. Then by the payment's state and the stored `until`:
   - PENDING/CREATING before `until` → `302` to the stored Razorpay URL, `Cache-Control: no-store`. No Razorpay call on this path.
   - PAID (or REFUND_*) → "Payment received. Your booking is confirmed; the details are in WhatsApp. You can close this page."
   - FAILED/UNKNOWN or past `until` → "This payment link has expired. Your time is no longer held. Go back to WhatsApp and tap Book again." with a button to `https://wa.me/<config.businessNumber digits>`.
   - Tiny server-rendered pages: mobile first, 18 px text, one clear button, the business's look, a strict CSP with no scripts, `noindex`; English or Hindi by the conversation's locale (copy in src/copy.ts).
3. **The message.** The `cta_url` button stays (same label, ≤ 20 chars) with our `/p/` link. The three pay bodies (intro, session, package; EN and HI) say: the time is held until <clock time, India time>; tap the button to open Razorpay's secure payment page; pay by any UPI app, card or net banking; "Please don't pay twice."; and below that "If the button does not open, use this link: <the /p/ link>". Well under 1024 chars.
4. **Nudge before the hold ends.** If nothing already tells the customer: one WhatsApp text about 8 minutes before `until` for a PENDING payment (SENDS on, inside the 24-hour window, once per payment, deduped with a settings row): "Your time is still held until <time>. Pay here: <link>. Having trouble paying? Reply HELP and we will help you." (EN/HI). Extend an existing equivalent instead of duplicating it.
5. **Docs:** docs/COPY.md (generated) and one line in docs/GO-LIVE.md: in the Razorpay dashboard (Live) all methods on: UPI, cards (incl. international), net banking.
- Rules: no migration, no new secret; no merge or deploy; no Cloudflare, Meta or Razorpay changes.
- Tests: the token (right, tampered, another payment's; constant-time compare); each /p/ state, and Hindi; the three flows send a cta whose URL and body carry the `/p/` link, and the settings row is written; the nudge (once, not when paid, not outside the window, not while SENDS is paused); every existing test stays green (tests of the old body or the Razorpay cta URL are updated, not deleted).

### Ticket 30: six booking days, Monday to Saturday, holidays, and "she calls you" (cap $14)
The owner's requests for the launch (29 Oct 2026). On live `CONSOLE_V2` is "false", so the owner and the practitioner use /admin and /amma; anything they need tomorrow works there, and also on /app so it survives the switch-over.
1. **Mon–Sat.** Working days are Monday to Saturday (`config.hours.days` = [1..6]); hours stay 2–7 pm India time. Every place that says Monday to Friday or weekdays (copy, docs/KNOWLEDGE.md and src/knowledge.ts, the console, docs, tests) follows.
2. **Six days to choose from.** The day step offers the first 6 working days that still have a free time, as one WhatsApp list message (row title "Fri, 30 Oct", a short description, the button ≤ 20 chars, "(India time)" in the body), looking far enough ahead to find 6. Every flow that picks a day (the ₹99 call, a single session, a package session, moving a session) uses it, in English and Hindi. Old day-button ids keep working.
3. **Holidays.** The owner or the practitioner marks a date as a holiday (no new bookings that day) and removes it again, on /amma, /admin and /app Calendar: a date (today to 60 days ahead), an optional owner-only reason (never shown to customers), "Mark as holiday", and the upcoming holidays each with "Remove"; plain POST forms with the pages' CSRF and Origin rules, audited. Stored without a migration (`settings` rows `holiday:<YYYY-MM-DD>`). Every slot offer and every hold skips holiday dates. Bookings already on that day stay as they are (never cancelled or messaged automatically): the page lists them with a warning and a Needs-you item is raised. The /app Calendar shows the day as "Holiday". /app: `set_hours` (owner yes, practitioner own, staff no).
4. **"She calls you".** The call confirmation, the moved-call message and the `call_booked` template no longer give the business number: she calls the customer's phone at the booked time, the call may come from a number they don't know, keep the phone nearby, and this WhatsApp number is for messages only. The template loses its number variable (docs/TEMPLATES.md in step; still `approved: false`).
5. **"Call me".** A short typed message asking to call or for a number (`config.words.callRequest`) gets one friendly line in the menu message: we don't take calls on this number; the quickest way to talk to Shantha Rao is the ₹99 call, where she calls you. Not for HUMAN, blocked or quiet chats, the crisis no-sell week, a message about a call she makes ("she didn't call me"), or a paying customer or someone with a booking coming up. No number is ever given.
- Rules: no secrets or real numbers; no merge or deploy; no Cloudflare, Meta or Razorpay changes.
- Tests: Saturday offered and Sunday never; the day list (6 rows, only free days, holidays skipped, both languages, every flow, old ids); holidays on /amma, /admin and /app (roles, audit, the warning, past dates refused, the day hidden everywhere); the copy and the template without the number; the call-request reply and where it doesn't apply; every existing test stays green.

### Ticket 31: fixes from the launch simulations (cap $20)
A QA run (29 Oct 2026) simulated 84 launch-day scenarios against main (Ticket 29 merged) with the live flags (AI_REPLIES "false", SENDS "true", NEW_BOOKINGS "true", no template approved). Fix the findings below, with tests, in this order. The id after each item is the finding in the QA report. Ticket 30 (day list, Mon–Sat hours, holidays, the call wording without a number, "call me" replies) runs at the same time: none of that is in this ticket, and edits in those spots stay minimal.
1. **B1** A past time, or one inside `config.booking.leadMinutes`, is refused in the hold itself for every kind (call, session, package-credit booking), with the times list again.
2. **B2** An unpaid hold is never described as a booked call: the same time again re-sends the pay step (same link while held); a different time releases the old hold (payment FAILED, intro EXPIRED, the slot freed) and holds the new one.
3. **B3** A second paid ₹99 call for the same person while one is already PAID/upcoming is a duplicate: refunded automatically through the existing refund path, the customer told (EN/HI), an attention item raised.
4. **B4** A late payment for a time someone else has taken: the customer is told (the existing late-payment rule: the team offers a new time or a refund), and the /p/ page no longer says "confirmed".
5. **I1** With the assistant off: a small fixed-answer router (EN, HI, Roman Hindi) for price, what Pranic Healing is, how the call works, is it real, refunds, abroad (time zone, paying), in person, "when is my call", medical conditions (no claims; the crisis and emergency checks stay first) and "book", built only from docs/KNOWLEDGE.md and the Help copy, each with the menu buttons. Anything else: one honest line ("I'm the booking assistant and can't answer typed questions…") with the menu, at most once per N minutes. A human reply is promised only after "Talk to a person". Non-genuine messages (spam, links, promotions, agencies, job seekers, threats, vashikaran, scams) use the noise and strike rules: no promise, no item for obvious spam, a firm one-liner at most (I16).
6. **I3** Emergency phrases in the present tense only ("having a stroke", "took poison", "fainted just now"); a first message that was answered with the emergency text still gets the greeting.
7. **I4** A payment confirmation or refund notice skipped while SENDS was paused is sent once when sends resume.
8. **I5** AMMA_AWAY: no day-before reminders while away; the owner has an item per booking.
9. **I6** After a package is paid, "hi" shows the menu, not Amma's session offer.
10. **I7** "We're refunding your ₹99" only once Razorpay has accepted the refund, with the timing ("usually 5–7 working days"); a refusal goes to the owner, not the customer.
11. **I8** Typed answers to an open step ("yes", "haan", "ok", "1", the button's words, "English"/"hindi", a day, a time) count as the tap.
12. **I10** No free times: a clear message with "Talk to a person", and an item.
13. **I11** A hold that ends unpaid: one message, "Your held time has been released. Tap below to choose a time again." with a button (inside the window, SENDS on, BOT mode only).
14. **I12** The Razorpay contact is the full international number, from one helper used by all three links.
15. **I13** Repeated identical greetings within a short time get nothing after the first menu, and count toward the noise rules.
16. **I14** A handoff that returns to the bot unanswered tells the customer once, honestly; the owner is emailed.
17. **I17** Username-only senders (no phone number) raise an item instead of vanishing.
18. **I19** A mismatched payment: the customer is told it is being checked today.
19. **I20** "Booking opens soon." gets "Talk to a person" and Help buttons.
20. **Pay page:** /p/ serves a tiny "Opening Razorpay's secure payment page…" page (meta refresh, a Continue button, no scripts, no-store) instead of a bare redirect.
21. **I2 (wording)** Until the reminder template is approved, a confirmation never promises "We will remind you the day before" when the reminder could not reach the customer.
- Skipped (next): I9 (move or cancel the ₹99 call), I15 (missed-call times over 3 days), I18 (call language and number for a family member).
- Rules: no merge or deploy; no Cloudflare, Meta or Razorpay changes; no names, secrets or real numbers.
- Tests for every item; every existing test stays green (tests of the old behaviour are updated, not deleted).

### Ticket 32: Instagram and Messenger DM replies (cap $20)
The owner wants free automatic replies to Instagram DMs (@disha_dira), Facebook Messenger (the Page "Disha Dira Pranic Healing") and comments, instead of paying for ManyChat: ask people to follow us ("we share a short Pranic Healing tip every week"), and once they follow, guide them to book on WhatsApp. No calls; no number shown except inside the wa.me link. Official Meta APIs only (Messenger Platform and the Messenger API for Instagram through the Page); the docs used are in the header of src/social.ts.
1. **Webhook** `GET/POST /meta/webhook` (src/social.ts): GET verification with a new secret `META_VERIFY_TOKEN`; POST checks `X-Hub-Signature-256` with the helper from src/whatsapp.ts and `META_APP_SECRET` (a separate Meta app) or else `WA_APP_SECRET`; `object: "page"` and `object: "instagram"`. /wa/webhook is unchanged. Public route. Ignored: our own echoes, reads, deliveries, reactions, story mentions, deleted messages, no sender, another account. 200 fast.
2. **Sending**: the Send API with the Page token `META_PAGE_TOKEN`, `META_PAGE_ID`, `META_IG_ID` (all Worker secrets); button templates and quick replies; failures logged by code only.
3. **The flow** (owner's order, 30 Oct 2026, EN and HI; Devanagari or common Roman Hindi words → Hindi): any first DM or comment gets only the follow ask ("Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap below and our booking assistant will help you with a session." [Visit profile / Open our Page] [I'm following / I've followed]); its topic is kept as a code. Instagram checks `is_user_follow_business` (not yet → one "not yet" message; the second tap goes through anyway; an API failure goes through). Messenger: the tap goes through. Then one line on the first message's topic (price, booking, where/abroad, what Pranic Healing is, how the call works, the ₹99 refund rule; never a medical answer), and the guide with [Book on WhatsApp] (wa.me with "Hi, I'd like to book a ₹99 call") and quick replies [Book a ₹99 call] [Prices] [About Pranic Healing] [How the call works], each answered in one line with [Book on WhatsApp]. After that, one "message us on WhatsApp" line a day; after 30 days without a message the flow starts again. A manual message from the Page or account pauses the automation for that person for 24 h. At most 3 automated messages per person a day (the messages after the follow excepted); spam and links get the first follow ask at most. Crisis words: the WhatsApp bot's Tele-MANAS message, no follow ask, no selling for a week, an owner item and email; emergencies: the 112 / 108 message.
4. **Comments** (owner's addition): a comment on an Instagram post or reel or a Page post gets one private reply (recipient `comment_id`) with the follow ask, starting the same flow: one per commenter per post, not for our own comments, not for anyone who had the link in the last 30 days, within the daily limit and the switch; an optional public reply ("Sent you a DM 🙏") behind `config.social.publicReply`, off. No comment text stored.
5. **State**: `migrations/0012_social.sql`: `social_contacts` (platform id, language, step, topic code, times, counters; no text, no names) and `social_seen` (ids for dedupe, our sent message ids, one-reply-per-post keys), cleaned on the 2-minute cron. "delete my data" in the chat deletes the row at once.
6. **Switch**: `SOCIAL_REPLIES` ("false" at the top level, test and live); off, the webhook verifies and answers 200 and nothing is stored or sent. The /admin Sends pause applies too.
7. **Data deletion page** `GET /data-deletion` (public, EN) for Meta App Review.
8. **Docs**: docs/SOCIAL.md for Rohit (the fastest path first: a new app in the Page's own portfolio on Standard Access; the shared-Page alternative; App Review as the fallback; permissions, webhook fields, the Page token, the Instagram setting, the Business Suite instant reply, the switch; the website privacy page).
- Rules: no merge or deploy; no Cloudflare, Meta or Razorpay changes; no secrets, names or real numbers.
- Tests: verification, signatures (and META_APP_SECRET), the ignore list, the follow ask, topics EN/HI and no medical answers, the follow check yes/no/second tap/failure, Messenger, the guide and quick replies, the after-follow line, the cap, the human pause, our own echoes, the switch, no text stored, retries, safety, comments (private reply, dedupe, skips, 30-day memory, cap, fallback to text, public reply), the clean-up, the deletion page, the WhatsApp webhook untouched.

### Ticket 33: Instagram and Messenger FAQs and short links
Rohit's requests after the live test of 31 Oct 2026: "1. For it to answer more faqs (as it does on WhatsApp) 2. The follow link and the WhatsApp link on FB page is a bit too long."
1. **More FAQs**: typed questions on Instagram and Messenger get every answer the WhatsApp fixed-answer router gives (src/router.ts, config.router.topics; the FAQ copy in src/copy.ts from docs/KNOWLEDGE.md), EN and HI by the contact's language, from the same copy (no new facts). Social's own topics and quick replies stay as they are. WhatsApp-only wording is adapted (no *bold*; "Talk to a person", "Help", "My bookings" are "on WhatsApp"); "when is my call" and payment problems point to WhatsApp. Illness questions get WhatsApp's careful medical answer; safety still runs first. Each answer comes with the way to WhatsApp. Before the follow: the line in the ask again; after the link: each topic once a day per person, otherwise the pointer every 6 hours. "Why should I do pranic healing?" gets the Pranic Healing answer.
2. **Instagram pointer**: the text no longer writes out the wa.me link (the button has it).
3. **Short links** on the Worker (public, using PUBLIC_URL; the long link when unset): `GET /b/<ref>` (EN), `/b/<ref>/hi` (HI) → 302 to the same wa.me link with the same prefilled text and ref; anything not in the ref format → 302 to plain wa.me (never a 404, never echoing input); `GET /fb` → the Facebook Page, `GET /ig` → the Instagram profile. Messenger texts use them.
- Rules: no merge or deploy; no Cloudflare, Meta or Razorpay changes; no secrets, names or real numbers.
- Tests: the routes (valid EN/HI, invalid, /fb, /ig), FAQ answers on both platforms EN/HI, the Instagram pointer, lengths and no numbers in every answer; WhatsApp tests stay green.
