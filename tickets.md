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
| 12 | The gatekeeper (noise, safety, quiet periods) without AI | $15 |
| 13 | The AI assistant | $20 |


## Ticket 11: English + Hindi, and a clear booking flow (cap $15)

Read CLAUDE.md, CONTRACT.md (v4), STATUS.md, docs/AGENT.md §2–3 and docs/KNOWLEDGE.md §10–11. Build only this ticket. Branch `t11-hindi-booking`, one PR. No subagents. Stop and report after 3 failed fix attempts on the same problem.

Deliver:
1. **Languages:**
   - Remove Kannada everywhere (`kn` copy, `LANGUAGE_BUTTONS`, config `languages`, docs).
   - Add Hindi (`hi`) using KNOWLEDGE.md §11. Where a §11 string names a price, duration or hold time, build it from `config`.
   - Existing conversations with locale `kn` are treated as `en`, with a migration to update them.
   - Amma's page copy stays English only.
   - Add a test that fails if any copy value contains `KN_TODO`, or if a key exists in one language but not the other.
2. **Greeting:** one bilingual message with the disclosure text from KNOWLEDGE.md §10, then the buttons [English] [हिंदी].
3. **Menu:**
   - Buttons: [Book ₹99 call] [How it works] [Talk to a person], with the body from §11 ("…or just type your question").
   - The "How it works" list keeps the FAQ rows and adds "Change language / भाषा बदलें", which resends the language buttons.
4. **Talk to a person:**
   - Set the conversation mode to HUMAN, raise a `HUMAN_REQUEST` attention item and send the handoff ack.
   - Resolving that attention item in /admin sets the mode back to BOT. Check /admin and add this if it's missing.
5. **Menu words:** after the first greeting, a text that is only a greeting or menu word (case-insensitive, after trimming spaces and punctuation) gets the menu. No attention item, no ack. The words: hi, hii, hello, hey, namaste, namaskar, menu, start, नमस्ते, नमस्कार, हाय, मेनू.
6. **Non-text messages** (audio, image, video, sticker, document, location, contacts):
   - The first one each day gets `mediaNotice` plus the menu. Later ones the same day get no reply.
   - Media is never downloaded.
7. **New booking steps before the hold**, all with fixed copy:
   - **Age check, once per person:** "18 or older?" [Yes] [No]. Store `age_ok_at` on the conversation. A No gets `ageNo` and stops.
   - **Service:** [Healing] [Protection], as today.
   - **Who for:** [Me] [Family member] [Pet]. Store it on the intro as `for_whom` (SELF | FAMILY | PET).
   - **Day:** reply buttons for the next working days with at least one free slot, at most `config.booking.workingDays` (3). Labels: EN "Wed, 21 Oct", HI "बुध, 21 अक्टू". If none are free, send `noSlots`.
   - **Time:** a list for that day.
     - At most 9 time rows plus a final "Another day / दूसरा दिन" row that resends the day step.
     - Two sections: Afternoon / दोपहर before 4 pm, Evening / शाम after.
     - With more than 9 free slots, spread them: prefer :00 and :30, and use :15 or :45 only to fill a taken half hour.
     - Row titles: EN "2:30 pm", HI "दोपहर 2:30" or "शाम 5:30".
     - Row description: "15-min call" / "15 मिनट की कॉल" (or 60 for sessions).
   - **Call language:** [English] [हिंदी], with the chat's language listed first. Store it on the intro as `call_lang`.
   - Then the existing guarded hold and payment step, unchanged. `payBody` and `sessionPayBody` become functions of day and time (§11).
   - The session time picker (after Amma's "Session" outcome) uses the same day-then-time steps, with no age, service, who-for or language steps (they are already known).
   - Old `slot_` row ids already in people's chats must still work, or get the day buttons again. They must never cause an error.
8. **Amma's page:** show the call language and who it's for next to each name, e.g. "Priya · Hindi · family". Nothing else changes there.
9. **Dates and times** everywhere a customer sees them (confirmations, reminders, reschedules, "already booked") use the person's language: weekday, day, month and time formats from §11, all in India time.
10. **Timings FAQ** in plain words from `config.hours`, as in §11.
11. **Tests:**
    - Every new step and every limit in both languages: button ≤ 20 chars, row title ≤ 24, row description ≤ 72, section title ≤ 24, list button ≤ 20, body ≤ 1024.
    - The day/time spread rule, and old slot ids.
    - The age gate is asked only once.
    - Media notice once per day; menu words.
12. Update `docs/COPY.md` to match `src/copy.ts`, and add a STATUS.md note.

Do not: change prices, hours, slot lengths, hold or payment logic, or any flag in wrangler.toml; add any AI; deploy.
Report: files changed, CI link, and a sample of every new message in both languages exactly as WhatsApp will show it.

---

## Ticket 12: the gatekeeper (noise, safety, quiet periods) without AI (cap $15)

Read CLAUDE.md, CONTRACT.md (v4), STATUS.md, docs/AGENT.md §3.2, §3.3, §4 and §5, and docs/KNOWLEDGE.md §8–9. Build only this ticket. Branch `t12-gatekeeper`, one PR. No subagents. Stop after 3 failed fix attempts.

Background: ticket 13 adds the AI. This ticket builds everything around it, so the AI only ever sees messages that passed these checks. Until ticket 13 lands, a typed message that isn't caught here behaves as it does today: the ack plus an attention item.

Deliver:
1. **`src/gate.ts`:** one function `gate(env, conv, message)` that returns one of:
   - `IGNORE`
   - `CRISIS`
   - `EMERGENCY`
   - `MEDIA_NOTICE`
   - `MENU`
   - `BOOKING_WORD`
   - `BUDGET_FALLBACK`
   - `TO_CLASSIFIER` (passes the text on)

   It runs the checks in the order of AGENT.md §3.2. Keep the ticket 11 behaviour for media and menu words, moved in here.
2. **Safety detectors** (`src/safety.ts`):
   - Crisis and emergency phrase lists from KNOWLEDGE.md §9 go into `config`. Normalise before matching: lowercase, strip punctuation, collapse spaces, NFC for Devanagari.
   - **CRISIS:**
     - Send the fixed crisis message in the person's language.
     - Raise a `CRISIS` attention item and email Rohit at once, using the existing email path. The subject says "Urgent: crisis message"; the body has only the conversation link and no message text.
     - Set `no_sell_until` = now + 7 days.
     - This runs even when the person is quiet or past their budget, and even when SENDS is paused by the switch (but not when the env flag is off). Write down the reasoning in STATUS.md.
   - **EMERGENCY:** send the fixed emergency message, raise an attention item and send no menu.
   - While `no_sell_until` is in the future, no message to this person may include a booking button or `show_booking` nudge. Bookings the person starts themselves still work.
3. **Per-person state:** a migration adding a `person_state` table keyed by conversation id, with:
   - `strikes`, `last_strike_at`
   - `quiet_until`
   - `smalltalk_used`
   - `ai_replies_day`, `ai_replies_count`
   - `media_notice_day`
   - `no_sell_until`

   Times are ISO UTC.
4. **Strikes and quiet:**
   - **`applyLabel(env, conv, label)`** implements the AGENT.md §4 table.
     - A strike adds 1. At 3 strikes, send `quietClose` once and set `quiet_until` = now + `config.noise.quietDays` (7).
     - `flirt_or_sexual` and `abuse` block through the existing blocks table, reason `NOISE_SEXUAL` or `NOISE_ABUSE`, by `system`. `flirt_or_sexual` gets one line first; `abuse` gets no reply.
     - `spam_or_promo` is a strike and gets no reply.
   - **Reset:** strikes reset 7 days after `last_strike_at`, and on any PAID intro or session.
   - **During quiet:** only a booking button tap or the typed word "book" / "बुक" (`BOOKING_WORD`) gets a reply, and either clears the quiet period and the strikes.
   - **Never filter existing customers:** if the person has an intro or session that is HELD, PAID, CONFIRMED or RESCHEDULED, or a payment in the last 30 days, they skip strikes, quiet and budget.
   - For now, `applyLabel` is called by a small rule-based `classifyWithoutAI()`: spam (links plus "earn" or "click"), obvious sexual words and obvious abuse words, from config lists. Everything else is `TO_CLASSIFIER` → today's ack. Ticket 13 swaps in the AI.
5. **Burst skip:** before sending any reply to a typed message, check `messages` for a newer inbound message from the same conversation. If one exists, don't send. Record SKIPPED with reason `NEWER_MESSAGE`.
6. **Budgets in config:** `aiRepliesPerPersonPerDay: 12` and `aiRepliesPerDayTotal: 300`, counted in IST days. Reaching either returns `BUDGET_FALLBACK`, which sends the menu with "Talk to a person". The AI isn't called yet; the counters are checked and the test proves the fallback works.
7. **9pm digest:** add counts only: crisis messages, emergencies, blocks by reason, quiet periods started, budget fallbacks. Never message text.
8. **/admin:** show strikes and quiet-until on the conversation page, with a "Clear strikes / end quiet" button (audited, CSRF-checked like the others).
9. **Tests:**
   - Every gate path in both languages, including Roman Hinglish crisis phrases.
   - A crisis during quiet still gets the crisis message.
   - Existing customers are never filtered.
   - 3 strikes lead to quiet, and quiet is broken by "book".
   - Abuse blocks.
   - Burst skip.
   - Budget fallback.
   - No message text in logs or emails (extend the logging test).

Do not: call any AI API, add AI secrets, change booking or payment logic, change flags, or deploy.
Report: files changed, CI link, the exact crisis and emergency messages as sent in both languages, and every config list you added.

---

## Ticket 13: the AI assistant (cap $20)

Read CLAUDE.md, CONTRACT.md (v4), STATUS.md, docs/AGENT.md §6–7 and all of docs/KNOWLEDGE.md. Build only this ticket. Branch `t13-ai-assistant`, one PR. No subagents. Stop after 3 failed fix attempts.

Deliver:
1. **Flag:**
   - Add `AI_REPLIES` to env, default `"false"` everywhere in wrangler.toml.
   - The release test requires `"false"` at the top level and in live. Test may be `"true"` or `"false"`.
   - Add an `AI_REPLIES` switch to /admin with the same rules as SENDS: the env is the master, and the switch can only pause.
   - Add `ANTHROPIC_API_KEY` to the secret names (names only).
2. **`src/ai.ts`:** a plain `fetch` call to the Anthropic Messages API, with no SDK.
   - **Model:** `config.ai.model`. Look up the current Claude Haiku 5.5 model id in Anthropic's docs and put it in config with today's date in a comment. Also in config: `config.ai.maxTokens` (400) and `config.ai.timeoutMs` (8000).
   - **System prompt:** a short rules header plus the full text of `docs/KNOWLEDGE.md`, bundled at build time (wrangler text import, or a generated `src/knowledge.ts` that a test keeps in sync with the doc). Mark it for prompt caching.
   - **Messages:** the last 10 messages of the conversation (in and out), oldest first, plus the new message.
     - Redact before sending: digit runs of 6 or more, emails and URLs become `[removed]`.
     - Never send the phone number, WhatsApp name or payment ids.
     - Add a `<booking_facts>` block with: next call or session day, time and status; call language; nothing else.
   - **Structured output:** a single tool definition matching AGENT.md §6 (`label`, `language`, `script`, `reply`, `next`), forced with `tool_choice`. Validate with zod. Invalid output, a timeout or an HTTP error sends `aiFallback` plus the menu. Never retry the same message.
   - **Customer text only in the user turn.** It is never placed inside the system prompt.
3. **Output check (`src/aicheck.ts`).** Reject the reply, sending the safe fallback for its label instead, if any of these hold:
   - It contains a banned word or phrase from config, matched case-insensitively in both scripts. Seed the config from KNOWLEDGE.md §8.
   - It contains a URL, an email or a phone-like number.
   - It contains a number that isn't a price, duration, hour or booking-fact time from config.
   - It's over 600 characters.
   - It mentions "system prompt", "instructions" or "Anthropic".

   Log only the rejection reason code.
4. **Wiring:**
   - `TO_CLASSIFIER` → if AI is on, call the AI; otherwise keep today's behaviour.
   - Run `applyLabel()` from ticket 12 with the AI's label first. If the label leads to a block, quiet or no reply, stop there.
   - Then send the checked reply as text. Map `next` to one button:
     - `show_booking` → [See call times]. Skip the button if `no_sell_until` is active.
     - `show_menu` → the menu.
     - `ask_more` → [Ask another question] [Book ₹99 call].
     - `handoff` → HUMAN mode plus attention, as in ticket 11.
     - `none` → no button.
   - A `crisis` or `medical_emergency` label from the AI triggers the same fixed path as the ticket 12 detectors, and the AI's own reply is dropped.
   - Count AI replies against the ticket 12 budgets.
5. **Eval set (`test/agent-evals/cases.json`):** all 60 scenarios from KNOWLEDGE.md §7, each with input text, a language, optional booking facts, the expected labels allowed, the expected `next` values allowed, and `mustNotContain`. Plus:
   - **CI test with a fake AI:** for each case, the fake returns a canned output; the test proves the wiring (strikes, blocks, buttons, fallbacks, output check) does the right thing.
   - **Manual live eval workflow (`.github/workflows/eval.yml`):**
     - `workflow_dispatch` only, using a GitHub secret `ANTHROPIC_API_KEY` that Rohit adds.
     - It runs every case against the real model and writes a markdown table (case, label, next, pass/fail, the reply with digits redacted) to the job summary.
     - Pass bar: ≥ 95% labels, 100% of safety cases, 0 banned words.
     - It never sends anything to WhatsApp.
6. **Docs:**
   - The privacy-page wording from KNOWLEDGE.md §10 goes into `docs/GO-LIVE.md` as a manual step for Rohit.
   - STATUS.md: how to turn AI on for test (secret → flag → deploy → switch), and the cost per reply measured from the live eval's token counts.

Do not: set `AI_REPLIES` to "true" anywhere, call the real API from CI tests, store AI replies outside the existing `messages` table and 30-day deletion, change booking or payment logic, or deploy.
Report: files changed, CI link, the system prompt header text, the tool schema, the measured tokens per call from one live eval (if Rohit runs it), and any KNOWLEDGE.md line that the eval showed was unclear.
