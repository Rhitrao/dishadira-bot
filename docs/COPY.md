# Message copy for review

Every message the bot sends to customers on WhatsApp, in English and Hindi, exactly as it is in the code (`src/copy.ts`). **This file is generated** from the code by `test/copydoc.ts`; a test fails when it is out of date. To change a message, change `src/copy.ts` (or ask Claude), then regenerate: `UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts`.

Words in {curly brackets} are filled in automatically (a day, a time, a number). Prices, call lengths, the hold time, the opening hours and the name of the "Energy cleansing" service come from `src/config.ts`.

Rules the copy follows: it never names an illness, never promises a result, never asks for health details. Amma's page (section 9) is English only.

Dates and times customers see are in India time: English `Wed, 21 Oct` and `2:30 pm`; Hindi `बुध, 21 अक्टूबर` and `दोपहर 2:30` (`सुबह` before noon, `शाम` from 4 pm).

## 1. First message and menu

What a customer sees first. The greeting is one message in both languages, followed by two buttons: English and हिंदी.

| Where it appears | English | हिंदी |
|---|---|---|
| Greeting (then the buttons English / हिंदी) | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally. To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद कॉल करती हैं। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally. To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद कॉल करती हैं। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: |
| Language buttons again, after "Change language" | Please choose your language / कृपया भाषा चुनें: | Please choose your language / कृपया भाषा चुनें: |
| Menu question | What would you like to do? You can also type your question. | आप क्या करना चाहेंगे? आप अपना सवाल लिखकर भी पूछ सकते हैं। |
| Menu button 1 (max 20 letters) | Book ₹99 call | ₹99 कॉल बुक करें |
| Menu button 2 (max 20 letters) | Sessions & packages | सेशन और पैकेज |
| Menu button 3 (max 20 letters) | Help | मदद |
| "Talk to a person" (a row in the Help list; also a button in the fallback menu and while nothing may be sold) (max 20 letters) | Talk to a person | किसी से बात करें |
| After "Talk to a person" | Thank you. A person from our team will reply here, usually within 24 hours. | धन्यवाद। हमारी टीम का कोई व्यक्ति आमतौर पर 24 घंटे के अंदर यहीं जवाब देगा। |
| The first message typed while a person from the team has the chat (once per handoff) | Got it. This is with our team, and they'll reply here. | ठीक है। आपका मैसेज हमारी टीम तक पहुँच गया है, वे यहीं जवाब देंगे। |
| Shown instead of booking while booking is closed | Booking opens soon. | बुकिंग जल्द शुरू होगी। |
| An old "Ask a question" button still in an older chat | Please type your question below. | कृपया अपना सवाल नीचे लिखें। |
| After a typed message the bot cannot answer yet (also a question in the very first message, after the language tap) | Thanks, a person will reply within 24 hours. | धन्यवाद। हमारी टीम का कोई व्यक्ति 24 घंटे के अंदर यहीं जवाब देगा। |
| A voice note, photo, video, sticker, file, location or contact from someone with no booking (first one each day) | Only typed messages can be read here. Please type your question, or tap a button below. | यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। कृपया अपना सवाल लिखें या नीचे कोई बटन दबाएँ। |
| The same, from someone with a held time, a payment in progress or a booking | Only typed messages can be read here. If this was about your payment or booking, our team will check and reply here. | यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। अगर यह आपके भुगतान या बुकिंग के बारे में था, तो हमारी टीम देखकर यहीं जवाब देगी। |

## 2. Help list

The list behind "Help": the six answers, then My bookings, Talk to a person and Change language (nine rows).

| Where it appears | English | हिंदी |
|---|---|---|
| List heading | How can we help? | हम कैसे मदद कर सकते हैं? |
| List button (max 20 letters) | Choose | चुनें |
| Row: My bookings (max 24 letters) | My bookings | मेरी बुकिंग |
| Row: Change language (max 24 letters) | Change language | भाषा बदलें |
| Topic title "what_is_this" (max 24 letters) | What is this? | यह क्या है? |
| Answer "what_is_this" | Disha Dira offers no-touch pranic healing by phone with Shantha Rao, a certified Pranic Healer trained in the MCKS system. The first step is a 15-minute call with her for ₹99. | दिशा दिरा में शांता राव जी, जो MCKS पद्धति में प्रशिक्षित सर्टिफ़ाइड प्राणिक हीलर हैं, फ़ोन पर बिना छुए प्राणिक हीलिंग करती हैं। पहला कदम उनके साथ 15 मिनट की ₹99 की कॉल है। |
| Topic title "how_it_works" (max 24 letters) | How it works | यह कैसे होता है |
| Answer "how_it_works" | 1. Pick a call time. 2. Pay ₹99. 3. Shantha Rao calls you for 15 minutes. 4. If you both agree, you can book a full session or a package. | 1. कॉल का समय चुनें। 2. ₹99 का भुगतान करें। 3. शांता राव जी आपको 15 मिनट के लिए कॉल करेंगी। 4. अगर आप दोनों को ठीक लगे, तो आप पूरा सेशन या पैकेज बुक कर सकते हैं। |
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
| Time list: message | Free times on {day} (India time). Each call is 15 minutes. | {day} के लिए खाली समय (भारतीय समय)। हर कॉल 15 मिनट की होती है। |
| Time list: button (max 20 letters) | Choose a time | समय चुनें |
| Time list: section before 4 pm (max 24 letters) | Afternoon | दोपहर |
| Time list: section from 4 pm (max 24 letters) | Evening | शाम |
| Time list: line under each time (max 72 letters) | 15-min call | 15 मिनट की कॉल |
| Time list: last row, shows the days again (max 24 letters) | Another day | दूसरा दिन |
| No call times free | There are no free call times right now. Please check again later. | अभी कॉल का कोई खाली समय नहीं है। कृपया थोड़ी देर बाद फिर देखें। |
| The chosen time was just taken | Sorry, that time was just taken. Please choose another. | माफ़ कीजिए, यह समय अभी-अभी बुक हो गया। कृपया दूसरा समय चुनें। |
| Customer already has a time held | A time is already held for you. Please use the payment button above, or try again in a few minutes. | आपके लिए एक समय पहले से रोका गया है। ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें। |
| Customer already has a booked call | Your call is already booked for {day} at {time}. Shantha Rao will call you then. | आपकी कॉल पहले से {day} को {time} बजे बुक है। शांता राव जी उसी समय आपको कॉल करेंगी। |
| Pay message (above the pay button). {until} is when the hold ends (India time); {link} is our own payment link, the same one the button opens (section 8) | {day} at {time} is held for you until {until} (India time). ⏎  ⏎ Tap "Pay ₹99" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपके लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "₹99 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Pay button (max 20 letters) | Pay ₹99 | ₹99 भुगतान करें |
| Payment link could not be made | Sorry, we couldn't create the payment link. Nothing was charged. Please try again. | माफ़ कीजिए, भुगतान लिंक नहीं बन पाया। कोई पैसा नहीं कटा है। कृपया फिर से कोशिश करें। |
| About 8 minutes before a held call or session time ends, if it is still unpaid (once; only inside the 24-hour window). "HELP" or "मदद" on its own reaches a person | Your time is still held until {until} (India time). Pay here: {link} ⏎  ⏎ Having trouble paying? Reply HELP and we will help you. | आपका समय अभी {until} बजे तक (भारतीय समय) रोका गया है। यहाँ भुगतान करें: {link} ⏎  ⏎ भुगतान में दिक्कत हो रही है? HELP या मदद लिखकर भेजें, हम आपकी मदद करेंगे। |
| Payment received: call confirmed (the call language is the language of the chat when booking). No number is given: she calls the customer's own phone | Received your ₹99. Shantha Rao will call you on {day} at {time} (India time), on the number you are messaging from. Call in English. The call may come from a number you don't know, so please keep your phone nearby. This WhatsApp number is for messages only, not calls. | हमें आपके ₹99 मिल गए हैं। शांता राव जी {day} को {time} बजे (भारतीय समय) आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। कॉल हिंदी में होगी। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं। |

## 4. After Amma's call

What the customer gets, depending on what Amma tapped. After "Session" the customer chooses a single session, 10 or 20 (a list; section 5). A single session uses the same day and time steps, without the age, service and who-for steps.

| Where it appears | English | हिंदी |
|---|---|---|
| Session offer: message (above the list of options) | Thank you for speaking with Shantha Rao. She would be glad to offer you a full session. Choose an option below: a single session, or a package of 10 or 20. | शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन देना चाहेंगी। नीचे एक विकल्प चुनें: एक सेशन, या 10 या 20 सेशन का पैकेज। |
| Template button "Choose a time" (max 20 letters) | Choose a time | समय चुनें |
| Session time list: message | Free times on {day} (India time). Each session is 60 minutes. | {day} के लिए खाली समय (भारतीय समय)। हर सेशन 60 मिनट का होता है। |
| Session time list: line under each time (max 72 letters) | 60-min session | 60 मिनट का सेशन |
| No session times free | There are no free session times right now. We will message you when new times are open. | अभी सेशन का कोई खाली समय नहीं है। नए समय खुलते ही हम आपको मैसेज करेंगे। |
| Session cannot be booked from this message | Sorry, we cannot book a session from this message. A person will look into it. | माफ़ कीजिए, इस मैसेज से सेशन बुक नहीं हो सकता। हमारी टीम इसे देखेगी। |
| Session pay message ({until}, {link}: as for the call) | {day} at {time} is held for your session until {until} (India time). ⏎  ⏎ Tap "Pay ₹799" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice. ⏎  ⏎ If the button does not open, use this link: {link} | {day}, {time} का समय आपके सेशन के लिए {until} बजे तक (भारतीय समय) रोका गया है। ⏎  ⏎ नीचे "₹799 भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें। ⏎  ⏎ अगर बटन न खुले, तो यह लिंक खोलें: {link} |
| Session pay button (max 20 letters) | Pay ₹799 | ₹799 भुगतान करें |
| Session paid and confirmed | Your session with Shantha Rao is confirmed for {day} at {time} (India time). It is a distance session: you stay where you are and she calls you at the booked time. Please keep your phone with you in a quiet place. We will remind you the day before. | शांता राव जी के साथ आपका सेशन {day} को {time} बजे (भारतीय समय) तय हो गया है। यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे। |
| "Not right fit": refund | Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ₹99. | शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके ₹99 वापस कर दिए गए हैं। |
| "Missed": choose a new time | Sorry we missed each other. Choose a new time for your call. There is nothing more to pay. | माफ़ कीजिए, हमारी बात नहीं हो पाई। अपनी कॉल के लिए नया समय चुनें। आपको कोई और भुगतान नहीं करना है। |
| New time chosen after a missed call (also a call moved by the team) | Your call is now booked for {day} at {time} (India time). Shantha Rao will call you on the number you are messaging from. The call may come from a number you don't know, so please keep your phone nearby. There is nothing more to pay. This WhatsApp number is for messages only, not calls. | आपकी कॉल अब {day} को {time} बजे (भारतीय समय) बुक है। शांता राव जी आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। आपको कोई और भुगतान नहीं करना है। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं। |
| A call that cannot be moved again | Sorry, this call cannot be moved again. A person will look into it. | माफ़ कीजिए, यह कॉल दोबारा नहीं बदली जा सकती। हमारी टीम इसे देखेगी। |
| Missed a second time | We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again. | दूसरी बार भी आपसे बात नहीं हो पाई, इसलिए हम यह बुकिंग बंद कर रहे हैं। आपकी रुचि के लिए धन्यवाद। आप कभी भी हमें फिर से लिख सकते हैं। |

## 5. Sessions, packages and My bookings

Prices and the per-session rates are built from `src/config.ts` (price ÷ sessions). Buying a single session uses the same steps as the first call (age check once, service, who for, day, time, pay). A package has no time step: pay, then book each session from the credits.

| Where it appears | English | हिंदी |
|---|---|---|
| Sessions & packages: list heading | Sessions are 60 minutes by phone. Choose an option. Most people start with the ₹99 call, so Shantha Rao can suggest what suits them. | हर सेशन 60 मिनट का होता है, फ़ोन पर। एक विकल्प चुनें। ज़्यादातर लोग ₹99 की कॉल से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा। |
| Sessions & packages: list button (max 20 letters) | See options | विकल्प देखें |
| Row 1: the first call (max 24 letters) | ₹99 first call | ₹99 पहली कॉल |
| Row 1: line under it (max 72 letters) | 15 min with Shantha Rao | शांता राव जी से 15 मिनट |
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
| A session booked from a package credit | Your session is booked for {day} at {time} (India time). Shantha Rao will call you then. Sessions left: 9. | आपका सेशन {day} को {time} बजे (भारतीय समय) बुक हो गया है। शांता राव जी उसी समय कॉल करेंगी। बचे हुए सेशन: 9। |
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
| "Not right fit" on a first session: the whole purchase is refunded | Thank you for speaking with Shantha Rao. She feels this isn't the right fit just now, so we've refunded your payment of {amount}. | शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी यह आपके लिए सही नहीं है, इसलिए आपके {amount} वापस कर दिए गए हैं। |
| Unused package sessions refunded | We've refunded {amount} for the sessions you didn't use. It goes back to your original payment method. | आपके बिना इस्तेमाल हुए सेशन के {amount} वापस कर दिए गए हैं। यह राशि आपके भुगतान के तरीके में लौटेगी। |

## 6. Reminders

Sent the evening before a call or a session. The two words are the first value of the reminder template.

| Where it appears | English | हिंदी |
|---|---|---|
| Reminder for a call | Reminder: your call with Shantha Rao is tomorrow, {day} at {time} (India time). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपकी कॉल कल, {day} को {time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें। |
| Reminder for a session | Reminder: your session with Shantha Rao is tomorrow, {day} at {time} (India time). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपका सेशन कल, {day} को {time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें। |
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
| A short typed "call me", "can I call", "number please" (config.words.callRequest): the body of the menu message. Not in a chat with a person, while quiet, after a crisis message, or with a booking coming up | We don't take calls on this WhatsApp number. The quickest way to talk to Shantha Rao is the ₹99 15-minute call: you choose a time, and she calls you. | इस WhatsApp नंबर पर हम कॉल नहीं लेते। शांता राव जी से बात करने का सबसे आसान तरीका ₹99 की 15 मिनट की कॉल है: आप समय चुनें, और वे आपको कॉल करेंगी। |
| Above the step again, when the assistant could not answer a question typed in the middle of a booking | Thanks for asking. Shantha Rao can explain this on your call. When you're ready, choose an option below. | पूछने के लिए धन्यवाद। शांता राव जी कॉल पर इसे समझा सकती हैं। जब आप तैयार हों, नीचे दिए विकल्पों में से चुनें। |
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
