# WhatsApp templates to submit to Meta

Seven message templates. Meta must approve them before the bot can message a customer more than 24 hours after their last message (day-before reminders, a booking confirmation after a late payment, and so on). Until a template is approved the bot does **not** send it; it raises an item in Rohit's queue instead.

How to submit (WhatsApp Manager → Message templates → Create template), for every template below:

- **Category:** Utility. Never Marketing.
- **Name:** exactly as written (lower case, underscores). **Language:** English.
- **Header and footer:** none. **Buttons:** none, except `session_offer` and `package_confirmed`, which have one Quick reply button each (see below).
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
Thank you, we have received your payment. Shantha Rao will call you on {{1}} at {{2}} (India time), on the number you are messaging from. The call may come from a number you don't know, so please keep your phone nearby. This WhatsApp number is for messages only, not calls.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Day of the call | Tue, 6 Oct |
| {{2}} | Time of the call (India time) | 2:00 pm |

No number is ever given: Amma calls from a different number, which is not shown (owner, 29 Oct 2026). Also sent when the team moves a paid call and the 24-hour window has closed.

## 2. session_offer

Sent after Amma taps "Session", when the 24-hour window has closed. No variables. One Quick reply button.

**Body**

```
Thank you for speaking with Shantha Rao. She would be glad to offer you a full session. Tap below to see your options.
```

**Button:** one **Quick reply**, text exactly `See options`. The bot treats a tap on it, or any reply, from someone with an open offer as "show me the options" and sends the list (a single session, or a package of 10 or 20). Header and footer stay empty.

No variables, so no sample values. (Prices are left out on purpose so a price change never needs a new template; the list in the chat shows them.)

## 3. session_confirmed

Sent when the ₹799 session payment is received and the 24-hour window has closed.

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

Sent when a refund has been started and the 24-hour window has closed: the ₹99 after "not right fit", a whole purchase after "not right fit" on a first session, or the unused sessions of a package.

**Body**

```
Your refund of {{1}} has been started. It goes back to your original payment method, and how long it takes depends on your bank.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | The amount refunded | ₹99 |

## 6. package_confirmed

Sent when a package payment is received and the 24-hour window has closed. One Quick reply button.

**Body**

```
Payment received. You have {{1}} sessions. Book your first one now?
```

**Button:** one **Quick reply**, text exactly `Book a session`. The bot treats a tap on it, from someone with sessions left in a package, as "start booking a session". Header and footer stay empty.

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Number of sessions in the package | 10 |

## 7. session_booked

Sent when a session is booked from a package and the 24-hour window has closed.

**Body**

```
Your session is booked for {{1}} at {{2}} (India time). Shantha Rao will call you then. Sessions left: {{3}}.
```

| Variable | Meaning | Sample value |
|---|---|---|
| {{1}} | Day of the session | Wed, 7 Oct |
| {{2}} | Time of the session (India time) | 2:00 pm |
| {{3}} | Sessions left in the package | 9 |

## 8. follow_up

Sent from the console's Inbox by a team member when a customer handed to the team has not written for 24 hours, so a normal reply can no longer go (ticket 22). No variables, no buttons. **Not in the CONTRACT's template list yet:** submit it only after Rohit has said yes (STATUS.md, "Blocked"). The bot's own automatic follow-ups (60 minutes and 20 hours after a message, ticket 35, docs/SOCIAL.md) never use this or any template: they are free text inside the 24-hour window only.

**Body**

```
We're following up on your message to our team. Please reply here when it suits you, and we'll carry on from there.
```

No variables, so no sample values.

---

## Hindi versions

Seven more templates, one per template above, with the same variables in the same order. **Name:** the English name plus `_hi` (for example `reminder_hi`). **Language:** Hindi. Category, header, footer and buttons as for the English one. The values the bot sends are in Hindi too: the day as `मंगल, 6 अक्टूबर` and the time as `दोपहर 2:00` or `शाम 5:30`. These drafts are built from the sentences in `docs/KNOWLEDGE.md` §11; Amma should read them before they are submitted. Set the template's `hi.approved` flag in `src/config.ts` when Meta approves it.

**As submitted (30 Oct 2026):** `session_confirmed`, `reminder`, `package_confirmed` and `follow_up` are named with `_hind` (for example `reminder_hind`), because their first `_hi` copies were filed under language English and were deleted; a deleted name stays blocked for 30 days. `src/config.ts` uses these names. Meta filed `session_offer`, `package_confirmed`, `session_offer_hi`, `package_confirmed_hind` and `follow_up_hind` under Marketing rather than Utility.

### 1. call_booked_hi

```
हमें आपका भुगतान मिल गया है। शांता राव जी {{1}} को {{2}} बजे (भारतीय समय) आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं।
```

Samples: {{1}} मंगल, 6 अक्टूबर · {{2}} दोपहर 2:00

### 2. session_offer_hi

```
शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन देना चाहेंगी। अपने विकल्प देखने के लिए नीचे टैप करें।
```

One Quick reply button, text `विकल्प देखें`. No variables.

### 3. session_confirmed_hind

```
शांता राव जी के साथ आपका सेशन {{1}} को {{2}} बजे (भारतीय समय) तय हो गया है। यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे।
```

Samples: {{1}} बुध, 7 अक्टूबर · {{2}} दोपहर 3:00

### 4. reminder_hind

```
याद दिला दें: शांता राव जी के साथ आपकी बुकिंग ({{1}}) कल, {{2}} को {{3}} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।
```

{{1}} is the word `कॉल` or `सेशन` (the Hindi sentence is built around "बुकिंग" so that it reads right for both). Samples: {{1}} कॉल · {{2}} मंगल, 6 अक्टूबर · {{3}} दोपहर 2:00

### 5. payment_update_hi

```
आपके {{1}} के रिफ़ंड की प्रक्रिया शुरू हो गई है। यह राशि आपके भुगतान के तरीके में वापस जाएगी, और कितना समय लगेगा यह आपके बैंक पर निर्भर करता है।
```

Sample: {{1}} ₹99

### 6. package_confirmed_hind

```
भुगतान मिल गया। आपके पास {{1}} सेशन हैं। क्या अभी पहला सेशन बुक करें?
```

One Quick reply button, text `सेशन बुक करें`. Sample: {{1}} 10

### 7. session_booked_hi

```
आपका सेशन {{1}} को {{2}} बजे (भारतीय समय) बुक हो गया है। शांता राव जी उसी समय कॉल करेंगी। बचे हुए सेशन: {{3}}।
```

Samples: {{1}} बुध, 7 अक्टूबर · {{2}} दोपहर 2:00 · {{3}} 9

### 8. follow_up_hind

```
हमारी टीम को भेजे आपके संदेश के बारे में हम फिर से संपर्क कर रहे हैं। जब सुविधा हो, यहीं जवाब दें, हम वहीं से बात आगे बढ़ाएँगे।
```

No variables.
