# Instagram and Messenger replies (Ticket 32): setup for Rohit

The bot can answer Instagram DMs (@disha_dira), Facebook Messenger (the Page "Disha Dira Pranic Healing") and comments on posts and
reels there, for free, instead of ManyChat. Nothing here was done by Claude: no Meta setting was touched. Do the steps in order. It all
stays off until you set `SOCIAL_REPLIES` to `"true"` (step 9).

This is **separate from WhatsApp**. It has its own webhook address (`/meta/webhook`) and its own verify token. Nothing below changes
the WhatsApp webhook (`/wa/webhook`), the WhatsApp number or its templates.

## What people get

1. **Any first DM or comment** (a question, "hi", anything): only the follow ask, with two buttons.
   > Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap
   > below and our booking assistant will help you with a session.
   > [Visit profile] [I'm following]  (Messenger: [Open our Page] [I've followed])

   A comment gets this as a **private reply** (a DM that Instagram or Facebook links to the comment). One per person per post.
2. **"I'm following"**: on Instagram the bot checks with Instagram that they follow. If not yet: "It looks like the follow hasn't come
   through yet…" and the same buttons; a second tap goes through anyway (so a real follower is never stuck). If Instagram doesn't
   answer, it goes through. Messenger can't check a Page follow, so the tap goes through.
3. **After the follow**: if their first message asked about price, booking, where (by phone, abroad, Dubai), what Pranic Healing is,
   how the call works or refunds, one short line on that first; then the way to book: "This is Disha Dira's automated booking
   assistant. Tap below to book a ₹99 15-minute call…" with **[Book on WhatsApp]** (opens WhatsApp with "Hi, I'd like to book a ₹99
   call" typed) and quick replies **[Book a ₹99 call] [Prices] [About Pranic Healing] [How the call works]**. Each answers in one line
   with [Book on WhatsApp]. A message naming an illness never gets a medical answer, only the way to book (the WhatsApp bot's safety
   rules apply there).
4. **After that**: a message gets "For bookings and questions, message us on WhatsApp: <link>. We reply there." at most once a day.
   After 30 days with no message, it starts again.
5. **Safety**: a crisis message gets the same Tele-MANAS message as WhatsApp (no follow ask, nothing sold for a week), you get an
   urgent item in /admin and an email. An emergency gets the 112 / 108 message.
6. **You can take over**: if you (or anyone on the Page) write to someone by hand in the Instagram or Page inbox, the bot stays out of
   that chat for 24 hours.
7. At most 3 automated messages per person a day (the messages after the follow still go). Spam and links get the follow ask once at
   most. No number is ever shown except inside the wa.me link. No message or comment text is stored.

Hindi: Devanagari, or Roman Hindi words like "kya", "kitna", "hai", get the Hindi messages.

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
     `https://www.facebook.com/profile.php?id=61588921902210` (already in `config.social.facebookPageUrl` for the [Open our Page]
     button); its number is usually the Page id too, but use the `id` that `me/accounts` gives.
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
   - Page fields: `messages`, `messaging_postbacks`, `message_echoes`, `feed`.
   - Instagram (Messenger → Instagram settings → Webhooks): the same callback and token; fields `messages`, `messaging_postbacks`,
     `comments`.
   - Subscribe the Page to the app: Graph API Explorer with the Page token,
     `POST <page id>/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,feed` → `{"success": true}`.
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
  only the id Instagram or Facebook gives us for you, your language and the reply step, never your messages, and delete it 90 days
  after your last message. See https://bot.disha-dira.com/data-deletion."
- The data deletion page lists the contact email from `config.social.contactEmail` (the address on the privacy page).
- The facts in the replies come from `docs/KNOWLEDGE.md` and the prices in Settings. Change the words in `src/social.ts`
  (`socialWords`), the keywords in `config.social` (src/config.ts).

## Limits Meta sets (read 30 Oct 2026)

- A private reply: one message per comment, within 7 days of the comment; the chat opens only once they answer.
- Button template: 1–3 buttons, text up to 640 characters, not shown on Instagram on the web. Quick replies: up to 13, titles up to 20
  characters; on Instagram only on text messages and not on desktop. Instagram text under 1,000 bytes.
- Meta wants the webhook's 200 within 5 seconds; the bot's Meta calls time out after 2.5 seconds each.
- Docs used: see the header of `src/social.ts`.
