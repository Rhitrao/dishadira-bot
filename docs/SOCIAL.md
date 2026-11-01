# Instagram and Messenger replies (Ticket 32): setup for Rohit

The bot can answer Instagram DMs (@disha_dira), Facebook Messenger (the Page "Disha Dira Pranic Healing") and comments on posts and
reels there, for free, instead of ManyChat. Nothing here was done by Claude: no Meta setting was touched. Do the steps in order. It all
stays off until you set `SOCIAL_REPLIES` to `"true"` (step 9).

This is **separate from WhatsApp**. It has its own webhook address (`/meta/webhook`) and its own verify token. Nothing below changes
the WhatsApp webhook (`/wa/webhook`), the WhatsApp number or its templates.

## What people get

Instagram shows buttons. **Messenger gets plain text with the links written out and quick replies** (tap-able bubbles above the
keyboard), because the Facebook app (not the Messenger app) shows a button message as "This post is unavailable… Open in Messenger".
Quick replies and links work in both apps.

1. **Any first DM or comment** (a question, "hi", a photo, a voice note, a sticker, a shared post, a story reply): only the follow ask.
   > Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap
   > below and our booking assistant will help you with a session.

   Instagram: [Visit profile] [I'm following]. Messenger: the same text, then `Our Page: https://bot.disha-dira.com/fb` (a short link,
   see "Short links" below), and the quick reply [I've followed].

   **Someone who already follows us** skips this: on Instagram the bot asks Instagram on their first message (if Instagram doesn't
   answer, they get the ask); on Messenger only someone who tapped "I've followed" before. They get the way to book straight away
   ("Thanks for being part of our community! …", or "Welcome back! You can book your ₹99 15-minute call with Shantha Rao here:" if they
   had the link before), even after 30 days away.

   A comment gets this as a **private reply** (a DM that Instagram or Facebook links to the comment). One per person per post. If the
   buttons or quick reply are refused there, the same words go as text with the link and "Once you follow, reply "following" here."
2. **"I'm following"** (tapped, or typed: "following", "followed", "done", "ok", "yes", "haan", "follow kiya", "follow kar diya",
   "I followed you", "हो गया"…; not "not yet", "no", "how do I follow?"): on Instagram the bot checks with Instagram that they follow.
   If not yet: "It looks like the follow hasn't come through yet…" and the same buttons; a second tap goes through anyway (so a real
   follower is never stuck). If Instagram doesn't answer, it goes through. Messenger can't check a Page follow, so the tap goes through.
3. **They write again without following**: the ask once more, shorter, **with the way to book straight away**, so the follow is asked
   for but never blocks booking:
   > We share a short Pranic Healing tip every week, so please follow us and tap below. You can also book a ₹99 call with Shantha Rao
   > on WhatsApp straight away.

   Instagram: [Visit profile] [I'm following] [Book on WhatsApp]. Messenger: the text, `Our Page: <link>`, `Book on WhatsApp: <link>`,
   [I've followed]. A question gets it at once, after one line on that question if it has a topic (price, booking, her number,
   abroad…); anything else 10 minutes after the bot's last message.
4. **After the follow**: if their first message asked about price, booking, where (by phone, abroad, Dubai), what Pranic Healing is,
   how the call works or refunds, one short line on that first; then the way to book: "This is Disha Dira's automated booking
   assistant. Tap below to book a ₹99 15-minute call…" with **[Book on WhatsApp]** (Messenger: `Book on WhatsApp:
   https://bot.disha-dira.com/b/FBGJCGT`; it opens WhatsApp with "Hi, I'd like to book a ₹99 call" typed) and quick replies **[Book a
   ₹99 call] [Prices] [About Pranic Healing] [How the call works]**. Each answers in one line with the WhatsApp link.
5. **After that**: a typed question gets its answer (each topic once a day; the list is below); any other message (or photo, voice
   note) gets "For bookings and questions, message us on WhatsApp: <link> We reply there." (Instagram: "…tap below to message us on
   WhatsApp. We reply there." with the button, no link written out) at most every 6 hours; after a day away, "Welcome back! You can book
   your ₹99 15-minute call with Shantha Rao here:" with the link and the questions. A **comment on another post** gets a private
   reply with only the WhatsApp link ("Thank you for your comment! To book a ₹99 15-minute call with Shantha Rao, tap below and message
   us on WhatsApp."), at most once a week. After 30 days with no message, it all starts again.
6. **Booked**: the WhatsApp link carries a short code, e.g. "Hi, I'd like to book a ₹99 call (ref: IGK7Q2M)". The WhatsApp bot takes
   the code out of the message (the greeting and menu work as usual) and links the two chats. Once that WhatsApp chat has a paid call,
   session or package, or they say "I booked" / "paid", they never get the follow ask or the ₹99 call again: "Welcome back! For your
   booking, a new session (₹799) or a package, message us on WhatsApp. We reply there:" with the link ("Hi" typed). "I booked already"
   gets "Thank you! We'll see you on WhatsApp. 🙏"; "I paid but no confirmation" gets "please don't pay again… tap "Talk to a person""
   with the link. The 9pm digest has "Instagram and Messenger (last 7 days): N people, N opened WhatsApp, N booked".
7. **Stop**: "not interested", "stop", "unsubscribe", "बंद करो": "Okay, we won't send you any more automatic messages here…", then
   nothing (DMs and comments) until they tap a button or 30 days pass.
   **Insults, threats and sexual messages** (DM or comment; the same word lists as WhatsApp, `config.noise`) get no reply at all and
   are counted (Ticket 34). A strong swear word or a sexual block word ("nudes"…) blocks at once; otherwise the second one does. Blocked
   means no automatic reply on that channel again, DMs or comments; the crisis and emergency messages still go, and "delete my data"
   still works (it deletes the block too). A threat ("I will kill you", "dekh lunga"…) also gives you an urgent item in /admin
   ("Threat on Instagram or Messenger"; read it in the inbox there). Someone with a paid booking is never blocked. There is no unblock
   button yet; a block ends 90 days after their last message, with the rest of their row.
8. **Her number or a call**: "We don't take calls here or share a number. The quickest way to talk to Shantha Rao is the ₹99 15-minute
   call…". Abroad or Dubai: "All calls and sessions are by phone, so you can join from anywhere… India time."
9. **Safety**: a crisis message, in a DM or a comment, gets the same Tele-MANAS message as WhatsApp (a comment gets it as the private
   reply; no follow ask, nothing sold for a week), you get an urgent item in /admin and an email. An emergency gets the 112 / 108
   message and the item.
10. **You can take over**: if you (or anyone on the Page) write to someone by hand in the Instagram or Page inbox, the bot stays out of
   that chat for 24 hours. The bot knows its own messages when they echo back by Messenger's metadata, the message id, a short hash of
   its own text (kept 7 days, never their text), or buttons and quick replies, which nobody types by hand; so a late echo of its own
   message never pauses it (Ticket 34, Rohit's test of 1 Nov). If Meta is slow to answer a send (2.5 seconds), the bot takes it as
   probably sent and moves on, and never sends the same message again.
11. At most 3 automated messages per person a day, and at most one reply nobody tapped for per minute (ten messages in a minute get
   one reply). Past that, the answers to a tap ("not yet", the way to book, the quick-reply
   answers) still go, and the WhatsApp link still goes to someone who writes if they haven't had it in 6 hours. Spam, links, paid
   promotions, crypto and job seekers get the first follow ask at most (and the link only if they tap "I'm following"). A phone number
   alone is not spam (people send theirs to be called; the reply points them to WhatsApp). No number is shown except inside the wa.me
   link. No message or comment text is stored.
12. **Ignored**: story mentions, reactions, unsent messages, read and delivery receipts, opt-ins, and anything that reaches the bot more
   than 24 hours late (Meta allows replies only within 24 hours of the person's last message; nothing is ever sent later or on a
   schedule). On Messenger an m.me link or ad opened in an existing chat (`messaging_referrals`, optional webhook field) counts as a
   first message (ads from Meta allow replies for 7 days, but the bot only ever answers at once). A reply to a private reply days later
   is a normal DM.

Hindi: Devanagari, or Roman Hindi words like "kya", "kitna", "hai", "kar diya", get the Hindi messages; a later English message
switches back.

### The answers (ticket 33): the same as WhatsApp

A typed question gets the answer the WhatsApp bot gives with the assistant off (its fixed-answer router, `src/router.ts`, with the
words in `config.router.topics`), in English or Hindi, taken from the same copy (`src/copy.ts`, from `docs/KNOWLEDGE.md`), so the two
never disagree. Social's own short lines come first for its own topics (price, refund, how the call works, her number, booking,
where/abroad, what Pranic Healing is), and its quick replies are unchanged. What changes for here: no *bold*, and WhatsApp's buttons
are named "on WhatsApp" ("message us on WhatsApp and tap "Talk to a person" there").

| They ask | They get (the WhatsApp answer) | Then |
|---|---|---|
| an illness ("I have thyroid", "can it cure…") | "Pranic healing is meant to support your wellbeing alongside your doctor's care, not replace it…" | [Message on WhatsApp] ("Hi") |
| "black magic", "nazar" | "We don't look into, confirm or remove anything like that…" | [Book on WhatsApp] |
| "money deducted", "payment failed" | "Sorry about this. Please don't pay again… message us on WhatsApp and tap "Talk to a person" there…" | [Message on WhatsApp] ("Hi") |
| "when is my call?", "my booking" | "To see your booking, message us on WhatsApp and tap "Help", then "My bookings" there." | [Message on WhatsApp] ("Hi") |
| "is this a scam / real?" | "That's a fair question. Shantha Rao is a certified Pranic Healer…" | [Book on WhatsApp] |
| timings, "available?" | "Calls are Monday to Saturday, 2 pm to 7 pm (India time)." | [Book on WhatsApp] |
| clinic, "meet in person" | "Calls and sessions are only by phone… Shantha Rao is based in Bengaluru." | [Book on WhatsApp] |
| PayPal, time zone, London | "Calls are Monday to Saturday… UPI needs an Indian bank account, and cards may work…" | [Book on WhatsApp] |
| "what is the process?" | "1. Pick a call time. 2. Pay ₹99. 3. Shantha Rao calls you for 15 minutes. 4. …" | [Book on WhatsApp] |
| "why should I do pranic healing?", "details" | social's "Pranic Healing is a gentle, no-touch energy healing practice…" | [Book on WhatsApp] |

Messenger: the answer, then `Book on WhatsApp: <short link>` and the quick replies (or `Message on WhatsApp: <short link>`). Before
the follow, the answer is the line above the ask again. Illness, a booking or a payment get [Message on WhatsApp] with "Hi" typed,
not the booking button: no booking push after an illness is named (docs/KNOWLEDGE.md §5), and bookings and payments are looked at on
WhatsApp. A greeting or "ok" alone has no topic, as on WhatsApp. Safety (crisis, emergency) still runs first.

### Short links (ticket 33)

Messenger writes its links out, and the full ones were long (the wa.me link with its typed text showed as lines of `%20`). So it
writes short links on the bot's own address (`PUBLIC_URL`), which send the person on (a 302 redirect). They are public (not behind
Cloudflare Access, which covers only /admin, /amma and /app), store nothing and log nothing:

- `https://bot.disha-dira.com/b/FBGJCGT` → WhatsApp with "Hi, I'd like to book a ₹99 call (ref: FBGJCGT)" typed, exactly as before,
  so the ref still links the chats. `/b/FBGJCGT/hi`: the Hindi text. `/b/FBGJCGT/back`: "Hi (ref: …)" for someone who has booked.
  Anything that is not a code the bot makes (`IG` or `FB` and 5 letters or digits) goes to plain `https://wa.me/<our number>`.
- `https://bot.disha-dira.com/fb` → the Facebook Page (`config.social.facebookPageUrl`); `/ig` → the Instagram profile.

Before: `Book on WhatsApp: https://wa.me/<our number>?text=Hi%2C%20I'd%20like%20to%20book%20a%20%E2%82%B999%20call%20(ref%3A%20FBGJCGT)`
and `Our Page: https://www.facebook.com/profile.php?id=61588921902210`. After: `Book on WhatsApp: https://bot.disha-dira.com/b/FBGJCGT`
and `Our Page: https://bot.disha-dira.com/fb`. Without `PUBLIC_URL` the bot writes the long links, as before. Instagram's
[Book on WhatsApp] button keeps the wa.me link itself: a button never shows its address, so a short link would only add a hop.
If you later give the Page a username (Facebook: Page settings → Username), put the new address in `config.social.facebookPageUrl`;
`/fb` keeps working either way.

## The fastest path: a new Meta app in the practitioner's portfolio

**Why.** The Page "Disha Dira Pranic Healing" is in the practitioner's business portfolio (ID ending …195723). The WhatsApp app
"Disha Dira Booking" is in the other portfolio, "Disha Dira Bookings". Meta's overview pages say an app that only serves **its own**
Page or Instagram account needs only Standard Access (no App Review):

- Instagram Platform overview (https://developers.facebook.com/docs/instagram-platform/overview): *"If your app only serves your
  Instagram professional account or an account you manage, Standard Access is all your app needs."* and *"Advanced Access is the access
  level required if your app serves Instagram professional accounts that you don't own or manage and can be used by app users who do
  not have a role on your app or a role on a business portfolio that has claimed your app. This access level requires App Review and
  Business Verification."*
- Messenger Platform overview (https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview.md):
  App Review is needed *"if your app needs Advanced Access. Not required if you only send and receive messages for your own Facebook Page."*
- Create an app for Messenger (https://developers.facebook.com/documentation/business-messaging/messenger-platform/create-an-app.md):
  *"If your app needs to access business data owned by other business portfolios to provide services or functionality to those
  businesses, you must become a Tech Provider."* That is why an app in the **same** portfolio as the Page is the simplest.

**But the feature pages say something stricter**, and Meta has not settled it (a developer asked exactly this on Meta's forum,
https://developers.facebook.com/community/threads/1784751929231582/, with no answer from Meta at the time of writing):

- Access levels (https://developers.facebook.com/docs/graph-api/overview/access-levels): *"Permissions with Standard Access can only be
  requested from app users who have a role on the requesting app. Similarly, features with Standard Access are only active for app users
  who have a role on the app."* ("App users" here are the people who log in to the app, i.e. you, not the people who DM.)
- Instagram Send API: *"Apps with Standard Access can only send messages to people that have a role on the app"*.
- Instagram webhooks: *"To get webhooks notification that include data owned or managed by people who do not have a role on your app,
  your app must have been approved in App Review."* Private replies list *"Advanced Access"* as a requirement.

So: **try Standard Access first with the new app, and test with a friend who has no role on the app.** If their DM gets the reply,
you are done without App Review. If it doesn't, do App Review on that same app (section "App Review" below).

### Steps (new app)

1. **@disha_dira and the Page.** Both are in the practitioner's portfolio "Disha Dira Pranic Healing" (…195723). In Business Settings →
   Accounts → Instagram accounts, @disha_dira shows **"Login needed": click Log In there first** and sign in to Instagram, otherwise
   the app can't reach its messages. Check that it is linked to the Page.
2. **Create the app.** developers.facebook.com → My Apps → Create app → use case **"Engage with customers on Messenger from Meta"**,
   type Business, and choose the **practitioner's portfolio** (…195723) as the business. Name it e.g. "Disha Dira Social".
3. **Basic settings** (App settings → Basic): app icon (512×512 or larger), Privacy Policy URL `https://disha-dira.com/privacy.html`,
   User data deletion → "Data deletion instructions URL" `https://bot.disha-dira.com/data-deletion`, category, contact email. Copy the
   **App secret** (Show).
4. **Permissions** (Use cases → Customize "Engage with customers on Messenger"): add `instagram_basic`, `instagram_manage_messages`,
   `instagram_manage_comments`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement` (only needed for the
   optional public reply). `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `business_management` are already there.
5. **The Page token.** Messenger API Setup → Generate access tokens → **Connect** → log in as an admin of the Page → pick
   "Disha Dira Pranic Healing" (and @disha_dira when asked) → allow everything. Then make it long-lived:
   - Graph API Explorer (https://developers.facebook.com/tools/explorer): pick the new app, "Get User Access Token" with the
     permissions of step 4, copy it.
   - Open `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP ID>&client_secret=<APP SECRET>&fb_exchange_token=<the token>`
     in the Explorer (or a browser): you get a long-lived user token.
   - In the Explorer, with that long-lived token: `GET me/accounts` → the `access_token` next to the Page is a Page token that does not
     expire (Meta: "A long-lived user token yields one with no expiration"). Note the Page `id`.
   - `GET <page id>?fields=instagram_business_account` → the `id` inside is the Instagram account id. It should be
     `17841474938698456` (what Business Settings shows for @disha_dira). The Page's public address is
     `https://www.facebook.com/profile.php?id=61588921902210` (already in `config.social.facebookPageUrl` for the "Our Page" link in
     Messenger); its number is usually the Page id too, but use the `id` that `me/accounts` gives.
6. **Instagram setting**: in the Instagram app on @disha_dira: Settings → Messages and story replies → Message controls → Connected
   tools → turn on **Allow access to messages**.
7. **Cloudflare secrets** on `dishadira-bot-live` (Workers → Settings → Variables and Secrets → Add → Secret). Never in GitHub or chat:
   - `META_APP_SECRET` = the new app's secret (step 3)
   - `META_PAGE_TOKEN` = the Page token (step 5)
   - `META_PAGE_ID` = the Page id, `META_IG_ID` = the Instagram account id (step 5; `17841474938698456`). These two are not secret,
     but are kept as Worker secrets so a deploy never wipes them and test and live can differ. The two profile links (Instagram and the
     Page) are in `config.social` (src/config.ts).
   - `META_VERIFY_TOKEN` = a long random phrase you invent (not the WhatsApp one).
8. **Webhooks** (in the new app; this is not the WhatsApp app, so WhatsApp is not affected):
   - Messenger API Setup → Configure webhooks: Callback URL `https://bot.disha-dira.com/meta/webhook`, Verify token = `META_VERIFY_TOKEN`
     → Verify and save. (Deploy → live must have run first, so the address exists.)
   - Page fields: `messages`, `messaging_postbacks`, `message_echoes`, `feed` (optional: `messaging_referrals`, so an m.me link or ad
     opened in an existing chat gets the follow ask).
   - Instagram (Messenger → Instagram settings → Webhooks): the same callback and token; fields `messages`, `messaging_postbacks`,
     `comments`.
   - Subscribe the Page to the app: Graph API Explorer with the Page token,
     `POST <page id>/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,feed` → `{"success": true}`.
   - Optional, **ice breakers** (up to 4 starter questions shown to someone opening a chat with us for the first time; mobile only).
     Graph API Explorer with the Page token, two calls (Messenger, then Instagram); each tap arrives as a first message (follow ask,
     the topic kept for after the follow). Meta allows 10 such calls per 10 minutes:
     `POST me/messenger_profile` and `POST me/messenger_profile?platform=instagram`, each with the body
     ```json
     {"ice_breakers": [{"locale": "default", "call_to_actions": [
       {"question": "Book a ₹99 call", "payload": "SOCIAL_Q_BOOK"},
       {"question": "Prices", "payload": "SOCIAL_Q_PRICE"},
       {"question": "What is Pranic Healing?", "payload": "SOCIAL_Q_WHAT"},
       {"question": "How does the call work?", "payload": "SOCIAL_Q_HOW"}]}]}
     ```
     (for Instagram also `"platform": "instagram"` in the body). Docs:
     https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api/ice-breakers and
     https://developers.facebook.com/docs/messenger-platform/instagram/features/ice-breakers
   - **Publish the app** (left menu → Publish). Meta sends webhooks only to published apps, whatever the review status.
9. **Turn it on**: change `SOCIAL_REPLIES = "false"` to `"true"` under `[env.live.vars]` in `wrangler.toml` in a PR, merge, then
   **Actions → Deploy → live**. `"false"` stops every reply at once (the webhook still answers Meta). The /admin "Sends" pause also
   pauses these replies (safety messages still go).
10. **Test**: from your own Instagram, DM "how much?" → follow ask → tap "I'm following" (you follow already) → the price line and the
    WhatsApp button. Comment on a post → a DM. Then ask a friend **with no role on the app** to do the same. If the friend gets
    nothing, Standard Access isn't enough: App Review below.
11. **Turn off** Meta Business Suite → Inbox → Automations → **Instant reply** for Instagram and Messenger once the bot answers, so
    people don't get two greetings.

## The other ways

**B. Keep the WhatsApp app "Disha Dira Booking" and share the Page with its portfolio.** In the practitioner's portfolio: Settings →
Partners → Add → Give a partner access to your assets → the "Disha Dira Bookings" portfolio ID → share the Page (and @disha_dira) with
full control (or at least Messages and Community activity). Then add the Messenger use case to "Disha Dira Booking", do steps 4–11 there,
and **leave `META_APP_SECRET` unset** (the bot then uses `WA_APP_SECRET`). The Page token itself only needs a person who can do the
MESSAGING and MODERATE tasks on the Page to connect it (step 5); the Page does not have to be in the app's portfolio for that. Whether
Meta counts a shared Page as "an account you manage" (Standard Access) or as another business's data (Tech Provider, App Review) is not
clear in the docs, which is why A comes first.

**C. App Review (if a friend without a role gets nothing).** On whichever app you use:
- Business Verification of the app's portfolio (Advanced Access needs it:
  https://developers.facebook.com/docs/graph-api/overview/access-levels).
- App Review → Requests → Request permissions: Advanced Access for `pages_messaging`, `instagram_manage_messages`,
  `instagram_manage_comments`, `instagram_basic`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`,
  `business_management` (say it is needed for `pages_messaging`, `pages_show_list` and `instagram_manage_messages`), plus
  `pages_read_user_content` and `pages_manage_engagement` only if you use Page comments / the public reply. Meta also lists the
  **Human Agent** feature for Instagram private replies.
- Choose "Apps for your own business" and Primary experience **Automated**
  (https://developers.facebook.com/documentation/business-messaging/instagram-messaging/app-review/apps-for-your-own-business.md).
- **Screencast** (one video): start a DM to @disha_dira and to the Page; the follow ask; tap "I'm following"; the "not yet" message
  (from an account that doesn't follow); the guide with the quick replies; tap each quick reply; a comment on a post getting the private
  reply; what happens when someone unsends a message (nothing); sending "delete my data". Show the Page admin going through the
  Facebook Login screen and picking the Page and Instagram account (needed for `business_management`).
- Test commands for the reviewer: "how much?", "what is pranic healing", "I'm following", "delete my data".
- URLs: privacy `https://disha-dira.com/privacy.html`, data deletion `https://bot.disha-dira.com/data-deletion`.
- Until it is approved, only people with a role on the app (Admin, Developer, Tester under App roles) get replies, so you can test.

## Also needed

- **Website privacy page**: add Instagram and Facebook Messenger to "What we collect" and "Who we share it with": "If you message us
  on Instagram or Facebook Messenger, or comment on our posts, an automated assistant replies with our WhatsApp booking link. We keep
  only the id Instagram or Facebook gives us for you, your language, the reply step and a short booking reference (linked to your
  WhatsApp chat with us if you use it), never your messages, and delete it 90 days
  after your last message. See https://bot.disha-dira.com/data-deletion."
- The data deletion page lists the contact email from `config.social.contactEmail` (the address on the privacy page).
- The facts in the replies come from `docs/KNOWLEDGE.md` and the prices in Settings. Change the words in `src/social.ts`
  (`socialWords`), the keywords in `config.social` (src/config.ts). The answers shared with WhatsApp are changed in `src/copy.ts` and
  `config.router.topics`, and change on both.

## Limits Meta sets (read 30 Oct 2026)

- A private reply: one message per comment, within 7 days of the comment; the chat opens only once they answer.
- Button template: 1–3 buttons, text up to 640 characters, not shown on Instagram on the web, and not in the Facebook app (so the bot
  uses it on Instagram only). Quick replies: up to 13, titles up to 20 characters, gone after the next message; on Instagram only on
  text messages and not on desktop. Messenger text up to 2,000 characters; Instagram text under 1,000 bytes.
- Private replies: one per comment, within 7 days of it, and Meta limits how many go per hour; a refused one is logged by its code and
  the next comment on that post may try again.
- Private replies on Messenger take "all messaging types available for using the Send API" (Meta's private replies page).
- Meta wants the webhook's 200 within 5 seconds; the bot's Meta calls time out after 2.5 seconds each.
- Docs used: see the header of `src/social.ts`.
