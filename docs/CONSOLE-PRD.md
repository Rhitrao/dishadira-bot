# Booking Console PRD

Version of 27 Oct 2026. The living copy is the Booking Console PRD doc; this file is the copy coding sessions read.

## Summary

Version 2 replaces today's two separate consoles with one role-based console: six screens, each answering one question, with the same layout on a phone and a laptop.

**What's wrong today.**

- **The work is split.** The practitioner marks call outcomes on one page, while payments, chats and settings sit in a different console.
- **Screens mix jobs.** Triage items, weekly numbers, on/off switches and safety state share one page, so nothing tells you the one thing to do next.
- **The words are the system's, not the user's.** Labels like "no-sell", "strikes", "quiet until" and alert codes show internal state instead of what to do.
- **It's built for one business.** Access is two fixed email addresses, names are written into the code, and there are no roles and no way to add a team member.

**The goal.** Anyone who opens the console sees first what needs them, and can finish it in a few taps on a phone. For a practitioner, that means a first action within 10 seconds.

**What v2 ships.**

- One console with six screens: Today, Inbox, Calendar, People, Payments and Settings.
- Three roles: Owner, Practitioner and Staff. Each sees only what their job needs.
- Built for more than one business: a workspace and invited members from day one, and an audit log of every sensitive action. Full multi-tenancy and self-serve setup come in Phase 3.
- Plain-language states and actions. Every number and every button says what it means for a customer.
- The bot flow fixes from the test chat, shipping first and separately (section 8).

## Research

The research points the same way three times: practitioners want a Today list with a Call button and outcome taps, staff want an inbox with booking powers, and owners want availability and money in plain words.

**What we did.**

- **Six simulated operator interviews**, each walked through today's actual screens: a 58-year-old solo healer on an Android phone, a family member running the business, a receptionist, a studio owner with 3 practitioners, a counsellor and a coach.
- **A simulated panel of 20 operators**, asked whether they would use and pay for the console, and which features matter most.
- **Desk research on 15 tools:** Jane, Fresha, Calendly, Cal.com, SimplePractice, Acuity, Practo Ray, Zenoti, WATI, Interakt, AiSensy, respond.io, Help Scout, Razorpay and Stripe, plus GOV.UK and Linear on design, and India's data protection law.
- The interviews and the panel are simulated, so they show likely confusion and objections, not real demand. Five real interviews come before Phase 1 is built (section 9).

**What today's console gets wrong** (each is quoted from the current screens):

- **Two consoles, two looks, two sign-in rules.** Call outcomes are marked on one page, and completed or no-show sessions on the other.
- **System words on screen:** "Reply window: 6 h left", "A template is needed", "SENDS is OFF (env flag)", "Check the Worker's cron triggers", "HEALING/PROTECTION".
- **Outcome buttons that don't say what happens next.** "Session" means "offer a session", and "Report rude" sits right next to the outcome buttons.
- **Countdowns nobody notices:** "Saved. Undo (N min)".
- **Moderation controls that feel like traps:** "Clear strikes / end quiet", "Clear no-sell", "Show number to call".
- **No way for staff to book or move a slot.** "Offer a new time" is only a text box.

**What operators asked for most** (20-person panel, 3 picks each):

| Feature | People who picked it | Weighted score |
| --- | --- | --- |
| Today list with one-tap call and "how did it go" | 7 | 18 |
| Calendar across several practitioners | 7 | 17 |
| One inbox of chats waiting for a person | 5 | 14 |
| Working hours and leave, beyond today and tomorrow | 8 | 13 |
| Roles that show each person only what they need | 6 | 11 |

The weighted score counts a first choice higher than a third. Half the panel (10) would use it; 9 would pay at their own "bargain" price. Studios were the keenest (6 of 7) and older Hindi-speaking solo healers the least keen. The top reasons to pass were "WhatsApp and Razorpay links already work", "it's all in English" and "I can't mark cash payments".

**Patterns worth copying.**

| Pattern | Seen in | Where it lands in v2 |
| --- | --- | --- |
| Outcome buttons appear only after the start time, and every outcome can be undone | [Fresha](https://www.fresha.com/help-center/knowledge-base/calendar/30-mark-appointments-as-no-shows), [Calendly](https://calendly.com/help/how-to-mark-no-shows-for-meetings) | Today's "How did it go?" |
| End-of-day loose ends: no outcome, unpaid, notes unsigned | [Jane](https://jane.app/guide/day-end-procedures-for-practitioners) | Today's "Loose ends" card after the last call |
| Practitioners see only their own schedule and their own customers | [Jane](https://jane.app/guide/staff-access-levels), [Acuity](https://help.acuityscheduling.com/hc/articles/47601371795085) | The Practitioner role |
| Refunds are a separate permission, off for finance and support roles | [Razorpay](https://razorpay.com/docs/payments/dashboard/account-settings/manage-team/), [Stripe](https://docs.stripe.com/dashboard/teams/roles) | Owner-only refunds; staff ask |
| One role per membership, because mixed roles grant more than intended | [Zenoti](https://help.zenoti.com/en/configuration/security-configurations/manage-visibility-for-guest-contact-details.html), [Stripe](https://docs.stripe.com/dashboard/teams/roles) | One role per member |
| Phones shown as the last 4 digits, and masked in exports too | [Zenoti](https://help.zenoti.com/en/configuration/security-configurations/manage-visibility-for-guest-contact-details.html), [Interakt](https://www.interakt.shop/resource-center/team-settings) | People, Inbox, CSV export |
| Inbox views All, Mine and Unassigned, with a closing note | [respond.io](https://respond.io/help/inbox/assignment-and-closing-a-conversation), [Help Scout](https://docs.helpscout.com/article/1429-about-default-folder-views-in-help-scout) | Inbox |
| "Someone else has this open" warning | [Help Scout](https://docs.helpscout.com/article/1583-collaborate-with-your-team-in-the-inbox) | Inbox, done on the server |
| An expired 24-hour window shown as a state, with templates only | [WATI](https://support.wati.io/en/articles/11463004-understanding-chat-statuses-in-team-inbox) | Inbox reply box |
| An activity log of who viewed and changed what, filterable | [Jane](https://jane.app/guide/activity-log) | Settings, audit log |
| One thing per page, full-width buttons, 19 px body text on every screen | [GOV.UK](https://designnotes.blog.gov.uk/2015/07/03/one-thing-per-page/), [GOV.UK type](https://designnotes.blog.gov.uk/2022/12/12/making-the-gov-uk-frontend-typography-scale-more-accessible) | Design system |

**India's data protection law sets hard requirements.** Under the DPDP Act and the 2025 Rules, a business needs access control, masking and logs of who accessed data, kept for at least a year. It must also erase data once its purpose is served. Most obligations apply from around May 2027 ([Section 8](https://dpdpa.com/dpdpa2023/chapter-2/section8.html), [Rule 8](https://dpdpa.com/dpdparules/rule8.html)).

**Competition.** Meta's own Business Agent, which books appointments and hands off to a human, launched globally on 3 June 2026 ([Hyperleap](https://hyperleap.ai/blog/meta-business-agent-india-launch-what-it-means)). The bot alone is no longer a moat, which makes the console the place to stand out.

## Users, roles and permissions

Three roles cover a solo practice and a small team. Each member has exactly one role, because mixed roles grant more than anyone intended; an owner who also takes calls is simply bookable as a practitioner.

- **Owner** runs the business: money, settings, the team and anything that can't be undone. Every workspace has exactly one owner, who can hand ownership to another member.
- **Practitioner** does the calls and sessions: sees their own day, calls the customer, marks what happened, and offers the next step.
- **Staff** looks after customers between calls: answers the chats the bot hands over, moves bookings, and asks an owner for refunds.

| Action | Owner | Practitioner | Staff |
| --- | --- | --- | --- |
| See Today | All of it | Own calls and sessions | Inbox and bookings |
| See the calendar | Everyone's | Own | Everyone's |
| Set working hours and block time off | Anyone's | Own | No |
| Mark a call outcome, offer a session | Yes | Own calls | No |
| Reply to a handed-over chat | Yes | No (they speak on calls) | Yes |
| See a customer's full phone number | Yes, logged | Own booked customers, from 1 hour before to 1 hour after the call, logged; the Call button shows only then | No (last 4 digits) |
| Read a customer's chat | Yes | Own customers | Yes, except safety messages |
| Move or cancel a booking | Yes | Own | Yes |
| Record money received outside Razorpay | Yes | No | Yes, owner approves |
| Refund | Yes | No | Ask owner |
| Block or unblock a number | Yes | No | Ask owner |
| See payment totals and export | Yes | No | No |
| Prices, hours, bot switches, payment keys | Yes | No | No |
| Invite, change roles, remove members | Yes | No | No |
| Read the audit log | Yes | No | No |

**Rules that apply to every role.**

- **Least access by default.** A new member sees nothing beyond their role, and a practitioner sees only customers booked with them.
- **Ask, don't do.** "Ask owner" puts a request on the owner's Today with one-tap approve or decline; nothing happens until then. Refunds the published policy makes automatic, such as a call marked "not a fit" or a booking the business cancels, need no approval.
- **Sensitive actions are logged:** revealing a number, refunds, blocks, role changes, data exports and deletions. The log records who, when and why, with a one-line reason for reveals and refunds, and opening a customer's page counts too. It's kept for at least a year, as India's data protection rules require.
- **Safety items reach everyone who can act.** A crisis or emergency message alerts the workspace's chosen safety contact and shows at the top of Today for owners and the practitioner who has that customer. Staff see only that an owner is needed, not the message text.

## Information architecture

The console has six screens. Everyone lands on Today, and a role sees only the tabs it can use, so a practitioner's console has three tabs, not six.

*(Drawing in the doc: screen map · 6 screens and who sees them.)*

Each screen's title is the question in italics, and Today pulls the urgent part of every other screen to the top.

**Navigation rules.**

- **Everything is two taps from Today at most.** A Today card opens the exact person, chat or payment it's about, and Back returns to the same scroll position.
- **A person is the hub.** Every booking, payment and chat links to that customer's page, and the page links back to each one.
- **Search is always there.** On the People tab, and at the top of the laptop rail: name, or the last 4 digits of the phone number.
- **No dead ends.** Every empty list says what would appear there and links to the next useful place.

**Where today's pages go.**

| Today's page | In v2 |
| --- | --- |
| Practitioner page (call list and outcome buttons) | Today for practitioners, plus the call card's outcome buttons |
| Console Home (needs you, week numbers, switches) | Today (tasks), Payments (numbers) and Settings (switches) |
| People and a person's page | People, with the chat, bookings and payments on one page |
| Payments | Payments, with refunds and approvals moved here from Home |
| Safety controls (strikes, quiet, no-sell) | A "Safety" panel on the person's page, in plain words |

## Screen specs

Every screen follows the same order: urgent items, then the list, then the numbers. Each one shows a line saying who can see it ("Visible to: Owner, Staff"). Everything here ships in Phase 1 unless it's marked Phase 2, and every amount on a button comes from Settings.

### Today: what needs me now?

1. **Safety.** A red card for each crisis or emergency message not yet handled. It shows the time, the customer, "The safety message was sent", and **Open chat**.
2. **Waiting for a reply.** One card per handed-over chat, oldest first: "Asked for a person, 2 h ago. Reply by 6:40 pm." Buttons: **Reply** and **Hand back to the bot**.
3. **Approvals** (owners only). Refunds, blocks and money marked by staff, each with **Approve** and **Decline**, the amount and who asked.
4. **Up next.** Today's calls and sessions in time order. Each row shows the time, first name and last 4 digits, service, who it's for, language, and a **Call** button.
   - From the start time until 24 hours later, the row shows **How did it go?** with three buttons that say what happens next: "Book a session for them", "Not a fit (₹99 refunded)" and "Didn't pick up (offer a new time)".
   - After a tap, the row shows "Saved. Undo until 4:15 pm": a clock time 10 minutes after the tap, rather than a countdown. "Report behaviour" sits under More, away from the outcome buttons.
5. **Later.** "Tomorrow: 3 calls" with a link to the calendar. If today is empty: "No calls today. Next: Thu 29 Oct, 2:00 pm." After the last call, a Loose ends card lists calls with no outcome, unpaid links and open chats, so the day closes clean.

Practitioners see only their own calls and their own customers' safety cards, nothing about money, and can switch the console to Hindi. Owners get a banner only when something affects everyone: "Bookings are paused", "Payments are failing" or "The bot hasn't run for 15 minutes", each with its fix.

*(Drawing in the doc: Today wireframe · phone and laptop, sample data.)*

The same Today on both screens: urgent cards first, then the day in time order. The names and numbers are sample data.

### Inbox: who is waiting for a reply?

- **List:** every chat handed to the team, oldest first, in three views: All, Mine and Unassigned. Each shows why ("Asked for a person", "Payment question", "Safety follow-up"), how long they've waited, and how long is left to reply.
- **The reply window in plain words.** Inside 24 hours: "Reply by 6:40 pm." After that: "WhatsApp only allows a follow-up message now", with the approved follow-up ready to send.
- **Thread:** messages labelled Customer, Bot, Assistant and the team member's name, with a reply box at the bottom.
- **Actions:** **Book or move for them** (opens a real slot picker), **Hand back to the bot** and **Done**, as three separate buttons. **Assign to me** shows others who is replying, so two people don't answer at once. Done asks for a one-line closing note.

### Calendar: when am I booked or free?

- **Day and week views** for one practitioner, or all of them from Phase 2, showing bookings, held times and free times.
- **Working hours** per practitioner, per weekday, defaulting to Monday to Friday, 2 to 7 pm. Phase 2; until then the hours stay as they are today.
- **Time off:** "Away from Mon 2 Nov to Wed 4 Nov". The bot stops offering those times at once. The screen lists only the bookings that clash, and lets you move or refund each one. Phase 2.
- **Book for a customer** (owner and staff): pick the person, the service and a time. Payment goes by the usual link, or is marked as received outside Razorpay.

### People: who is this customer?

- **Search** by name or the last 4 digits. Filters: Waiting, Upcoming, Has a package, Blocked.
- **Person page, top to bottom:**
  - Name, last 4 digits, language, first contact date and the ad they came from.
  - The next booking.
  - Package: "6 of 10 left", with a ledger of bought, used, returned and refunded sessions.
  - Payments.
  - The chat, with the date its text will be deleted ("Text deleted on 3 Nov").
- **Safety panel, in words:** "Not shown booking options until 29 Oct, after a crisis message", with **Allow bookings again**. Strikes and quiet periods are described the same way.
- **More menu** (owners only): Show full number (logged, with a reason), Block, Remove their data.

### Payments: is the money right?

- **Problems first:** failed refunds, refunds still waiting after 7 days, amounts that don't match, and payments with no booking. Each has its next step.
- **This month:** received, refunded and net, plus sessions still owed on packages. Any month is selectable, with CSV export.
- **Record money received outside Razorpay** (cash or a direct UPI transfer). Staff record it from the customer's page, and it shows on the owner's Today until approved.
- **Every payment's status is in words:** Paid, Waiting, Failed, Refund on its way, Refunded, and "Check with Razorpay" with a link to that payment.

### Settings: how does the business run? (owners only)

- **Business:** name, accent colour, default language, time zone.
- **Services and prices:** call, session and package prices, as the bot quotes them.
- **Hours and time off** for each practitioner (Phase 2).
- **Team:** invite by email, set roles, remove members.
- **Bot:**
  - Taking bookings on or off.
  - The assistant on or off, with its daily limit.
  - Who gets the daily summary email.
  - The safety contact who is alerted to crisis messages.
- **Payments:** Razorpay connection, test or live, and whether international cards are on.
- **Privacy:** how long chat text is kept, and whether staff can read chat text.
- **System:** last bot run, last message sent, and errors. This is where today's technical health messages move.
- **Audit log:** who did what and when, filterable by person and action.

### Acceptance checks for Phase 1

Each check is written as a test before the screen is built, and the release passes only when all of them pass.

1. **Today, practitioner.** Given a paid call that started 5 minutes ago, the practitioner sees it first under Up next with the three outcome buttons. Tapping "Didn't pick up" sends the customer the new-time message and shows "Undo until" a time 10 minutes later.
2. **Undo.** Given an outcome tapped 11 minutes ago, Undo is gone, and a POST to undo it is refused with "Too late to undo".
3. **Two tabs.** Given the same call open in two tabs, the second outcome tap shows "Already marked: Not a fit, by you at 4:05 pm" and changes nothing.
4. **Role checks.** Every POST route refuses a member whose role can't do it, even when the form is sent by hand. A hidden button and a refused POST always agree.
5. **Removed member.** A member removed while signed in gets "No access" on their next page load, and their open forms are refused.
6. **Inbox claim.** Given a chat assigned to someone else less than 30 minutes ago, Reply shows a warning naming them. After 30 minutes without a reply, the claim lapses.
7. **Reply window.** Given a chat whose 24-hour window closed, the reply box is replaced by the approved follow-up message, ready to send.
8. **Stale booking.** A past call with no outcome never blocks a new booking. It shows under Loose ends instead.
9. **Masking.** Staff never see more than the last 4 digits anywhere, including CSV exports.

**Failure states.**

- **Razorpay doesn't answer:** the action shows "Razorpay didn't respond. Nothing was charged or refunded. Try again in a minute." The retry is safe because every money action has an idempotency key.
- **A database write fails:** the page says "That didn't save" with the form still filled in. Nothing shows as done until it is saved.
- **WhatsApp send fails:** the card stays on Today with "Message not delivered" and a Retry button.
- **The bot stops running:** the owner banner appears after 15 minutes, and an email goes to the owner.

## Design system

The direction is a calm ledger: warm paper, dark ink, one accent colour, generous space and large type. It should feel like a well-kept appointment book, not an analytics dashboard.

**Principles.**

1. **One screen, one question.** Each screen's title is the question it answers, and the first thing under it is the answer.
2. **Tasks before numbers.** Anything needing a person is a card with a verb on its button. Numbers sit below, and only where someone acts on them.
3. **Say it in the customer's terms.** "Waiting for your reply, 2 hours", never "HUMAN since 14:02". No internal codes on screen.
4. **Colour is never the only signal.** Every status has a word, and the colour only backs it up.
5. **Nothing irreversible in one tap.** Refunds, blocks and removals open a confirm step that names the effect and the amount.

**Tokens.**

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| Paper | #FBFAF7 | #121615 | Page background |
| Surface | #FFFFFF | #1A201F | Cards and rows |
| Ink | #14302F | #E8EEEC | Body text, at least 12:1 on paper |
| Muted | #5B6B69 | #9FB0AD | Secondary text, at least 4.5:1 |
| Accent | #1B6F73 | #5CC2BE | Primary buttons, current tab; a workspace can set its own |
| Attention | #A15C00 | #F0B35A | Waiting on someone |
| Danger | #B3261E | #FF8A80 | Safety items, refunds, failures |
| Done | #2E7D4F | #7FD3A0 | Paid, confirmed |

**Type and spacing.**

- **Typeface:** Jost, self-hosted from the Worker (the CSP adds `font-src 'self'`), with tabular figures for times and amounts. System sans is the fallback. Hindi uses Noto Sans Devanagari, also self-hosted. Every console string lives in one catalogue with English and Hindi from Phase 1.
- **Sizes:** body 19 px on every screen, with nothing below 16 px; times and amounts 20 px semibold; screen titles 26 px. Line height 1.45.
- **Spacing:** steps of 4 px (8, 12, 16, 24, 32). Tap targets are at least 48 by 48 px, with 8 px between them.

**Components.**

- **Task card:** what to do (title), why and how long it has waited (one line), one primary button, at most one secondary link.
- **Appointment row:** time, customer first name and last 4 digits, the service, status in words, and a Call or Open action.
- **Status chip:** a word plus a colour, from a fixed list per object (for example a booking is Held, Confirmed, Done, Missed or Cancelled).
- **Conversation bubble:** customer, bot, assistant and team member messages, each labelled. Assistant answers show the question type in small text.
- **Confirm step:** a `details` panel that opens in place, with the effect in one sentence and a red confirm button. It needs no script.
- **Empty state:** one sentence saying what will appear here, plus the next useful link ("No calls today. Next: Thu 29 Oct, 2:00 pm").
- **Banner:** only for things that affect everyone, such as "Bookings are paused" or "Payments are failing", always with the button that fixes it.

**Layout.**

- **Phone (under 900 px):** one column, a bottom tab bar with four tabs (Today, Inbox, Calendar, People) and a More tab holding Payments and Settings. Primary buttons sit within thumb reach at the bottom of each card.
- **Laptop (900 px and up):** a left rail with the same tabs, and a list-and-detail layout. Inbox, People and Payments show the list on the left and the open item on the right, so you never lose your place. Content width is capped at 1,200 px.

## Backend and data

The console stays inside the same Cloudflare Worker and D1 database. The change is who may do what: fixed email addresses become workspace members with roles, checked on every request.

**Sign-in.**

- **Identity stays with Cloudflare Access** (email one-time code or Google). The Access policy changes from two fixed addresses to "any verified email".
- **Membership is the gate.** The Worker reads the verified email from the Access token, looks up active memberships, and refuses anyone with none. From Phase 3, a member of several workspaces picks one after sign-in.
- **What stays as today:** POST-only changes, the Origin check, per-form CSRF tokens, `no-store`, and the strict CSP with no scripts.

**New tables** (migrations 0011 and on; the existing tables keep their shape).

| Table | Holds | Notes |
| --- | --- | --- |
| `workspaces` | Name, slug, time zone, WhatsApp number id, status | Today's data becomes workspace 1 |
| `members` | Workspace, email, display name, roles, status (invited, active, removed), last seen | One role per membership; an owner can also be bookable as a practitioner |
| `invites` | Email, role, token hash, expiry, invited by | One-time link sent by email; expires in 7 days |
| `availability` | Practitioner, weekday, start and end time | Replaces the fixed 2 to 7 pm in config |
| `time_off` | Practitioner, from, to, reason | Blocks slots without a code change |
| `requests` | Kind (refund, mark paid, block), target, asked by, decided by, decision, reason | The "ask owner" queue |

**Changes to existing tables.**

- `slots`, `intros` and `sessions` gain `practitioner_id`. Existing rows point to the single current practitioner.
- `audit_log` gains `workspace_id`, `member_id` and `reason`. The actor becomes a member, not a raw email.
- `conversations`, `payments` and `packages` gain `workspace_id` in the multi-tenant phase (section 9). Every query then filters by it, enforced in one data helper rather than repeated in each screen.

**Worker changes.**

- **One permission check.** `can(member, action, target)` returns yes, no or "ask". Every route and every button calls it, so a hidden button and a refused POST always agree.
- **One console under `/app`.** `/admin` and `/amma` redirect to it for one release, then go.
- **Settings move out of code.** In Phase 1, prices, the bot switches, the business number and copy overrides go into a settings table. In Phase 3, payment keys are stored per workspace, encrypted with a Worker secret, so a new business can be set up without a deploy.
- **Same few files.** `auth.ts` (sign-in, members, `can`), `ui.ts` (the design system), `console.ts` (routes) and one file per screen. Plain server-rendered HTML, as today.

**Notifications.** The console has no scripts, so anything urgent also goes by email through the existing Cloudflare Email Service. Nobody has to keep the page open.

| Event | Who is told | How | When |
| --- | --- | --- | --- |
| Crisis or emergency message | Safety contact; the customer's practitioner | Email, plus top of Today | At once, any hour |
| Chat handed to the team | Staff and owner | Today and Inbox; email if no reply within 2 hours in working hours | At once on screen |
| An "ask owner" request | Owner | Today; one email bundling the requests | Within 30 minutes |
| Bot not running, or payments failing | Owner | Banner, plus email | After 15 minutes |
| Invite | The person invited | Email with a one-time link | At once; the link lasts 7 days |
| Daily summary | Members chosen in Settings | Email, in the console's words | 9 pm India time |

**Moving today's data (Phase 1), in order.**

1. The migration creates workspace 1 and two members from the two current sign-in emails. The current admin email becomes the Owner, and the current practitioner email becomes a Practitioner.
2. The existing calls, sessions and slots point to that practitioner. Old audit rows keep their raw email and show as "before roles".
3. Prices, the switches and the business number are copied from config into the settings table, with the same values.
4. The new console goes live under `/app` behind a `CONSOLE_V2` switch, while the old pages keep working.
5. Only after the owner has checked it does the owner change the Access policy to "any verified email". This is a Cloudflare setting, so it's done by hand, never by a deploy.
6. `/admin` and `/amma` redirect to `/app` for one release, then are removed.

**Rollback.** Turning `CONSOLE_V2` off brings back the old pages. The new tables are only added to, so nothing needs undoing.

## Bot flow fixes (Ticket 18)

The six problems found in the test chat are fixed in [pull request #29](https://github.com/Rhitrao/dishadira-bot/pull/29). All 740 tests pass, and it's ready to merge and deploy to the test bot.

| Problem in the test chat | Fix |
| --- | --- |
| A past call with no outcome blocked every new booking, and the bot only said so after four taps | One rule everywhere, at the Book tap: only a paid call that hasn't ended, or a live hold, counts. A past call waiting for an outcome goes to the team instead. |
| Late at night, only 2 days were offered | The bot offers the next 3 working days that still have free times, looking up to 10 working days ahead. |
| Questions mid-booking: the step repeated, answers ended with a question, and "Talk to a person" was pushed after 3 good answers | A good answer resets the count, so the person offer comes only after 3 unanswered turns. Answers end by pointing to the step, and a failed answer gets a warm line plus the step. |
| Every help answer came as two messages | The answer and the menu buttons now come in one message, unless the answer is over 1,024 characters. |
| "What is this?" was too thin | It now says no-touch pranic healing by phone with a certified MCKS healer, starting with a 15-minute ₹99 call, in English and Hindi. |
| Silence after "Talk to a person" | The first message after a handoff gets one "Got it. This is with our team, and they'll reply here.", but not after a crisis message. |

**Before deploying:** a Hindi speaker should read the three new Hindi lines: the warm fallback, the handoff acknowledgement, and "What is this?".

## Success metrics, rollout, risks and open questions

The console ships in four phases, and none starts until the one before has passed its gate. Before Phase 1 is built, five real operators try clickable mock-ups of Today and Inbox: two older solo practitioners and three studios.

*(Drawing in the doc: rollout · 4 phases, each with a gate.)*

Phase 1 is the redesign itself. Phase 3 is the step from one business to a product other businesses can sign up for.

**How we'll know it works.**

| Measure | Target |
| --- | --- |
| Time from opening the console to the first action | Under 10 seconds for a practitioner |
| Call outcomes marked within 1 hour of the call ending | 90% or more |
| Handed-over chats answered within WhatsApp's 24-hour window | 95% or more |
| First reply to a handed-over chat during working hours | Median under 2 hours |
| Safety items opened during working hours | Within 15 minutes |
| Questions like "what does this mean?" from the team | None in a week |
| Customers blocked by stale data, like the old-call bug | None |

**Risks.**

- **One business seeing another's data** (Phase 3). Every query goes through one helper that adds the workspace filter, and a test fails any query without it.
- **Sign-in open to any email.** Membership is still the gate, so a stranger gets a polite "No access" page and nothing else. Failed attempts are rate-limited and logged.
- **Hindi quality.** A native speaker reviews every console string before Phase 2 ships.
- **Scope creep.** Each phase is one ticket set with its own PR, following the repo rules.

**Open questions.**

- Pricing: the simulated panel pointed to about ₹499 a month for a solo practice and about ₹999 plus a per-practitioner fee for studios. That needs real interviews first.
- Decided: the default safety contact in a new workspace is the first owner, changeable in Settings.
- Decided: staff read chat text by default, so they can reply, except safety messages. An owner can turn it off in Settings.
- Decided: the Hindi console for practitioners ships in Phase 1, because the first practitioner may prefer Hindi.
- Two-way Google Calendar sync: Phase 2, or later?
