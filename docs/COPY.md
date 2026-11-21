# Message copy for review

Every message the bot sends to customers on WhatsApp, in English and Hindi, exactly as it is in the code (`src/copy.ts`). **This file is generated** from the code by `test/copydoc.ts`; a test fails when it is out of date. To change a message, change `src/copy.ts` (or ask Claude), then regenerate: `UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts`.

Words in {curly brackets} are filled in automatically (a day, a time, a number). Prices, call lengths, the hold time, the opening hours and the name of the "Energy cleansing" service come from `src/config.ts`.

Rules the copy follows: it never names an illness, never promises a result, never asks for health details (one exception, the owner's decision of 4 Nov 2026: after a paid ₹99 call, what they'd like help with, from a short list; section 8d). Amma's page (section 9) is English only.

Dates and times customers see are in India time: English `Wed, 21 Oct` and `2:30 pm`; Hindi `बुध, 21 अक्टूबर` and `दोपहर 2:30` (`सुबह` before noon, `शाम` from 4 pm).

## 1. First message and menu

What a customer sees first. The greeting is one message in both languages, followed by two buttons: English and हिंदी.

| Where it appears | English | हिंदी |
|---|---|---|
| Greeting (then the buttons English / हिंदी) | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally, on a voice call (audio only, no video). To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद वॉइस कॉल करती हैं (सिर्फ़ आवाज़, वीडियो नहीं)। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally, on a voice call (audio only, no video). To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद वॉइस कॉल करती हैं (सिर्फ़ आवाज़, वीडियो नहीं)। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: |
| Language buttons again, after "Change language" | Please choose your language / कृपया भाषा चुनें: | Please choose your language / कृपया भाषा चुनें: |
| Menu question | What would you like to do? You can also type your question. | आप क्या करना चाहेंगे? आप अपना सवाल लिखकर भी पूछ सकते हैं। |
| Menu button 1 (max 20 letters) | Book ₹99 call | ₹99 कॉल बुक करें |
| Menu button 2 (max 20 letters) | Sessions & packages | सेशन और पैकेज |
| Menu button 3 (max 20 letters) | Help | मदद |
| "Talk to a person" (a row in the Help list; also a button in the fallback menu and while nothing may be sold) (max 20 letters) | Talk to a person | किसी से बात करें |
| After "Talk to a person" | Thank you. A person from our team will reply here, usually within 24 hours. | धन्यवाद। हमारी टीम का कोई व्यक्ति आमतौर पर 24 घंटे के अंदर यहीं जवाब देगा। |
| The first message typed while a person from the team has the chat (once per handoff) | Got it. This is with our team, and they'll reply here. | ठीक है। आपका मैसेज हमारी टीम तक पहुँच गया है, वे यहीं जवाब देंगे। |
| Shown instead of booking while booking is closed | New bookings are paused for a short while. Please message us again in a day or two, or tap below to talk to our team. | नई बुकिंग कुछ समय के लिए रुकी हुई है। कृपया एक-दो दिन बाद फिर मैसेज करें, या हमारी टीम से बात करने के लिए नीचे दबाएँ। |
| An old "Ask a question" button still in an older chat | Please type your question below. | कृपया अपना सवाल नीचे लिखें। |
| A typed message the bot has no fixed answer for (at most once every 30 minutes; with Book, Help and Talk to a person). Also a question in the very first message, after the language tap | I'm the booking assistant and can't answer typed questions. Tap below to book, or "Talk to a person". | मैं बुकिंग असिस्टेंट हूँ और लिखे हुए सवालों का जवाब नहीं दे सकता। बुक करने के लिए नीचे दबाएँ, या "किसी से बात करें" चुनें। |
| A voice note, photo, video, sticker, file, location or contact from someone with no booking (first one each day) | Thank you — our team will take a look and reply here if needed. You can also type your question, or tap a button below. | धन्यवाद — हमारी टीम इसे देखेगी और ज़रूरत हुई तो यहीं जवाब देगी। आप अपना सवाल लिखकर भी भेज सकते हैं, या नीचे कोई बटन दबाएँ। |
| The same, from someone with a held time, a payment in progress or a booking | Thank you — our team will take a look and reply here if needed. | धन्यवाद — हमारी टीम इसे देखेगी और ज़रूरत हुई तो यहीं जवाब देगी। |

## 2. Help list

The list behind "Help": the six answers, then My bookings, Talk to a person and Change language (nine rows).

| Where it appears | English | हिंदी |
|---|---|---|
| List heading | How can we help? | हम कैसे मदद कर सकते हैं? |
| List button (max 20 letters) | Choose | चुनें |
| Row: My bookings (max 24 letters) | My bookings | मेरी बुकिंग |
| Row: Change language (max 24 letters) | Change language | भाषा बदलें |
| Topic title "what_is_this" (max 24 letters) | What is this? | यह क्या है? |
| Answer "what_is_this" | Disha Dira offers no-touch pranic healing by phone with Shantha Rao, a certified Pranic Healer trained in the MCKS system. The first step is a 15-minute call with her for ₹99: a voice call by phone (audio only, no video). | दिशा दिरा में शांता राव जी, जो MCKS पद्धति में प्रशिक्षित सर्टिफ़ाइड प्राणिक हीलर हैं, फ़ोन पर बिना छुए प्राणिक हीलिंग करती हैं। पहला कदम उनके साथ 15 मिनट की ₹99 की कॉल है: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। |
| Topic title "how_it_works" (max 24 letters) | How it works | यह कैसे होता है |
| Answer "how_it_works" | 1. Pick a call time. 2. Pay ₹99. 3. Shantha Rao calls you for 15 minutes: a voice call by phone (audio only, no video). 4. If you both agree, you can book a full session or a package. | 1. कॉल का समय चुनें। 2. ₹99 का भुगतान करें। 3. शांता राव जी आपको 15 मिनट के लिए कॉल करेंगी: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। 4. अगर आप दोनों को ठीक लगे, तो आप पूरा सेशन या पैकेज बुक कर सकते हैं। |
| Topic title "price" (max 24 letters) | Price | फ़ीस |
| Answer "price" | The first call is ₹99. A single session is ₹799. Packages: 10 sessions for ₹5,000 (₹500 each) or 20 for ₹9,000 (₹450 each), with no expiry. | पहली कॉल ₹99 की है। एक सेशन ₹799 का है। पैकेज: 10 सेशन ₹5,000 में (₹500 प्रति सेशन) या 20 सेशन ₹9,000 में (₹450 प्रति सेशन), कोई समय-सीमा नहीं। |
| Topic title "timings" (max 24 letters) | Call timings | कॉल का समय |
| Answer "timings" | Calls are Monday to Saturday, 2 pm to 7 pm (India time). | कॉल सोमवार से शनिवार, दोपहर 2 बजे से शाम 7 बजे तक (भारतीय समय) होती हैं। |
| Topic title "refund" (max 24 letters) | Refunds | रिफ़ंड |
| Answer "refund" | If Shantha Rao feels the call is not the right fit, your ₹99 is refunded. A single session can be moved once, up to 3 hours before, and cancelled for a full refund 24 hours or more before. A package session that you move or cancel 3 hours or more before goes back to your package. If we have to cancel, you are refunded too. | अगर पहली कॉल के बाद शांता राव जी को लगे कि यह आपके लिए सही नहीं है, तो आपके ₹99 वापस कर दिए जाते हैं। एक सेशन का समय 3 घंटे पहले तक एक बार बदला जा सकता है, और 24 घंटे या उससे पहले रद्द करने पर पूरे पैसे वापस मिलते हैं। पैकेज का सेशन 3 घंटे या उससे पहले बदलने या रद्द करने पर आपके पैकेज में वापस जुड़ जाता है। अगर हमें कॉल रद्द करनी पड़े, तब भी पैसे वापस मिलते हैं। |
| Topic title "privacy" (max 24 letters) | Your privacy | आपकी प्राइवेसी |
| Answer "privacy" | We keep only your name, WhatsApp number, bookings and payments. Please do not share health details here. | हम सिर्फ़ आपका नाम, WhatsApp नंबर, बुकिंग और भुगतान की जानकारी रखते हैं। चैट के मैसेज आख़िरी मैसेज के 7 दिन बाद मिटा दिए जाते हैं। कृपया यहाँ सेहत से जुड़ी जानकारी या रिपोर्ट न भेजें। |

## 3. Booking the first call

The steps before the payment: age check (once per person), service, who it is for, day, time, then pay. Words in {curly brackets} are filled in automatically.

| Where it appears | English | हिंदी |
|---|---|---|
| Age question (once per person) | Are you 18 or older? | क्या आपकी उम्र 18 साल या उससे ज़्यादा है? |
| Age button (max 20 letters) | Yes | हाँ |
| Age button (max 20 letters) | No | नहीं |
| After "No" | Please ask a parent or guardian to message us. They can book the call for you. | कृपया अपने माता-पिता या अभिभावक से हमें मैसेज करने को कहें। वे आपके लिए कॉल बुक कर सकते हैं। |
| Which service? | Which would you like? | आप किस तरह का सेशन चाहेंगे? |
| Service button (max 20 letters) | Healing | हीलिंग |
| Service button (max 20 letters); the name comes from config.serviceNames | Energy cleansing | एनर्जी क्लींजिंग |
| Who is it for? | Who is this for? | यह किसके लिए है? |
| Button (max 20 letters) | Me | मेरे लिए |
| Button (max 20 letters) | Family member | परिवार के लिए |
| Button (max 20 letters) | Pet | पालतू जानवर के लिए |
| Which day? One list with up to 6 days that still have a free time (row titles e.g. "Wed, 21 Oct" / "बुध, 21 अक्टूबर"); holidays are left out | Which day suits you? (India time) | कौन सा दिन आपके लिए ठीक रहेगा? (भारतीय समय) |
| Day list: button (max 20 letters) | Choose a day | दिन चुनें |
| Day list: line under a day with afternoon and evening times (max 72 letters) | Afternoon and evening times | दोपहर और शाम का समय |
| Day list: line under a day with afternoon times only (max 72 letters) | Afternoon times | दोपहर का समय |
| Day list: line under a day with evening times only (max 72 letters) | Evening times | शाम का समय |
| Time list: message | Free times on {day} (India time). Each call is 15 minutes, a voice call by phone (audio only, no video). | {day} के लिए खाली समय (भारतीय समय)। हर कॉल 15 मिनट की होती है: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। |
| Time list: button (max 20 letters) | Choose a time | समय चुनें |
| Time list: section before 4 pm (max 24 letters) | Afternoon | दोपहर |
| Time list: section from 4 pm (max 24 letters) | Evening | शाम |
| Time list: line under each time (max 72 letters) | 15-min voice call | 15 मिनट की वॉइस कॉल |
| Time list: last row, shows the days again (max 24 letters) | Another day | दूसरा दिन |
| No call times free | There are no free call times in the next few days. Tap "Talk to a person", or check back tomorrow. | अगले कुछ दिनों में कॉल का कोई खाली समय नहीं है। "किसी से बात करें" दबाएँ, या कल फिर देखें। |
| The chosen time was just taken | Sorry, that time was just taken. Please choose another. | माफ़ कीजिए, यह समय अभी-अभी बुक हो गया। कृपया दूसरा समय चुनें। |
| Customer already has a time held | A time is already held for you. Please use the payment button above, or try again in a few minutes. | आपके लिए एक समय पहले से रोका गया है। ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें। |
| Customer already has a booked call | Your call is already booked for {day} at {time}. Shantha Rao will call you then. | आपकी कॉल पहले से {day} को {time} बजे बुक है। शांता राव जी उसी समय आपको कॉल करेंगी। |
| Pay message (above the pay button). {until} is when the hold ends (India time); {link} is our own payment link, the same one the button opens (section 8) | {day} at {time} is held for you until {until} (India time). ⏎  ⏎ Tap "Pay ₹99" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपके लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "₹99 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Pay button (max 20 letters) | Pay ₹99 | ₹99 भुगतान करें |
| Payment link could not be made | Sorry, we couldn't create the payment link. Nothing was charged. Please try again. | माफ़ कीजिए, भुगतान लिंक नहीं बन पाया। कोई पैसा नहीं कटा है। कृपया फिर से कोशिश करें। |
| About 8 minutes before a held call or session time ends, if it is still unpaid (once; only inside the 24-hour window). "HELP" or "मदद" on its own reaches a person | Your time is still held until {until} (India time). Pay here: {link} ⏎  ⏎ Having trouble paying? Reply HELP and we will help you. | आपका समय अभी {until} बजे तक (भारतीय समय) रोका गया है। यहाँ भुगतान करें: {link} ⏎  ⏎ भुगतान में दिक्कत हो रही है? HELP या मदद लिखकर भेजें, हम आपकी मदद करेंगे। |
| Payment received: call confirmed (the call language is the language of the chat when booking). No number is given: she calls the customer's own phone | Received your ₹99. Shantha Rao will call you on {day} at {time} (India time), on the number you are messaging from. It is a voice call by phone (audio only, no video), in English. The call may come from a number you don't know, so please keep your phone nearby. This WhatsApp number is for messages only, not calls. | हमें आपके ₹99 मिल गए हैं। शांता राव जी {day} को {time} बजे (भारतीय समय) आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होगी, हिंदी में। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं। |

## 4. After Amma's call

What the customer gets, depending on what Amma tapped. After "Session" the customer chooses a single session, 10 or 20 (a list; section 5). A single session uses the same day and time steps, without the age, service and who-for steps.

| Where it appears | English | हिंदी |
|---|---|---|
| Session offer: message (above the list of options) | Thank you for speaking with Shantha Rao. She would be glad to offer you a full session. Choose an option below: a single session, or a package of 10 or 20. | शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन देना चाहेंगी। नीचे एक विकल्प चुनें: एक सेशन, या 10 या 20 सेशन का पैकेज। |
| Template button "Choose a time" (max 20 letters) | Choose a time | समय चुनें |
| Session time list: message | Free times on {day} (India time). Each session is 60 minutes, a voice call by phone (audio only, no video). | {day} के लिए खाली समय (भारतीय समय)। हर सेशन 60 मिनट का होता है: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। |
| Session time list: line under each time (max 72 letters) | 60-min session | 60 मिनट का सेशन |
| No session times free | There are no free session times in the next few days. Tap "Talk to a person", or check back tomorrow. | अगले कुछ दिनों में सेशन का कोई खाली समय नहीं है। "किसी से बात करें" दबाएँ, या कल फिर देखें। |
| Session cannot be booked from this message | Sorry, we cannot book a session from this message. A person will look into it. | माफ़ कीजिए, इस मैसेज से सेशन बुक नहीं हो सकता। हमारी टीम इसे देखेगी। |
| Session pay message ({until}, {link}: as for the call) | {day} at {time} is held for your session until {until} (India time). ⏎  ⏎ Tap "Pay ₹799" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपके सेशन के लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "₹799 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Session pay button (max 20 letters) | Pay ₹799 | ₹799 भुगतान करें |
| Session paid and confirmed. Until the reminder template is approved, the last sentence is "Please note the time; we'll message you here if anything changes." when the day-before reminder could not reach them | Your session with Shantha Rao is confirmed for {day} at {time} (India time). It is a distance session, a voice call by phone (audio only, no video): you stay where you are and she calls you at the booked time. Please keep your phone with you in a quiet place. We will remind you the day before. | शांता राव जी के साथ आपका सेशन {day} को {time} बजे (भारतीय समय) तय हो गया है। यह दूर से होने वाला सेशन है, फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं): आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे। |
| "Not right fit": refund | Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we're refunding your ₹99. It usually reaches your account in 5–7 working days. | शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके ₹99 वापस किए जा रहे हैं। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है। |
| "Missed": choose a new time | Sorry we missed each other. Choose a new time for your call. There is nothing more to pay. | माफ़ कीजिए, हमारी बात नहीं हो पाई। अपनी कॉल के लिए नया समय चुनें। आपको कोई और भुगतान नहीं करना है। |
| New time chosen after a missed call (also a call moved by the team) | Your call is now booked for {day} at {time} (India time). Shantha Rao will call you on the number you are messaging from: a voice call by phone (audio only, no video). The call may come from a number you don't know, so please keep your phone nearby. There is nothing more to pay. This WhatsApp number is for messages only, not calls. | आपकी कॉल अब {day} को {time} बजे (भारतीय समय) बुक है। शांता राव जी आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। आपको कोई और भुगतान नहीं करना है। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं। |
| A call that cannot be moved again | Sorry, this call cannot be moved again. A person will look into it. | माफ़ कीजिए, यह कॉल दोबारा नहीं बदली जा सकती। हमारी टीम इसे देखेगी। |
| Missed a second time | We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again. | दूसरी बार भी आपसे बात नहीं हो पाई, इसलिए हम यह बुकिंग बंद कर रहे हैं। आपकी रुचि के लिए धन्यवाद। आप कभी भी हमें फिर से लिख सकते हैं। |

## 5. Sessions, packages and My bookings

Prices and the per-session rates are built from `src/config.ts` (price ÷ sessions). Buying a single session uses the same steps as the first call (age check once, service, who for, day, time, pay). A package has no time step: pay, then book each session from the credits.

| Where it appears | English | हिंदी |
|---|---|---|
| Sessions & packages: list heading | Sessions are 60 minutes, a voice call by phone (audio only, no video). Choose an option. Most people start with the ₹99 call, so Shantha Rao can suggest what suits them. | हर सेशन 60 मिनट का होता है: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। एक विकल्प चुनें। ज़्यादातर लोग ₹99 की कॉल से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा। |
| Sessions & packages: list button (max 20 letters) | See options | विकल्प देखें |
| Row 1: the first call (max 24 letters) | ₹99 first call | ₹99 पहली कॉल |
| Row 1: line under it (max 72 letters) | 15-min voice call with Shantha Rao (no video) | शांता राव जी से 15 मिनट की वॉइस कॉल (वीडियो नहीं) |
| Row 2: single session (max 24 letters) | Single session | एक सेशन |
| Row 2: line under it (max 72 letters) | ₹799 | ₹799 |
| Row 3: the 10-pack (max 24 letters) | 10 sessions | 10 सेशन |
| Row 3: line under it (max 72 letters) | ₹5,000 · ₹500 each · no expiry | ₹5,000 · ₹500 प्रति सेशन · कोई समय-सीमा नहीं |
| Row 4: the 20-pack (max 24 letters) | 20 sessions | 20 सेशन |
| Row 4: line under it (max 72 letters) | ₹9,000 · ₹450 each · no expiry | ₹9,000 · ₹450 प्रति सेशन · कोई समय-सीमा नहीं |
| Soft gate: shown when someone who never had the first call picks a session or package (buttons: Book call / Continue) | Most people start with a ₹99 call, so Shantha Rao can understand what you need first. Would you like to do that, or continue? | ज़्यादातर लोग पहले ₹99 की कॉल करते हैं, ताकि शांता राव जी आपकी ज़रूरत समझ सकें। क्या आप ऐसा करना चाहेंगे, या आगे बढ़ें? |
| Soft gate: Continue (max 20 letters) | Continue | आगे बढ़ें |
| Package: pay message (above the pay button); the link is open for an hour | 10 sessions for {price}. After paying, you book each session whenever you like, with no payment per session. ⏎  ⏎ Tap "Pay {price}" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. The link is open until {until} (India time). Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | 10 सेशन {price} में। भुगतान के बाद आप जब चाहें हर सेशन बुक कर सकते हैं, हर बार भुगतान नहीं करना होगा। ⏎  ⏎ नीचे "{price} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। यह लिंक {until} बजे तक (भारतीय समय) खुला है। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Package: pay button (max 20 letters) | Pay {price} | {price} भुगतान करें |
| Package: a payment link is already open | A payment link for a package is already open. Please use the payment button above, or try again in a few minutes. | पैकेज का भुगतान लिंक पहले से खुला है। कृपया ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें। |
| Package paid: the credits are added (button below: Book a session) | Payment received. You have 10 sessions. Book your first one now? | भुगतान मिल गया। आपके पास 10 सेशन हैं। क्या अभी पहला सेशन बुक करें? |
| Button under it (max 20 letters) | Book a session | सेशन बुक करें |
| A session booked from a package credit | Your session is booked for {day} at {time} (India time). Shantha Rao will call you then: a voice call by phone (audio only, no video). Sessions left: 9. | आपका सेशन {day} को {time} बजे (भारतीय समय) बुक हो गया है। शांता राव जी उसी समय कॉल करेंगी: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। बचे हुए सेशन: 9। |
| Two sessions are already booked | You already have 2 upcoming sessions. You can book the next one after one of them. | आपके 2 सेशन पहले से बुक हैं। उनमें से एक होने के बाद आप अगला बुक कर सकते हैं। |
| No sessions left in the package | You have no sessions left in your package. You can buy a single session or a new package from "Sessions & packages". | आपके पैकेज में कोई सेशन नहीं बचा है। आप "सेशन और पैकेज" से एक सेशन या नया पैकेज ले सकते हैं। |
| Sessions left (added when there is nothing booked) | Sessions left in your package: 9. | पैकेज में बचे सेशन: 9। |
| My bookings: the list and the sessions left, for someone with a package | Your bookings: {list}. Sessions left in your package: 9. | आपकी बुकिंग: {list}। पैकेज में बचे सेशन: 9। |
| My bookings: the list, for someone without a package | Your bookings: {list}. | आपकी बुकिंग: {list}। |
| My bookings: nothing booked | You have no upcoming bookings. | आपकी कोई आने वाली बुकिंग नहीं है। |
| My bookings: one entry (the word is call or session) | {call or session} on {day} at {time} | {call or session}, {day} को {time} बजे |
| My bookings: one session, with the buttons Move and Cancel (when there is more than one booking) | Your session on {day} at {time}. What would you like to do? | {day} को {time} बजे आपका सेशन। आप क्या करना चाहेंगे? |
| Button (max 20 letters) | Move | समय बदलें |
| Button (max 20 letters) | Cancel | रद्द करें |
| A booking that no longer exists or has changed | Sorry, we couldn't find that booking. It may have changed. Please open My bookings again. | माफ़ कीजिए, वह बुकिंग नहीं मिली। शायद वह बदल गई है। कृपया "मेरी बुकिंग" फिर से खोलें। |
| Less than 3 hours before: it can no longer be moved or cancelled | Sorry, sessions can only be moved or cancelled up to 3 hours before. | माफ़ कीजिए, सेशन का समय सिर्फ़ 3 घंटे पहले तक बदला या रद्द किया जा सकता है। |
| A single session that was already moved once (button: Talk to a person) | This session has already been moved once, so it can't be moved again. If you need help, please talk to a person from our team. | इस सेशन का समय एक बार बदला जा चुका है, इसलिए इसे दोबारा नहीं बदला जा सकता। मदद चाहिए तो कृपया हमारी टीम के किसी व्यक्ति से बात करें। |
| A session moved to a new time | Done. Your session is now on {day} at {time} (India time). | हो गया। आपका सेशन अब {day} को {time} बजे (भारतीय समय) है। |
| A package session cancelled in time: the credit is back | Cancelled. The session is back in your package. Sessions left: 9. | रद्द हो गया। सेशन आपके पैकेज में वापस जुड़ गया है। बचे हुए सेशन: 9। |
| A single session cancelled 24 hours or more before: refund | Cancelled. As it was 24 hours or more before, the full amount will be refunded to your original payment method. | रद्द हो गया। क्योंकि यह 24 घंटे या उससे पहले था, पूरी राशि आपके भुगतान के तरीके में वापस कर दी जाएगी। |
| A single session cancelled 3 to 24 hours before: no refund, move instead (buttons: Move / Keep it) | Between 3 and 24 hours before, a single session can't be refunded, but you can move it once. Move it instead? | 3 से 24 घंटे पहले, एक सेशन का पैसा वापस नहीं होता, लेकिन आप एक बार समय बदल सकते हैं। क्या समय बदलें? |
| "Not right fit" on a first session: the whole purchase is refunded | Thank you for speaking with Shantha Rao. She feels this isn't the right fit just now, so we're refunding your payment of {amount}. It usually reaches your account in 5–7 working days. | शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी यह आपके लिए सही नहीं है, इसलिए आपके {amount} वापस किए जा रहे हैं। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है। |
| Unused package sessions refunded | We've refunded {amount} for the sessions you didn't use. It goes back to your original payment method. | आपके बिना इस्तेमाल हुए सेशन के {amount} वापस कर दिए गए हैं। यह राशि आपके भुगतान के तरीके में लौटेगी। |

## 6. Reminders

Sent the evening before a call or a session. The two words are the first value of the reminder template.

| Where it appears | English | हिंदी |
|---|---|---|
| Reminder for a call | Reminder: your call with Shantha Rao is tomorrow, {day} at {time} (India time). It is a voice call by phone (audio only, no video). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपकी कॉल कल, {day} को {time} बजे (भारतीय समय) है। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है। कृपया फ़ोन अपने पास रखें। |
| Reminder for a session | Reminder: your session with Shantha Rao is tomorrow, {day} at {time} (India time). It is a voice call by phone (audio only, no video). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपका सेशन कल, {day} को {time} बजे (भारतीय समय) है। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है। कृपया फ़ोन अपने पास रखें। |
| The word "call" (template value) | call | कॉल |
| The word "session" (template value) | session | सेशन |

## 7. Safety, noise and re-prompts

Sent by code, never by the AI. The crisis and emergency messages go to everyone, whatever their state. When someone types while a booking step is open, the step is sent again with the re-prompt line and, on the day and time steps, the hint.

| Where it appears | English | हिंदी |
|---|---|---|
| A message that talks of ending one's life (fixed text; Tele-MANAS 14416 or 1-800-891-4416, and 112) | We're really sorry you're going through this. You don't have to face it alone. Please talk to someone right now: Tele-MANAS is a free government helpline, open 24×7. Call *14416* or *1-800-891-4416*. If you or anyone else is in danger right now, call *112*. A person from our team has been told and will message you here as soon as they can. | हमें बहुत दुख है कि आप इस मुश्किल से गुज़र रहे हैं। आप अकेले नहीं हैं। कृपया अभी किसी से बात करें। टेली-मानस (Tele-MANAS) सरकार की मुफ़्त हेल्पलाइन है, जो हर दिन 24 घंटे खुली रहती है: *14416* या *1-800-891-4416* पर कॉल करें। अगर आप या कोई और अभी खतरे में है, तो *112* पर कॉल करें। हमने अपनी टीम को बता दिया है, वे जल्द से जल्द आपको यहीं मैसेज करेंगे। |
| A message that describes a medical emergency (fixed text) | This sounds like an emergency. Please call *112*, or *108* for an ambulance, right now, or go to the nearest hospital. | यह इमरजेंसी लग रही है। कृपया तुरंत *112* पर, या एम्बुलेंस के लिए *108* पर कॉल करें, या सबसे नज़दीकी अस्पताल जाएँ। |
| After the third strike: the last line before 7 quiet days | It seems we can't help with this. If you'd like to book a call with Shantha Rao later, just type *book*. | लगता है हम इसमें मदद नहीं कर पाएँगे। अगर आप बाद में शांता राव जी के साथ कॉल बुक करना चाहें, तो बस *बुक* लिखें। |
| After "stop" | Done. We won't send you any more messages. If you write to us again, we'll reply. | ठीक है। अब हम आपको कोई मैसेज नहीं भेजेंगे। अगर आप फिर से लिखेंगे, तो हम जवाब देंगे। |
| One line after a flirting message | This chat is only for bookings. | यह चैट सिर्फ़ बुकिंग के लिए है। |
| Menu heading when the AI cannot answer or the day's AI budget is used up | Sorry, we can't answer that right now. You can book a call below or talk to a person. | माफ़ कीजिए, अभी इसका जवाब नहीं दिया जा सका। आप नीचे से कॉल बुक कर सकते हैं या किसी व्यक्ति से बात कर सकते हैं। |
| The same, while selling is paused after a crisis message | Sorry, we can't answer that right now. You can talk to a person from our team below. | माफ़ कीजिए, अभी इसका जवाब नहीं दिया जा सका। आप नीचे से हमारी टीम के किसी व्यक्ति से बात कर सकते हैं। |
| Button under an assistant answer that leads to booking | See call times | कॉल का समय देखें |
| Sent instead of an assistant answer that failed the output check: questions, objections, booking wishes | Thanks for asking. Shantha Rao can explain this properly on a short ₹99 call, or you can ask a person from our team. | पूछने के लिए धन्यवाद। शांता राव जी ₹99 की छोटी कॉल पर इसे अच्छे से समझा सकती हैं, या आप हमारी टीम के किसी व्यक्ति से बात कर सकते हैं। |
| The same, for a personal concern | We're sorry you're going through this. If you'd like, Shantha Rao can listen on a short call. Please also keep following your doctor's advice. | हमें दुख है कि आप इससे गुज़र रहे हैं। अगर आप चाहें, तो शांता राव जी एक छोटी कॉल पर आपकी बात सुन सकती हैं। कृपया अपने डॉक्टर की सलाह भी मानते रहें। |
| The same, for a question about an existing booking (the team is told) | Our team will check this and reply to you here. | हमारी टीम इसे देखकर यहीं आपको जवाब देगी। |
| The same, for off-topic, astrology, prohibited, repeated and small-talk messages | We can only help with Disha Dira calls and bookings. | हम सिर्फ़ दिशा दिरा की कॉल और बुकिंग में मदद कर सकते हैं। |
| Re-prompt: added above the step when someone types instead of tapping ({hint} is the next row, or nothing) | {hint} Please choose from the options below. | {hint} कृपया नीचे दिए विकल्पों में से चुनें। |
| Hint on the day and time steps (from config.hours) | Calls and sessions are Monday to Saturday, 2 pm to 7 pm (India time). | कॉल और सेशन सोमवार से शनिवार, दोपहर 2 से शाम 7 बजे तक (भारतीय समय) होते हैं। |
| From the third re-prompt in a row: a second message with the Talk to a person button | If you would rather talk to a person from our team, tap below. | अगर आप हमारी टीम के किसी व्यक्ति से बात करना चाहें, तो नीचे टैप करें। |
| A short typed "call me", "can I call", "number please" (config.words.callRequest): the body of the menu message. Not in a chat with a person, while quiet, after a crisis message, or with a booking coming up | We don't take calls on this WhatsApp number. The quickest way to talk to Shantha Rao is the ₹99 15-minute call: you choose a time, and she calls you. It is a voice call by phone (audio only, no video). | इस WhatsApp नंबर पर हम कॉल नहीं लेते। शांता राव जी से बात करने का सबसे आसान तरीका ₹99 की 15 मिनट की कॉल है: आप समय चुनें, और वे आपको कॉल करेंगी। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होती है। |
| Above the step again, when the assistant could not answer a question typed in the middle of a booking | Thanks for asking. Shantha Rao can explain this on your call. When you're ready, choose an option below. | पूछने के लिए धन्यवाद। शांता राव जी कॉल पर इसे समझा सकती हैं। जब आप तैयार हों, नीचे दिए विकल्पों में से चुनें। |
| Ticket 36: above the time list again, once, when someone at the time step types "now", "call me now" or "call me" (a second miss in a row goes to the team with the Talk to a person message instead) | Shantha Rao can't call right away: she calls you at the time you book. Calls and sessions are Monday to Saturday, 2 pm to 7 pm (India time). Please choose a free time below. | शांता राव जी अभी तुरंत कॉल नहीं कर सकतीं: वे आपके बुक किए हुए समय पर आपको कॉल करती हैं। कॉल और सेशन सोमवार से शनिवार, दोपहर 2 से शाम 7 बजे तक (भारतीय समय) होते हैं। कृपया नीचे से कोई खाली समय चुनें। |
| Ticket 36: the same, when the time they typed is outside the hours ("morning 9 am"; hours from config.hours) | Sorry, that time is outside our hours. Calls and sessions are Monday to Saturday, 2 pm to 7 pm (India time). Please choose a free time below. | माफ़ कीजिए, यह समय हमारे कॉल के समय से बाहर है। कॉल और सेशन सोमवार से शनिवार, दोपहर 2 से शाम 7 बजे तक (भारतीय समय) होते हैं। कृपया नीचे से कोई खाली समय चुनें। |
| Ticket 36: the same, when the time they typed is inside the hours but nothing is free then ({day} is the list's day) | Sorry, nothing is free at that time on {day}. Please choose another free time below, or "Another day". | माफ़ कीजिए, {day} को उस समय कुछ खाली नहीं है। कृपया नीचे से कोई दूसरा खाली समय चुनें, या "दूसरा दिन"। |
| Book tapped by someone who already has a call (with the buttons below) | You already have a call on {day} at {time}. Shantha Rao will call you then. | आपकी कॉल पहले से {day} को {time} बजे बुक है। शांता राव जी उसी समय कॉल करेंगी। |
| Button under it (max 20 letters); the other button is Talk to a person | Keep it | ठीक है |

## 8. The payment page (our own link)

Every pay button and pay message opens our own link (bot.disha-dira.com/p/…), never Razorpay's link directly: WhatsApp turns a Razorpay link into its own "Pay now" card, which opens WhatsApp's UPI setup instead of Razorpay's page. While the time is held, our link goes straight on to Razorpay's secure payment page (UPI, cards, net banking). Otherwise it shows one of these small pages, in the chat's language, with one button back to WhatsApp. A link we did not make shows the "not found" page in both languages.

| Where it appears | English | हिंदी |
|---|---|---|
| The name at the top of the page | Disha Dira | दिशा दिरा |
| The button (opens the chat on WhatsApp) | Back to WhatsApp | WhatsApp पर वापस जाएँ |
| Already paid: heading | Payment received | भुगतान मिल गया |
| Already paid: text (a call or a session) | Your booking is confirmed; the details are in WhatsApp. You can close this page. | आपकी बुकिंग तय हो गई है; पूरी जानकारी WhatsApp पर है। आप यह पेज बंद कर सकते हैं। |
| Already paid: text (a package) | Your sessions are added to your package; the details are in WhatsApp. You can close this page. | आपके सेशन आपके पैकेज में जुड़ गए हैं; पूरी जानकारी WhatsApp पर है। आप यह पेज बंद कर सकते हैं। |
| The hold or the link has ended: heading | This payment link has expired | इस भुगतान लिंक का समय खत्म हो गया है |
| The hold has ended: text (a call or a session) | Your time is no longer held. Go back to WhatsApp and tap Book again. | आपका समय अब रोका हुआ नहीं है। WhatsApp पर वापस जाएँ और फिर से "बुक करें" दबाएँ। |
| The link has ended: text (a package) | Go back to WhatsApp and choose your package again. | WhatsApp पर वापस जाएँ और पैकेज फिर से चुनें। |
| A link we did not make: heading | Link not found | लिंक नहीं मिला |
| A link we did not make: text | This payment link is not right. Please go back to WhatsApp and use the latest payment message. | यह भुगतान लिंक सही नहीं है। कृपया WhatsApp पर वापस जाएँ और सबसे नए भुगतान मैसेज का लिंक खोलें। |
| The page could not be opened just now: heading | Please try again | कृपया फिर से कोशिश करें |
| The page could not be opened just now: text | We couldn't open the payment page just now. Please open the link again in a minute. | अभी भुगतान पेज नहीं खुल पाया। कृपया एक मिनट बाद लिंक फिर से खोलें। |
| While the time is held: the short page before Razorpay's (it moves on by itself): heading | Opening Razorpay's secure payment page… | Razorpay का सुरक्षित भुगतान पेज खुल रहा है… |
| The same: text (the button is Continue, to Razorpay's page) | If it doesn't open in a moment, tap Continue. | अगर यह थोड़ी देर में न खुले, तो "आगे बढ़ें" दबाएँ। |
| The same: button | Continue | आगे बढ़ें |
| Paid after the hold ended, and the time went to someone else: text (under "Payment received") | Our team will message you on WhatsApp about your time. You can close this page. | आपके समय के बारे में हमारी टीम WhatsApp पर मैसेज करेगी। आप यह पेज बंद कर सकते हैं। |
| A payment we must check (the wrong amount): heading | We're checking your payment | हम आपका भुगतान जाँच रहे हैं |
| The same: text | Our team will message you on WhatsApp today. Please don't pay again. | हमारी टीम आज ही WhatsApp पर मैसेज करेगी। कृपया दोबारा भुगतान न करें। |

## 8b. Typed questions, payments and other fixes (ticket 31)

With the assistant off, a typed question that names a common topic gets a fixed answer (src/router.ts) with the menu buttons: the Help answers (section 2) for the price, what it is, how it works, timings and refunds, and the answers below. Illness: only Help and Talk to a person under it. Anything else gets the "booking assistant" line (section 1).

| Where it appears | English | हिंदी |
|---|---|---|
| "How does the call work?" (after the How it works answer) | The first call is 15 minutes, a voice call by phone (audio only, no video), at the time you pick. Shantha Rao calls you herself, listens to what is going on, and explains how she works and whether a full session would suit you. The call is in the language you chat in, English or Hindi. | पहली कॉल 15 मिनट की होती है, फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं), आपके चुने हुए समय पर। शांता राव जी खुद आपको कॉल करती हैं, आपकी बात सुनती हैं, और बताती हैं कि वे कैसे काम करती हैं और क्या पूरा सेशन आपके लिए ठीक रहेगा। कॉल उसी भाषा में होती है जिसमें आप चैट करते हैं, अंग्रेज़ी या हिंदी। |
| "Is this real? Is it a scam?" | That's a fair question. Shantha Rao is a certified Pranic Healer trained in the MCKS system. Payment happens only on Razorpay's secure page, and we never ask for your PIN or OTP. If she feels a session isn't the right fit after your first call, your ₹99 is refunded. We make no health promises. | यह सही सवाल है। शांता राव जी MCKS पद्धति में प्रशिक्षित सर्टिफ़ाइड प्राणिक हीलर हैं। भुगतान सिर्फ़ Razorpay के सुरक्षित पेज पर होता है, और हम कभी आपका PIN या OTP नहीं माँगते। अगर पहली कॉल के बाद उन्हें लगे कि सेशन आपके लिए सही नहीं है, तो आपके ₹99 वापस कर दिए जाते हैं। हम सेहत को लेकर कोई वादा नहीं करते। |
| Abroad: time zone and paying (with Talk to a person) | Calls are Monday to Saturday, 2 pm to 7 pm (India time). Please check the time difference where you are. Calls are voice calls by phone (no video), so you can join from anywhere. Payment is on Razorpay's secure page: UPI needs an Indian bank account, and cards may work. If paying doesn't work, tap "Talk to a person". | कॉल सोमवार से शनिवार, दोपहर 2 बजे से शाम 7 बजे तक (भारतीय समय) होती हैं। कृपया अपने यहाँ के समय का अंतर देख लें। कॉल फ़ोन पर वॉइस कॉल होती है (वीडियो नहीं), इसलिए आप कहीं से भी जुड़ सकते हैं। भुगतान Razorpay के सुरक्षित पेज पर होता है: UPI के लिए भारतीय बैंक खाता चाहिए, कार्ड से भुगतान हो सकता है। अगर भुगतान न हो पाए, तो "किसी से बात करें" दबाएँ। |
| "Can I come in person?" | Calls and sessions are only voice calls by phone (audio only, no video), so you can join from anywhere and nobody needs to travel. Shantha Rao is based in Bengaluru. | कॉल और सेशन सिर्फ़ फ़ोन पर वॉइस कॉल से होते हैं (सिर्फ़ आवाज़, वीडियो नहीं), इसलिए आप कहीं से भी जुड़ सकते हैं और कहीं जाना नहीं पड़ता। शांता राव जी बेंगलुरु में रहती हैं। |
| An illness or medicine is named (buttons: Help, Talk to a person) | Pranic healing is meant to support your wellbeing alongside your doctor's care, not replace it, so we never promise to treat any illness. Please keep following your doctor's advice, and never stop or change a medicine without your doctor. | प्राणिक हीलिंग डॉक्टर के इलाज के साथ आपकी सेहत को सहारा देने के लिए है, उसकी जगह नहीं, इसलिए हम किसी बीमारी के इलाज का वादा नहीं करते। कृपया अपने डॉक्टर की सलाह मानते रहें, और डॉक्टर से पूछे बिना कोई दवा बंद न करें या न बदलें। |
| "Someone did something to me" (black magic, nazar…), never repeating those words | We don't look into, confirm or remove anything like that. If you've been feeling stressed or unsettled, Shantha Rao can listen on a call and tell you whether a calming session suits you. If you ever feel unsafe, please call 112. | हम ऐसी किसी बात की जाँच, पुष्टि या उसे हटाने का काम नहीं करते। अगर आप तनाव या बेचैनी महसूस कर रहे हैं, तो शांता राव जी एक कॉल पर आपकी बात सुनकर बता सकती हैं कि क्या एक शांत करने वाला सेशन आपके लिए ठीक रहेगा। अगर आप कभी असुरक्षित महसूस करें, तो 112 पर कॉल करें। |
| "I paid but got no confirmation" / money deducted (buttons: Talk to a person, My bookings) | Sorry about this. Please don't pay again. If money was taken and no confirmation came, tap "Talk to a person" and our team will check. When a payment fails, banks usually return the money on their own. | इसके लिए माफ़ कीजिए। कृपया दोबारा भुगतान न करें। अगर पैसे कट गए और पुष्टि का मैसेज नहीं आया, तो "किसी से बात करें" दबाएँ, हमारी टीम जाँच करेगी। भुगतान फेल होने पर बैंक आमतौर पर पैसे खुद लौटा देते हैं। |
| Influencing or harming another person (vashikaran, "get my love back"): one line, as a strike | We can't help with influencing or controlling another person. Our sessions are only about helping you feel calmer and steadier. | हम किसी दूसरे व्यक्ति को प्रभावित करने या उस पर काबू करने में मदद नहीं कर सकते। हमारे सेशन सिर्फ़ आपको शांत और स्थिर महसूस कराने के लिए हैं। |
| Job seekers, learners, partnerships: one line a day, with Talk to a person | This chat is only for booking calls with Shantha Rao. For anything else, tap "Talk to a person". | यह चैट सिर्फ़ शांता राव जी के साथ कॉल बुक करने के लिए है। किसी और बात के लिए "किसी से बात करें" दबाएँ। |
| An old time row whose time has passed or is too soon (then the times again) | Sorry, that time is too soon or has already passed. Please choose another. | माफ़ कीजिए, यह समय बहुत पास है या निकल चुका है। कृपया दूसरा समय चुनें। |
| The same time tapped again while its hold is unpaid (with the same pay button and link) | {day} at {time} is still held for you until {until} (India time). It is booked once you pay. ⏎  ⏎ Tap "Pay ₹99" below to open Razorpay's secure payment page. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपके लिए {until} बजे तक (भारतीय समय) रोका हुआ है। भुगतान के बाद ही बुकिंग पक्की होगी। ⏎  ⏎ नीचे "₹99 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| A second payment by mistake: refunded automatically | We received a second payment of {amount} by mistake, so we are refunding it. It usually reaches your account in 5–7 working days. | हमें गलती से {amount} का दूसरा भुगतान मिला, इसलिए उसे वापस किया जा रहा है। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है। |
| … and the booking that stays (added after it) | Your booking stays on {day} at {time} (India time). | आपकी बुकिंग {day} को {time} बजे (भारतीय समय) ही रहेगी। |
| Paid after the hold ended, and someone else has the time (the team then offers a new time or a refund) | We received your {amount}, but the time you picked was booked by someone else after your hold ended. Our team will message you here today with a new time or a full refund. | हमें आपके {amount} मिल गए हैं, लेकिन रोकने का समय खत्म होने के बाद आपका चुना हुआ समय किसी और ने बुक कर लिया। हमारी टीम आज ही यहीं आपको नया समय या पूरा रिफ़ंड देगी। |
| A payment with the wrong amount | We received a payment that we need to check. Our team will sort it out and reply here today. Please don't pay again. | हमें एक भुगतान मिला है जिसे हमें जाँचना है। हमारी टीम आज ही इसे ठीक करके यहीं जवाब देगी। कृपया दोबारा भुगतान न करें। |
| A held time that ended unpaid (button: Book the call, or Choose a time for a session) | Your held time has been released. Nothing was charged. Tap below to choose a time again. | आपके लिए रोका गया समय छोड़ दिया गया है। कोई पैसा नहीं कटा। फिर से समय चुनने के लिए नीचे दबाएँ। |
| A "Talk to a person" request nobody answered in 24 hours (with the menu) | Sorry we couldn't reply in time. You can book below, or ask again for a person. | माफ़ कीजिए, हम समय पर जवाब नहीं दे पाए। आप नीचे से बुक कर सकते हैं, या फिर से किसी व्यक्ति से बात करने को कह सकते हैं। |
| Automatic follow-up, 60 minutes after their last message, if they haven't booked (with the Book button; never 9 pm to 8 am) | Just checking in: did you find what you were looking for? If you'd like to talk to Shantha Rao, the ₹99 15-minute voice call (no video) is the easiest way. You choose the time, and she calls you. | हम बस यह जानना चाहते थे: क्या आपको वह मिल गया जो आप ढूँढ रहे थे? अगर आप शांता राव जी से बात करना चाहें, तो ₹99 की 15 मिनट की वॉइस कॉल (वीडियो नहीं) सबसे आसान तरीका है। समय आप चुनते हैं, और वे आपको कॉल करती हैं। |
| Automatic follow-up, 20 hours after their last message (with the Book button; at most 2 a week) | Whenever you're ready, you can book a ₹99 15-minute voice call (no video) with Shantha Rao. Calls are Monday to Saturday, 2 pm to 7 pm. | जब भी आप तैयार हों, शांता राव जी के साथ ₹99 की 15 मिनट की वॉइस कॉल (वीडियो नहीं) बुक कर सकते हैं। कॉल सोमवार से शनिवार, दोपहर 2 बजे से शाम 7 बजे तक होती हैं। |
| The only follow-up after an illness is named, at 20 hours (no button, no price) | Hope you're doing okay. If you'd like to talk to Shantha Rao, just reply to this message. We're here. | उम्मीद है आप ठीक हैं। अगर आप शांता राव जी से बात करना चाहें, तो बस इस मैसेज का जवाब दें। हम आपके लिए यहाँ हैं। |

## 8c. After the call (ticket 40)

Each goes once, to one person, never at night (9 pm to 8 am), and never to anyone who said stop, is blocked, is with the team, or sent a safety message. Outside the 24-hour window only the approved template goes (docs/TEMPLATES.md 9 to 11); until Meta approves it, nothing is sent.

| Where it appears | English | हिंदी |
|---|---|---|
| 48 hours after the session offer, if nothing is paid or booked: one reminder, above the same list (single session, 10 or 20). Owner switch: After-call reminder | A gentle reminder: after your call, Shantha Rao offered you a full session. If you'd like to go ahead, choose an option below: a single session, or a package of 10 or 20. If now isn't the right time, that's completely fine. | एक छोटी-सी याद: कॉल के बाद शांता राव जी ने आपको पूरा सेशन देने की बात कही थी। अगर आप आगे बढ़ना चाहें, तो नीचे एक विकल्प चुनें: एक सेशन, या 10 या 20 सेशन का पैकेज। अगर अभी सही समय नहीं है, तो कोई बात नहीं। |
| The morning after a paid session (from 10 am): thank-you, review and referral ask, at most once in 90 days. The review sentence is left out while no Google review link is set; the WhatsApp link opens a chat with us with "Hi, I was referred by a friend" filled in. Owner switch: Review & referral ask (off by default) | Thank you for your session with Shantha Rao. ⏎  ⏎ If the session helped, would you share a short Google review? {Google review link} ⏎  ⏎ If someone you know might benefit, you can share this WhatsApp link: {WhatsApp link} ⏎  ⏎ With warm wishes, Disha Dira | शांता राव जी के साथ सेशन के लिए धन्यवाद। ⏎  ⏎ अगर सेशन से मदद मिली हो, तो क्या आप Google पर एक छोटा-सा रिव्यू लिखेंगे? {Google review link} ⏎  ⏎ अगर आपके किसी जानने वाले को इससे फ़ायदा हो सकता है, तो आप उन्हें यह WhatsApp लिंक भेज सकते हैं: {WhatsApp link} ⏎  ⏎ शुभकामनाओं के साथ, दिशा दिरा |
| The team's "Send session link", Let them choose (with the button "Choose a time", then the session's day and time steps) | Shantha Rao would like to book a full session with you: ₹799, 60 minutes, a voice call by phone (audio only, no video). Tap below to choose a time; it is yours once it is paid. | शांता राव जी आपके साथ एक पूरा सेशन बुक करना चाहती हैं: ₹799, 60 मिनट, फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। समय चुनने के लिए नीचे टैप करें; भुगतान होते ही वह समय आपका हो जाएगा। |

## 8d. Voice calls only, out of scope, and the questions after paying (ticket 41)

Every call and session is a voice call by phone, never video (owner, 4 Nov 2026). Right after a ₹99 call is paid (after the confirmation, inside the 24-hour window), three short questions, one at a time, each with Skip; nothing is ever chased. The owner decided (4 Nov 2026) that the bot may ask what they'd like help with, from this short list. The Hindi is for review.

| Where it appears | English | हिंदी |
|---|---|---|
| "Is it a video call?", "video pe", "वीडियो कॉल" (with the menu buttons) | All calls and sessions are voice calls by phone — no video. | सभी कॉल और सेशन फ़ोन पर वॉइस कॉल होते हैं — वीडियो नहीं। |
| A sexual-function concern (never treated as flirting; buttons: Help, Talk to a person). From someone who has paid, the team also gets an item: consider a refund | Thank you for telling us. This isn't something we can help with. Please consult a qualified doctor, such as a urologist or your physician. Pranic Healing complements medical care; it doesn't replace it. | बताने के लिए धन्यवाद। इसमें हम मदद नहीं कर सकते। कृपया किसी योग्य डॉक्टर, जैसे यूरोलॉजिस्ट या अपने फ़िज़िशियन, से सलाह लें। प्राणिक हीलिंग डॉक्टर के इलाज के साथ सहारा देती है, उसकी जगह नहीं लेती। |
| Question 1: the name (buttons: Use {name} when there is a WhatsApp name, and Skip) | Three quick questions before your call, so Shantha Rao knows a little about you. You can skip any of them. ⏎  ⏎ First, what name should she use? Tap "Use {WhatsApp name}", or type your name. — with no WhatsApp name: Three quick questions before your call, so Shantha Rao knows a little about you. You can skip any of them. ⏎  ⏎ First, what is your name? Please type it, or tap Skip. | कॉल से पहले तीन छोटे सवाल, ताकि शांता राव जी आपके बारे में थोड़ा जान सकें। आप कोई भी सवाल छोड़ सकते हैं। ⏎  ⏎ पहला: वे आपको किस नाम से बुलाएँ? "यही नाम: {WhatsApp…" दबाएँ, या अपना नाम लिखें। — with no WhatsApp name: कॉल से पहले तीन छोटे सवाल, ताकि शांता राव जी आपके बारे में थोड़ा जान सकें। आप कोई भी सवाल छोड़ सकते हैं। ⏎  ⏎ पहला: आपका नाम क्या है? कृपया लिखें, या "छोड़ें" दबाएँ। |
| Button (max 20 letters; a long name is shortened) | Use {name} | यही नाम: {name} |
| Skip button on each question (max 20 letters) | Skip | छोड़ें |
| Question 2: their work (typed; button: Skip) | Thank you. What is your profession or work? A few words is enough (for example: teacher, homemaker, student, retired). | धन्यवाद। आप क्या काम करते हैं? कुछ शब्द काफ़ी हैं (जैसे: टीचर, गृहिणी, विद्यार्थी, रिटायर्ड)। |
| Question 3: what they'd like help with (a list) | And what would you like Shantha Rao's help with? Choose one below. | और आप शांता राव जी से किस बात में मदद चाहते हैं? नीचे एक चुनें। |
| The list's button (max 20 letters) | Choose one | एक चुनें |
| List row (max 24 letters) | Stress & anxiety | तनाव और चिंता |
| List row (max 24 letters) | Sleep | नींद |
| List row (max 24 letters) | Relationships & family | रिश्ते और परिवार |
| List row (max 24 letters) | Work & career | काम और करियर |
| List row (max 24 letters) | Low energy | कम ऊर्जा |
| List row (max 24 letters) | Physical discomfort | शारीरिक तकलीफ़ |
| List row (max 24 letters) | Something else | कुछ और |
| Line under "Low energy" (max 72 letters) | Or feeling heavy | या भारीपन महसूस होना |
| Line under "Something else" (max 72 letters) | Type a few words | कुछ शब्दों में लिखें |
| The list's last row (max 24 letters) | Skip | छोड़ें |
| After "Something else": their own words (button: Skip; the words stay only in the chat) | Please type a few words about it, or tap Skip. | कृपया इसके बारे में कुछ शब्द लिखें, या "छोड़ें" दबाएँ। |
| After the last answer or Skip | Thank you. Shantha Rao will see this before your call. | धन्यवाद। शांता राव जी कॉल से पहले इसे देख लेंगी। |

## 8e. Catalogue services and reading-safety replies (ticket 49)

The services the owner adds in Settings → Services (a Tarot reading, guided hypnosis …) are offered only while the `NEW_SERVICES` env flag is "true" (the test bot), and each only while it can be booked and is marked "Offered by the bot". {name} is the service's name in Settings; {question} is its own question after payment. The two reading-safety replies are sent on every bot (test and live), by code, before any AI. The two health questions are asked only for a service marked so in Settings, and the answers are never kept (one more exception to "never asks for health details", the owner's decision, CONTRACT v18).

| Where it appears | English | हिंदी |
|---|---|---|
| "Book", when at least one more service is offered: a list (button below) | What would you like to book? Every call and session is a voice call by phone (audio only, no video). Most people start with the ₹99 call, so Shantha Rao can suggest what suits them. | आप क्या बुक करना चाहेंगे? हर कॉल और सेशन फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होता है। ज़्यादातर लोग ₹99 की कॉल से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा। |
| The list's button (max 20 letters) | See options | विकल्प देखें |
| The list's first section: the ₹99 call and the single session (max 24 letters) | Start here | यहाँ से शुरू करें |
| A section of offered services (max 24 letters) | Release | रिलीज़ |
| A section of offered services (max 24 letters) | Understand | समझ |
| A section of offered services (max 24 letters) | Rewire | रीवायर |
| The line under a service's row (max 72 letters); the row's title is the service's name | 30 min · {price} · voice call — only after the first call: 30 min · {price} · voice call · after the ₹99 call | 30 मिनट · {price} · वॉइस कॉल — only after the first call: 30 मिनट · {price} · वॉइस कॉल · ₹99 की कॉल के बाद |
| An old button of a service that isn't offered any more (with the menu) | Sorry, this isn't open for booking right now. Here is what you can do. | माफ़ कीजिए, अभी इसकी बुकिंग नहीं हो रही है। आप ये कर सकते हैं। |
| A service offered only after the first call, to someone who hasn't had one (buttons: Book ₹99 call, Help) | Thank you for your interest. {name} is offered after a first call with Shantha Rao, so she can understand what you're looking for and suggest what suits you. The first call is ₹99 for 15 minutes, a voice call by phone (audio only, no video). | आपकी रुचि के लिए धन्यवाद। {name} शांता राव जी के साथ पहली कॉल के बाद ही होती है, ताकि वे समझ सकें कि आप क्या चाहते हैं और बता सकें कि आपके लिए क्या ठीक रहेगा। पहली कॉल ₹99 की है, 15 मिनट की, फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। |
| Health question 1, before a time is held (buttons Yes / No) | Before we choose a time, two quick questions. Please just tap Yes or No; we don't keep your answers. ⏎  ⏎ Are you under treatment for a mental-health condition right now? | समय चुनने से पहले दो छोटे सवाल। बस "हाँ" या "नहीं" दबाएँ; हम आपके जवाब नहीं रखते। ⏎  ⏎ क्या अभी आपका किसी मानसिक स्वास्थ्य की समस्या का इलाज चल रहा है? |
| Health question 2 (buttons Yes / No) | Have you ever had seizures or epilepsy? | क्या आपको कभी दौरे (सीज़र) या मिर्गी हुई है? |
| Any "Yes": no booking (buttons: Book ₹99 call, Help) | Thank you for telling us. For your wellbeing, Shantha Rao would like to speak with you first on the ₹99 call, before a {name}. She will listen and suggest what suits you. Please keep following your doctor's advice. | बताने के लिए धन्यवाद। आपकी भलाई के लिए, {name} से पहले शांता राव जी आपसे ₹99 की कॉल पर बात करना चाहेंगी। वे आपकी बात सुनेंगी और बताएँगी कि आपके लिए क्या ठीक रहेगा। कृपया अपने डॉक्टर की सलाह मानते रहें। |
| The service's free times on one day (list) | Free times on {day} (India time) for your {name}. It is 30 minutes, a voice call by phone (audio only, no video). | {day} के लिए खाली समय (भारतीय समय), आपकी {name} के लिए। यह 30 मिनट की फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है। |
| The line under each time (max 72 letters) | 30-min voice call | 30 मिनट की वॉइस कॉल |
| No free times for the service in the next days | There are no free times for this in the next few days. Tap "Talk to a person", or check back tomorrow. | अगले कुछ दिनों में इसका कोई खाली समय नहीं है। "किसी से बात करें" दबाएँ, या कल फिर देखें। |
| Pay button (max 20 letters) | Pay {price} | {price} भुगतान करें |
| Pay message (the button above) | {day} at {time} is held for your {name} until {until} (India time). ⏎  ⏎ Tap "Pay {price}" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपकी {name} के लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "{price} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Confirmation after payment (inside the 24-hour window only) | Your {name} with Shantha Rao is confirmed for {day} at {time} (India time). It is a voice call by phone (audio only, no video): she calls you at the booked time on the number you are messaging from. Please keep your phone with you in a quiet place. We will remind you the day before. | शांता राव जी के साथ आपकी {name} {day} को {time} बजे (भारतीय समय) तय हो गई है। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है: वे तय समय पर आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे। |
| Day-before reminder (outside the window: the `reminder` template with the service's name as {{1}}) | Reminder: your {name} with Shantha Rao is tomorrow, {day} at {time} (India time). It is a voice call by phone (audio only, no video). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपकी बुकिंग ({name}) कल, {day} को {time} बजे (भारतीय समय) है। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है। कृपया फ़ोन अपने पास रखें। |
| The service's question after payment (button: Skip) | {question} ⏎  ⏎ Please type it here in a few words, or tap Skip. Shantha Rao will read it before your booking. | {question} ⏎  ⏎ कृपया इसे यहाँ कुछ शब्दों में लिखें, या "छोड़ें" दबाएँ। शांता राव जी आपकी बुकिंग से पहले इसे पढ़ लेंगी। |
| After their answer | Thank you. Shantha Rao will see this before your booking. | धन्यवाद। शांता राव जी आपकी बुकिंग से पहले इसे देख लेंगी। |
| "Someone did something to me" (black magic, nazar, jadoo, tona …): buttons Book ₹99 call, Help | Thank you for telling us. We don't look into or confirm anything like that, and Shantha Rao doesn't remove anything or do any ritual for it. Her sessions work on how you feel and how you respond to what's happening around you. If you'd like to talk it over, the ₹99 call is a gentle first step. If you ever feel unsafe, please call 112. | बताने के लिए धन्यवाद। हम ऐसी किसी बात की जाँच या पुष्टि नहीं करते, और शांता राव जी इसके लिए कुछ हटाने या कोई विधि करने का काम नहीं करतीं। उनके सेशन इस पर काम करते हैं कि आप कैसा महसूस करते हैं और आसपास जो हो रहा है उस पर कैसे प्रतिक्रिया देते हैं। अगर आप इस बारे में बात करना चाहें, तो ₹99 की कॉल एक आसान पहला कदम है। अगर आप कभी असुरक्षित महसूस करें, तो 112 पर कॉल करें। |
| A request to predict death, illness, pregnancy, exam or court results, or an exact date: buttons Help, Talk to a person | Readings and sessions don't predict things like death, illness, pregnancy, exam or court results, or exact dates, so we can't answer that. For anything about your health, please always see a doctor. | रीडिंग और सेशन मौत, बीमारी, गर्भ, परीक्षा या कोर्ट के नतीजे, या कोई सटीक तारीख जैसी बातें नहीं बताते, इसलिए हम इसका जवाब नहीं दे सकते। सेहत से जुड़ी किसी भी बात के लिए कृपया हमेशा डॉक्टर से मिलें। |

## 8f. The Karmic Coaching front door (ticket 52)

Only while the `KARMIC_FRONT_DOOR` env flag is "true" (the test bot). After the language choice, and on Book, the bot asks what the person would like help with (a list: five topics, then Sessions & packages and Help). Every topic recommends the Karmic Clarity Call first; with `NEW_SERVICES` on too, a second message lists the services that can be booked directly for that topic. The topic is kept on the booking for the team ("Came for: …"); it is not health data. The Hindi is for review.

| Where it appears | English | हिंदी |
|---|---|---|
| "What would you like help with?" (a list; button below) | What would you like help with? Choose one below, or type it in your own words. | आप किस बारे में मदद चाहेंगे? नीचे से एक चुनें, या अपने शब्दों में लिखें। |
| The list's button (max 20 letters) | Choose | चुनें |
| The list's first section (max 24 letters) | Choose a topic | विषय चुनें |
| List row (max 24 letters) | Relationships & family | रिश्ते और परिवार |
| The line under it (max 72 letters) | Partner, parents, children or people close to you | जीवनसाथी, माता-पिता, बच्चे या आपके करीबी लोग |
| List row (max 24 letters) | Feeling heavy or drained | मन भारी या थका हुआ |
| The line under it (max 72 letters) | Low, tired or weighed down lately | कुछ समय से उदास, थका हुआ या बोझिल लगना |
| List row (max 24 letters) | A decision or direction | कोई फ़ैसला या दिशा |
| The line under it (max 72 letters) | Work, a choice, or which way to go | काम, कोई चुनाव, या किस राह जाएँ |
| List row (max 24 letters) | A habit or pattern | कोई आदत या पैटर्न |
| The line under it (max 72 letters) | Something you keep doing and would like to change | कोई आदत जो बार-बार होती है और आप बदलना चाहते हैं |
| List row (max 24 letters) | Not sure yet | अभी पता नहीं |
| The line under it (max 72 letters) | Talk it through with Shantha Rao first | पहले शांता राव जी से बात करके देखें |
| The list's second section, with the rows Sessions & packages and Help (max 24 letters) | Something else | कुछ और |
| After the tap on "Relationships & family": this line, then the next one | Thank you for sharing. Relationships and family can weigh on us a lot. | बताने के लिए धन्यवाद। रिश्ते और परिवार की बातें मन पर बहुत असर डालती हैं। |
| After the tap on "Feeling heavy or drained": this line, then the next one | Thank you for sharing. We're sorry you've been feeling this way. | बताने के लिए धन्यवाद। हमें दुख है कि आप ऐसा महसूस कर रहे हैं। |
| After the tap on "A decision or direction": this line, then the next one | Thank you for sharing. It can help to talk a decision through. | बताने के लिए धन्यवाद। किसी फ़ैसले के बारे में बात कर लेने से मदद मिलती है। |
| After the tap on "A habit or pattern": this line, then the next one | Thank you for sharing. Wanting to change a pattern is a good place to start. | बताने के लिए धन्यवाद। किसी पैटर्न को बदलने की इच्छा एक अच्छी शुरुआत है। |
| After the tap on "Not sure yet": this line, then the next one | That's completely fine. | कोई बात नहीं। |
| Below the line above, in the same message (buttons: Book ₹99 call, Help) | A good first step is the Karmic Clarity Call (₹99, 15 min): Shantha Rao calls you by phone (audio only, no video), listens to what's going on, and suggests what suits you. | पहला कदम कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) हो सकता है: शांता राव जी आपको फ़ोन पर कॉल करती हैं (सिर्फ़ आवाज़, वीडियो नहीं), आपकी बात सुनती हैं, और बताती हैं कि आपके लिए क्या ठीक रहेगा। |
| The button that books the ₹99 call itself (max 20 letters; also under the reading-safety reply and "only after the first call") | Book ₹99 call | ₹99 कॉल बुक करें |
| Only with NEW_SERVICES on: the topic's services, to book directly (a list; button below; rows as in 8e) | Or, if you already know what you'd like, you can book it directly: | या, अगर आप जानते हैं कि आपको क्या चाहिए, तो सीधे बुक कर सकते हैं: |
| That list's button (max 20 letters) | See options | विकल्प देखें |
| My bookings: a booked ₹99 call (with the flag on, see 8g) | call | कॉल |

## 8g. With the front door on: the words that change (ticket 52)

While `KARMIC_FRONT_DOOR` is "true", these messages read as below instead of as in the sections above: the brand line above the greeting (its disclosure unchanged), "Book" on the menu, and the ₹99 call named the Karmic Clarity Call wherever the bot's own words name it. Approved Meta templates never change. Instagram and Messenger name it the same way in their price, booking and short-link replies.

| Where it appears | English | हिंदी |
|---|---|---|
| Greeting (then the buttons English / हिंदी) | Disha Dira · Karmic Coaching with Shantha Rao ⏎  ⏎ Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally, on a voice call (audio only, no video). To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद वॉइस कॉल करती हैं (सिर्फ़ आवाज़, वीडियो नहीं)। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: | Disha Dira · Karmic Coaching with Shantha Rao ⏎  ⏎ Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally, on a voice call (audio only, no video). To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद वॉइस कॉल करती हैं (सिर्फ़ आवाज़, वीडियो नहीं)। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: |
| Menu button (max 20 letters): opens "What would you like help with?" | Book | बुक करें |
| Pay message for the call | Your Karmic Clarity Call (₹99, 15 min): {day} at {time} is held for you until {until} (India time). ⏎  ⏎ Tap "Pay ₹99" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | आपकी कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट): {day}, {time} का समय आपके लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "₹99 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| The same time tapped again while it is still held | Your Karmic Clarity Call (₹99, 15 min): {day} at {time} is still held for you until {until} (India time). It is booked once you pay. ⏎  ⏎ Tap "Pay ₹99" below to open Razorpay's secure payment page. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | आपकी कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट): {day}, {time} का समय आपके लिए {until} बजे तक (भारतीय समय) रोका हुआ है। भुगतान के बाद ही बुकिंग पक्की होगी। ⏎  ⏎ नीचे "₹99 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Call confirmed (inside the 24-hour window; outside it the approved call_booked template, unchanged) | Thank you, your Karmic Clarity Call (₹99, 15 min) is booked. Shantha Rao will call you on {day} at {time} (India time), on the number you are messaging from. It is a voice call by phone (audio only, no video), in English. The call may come from a number you don't know, so please keep your phone nearby. This WhatsApp number is for messages only, not calls. | धन्यवाद, आपकी कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) बुक हो गई है। शांता राव जी {day} को {time} बजे (भारतीय समय) आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होगी, हिंदी में। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं। |
| Day-before reminder (inside the window; outside it the approved reminder template, unchanged) | Reminder: your Karmic Clarity Call (₹99, 15 min) with Shantha Rao is tomorrow, {day} at {time} (India time). It is a voice call by phone (audio only, no video). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपकी कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) कल, {day} को {time} बजे (भारतीय समय) है। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) है। कृपया फ़ोन अपने पास रखें। |
| My bookings: a booked call | Karmic Clarity Call (₹99, 15 min) | कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) |
| "Call me", "number please" | We don't take calls on this WhatsApp number. The quickest way to talk to Shantha Rao is the Karmic Clarity Call (₹99, 15 min): you choose a time, and she calls you. It is a voice call by phone (audio only, no video). | इस WhatsApp नंबर पर हम कॉल नहीं लेते। शांता राव जी से बात करने का सबसे आसान तरीका कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) है: आप समय चुनें, और वे आपको कॉल करेंगी। यह फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होती है। |
| The assistant's safe fallback for a question | Thanks for asking. Shantha Rao can explain this properly on the Karmic Clarity Call (₹99, 15 min), or you can ask a person from our team. | पूछने के लिए धन्यवाद। शांता राव जी कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) पर इसे अच्छे से समझा सकती हैं, या आप हमारी टीम के किसी व्यक्ति से बात कर सकते हैं। |
| Help → Price | The Karmic Clarity Call (₹99, 15 min) is the first step. A single session is ₹799. Packages: 10 sessions for ₹5,000 (₹500 each) or 20 for ₹9,000 (₹450 each), with no expiry. | पहला कदम कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) है। एक सेशन ₹799 का है। पैकेज: 10 सेशन ₹5,000 में (₹500 प्रति सेशन) या 20 सेशन ₹9,000 में (₹450 प्रति सेशन), कोई समय-सीमा नहीं। |
| Sessions & packages (list) | Sessions are 60 minutes, a voice call by phone (audio only, no video). Choose an option. Most people start with the Karmic Clarity Call (₹99, 15 min), so Shantha Rao can suggest what suits them. | हर सेशन 60 मिनट का होता है: फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। एक विकल्प चुनें। ज़्यादातर लोग कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा। |
| Its first row (max 24 letters) | Karmic Clarity Call | कार्मिक क्लैरिटी कॉल |
| The line under it (max 72 letters) | ₹99 · 15 min · voice call with Shantha Rao (no video) | ₹99 · 15 मिनट · शांता राव जी से वॉइस कॉल (वीडियो नहीं) |
| Soft nudge before a session or package (buttons: Book ₹99 call, Continue) | Most people start with the Karmic Clarity Call (₹99, 15 min), so Shantha Rao can understand what you need first. Would you like to do that, or continue? | ज़्यादातर लोग पहले कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) करते हैं, ताकि शांता राव जी आपकी ज़रूरत समझ सकें। क्या आप ऐसा करना चाहेंगे, या आगे बढ़ें? |
| Automatic follow-up, 60 minutes | Just checking in: did you find what you were looking for? If you'd like to talk to Shantha Rao, the Karmic Clarity Call (₹99, 15 min), a voice call (no video), is the easiest way. You choose the time, and she calls you. | हम बस यह जानना चाहते थे: क्या आपको वह मिल गया जो आप ढूँढ रहे थे? अगर आप शांता राव जी से बात करना चाहें, तो कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट), एक वॉइस कॉल (वीडियो नहीं), सबसे आसान तरीका है। समय आप चुनते हैं, और वे आपको कॉल करती हैं। |
| Automatic follow-up, 20 hours | Whenever you're ready, you can book the Karmic Clarity Call (₹99, 15 min), a voice call (no video) with Shantha Rao. Calls are Monday to Saturday, 2 pm to 7 pm. | जब भी आप तैयार हों, शांता राव जी के साथ कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) बुक कर सकते हैं, एक वॉइस कॉल (वीडियो नहीं)। कॉल सोमवार से शनिवार, दोपहर 2 बजे से शाम 7 बजे तक होती हैं। |
| The Book list of ticket 49 (not shown while the front door is on) | What would you like to book? Every call and session is a voice call by phone (audio only, no video). Most people start with the Karmic Clarity Call (₹99, 15 min), so Shantha Rao can suggest what suits them. | आप क्या बुक करना चाहेंगे? हर कॉल और सेशन फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं) होता है। ज़्यादातर लोग कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा। |
| The line under a service's row | 30 min · {price} · voice call — only after the first call: 30 min · {price} · voice call · after the Clarity Call | 30 मिनट · {price} · वॉइस कॉल — only after the first call: 30 मिनट · {price} · वॉइस कॉल · क्लैरिटी कॉल के बाद |
| A service offered only after the first call | Thank you for your interest. {name} is offered after a first call with Shantha Rao, so she can understand what you're looking for and suggest what suits you. The first call is the Karmic Clarity Call (₹99, 15 min), a voice call by phone (audio only, no video). | आपकी रुचि के लिए धन्यवाद। {name} शांता राव जी के साथ पहली कॉल के बाद ही होती है, ताकि वे समझ सकें कि आप क्या चाहते हैं और बता सकें कि आपके लिए क्या ठीक रहेगा। पहली कॉल कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) है, फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)। |
| A "Yes" to a health question | Thank you for telling us. For your wellbeing, Shantha Rao would like to speak with you first on the Karmic Clarity Call (₹99, 15 min), before a {name}. She will listen and suggest what suits you. Please keep following your doctor's advice. | बताने के लिए धन्यवाद। आपकी भलाई के लिए, {name} से पहले शांता राव जी आपसे कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) पर बात करना चाहेंगी। वे आपकी बात सुनेंगी और बताएँगी कि आपके लिए क्या ठीक रहेगा। कृपया अपने डॉक्टर की सलाह मानते रहें। |
| "Someone did something to me" | Thank you for telling us. We don't look into or confirm anything like that, and Shantha Rao doesn't remove anything or do any ritual for it. Her sessions work on how you feel and how you respond to what's happening around you. If you'd like to talk it over, the Karmic Clarity Call (₹99, 15 min) is a gentle first step. If you ever feel unsafe, please call 112. | बताने के लिए धन्यवाद। हम ऐसी किसी बात की जाँच या पुष्टि नहीं करते, और शांता राव जी इसके लिए कुछ हटाने या कोई विधि करने का काम नहीं करतीं। उनके सेशन इस पर काम करते हैं कि आप कैसा महसूस करते हैं और आसपास जो हो रहा है उस पर कैसे प्रतिक्रिया देते हैं। अगर आप इस बारे में बात करना चाहें, तो कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) एक आसान पहला कदम है। अगर आप कभी असुरक्षित महसूस करें, तो 112 पर कॉल करें। |

## 9. Amma's page

English only. No chat text and no health details are ever shown here.

| Label | Text |
|---|---|
| title | Calls and sessions |
| today | Today |
| tomorrow | Tomorrow |
| nothingToday | No calls today |
| nothingTomorrow | No calls tomorrow |
| refresh | Refresh |
| howDidItGo | How did it go? |
| notYet | This call has not started yet. |
| protection | Energy cleansing |
| healing | Healing |
| kindCall | Call ₹99 |
| kindSessionSingle | Session ₹799 · single |
| btnCall | Call |
| btnSession | Session |
| btnNotFit | Not right fit |
| btnMissed | Missed |
| btnRude | Report rude |
| yes | Yes |
| back | Back |
| undo | Undo |
| undone | Undone. |
| alreadyAnswered | This call already has an answer. If it was a mistake, please tell Rohit. |
| undoTooLate | Sorry, it is too late to undo this. |
| expired | This page has expired. Please go back and try again. |
| notFound | Not found. |
| noName | Customer |
| callLang | {"en":"English","hi":"Hindi"} |
| forWhom | {"SELF":"self","FAMILY":"family","PET":"pet"} |
