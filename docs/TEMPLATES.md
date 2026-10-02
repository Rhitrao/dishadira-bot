# WhatsApp templates to submit to Meta

Five message templates. Meta must approve them before the bot can message a customer more than 24 hours after their last message (day-before reminders, a booking confirmation after a late payment, and so on). Until a template is approved the bot does **not** send it; it raises an item in Rohit's queue instead.

How to submit (WhatsApp Manager → Message templates → Create template), for every template below:

- **Category:** Utility. Never Marketing.
- **Name:** exactly as written (lower case, underscores). **Language:** English.
- **Header and footer:** none. **Buttons:** none, except `session_offer`, which has one Quick reply button (see below).
- **Variables:** written `{{1}}`, `{{2}}`, `{{3}}`. Paste the sample values shown (Meta requires them; they are examples, not real data).
- Do not add offers, discounts, emojis or promotional words. Each text is a confirmation, reminder or account update about something the customer already did.

The wording matches what the code sends (free text inside 24 hours uses the same sentences, see `docs/COPY.md`). If you change a template, the code's wording in `src/copy.ts` and the parameters in the code must change together; ask Claude.

When Meta approves a template, set its `approved` flag to `true` in `src/config.ts` (section `templates`) through a pull request, then run the Deploy workflow. Do it per template; the others stay off until approved.

---

## 1. call_booked

Sent when a ₹99 payment is received but the customer's 24-hour window has closed.

**Body**

```
Thank you, we have received your payment. Shantha Rao will call you on {{1}} at {{2}} from {{3}}. That number is for her calls only, so please message us here if you need anything.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Day of the call | Tue 6 Oct |
| {{2}} | Time of the call (India time) | 2:00pm |
| {{3}} | The business number Amma calls from | +91 00000 00000 |

## 2. session_offer

Sent after Amma taps "Session", when the 24-hour window has closed. No variables. One Quick reply button.

**Body**

```
Thank you for speaking with Shantha Rao. She would be glad to offer you a full session. Tap below to choose a time.
```

**Button:** one **Quick reply**, text exactly `Choose a time`. The bot treats a tap on it, or any reply, from someone with an open offer as "show me the times". Header and footer stay empty.

No variables, so no sample values. (The price is left out on purpose so a price change never needs a new template; the chat tells the customer the price when they choose a time.)

## 3. session_confirmed

Sent when the ₹700 session payment is received and the 24-hour window has closed.

**Body**

```
Your session with Shantha Rao is confirmed for {{1}} at {{2}} (India time). It is a distance session: you stay where you are and she calls you at the booked time. Please keep your phone with you in a quiet place. We will remind you the day before.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Day of the session | Wed 7 Oct |
| {{2}} | Time of the session (India time) | 3:00pm |

## 4. reminder

Sent at 6:30 pm the evening before a call or a session (outside the 24-hour window; inside it the same sentence goes as normal text).

**Body**

```
Reminder: your {{1}} with Shantha Rao is tomorrow, {{2}} at {{3}} (India time). Please keep your phone with you.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | The word "call" or "session" | call |
| {{2}} | Day | Tue 6 Oct |
| {{3}} | Time (India time) | 2:00pm |

## 5. payment_update

Sent when Amma says a session is not the right fit and the ₹99 is refunded, and the 24-hour window has closed.

**Body**

```
Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your {{1}}.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | The amount refunded | ₹99 |
