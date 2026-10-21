# Message copy for review

Every message the bot sends to customers on WhatsApp, in English and Hindi, exactly as it is in the code (`src/copy.ts`). **This file is generated** from the code by `test/copydoc.ts`; a test fails when it is out of date. To change a message, change `src/copy.ts` (or ask Claude), then regenerate: `UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts`.

Words in {curly brackets} are filled in automatically (a day, a time, a number). Prices, call lengths, the hold time, the opening hours and the name of the "Energy cleansing" service come from `src/config.ts`.

Rules the copy follows: it never names an illness, never promises a result, never asks for health details. Amma's page (section 6) is English only.

Dates and times customers see are in India time: English `Wed, 21 Oct` and `2:30 pm`; Hindi `बुध, 21 अक्टूबर` and `दोपहर 2:30` (`सुबह` before noon, `शाम` from 4 pm).

## 1. First message and menu

What a customer sees first. The greeting is one message in both languages, followed by two buttons: English and हिंदी.

| Where it appears | English | हिंदी |
|---|---|---|
| Greeting (then the buttons English / हिंदी) | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally. To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद कॉल करती हैं। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: | Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally. To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html ⏎  ⏎ नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद कॉल करती हैं। आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html ⏎  ⏎ Please choose your language / कृपया भाषा चुनें: |
| Language buttons again, after "Change language" | Please choose your language / कृपया भाषा चुनें: | Please choose your language / कृपया भाषा चुनें: |
| Menu question | What would you like to do? You can also type your question. | आप क्या करना चाहेंगे? आप अपना सवाल लिखकर भी पूछ सकते हैं। |
| Menu button 1 (max 20 letters) | Book ₹99 call | ₹99 कॉल बुक करें |
| Menu button 2 (max 20 letters) | How it works | यह कैसे काम करता है |
| Menu button 3 (max 20 letters) | Talk to a person | किसी से बात करें |
| After "Talk to a person" | Thank you. A person from our team will reply here, usually within 24 hours. | धन्यवाद। हमारी टीम का कोई व्यक्ति आमतौर पर 24 घंटे के अंदर यहीं जवाब देगा। |
| Shown instead of booking while booking is closed | Booking opens soon. | बुकिंग जल्द शुरू होगी। |
| An old "Ask a question" button still in an older chat | Please type your question below. | कृपया अपना सवाल नीचे लिखें। |
| After a typed message the bot cannot answer yet (also a question in the very first message, after the language tap) | Thanks, a person will reply within 24 hours. | धन्यवाद। हमारी टीम का कोई व्यक्ति 24 घंटे के अंदर यहीं जवाब देगा। |
| A voice note, photo, video, sticker, file, location or contact from someone with no booking (first one each day) | Only typed messages can be read here. Please type your question, or tap a button below. | यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। कृपया अपना सवाल लिखें या नीचे कोई बटन दबाएँ। |
| The same, from someone with a held time, a payment in progress or a booking | Only typed messages can be read here. If this was about your payment or booking, our team will check and reply here. | यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। अगर यह आपके भुगतान या बुकिंग के बारे में था, तो हमारी टीम देखकर यहीं जवाब देगी। |

## 2. How it works list

The list behind "How it works". Its last row is "Change language", in the language of the chat.

| Where it appears | English | हिंदी |
|---|---|---|
| List heading | Choose a topic. | एक विषय चुनें। |
| List button (max 20 letters) | Choose | चुनें |
| Last row of the list (max 24 letters) | Change language | भाषा बदलें |
| Topic title "what_is_this" (max 24 letters) | What is this? | यह क्या है? |
| Answer "what_is_this" | Disha Dira offers energy cleansing and healing sessions with Shantha Rao. You can first book a short call to speak with her. | दिशा दिरा में शांता राव जी के साथ हीलिंग और एनर्जी क्लींजिंग सेशन होते हैं। शुरुआत में आप उनसे बात करने के लिए एक छोटी कॉल बुक कर सकते हैं। |
| Topic title "how_it_works" (max 24 letters) | How it works | यह कैसे होता है |
| Answer "how_it_works" | 1. Pick a call time. 2. Pay ₹99. 3. Shantha Rao calls you for 15 minutes. 4. If you both agree, you can book a full session. | 1. कॉल का समय चुनें। 2. ₹99 का भुगतान करें। 3. शांता राव जी आपको 15 मिनट के लिए कॉल करेंगी। 4. अगर आप दोनों को ठीक लगे, तो आप पूरा सेशन बुक कर सकते हैं। |
| Topic title "price" (max 24 letters) | Price | फ़ीस |
| Answer "price" | The first call is ₹99. A full session is ₹700. | पहली कॉल ₹99 की है। पूरा सेशन ₹700 का है। |
| Topic title "timings" (max 24 letters) | Call timings | कॉल का समय |
| Answer "timings" | Calls are Monday to Friday, 2 pm to 7 pm (India time). | कॉल सोमवार से शुक्रवार, दोपहर 2 बजे से शाम 7 बजे तक (भारतीय समय) होती हैं। |
| Topic title "refund" (max 24 letters) | Refunds | रिफ़ंड |
| Answer "refund" | If Shantha Rao feels the call is not the right fit, your ₹99 is refunded. If we have to cancel, you are refunded too. | अगर पहली कॉल के बाद शांता राव जी को लगे कि यह आपके लिए सही नहीं है, तो आपके ₹99 वापस कर दिए जाते हैं। अगर हमें कॉल रद्द करनी पड़े, तब भी पैसे वापस मिलते हैं। |
| Topic title "privacy" (max 24 letters) | Your privacy | आपकी प्राइवेसी |
| Answer "privacy" | We keep only your name, WhatsApp number, bookings and payments. Please do not share health details here. | हम सिर्फ़ आपका नाम, WhatsApp नंबर, बुकिंग और भुगतान की जानकारी रखते हैं। चैट के मैसेज आख़िरी मैसेज के 30 दिन बाद मिटा दिए जाते हैं। कृपया यहाँ सेहत से जुड़ी जानकारी या रिपोर्ट न भेजें। |

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
| Which day? (up to 3 day buttons, e.g. "Wed, 21 Oct" / "बुध, 21 अक्टूबर") | Which day suits you? (India time) | कौन सा दिन आपके लिए ठीक रहेगा? (भारतीय समय) |
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
| Pay message (above the pay button) | {day} at {time} is held for you for 20 minutes. Tap below to pay ₹99 and confirm. Please don't pay twice. | {day}, {time} का समय आपके लिए 20 मिनट तक रोका गया है। बुकिंग पूरी करने के लिए नीचे ₹99 का भुगतान करें। कृपया दो बार भुगतान न करें। |
| Pay button (max 20 letters) | Pay ₹99 | ₹99 भुगतान करें |
| Payment link could not be made | Sorry, we couldn't create the payment link. Nothing was charged. Please try again. | माफ़ कीजिए, भुगतान लिंक नहीं बन पाया। कोई पैसा नहीं कटा है। कृपया फिर से कोशिश करें। |
| Payment received: call confirmed (the call language is the language of the chat when booking) | Received your ₹99. Shantha Rao will call you on {day} at {time} from {number}. Call in English. That number is for her calls only, so please message us here. | हमें आपके ₹99 मिल गए हैं। शांता राव जी {day} को {time} बजे {number} से आपको कॉल करेंगी। कॉल हिंदी में होगी। वह नंबर सिर्फ़ उनकी कॉल के लिए है, इसलिए मैसेज यहीं भेजें। |

## 4. After Amma's call

What the customer gets, depending on what Amma tapped. The session uses the same day and time steps, without the age, service and who-for steps.

| Where it appears | English | हिंदी |
|---|---|---|
| Session offer: message | Thank you for speaking with Shantha Rao. She would be glad to offer you a full session (₹700). Tap below to choose a time. | शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन (₹700) देना चाहेंगी। समय चुनने के लिए नीचे टैप करें। |
| Session offer: button (max 20 letters) | Choose a time | समय चुनें |
| Session time list: message | Free times on {day} (India time). Each session is 60 minutes. | {day} के लिए खाली समय (भारतीय समय)। हर सेशन 60 मिनट का होता है। |
| Session time list: line under each time (max 72 letters) | 60-min session | 60 मिनट का सेशन |
| No session times free | There are no free session times right now. We will message you when new times are open. | अभी सेशन का कोई खाली समय नहीं है। नए समय खुलते ही हम आपको मैसेज करेंगे। |
| Session cannot be booked from this message | Sorry, we cannot book a session from this message. A person will look into it. | माफ़ कीजिए, इस मैसेज से सेशन बुक नहीं हो सकता। हमारी टीम इसे देखेगी। |
| Session pay message | {day} at {time} is held for your session for 20 minutes. Tap below to pay ₹700 and confirm. Please don't pay twice. | {day}, {time} का समय आपके सेशन के लिए 20 मिनट तक रोका गया है। बुकिंग पूरी करने के लिए नीचे ₹700 का भुगतान करें। कृपया दो बार भुगतान न करें। |
| Session pay button (max 20 letters) | Pay ₹700 | ₹700 भुगतान करें |
| Session paid and confirmed | Your session with Shantha Rao is confirmed for {day} at {time} (India time). It is a distance session: you stay where you are and she calls you at the booked time. Please keep your phone with you in a quiet place. We will remind you the day before. | शांता राव जी के साथ आपका सेशन {day} को {time} बजे (भारतीय समय) तय हो गया है। यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे। |
| "Not right fit": refund | Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ₹99. | शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके ₹99 वापस कर दिए गए हैं। |
| "Missed": choose a new time | Sorry we missed each other. Choose a new time for your call. There is nothing more to pay. | माफ़ कीजिए, हमारी बात नहीं हो पाई। अपनी कॉल के लिए नया समय चुनें। आपको कोई और भुगतान नहीं करना है। |
| New time chosen after a missed call | Your call is now booked for {day} at {time}. Shantha Rao will call you from {number}. There is nothing more to pay. | आपकी कॉल अब {day} को {time} बजे बुक है। शांता राव जी {number} से कॉल करेंगी। आपको कोई और भुगतान नहीं करना है। |
| A call that cannot be moved again | Sorry, this call cannot be moved again. A person will look into it. | माफ़ कीजिए, यह कॉल दोबारा नहीं बदली जा सकती। हमारी टीम इसे देखेगी। |
| Missed a second time | We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again. | दूसरी बार भी आपसे बात नहीं हो पाई, इसलिए हम यह बुकिंग बंद कर रहे हैं। आपकी रुचि के लिए धन्यवाद। आप कभी भी हमें फिर से लिख सकते हैं। |

## 5. Reminders

Sent the evening before a call or a session. The two words are the first value of the reminder template.

| Where it appears | English | हिंदी |
|---|---|---|
| Reminder for a call | Reminder: your call with Shantha Rao is tomorrow, {day} at {time} (India time). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपकी कॉल कल, {day} को {time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें। |
| Reminder for a session | Reminder: your session with Shantha Rao is tomorrow, {day} at {time} (India time). Please keep your phone with you. | याद दिला दें: शांता राव जी के साथ आपका सेशन कल, {day} को {time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें। |
| The word "call" (template value) | call | कॉल |
| The word "session" (template value) | session | सेशन |

## 6. Amma's page

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
| kindSession | Session ₹700 |
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
