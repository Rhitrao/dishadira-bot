# Go-live checklist (for Rohit)

Plain steps, no coding. Do them in order and tick them off. Nothing here changes by itself: the bot ships with every safety switch **off**, so it cannot message anyone or take money until you turn the switches on in step 15.

You will use these places: the Cloudflare dashboard, GitHub (this repository), the Meta developer and WhatsApp Manager pages, and the Razorpay dashboard. Where a step says "ask Claude", start a coding session and say what you need.

Two copies of everything exist: **test** (practice data, Razorpay Test Mode, Meta test number) and **live** (real data, real money). They have separate databases and separate Workers, so they never mix.

**Words used.** *Worker* = the bot's program on Cloudflare. *D1* = its database. *Secret* = a password-like value you paste into Cloudflare and never into GitHub. *Flag* = an on/off switch in `wrangler.toml`.

---

## A. Get the test copy running

### 1. Create the two databases
- [ ] Cloudflare dashboard → **Storage & databases → D1 SQL database → Create database**.
- [ ] Create one named exactly `dishadira-bot-test` and another named exactly `dishadira-bot-live`.
- [ ] Open each and copy its **Database ID** (a long code like `1a2b3c4d-...`).
- [ ] In GitHub open `wrangler.toml` (pencil icon). Replace `00000000-0000-0000-0000-000000000001` with the **test** ID and `00000000-0000-0000-0000-000000000002` with the **live** ID. Do not touch anything else. Commit it on a new branch and open a pull request; merge it when the checks are green. (Database IDs are not secret.)

### 2. Create the Cloudflare API token and tell GitHub
- [ ] Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.
- [ ] Give it these permissions only: **Account → Workers Scripts → Edit**, and **Account → D1 → Edit**. Nothing else. Under *Account Resources* choose your own account only.
- [ ] Copy the token (it is shown once).
- [ ] Copy your **Account ID** (Cloudflare dashboard → Workers & Pages → right-hand side).
- [ ] GitHub → this repository → **Settings → Secrets and variables → Actions → New repository secret**. Create `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (the account ID).

### 3. First deploy of the test copy
- [ ] GitHub → **Actions → Deploy → Run workflow**, choose **test**, run. It runs all the checks, prepares the test database, then deploys. Wait for green.
- [ ] If it fails, copy the red error text into a Claude session. Do not retry blindly.
- [ ] Cloudflare → Workers & Pages: you now have a Worker named `dishadira-bot-test`. Note its web address (ends in `workers.dev`).

### 4. Add the Worker secrets (test)
Cloudflare → Workers & Pages → `dishadira-bot-test` → **Settings → Variables and Secrets → Add → Type: Secret**. Add each name below with its value. Never paste these into GitHub, a chat, or a screenshot.

| Secret name | What it is | Where the value comes from |
|---|---|---|
| `WA_TOKEN` | Permission for the bot to send WhatsApp messages | Meta Business settings → Users → **System users** → create one, give it your app, **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`. Use the permanent token, not the 24-hour test token. |
| `WA_APP_SECRET` | Lets the bot check that messages really come from Meta | Meta developer app → **App settings → Basic → App secret → Show** |
| `WA_VERIFY_TOKEN` | A password you invent; Meta repeats it back when connecting the webhook (step 8) | Make up a long random phrase (20+ letters and numbers). Keep a copy: you paste the same phrase into Meta in step 8. |
| `WA_PHONE_ID` | Which WhatsApp number sends | Meta developer app → **WhatsApp → API Setup → Phone number ID** (test number for the test copy, the Airtel number for live) |
| `RAZORPAY_KEY_ID` | Your Razorpay key id. It starts with `rzp_test_` (Test Mode) or `rzp_live_` (Live Mode) | Razorpay dashboard → **Account & Settings → API Keys → Generate Key** (in the right mode). **Test Mode keys for the test copy, Live Mode keys for live.** The bot refuses to create payment links if the key's prefix does not match the copy's `PAYMENT_MODE`. |
| `RAZORPAY_KEY_SECRET` | The secret that goes with that key id | Shown once when you generate the key; copy it then. Same rule: Test keys for test, Live keys for live. |
| `RAZORPAY_WEBHOOK_SECRET` | A password you invent; Razorpay signs every payment notice with it and the bot checks that signature | Make up a long random phrase (20+ letters and numbers). You paste the same phrase into Razorpay in step 9. Test and live use different phrases. |
| `ACCESS_TEAM` | The name of your Cloudflare Zero Trust team | Zero Trust dashboard → **Settings → Custom pages → Team domain** (the part before `.cloudflareaccess.com`) |
| `ACCESS_AUD` | The code that identifies the Access application from step 5 | Zero Trust → **Access → Applications →** your application → **Overview → Application Audience (AUD) Tag** |
| `AMMA_EMAIL` | The Google address Amma signs in with | Ask Amma which Google account she uses |
| `ROHIT_EMAIL` | The Google address you sign in with | Yours. Only this address can open `/admin`. |
| `DIGEST_TO` | Where the 9 pm summary and alert emails go | Your own address; it must be the verified address from step 6 |
| `ANTHROPIC_API_KEY` | Lets the assistant answer typed questions (only used when `AI_REPLIES` is `"true"`, see step 14d) | Anthropic Console → **API keys → Create key**. Give the key its own workspace or project and set a **monthly spend limit** (for example US$10). Use a different key for test and live. The same kind of key also goes into GitHub for the manual eval (STATUS.md). |

Never paste these values into GitHub, chat or screenshots. Razorpay shows the key secret only once; if you lose it, generate a new key.

### 5. Protect /amma and /admin with Cloudflare Access
Access is the front door: only the right Google accounts get in.
- [ ] The bot needs a normal web address on your own domain (the `workers.dev` address cannot be limited to two pages). Cloudflare → `dishadira-bot-test` → **Settings → Domains & Routes → Add → Custom domain** → `bot-test.disha-dira.com`. (For live later: `bot.disha-dira.com`.) After the next Deploy, check the domain is still listed; if it vanished, tell Claude.
- [ ] Zero Trust → **Access → Applications → Add an application → Self-hosted**.
- [ ] Name it `Disha Dira bot (test)`. Add two destinations on that hostname: path `/amma` and path `/admin` (not the whole site: WhatsApp and Razorpay must reach the other addresses without logging in).
- [ ] Add one **Allow** policy that lists exactly two emails: Amma's and yours. (The bot itself then lets only you into `/admin`.)
- [ ] Sign-in method: **Google** (or one-time PIN if Google is not set up).
- [ ] Copy the **AUD tag** into the secret `ACCESS_AUD` (step 4).
- [ ] Check: open `https://bot-test.disha-dira.com/admin` in a private window. It must ask you to sign in. Signed in as you, you see the console. Open `/amma` as Amma (or as you): you see "Calls and sessions". Anyone else must be refused.
- [ ] Check: `https://bot-test.disha-dira.com/health` must open **without** signing in.

### 6. Email Routing and the verified address
The bot sends the 9 pm digest and alerts only to one address you have verified.
- [ ] Before you start: does `disha-dira.com` already receive real email (for example a Hostinger mailbox)? Enabling Email Routing replaces the domain's mail records. If unsure, stop and ask Claude first.
- [ ] Cloudflare → your domain `disha-dira.com` → **Email → Email Routing → Get started / Enable**.
- [ ] **Destination addresses → Add destination address** → your own email. Open the email Cloudflare sends and click the verification link. The address must show **Verified**.
- [ ] Put that same address in the secret `DIGEST_TO`.
- [ ] The bot sends from `bot@disha-dira.com` (set in `src/config.ts`, `mail.from`). If Cloudflare does not accept that sender, ask Claude to change it.
- [ ] Later check: after step 15 the 9 pm email arrives. If not, look at Worker logs (Cloudflare → the Worker → Logs).

### 7. Switch on the test flags
The flags are in `wrangler.toml`, under `[env.test.vars]`. For the sandbox run, set `NEW_BOOKINGS = "true"` and `SENDS = "true"` and `OWNER_APPROVED = "true"` there **for test only**. Leave `PAYMENT_MODE = "test"`. Do **not** change anything under `[env.live.vars]` yet. Commit through a pull request, merge, then run **Deploy → test**.

### 8. Connect Meta (WhatsApp) to the test copy
- [ ] Meta developer app → **WhatsApp → Configuration → Webhook → Edit**.
- [ ] **Callback URL:** `https://bot-test.disha-dira.com/wa/webhook`
- [ ] **Verify token:** the same phrase as the secret `WA_VERIFY_TOKEN`. Click **Verify and save** (it must succeed).
- [ ] Under **Webhook fields**, subscribe to **messages**.
- [ ] With the Meta **test number**, add your own phone as an allowed recipient.

### 9. Connect Razorpay to the test copy
- [ ] Razorpay dashboard switched to **Test Mode** → **Account & Settings → Webhooks → Add New Webhook**.
- [ ] **Webhook URL:** `https://bot-test.disha-dira.com/pay/razorpay/webhook`
- [ ] **Secret:** the same phrase as the secret `RAZORPAY_WEBHOOK_SECRET` (step 4).
- [ ] **Active events:** tick exactly these five: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`. Save.
- [ ] Check Payment Links works in Test Mode on your Razorpay account (Razorpay's onboarding/KYC item in `STATUS.md`; Live Mode keys only come after approval).

### 10. Submit the 7 templates
- [ ] WhatsApp Manager → **Message templates → Create template**. Create all seven exactly as written in `docs/TEMPLATES.md`: `call_booked`, `session_offer`, `session_confirmed`, `reminder`, `payment_update`, `package_confirmed`, `session_booked`. Category **Utility**, language English.
- [ ] Then create the seven **Hindi** versions (language **Hindi**, names ending in `_hi`: `call_booked_hi`, `session_offer_hi`, `session_confirmed_hi`, `reminder_hi`, `payment_update_hi`, `package_confirmed_hi`, `session_booked_hi`), wording in the "Hindi versions" part of `docs/TEMPLATES.md`.
- [ ] Approval usually takes minutes to a day. When one is approved, ask Claude (or edit `src/config.ts` yourself) to set that template's `approved` to `true` (for a Hindi one, its `hi.approved`), then run **Deploy → test**. A Hindi customer gets the Hindi template only once its own flag is `true`, and otherwise the English one.
- [ ] Amma reads `docs/COPY.md` (every message, English and Hindi) and tells you about anything that sounds wrong.

---

## B. The sandbox run (test copy only, no real money)

Do this on weekdays between 14:00 and 19:00 India time, because that is when call times exist. Calls cannot be booked less than one hour ahead.

### 11. Book, call, pay, refund
- [ ] **Booking.** From your allowed phone, message the Meta test number. Choose a language, **Book a ₹99 call**, a service, a time. Tap the pay button and pay with a Razorpay **test** method (Razorpay's test card and test UPI details are on their docs pages "Test Card Details" and "Test UPI Details"). No real money moves in Test Mode.
- [ ] **Is it recognised as a test payment?** After paying you get the "call confirmed" message. Open `/admin`. There must be **no** item saying "A payment arrived with the wrong amount". If that item appears even though you paid exactly ₹99, something is wrong with how the payment was read (amount, currency, or a test/live key mix-up). **Stop here and send Claude the text of the item**; do not go live.
- [ ] **Amma's page.** Open `/amma` (as Amma or yourself). The call shows under Today with a Call button. The outcome buttons appear only once the call time has started.
- [ ] **Outcome: Session.** Once the time has started, tap **Session**, then **Yes**. Wait 10 minutes (the undo time). You then get the session offer on WhatsApp.
- [ ] **Single session ₹799.** You get a list with three options. Tap **Single session**, pick a time, pay ₹799 with the test method. You get "Your session … is confirmed". `/amma` shows it under the right day, marked "single".
- [ ] **A package.** From the menu tap **Sessions & packages → 10 sessions**, pay ₹5,000 with the test method (no time is asked). You get "Payment received. You have 10 sessions" with a **Book a session** button. Book one: you get "Your session is booked … Sessions left: 9" with no payment step, and `/amma` shows it as "package 1/10". Open **Help → My bookings** and try **Move** and **Cancel** (a package session cancelled 3 hours or more before goes back to the package).
- [ ] **Stopping a package.** In `/admin` open the person (`/admin/conv/<id>`), tap **Refund unused sessions**, check the amount (unused × ₹500), confirm, and see the refund in Razorpay's Test Mode dashboard.
- [ ] **Outcome: Not right fit, and the refund.** Make a second ₹99 booking (use another phone or ask Claude to reset the test database). After the call time starts, tap **Not right fit**, then **Yes**, and wait 10 minutes. You receive the "refunded your ₹99" message, and Razorpay's Test Mode dashboard shows the ₹99 refund as processed. `/admin` shows the refund in the 7-day numbers.
- [ ] **Reminder.** Leave a booking for the next working day; at 6:30 pm India time the evening before, you should receive the reminder (a template once its approval is done, text inside 24 hours).
- [ ] **Pause test.** In `/admin` use the **Sends** and **New bookings** switches to pause and resume. While paused, nothing is sent and booking says "Booking opens soon".
- [ ] Anything odd goes to Claude with a screenshot **with the phone number hidden**.

---

## C. Going live

### 12. Prepare the live copy
- [ ] Repeat steps 3 to 6 and 8 to 9 for the live side, with live values: Worker `dishadira-bot-live`, custom domain `bot.disha-dira.com`, its own Access application and AUD tag, the **Live Mode** Razorpay keys (and a new webhook secret), the Airtel number's phone ID and a permanent token, and the live webhook addresses `https://bot.disha-dira.com/wa/webhook` and `https://bot.disha-dira.com/pay/razorpay/webhook` (Razorpay in **Live Mode**, same five events).
- [ ] Add all the secrets from step 4 to `dishadira-bot-live`. Different values from test.
- [ ] Run **Actions → Deploy → live**. This applies the migrations to the **fresh live database** and deploys. All flags stay off.
- [ ] Check `https://bot.disha-dira.com/health` opens, and `/admin` asks for sign-in.
- [ ] Set the real business number in `src/config.ts` (`businessNumber`) if it is still the placeholder (ask Claude).
- [ ] Make sure all seven templates are approved and set to approved in `src/config.ts` before you go further.

### 13. One real ₹99
- [ ] In `wrangler.toml` under `[env.live.vars]` set only `SENDS = "true"` first, deploy **live**, and message the Airtel number: you should get the greeting and menu; booking says "Booking opens soon".
- [ ] Then set `NEW_BOOKINGS = "true"`, deploy **live**, and book and pay **one real ₹99 yourself**. Check: the "call confirmed" message arrives, `/amma` shows the call, no "wrong amount" item in `/admin`, and the payment shows in the Razorpay **Live Mode** dashboard.
- [ ] Have Amma tap **Not right fit** on that call. After 10 minutes, check the ₹99 comes back (Razorpay dashboard, and your bank/UPI app after a day or two).

### 14. Flag order
Always one at a time, with a Deploy in between and a look at `/admin` after each. In `[env.live.vars]`:
1. [ ] `SENDS = "true"`: the bot can reply.
2. [ ] `NEW_BOOKINGS = "true"`: people can book and pay. (Done in step 13.)
3. [ ] `OWNER_APPROVED = "true"`: your sign-off flag. The code does not use it yet; set it when you are satisfied, so the record shows it.
4. [ ] Only after steps 1 to 3 have worked for a few days: start the ad.
`PAYMENT_MODE` is already `"live"` on the live side and `"test"` on the test side; never swap them.

### 14b. Safety and privacy checks (ticket 12)
- [ ] `CHAT_RETENTION_MINUTES` in `wrangler.toml` is `"10080"` (7 days) under `[vars]` and `[env.live.vars]`, and `"10"` under `[env.test.vars]`. Message text is erased that long after a person's last message; bookings, payments and refunds are kept.
- [ ] `PUBLIC_URL` under `[env.live.vars]` is the address of the live Worker (`https://bot.disha-dira.com`). The urgent e-mail "Urgent: crisis message" links to `<PUBLIC_URL>/admin` and never contains what the person wrote. Check `DIGEST_TO` and the e-mail binding work before the ad starts: this e-mail is the one that must never be missed.
- [ ] On the test copy, send the words "I want to die" from your own phone: you must get the Tele-MANAS message at once, an e-mail within a minute, and an item "CRISIS" in `/admin`. The chat then belongs to a person (resolve the item to give it back to the bot) and the bot sells nothing to that number for 7 days ("Clear no-sell" on the person's page, `/admin/conv/<id>`, lifts it early).
- [ ] The word lists for crisis, emergency, spam, flirting and abuse are in `src/config.ts` (`safety`, `noise`, `words`). Read them once and ask Claude to add what is missing.

### 14c. The website must say the same (Rohit does this, before live)
- [ ] The website's **fees page**, **terms** and **refund page** must show the same prices and rules as the bot, because customers will compare them. If they ever differ, the website wins and the bot must be fixed.
  - Prices: first call ₹99; single session ₹799; 10 sessions for ₹5,000 (₹500 each); 20 sessions for ₹9,000 (₹450 each). Packages never expire, and package sessions are booked later with no payment each time (at most 2 upcoming).
  - First call: refunded in full if Shantha Rao feels a session is not the right fit; a missed call gets one free new time.
  - Single session: can be moved once, up to 3 hours before; cancel 24 hours or more before for a full refund; between 3 and 24 hours before there is no refund but it can be moved once; no refund if you do not attend.
  - Package session: move or cancel up to 3 hours before and it goes back to the package; later, or if you do not attend, the session is used.
  - Stopping a package: unused sessions are refunded at the package rate (₹500 or ₹450 each). Payments older than 6 months are refunded directly by the team, not through the payment provider.
  - "Not right fit" at the very first session (when the ₹99 call was skipped): the whole payment is refunded, once per person.
  - Remove any line that says "no packages", and any "in person" wording if the work is by phone only.

### 14d. The assistant and the privacy page (Rohit does this, before `AI_REPLIES` is ever switched on)
The assistant (ticket 14) sends what customers type to Anthropic, in the United States, to write the reply. Until the privacy page says so, keep `AI_REPLIES = "false"`.
- [ ] Update the website's **privacy page**, under "What we collect" and "Who we share it with", with this wording (from `docs/KNOWLEDGE.md` section 10; it says **7 days** because that is what the bot does since ticket 12, not the 30 days the knowledge bank still shows):
  > An automated assistant answers questions on WhatsApp. To do this, the text of your messages is processed by our AI service provider (Anthropic, in the United States), only to reply to you. We remove phone numbers and links before sending. Chat messages are deleted 7 days after your last message.
- [ ] Decide whether to add "It is not used to train AI models" **only after** you have checked Anthropic's current commercial terms. Do not publish it unchecked.
- [ ] Make sure the bot's first message (already built in) and the privacy page agree: the greeting says the assistant is automated and that messages are processed by the assistant and the AI provider.
- [ ] Add the `ANTHROPIC_API_KEY` secret to the **test** Worker only (step 4), then follow "How to turn the assistant on for test" in `STATUS.md`. Read every reply in the shadow week before thinking about live.
- [ ] On live, `AI_REPLIES` stays `"false"` until the eval (`Actions → Assistant eval`) passes, the shadow week is done and Amma has read `docs/KNOWLEDGE.md` and the Hindi messages.

### 15. How to pause everything
Fastest first. None of these needs coding.
- **One tap, instant:** `/admin` → switch **New bookings** to paused (nobody can start a new booking) and **Sends** to paused (the bot stops sending messages; incoming messages are still recorded). Resume with the same switch.
- **The assistant misbehaves:** `/admin` → switch **AI answers** to paused. Typed questions then get the plain acknowledgement and an item for you, and nothing is sent to Anthropic. (Or set `AI_REPLIES = "false"` in `wrangler.toml` and Deploy.)
- **Amma is unavailable:** `/admin` → **Amma away**. New bookings pause and every booked call and session of today and tomorrow becomes an item for you (offer a new time or refund).
- **Stop for good until you say so:** in `wrangler.toml` set `NEW_BOOKINGS = "false"` and `SENDS = "false"` under `[env.live.vars]`, then **Deploy → live**. The switches in `/admin` can only turn things off, never on, so the file is always the final say.
- **Emergency, no deploy:** in the Razorpay dashboard deactivate the live API key (Account & Settings → API Keys), and in the Meta app remove the webhook subscription. The bot then cannot take money or hear customers.
- Keep your phone number list private; never share screenshots with numbers.
