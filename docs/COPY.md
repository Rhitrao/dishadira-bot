# Message copy for review

Every message the bot sends to customers on WhatsApp, and every label on Amma's page, exactly as it is in the code (`src/copy.ts`). English is final unless you ask for a change. **Please write the Kannada in the empty column.** Words in {curly brackets} are filled in automatically (a day, a time, a number): keep them as they are in the Kannada.

Rules the copy follows: it never names an illness, never promises a result, never asks for health details. Button names have a size limit (shown in the first column), so please keep the Kannada short.

## 1. First message and menu

What a customer sees first.

| Where it appears | English | Kannada |
|---|---|---|
| Greeting (then two language buttons: English / ಕನ್ನಡ) | Namaste! I'm Disha Dira's booking assistant. Shantha Rao calls you personally. This chat is only for booking a call. Please choose your language. | |
| Menu question | What would you like to do? | |
| Menu button 1 (max 20 letters) | Book a ₹99 call | |
| Menu button 2 (max 20 letters) | How it works | |
| Menu button 3 (max 20 letters) | Ask a question | |
| Shown instead of booking while booking is closed | Booking opens soon. | |
| Ask a question: prompt | Please type your question below. | |
| Ask a question: after the customer writes | Thanks, a person will reply within 24 hours. | |
| Help list: heading | Choose a topic. | |
| Help list: button (max 20 letters) | Choose | |
| Help list: topic title (max 24 letters), "what_is_this" | What is this? | |
| Help list: answer, "what_is_this" | Disha Dira offers protection and healing sessions with Shantha Rao. You can first book a short call to speak with her. | |
| Help list: topic title (max 24 letters), "how_it_works" | How it works | |
| Help list: answer, "how_it_works" | 1. Pick a call time. 2. Pay ₹99. 3. Shantha Rao calls you for 15 minutes. 4. If you both agree, you can book a full session. | |
| Help list: topic title (max 24 letters), "price" | Price | |
| Help list: answer, "price" | The first call is ₹99. A full session is ₹700. | |
| Help list: topic title (max 24 letters), "timings" | Call timings | |
| Help list: answer, "timings" | Calls are on weekdays, 14:00 to 19:00 (India time). | |
| Help list: topic title (max 24 letters), "refund" | Refunds | |
| Help list: answer, "refund" | If Shantha Rao feels the call is not the right fit, your ₹99 is refunded. If we have to cancel, you are refunded too. | |
| Help list: topic title (max 24 letters), "privacy" | Your privacy | |
| Help list: answer, "privacy" | We keep only your name, WhatsApp number, bookings and payments. Please do not share health details here. | |

## 2. Booking the first call

Choosing a service, a time, and paying.

| Where it appears | English | Kannada |
|---|---|---|
| Which service? (question) | Which would you like? | |
| Service button (max 20 letters) | Protection | |
| Service button (max 20 letters) | Healing | |
| Time list: message | Choose a time for your 15-minute call with Shantha Rao (India time). | |
| Time list: button (max 20 letters) | Choose a time | |
| No call times free | There are no free call times right now. Please check again later. | |
| The chosen time was just taken | Sorry, that time was just taken. Please choose another. | |
| Customer already has a time held | You already have a time held for you. Please use the payment button above, or wait a few minutes and try again. | |
| Customer already has a booked call | Your call is already booked for {day} {time}. Shantha Rao will call you then. | |
| Pay message (above the pay button) | Your time is held for 20 minutes. Tap below to pay ₹99. Please don't pay twice. | |
| Pay button (max 20 letters) | Pay ₹99 | |
| Payment link could not be made | Sorry, we could not create the payment link. Nothing was charged. Please try again. | |
| Payment received: call confirmed | Received your ₹99. Shantha Rao will call you on {day} at {time} from {number}. That number is for her calls only, so please message us here. | |

## 3. After Amma's call

What the customer gets, depending on what Amma tapped.

| Where it appears | English | Kannada |
|---|---|---|
| Amma tapped Session: offer message | Thank you for speaking with Shantha Rao. She would be glad to offer you a full session (₹700). Tap below to choose a time. | |
| Session offer button (max 20 letters) | Choose a time | |
| Session time list: message | Choose a time for your 60-minute session with Shantha Rao (India time). | |
| No session times free | There are no free session times right now. We will message you when new times are open. | |
| Session cannot be booked from that message | Sorry, we cannot book a session from this message. A person will look into it. | |
| Session pay message (above the pay button) | Your time is held for 20 minutes. Tap below to pay ₹700 for your session. Please don't pay twice. | |
| Session pay button (max 20 letters) | Pay ₹700 | |
| Session payment received: session confirmed | Your session with Shantha Rao is confirmed for {day} at {time} (India time). It is a distance session: you stay where you are and she calls you at the booked time. Please keep your phone with you in a quiet place. We will remind you the day before. | |
| Amma tapped Not right fit: refund message | Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ₹99. | |
| Amma tapped Missed: choose a new time | Sorry we missed each other. Choose a new time for your call. There is nothing more to pay. | |
| Call moved to a new time | Your call is now booked for {day} at {time}. Shantha Rao will call you from {number}. There is nothing more to pay. | |
| Call cannot be moved again | Sorry, this call cannot be moved again. A person will look into it. | |
| Second missed call: booking closed | We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again. | |

## 4. Day-before reminder

Sent at 6:30 pm the evening before a call or session. {kind} is the word "call" or "session".

| Where it appears | English | Kannada |
|---|---|---|
| Reminder | Reminder: your {kind} with Shantha Rao is tomorrow, {day} at {time} (India time). Please keep your phone with you. | |

## 5. Amma's page

Labels and messages on the page Amma opens. No chat text or health words ever appear here.

| Where it appears | English | Kannada |
|---|---|---|
| Page title | Calls and sessions | |
| Heading: today | Today | |
| Heading: tomorrow | Tomorrow | |
| Nothing today | No calls today | |
| Nothing tomorrow | No calls tomorrow | |
| Refresh button | Refresh | |
| Service name | Protection | |
| Service name | Healing | |
| Tag for a first call | Call ₹99 | |
| Tag for a full session | Session ₹700 | |
| Button: phone the customer | Call | |
| Question shown after the call time | How did it go? | |
| Outcome button: session | Session | |
| Outcome button: not right fit | Not right fit | |
| Outcome button: missed | Missed | |
| Outcome button: report rude (small, red) | Report rude | |
| Before the call has started | This call has not started yet. | |
| Confirm question ({label} is the button name) | Confirm: {label} for {name}, {time}? | |
| Yes button | Yes | |
| Back button | Back | |
| Saved, with undo time ({minutes} minutes) | Saved. Undo ({minutes} min) | |
| Undo button | Undo | |
| After undo | Undone. | |
| Saved: {label} | Saved: {label} | |
| Done: {label} (after it has been applied) | Done: {label} | |
| Call already has an answer | This call already has an answer. If it was a mistake, please tell Rohit. | |
| Too late to undo | Sorry, it is too late to undo this. | |
| Page expired | This page has expired. Please go back and try again. | |
| Not found | Not found. | |
| When a customer has no name | Customer | |
