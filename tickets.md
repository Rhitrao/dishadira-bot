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
7. **Docs:**
   - Put the privacy-page wording from KNOWLEDGE.md §10 into `docs/GO-LIVE.md` as a manual step.
   - In STATUS.md: how to turn AI on for test (key secret → flag in `[env.test.vars]` → deploy → switch), and the cost per reply measured by the live eval.

Do not: set `AI_REPLIES` to "true" anywhere, call the real API from CI tests, store AI replies outside the existing `messages` table and 30-day deletion, change booking or payment logic, or deploy.
Report: files changed, CI link, the system prompt header text, the tool schema, and any KNOWLEDGE.md line the eval showed was unclear.
