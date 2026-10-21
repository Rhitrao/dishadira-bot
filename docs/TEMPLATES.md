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

A Hindi customer gets the Hindi version of a template (see "Hindi versions" at the end) once Meta has approved it and its own `hi.approved` flag in `src/config.ts` is `true`. Until then the English template is sent.

---

## 1. call_booked

Sent when a ₹99 payment is received but the customer's 24-hour window has closed.

**Body**

```
Thank you, we have received your payment. Shantha Rao will call you on {{1}} at {{2}} from {{3}}. That number is for her calls only, so please message us here if you need anything.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Day of the call | Tue, 6 Oct |
| {{2}} | Time of the call (India time) | 2:00 pm |
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
| {{1}} | Day of the session | Wed, 7 Oct |
| {{2}} | Time of the session (India time) | 3:00 pm |

## 4. reminder

Sent at 6:30 pm the evening before a call or a session (outside the 24-hour window; inside it the same sentence goes as normal text).

**Body**

```
Reminder: your {{1}} with Shantha Rao is tomorrow, {{2}} at {{3}} (India time). Please keep your phone with you.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | The word "call" or "session" | call |
| {{2}} | Day | Tue, 6 Oct |
| {{3}} | Time (India time) | 2:00 pm |

## 5. payment_update

Sent when Amma says a session is not the right fit and the ₹99 is refunded, and the 24-hour window has closed.

**Body**

```
Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your {{1}}.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | The amount refunded | ₹99 |

---

## Hindi versions

Five more templates, one per template above, with the same variables in the same order. **Name:** the English name plus `_hi` (for example `reminder_hi`). **Language:** Hindi. Category, header, footer and buttons as for the English one. The values the bot sends are in Hindi too: the day as `मंगल, 6 अक्टूबर` and the time as `दोपहर 2:00` or `शाम 5:30`. These drafts are built from the sentences in `docs/KNOWLEDGE.md` §11; Amma should read them before they are submitted. Set the template's `hi.approved` flag in `src/config.ts` when Meta approves it.

### 1. call_booked_hi

```
हमें आपका भुगतान मिल गया है। शांता राव जी {{1}} को {{2}} बजे {{3}} से आपको कॉल करेंगी। वह नंबर सिर्फ़ उनकी कॉल के लिए है, इसलिए मैसेज यहीं भेजें।
```

Samples: {{1}} मंगल, 6 अक्टूबर · {{2}} दोपहर 2:00 · {{3}} +91 00000 00000

### 2. session_offer_hi

```
शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन देना चाहेंगी। समय चुनने के लिए नीचे टैप करें।
```

One Quick reply button, text `समय चुनें`. No variables.

### 3. session_confirmed_hi

```
शांता राव जी के साथ आपका सेशन {{1}} को {{2}} बजे (भारतीय समय) तय हो गया है। यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे।
```

Samples: {{1}} बुध, 7 अक्टूबर · {{2}} दोपहर 3:00

### 4. reminder_hi

```
याद दिला दें: शांता राव जी के साथ आपकी बुकिंग ({{1}}) कल, {{2}} को {{3}} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।
```

{{1}} is the word `कॉल` or `सेशन` (the Hindi sentence is built around "बुकिंग" so that it reads right for both). Samples: {{1}} कॉल · {{2}} मंगल, 6 अक्टूबर · {{3}} दोपहर 2:00

### 5. payment_update_hi

```
शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके {{1}} वापस कर दिए गए हैं।
```

Sample: {{1}} ₹99
