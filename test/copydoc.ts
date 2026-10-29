// Builds docs/COPY.md from src/copy.ts, so the review document can never drift from what the bot sends.
// test/copy.test.ts fails when the file is out of date; regenerate it with:  UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts
import { allCopy, type Copy, type Lang } from "../src/copy";

type Entry = [path: string, where: string];

const sample: Record<string, (c: Copy, lang: Lang) => string> = {
  timesFor: (c) => c.timesFor("{day}"),
  sessionTimesFor: (c) => c.sessionTimesFor("{day}"),
  callAlreadyBooked: (c) => c.callAlreadyBooked("{day}", "{time}"),
  payBody: (c) => c.payBody("{day}", "{time}", "{until}", "{link}"),
  confirmed: (c, lang) => c.confirmed("{day}", "{time}", lang),
  sessionPayBody: (c) => c.sessionPayBody("{day}", "{time}", "{until}", "{link}"),
  sessionConfirmed: (c) => c.sessionConfirmed("{day}", "{time}"),
  rescheduled: (c) => c.rescheduled("{day}", "{time}"),
  reminderCall: (c) => c.reminderCall("{day}", "{time}"),
  reminderSession: (c) => c.reminderSession("{day}", "{time}"),
  alreadyBookedStart: (c) => c.alreadyBookedStart("{day}", "{time}"),
  reprompt: (c) => c.reprompt("{hint}"),
  packPayBody: (c) => c.packPayBody(10, "{price}", "{until}", "{link}"),
  payNudge: (c) => c.payNudge("{until}", "{link}"),
  packPayLabel: (c) => c.packPayLabel("{price}"),
  packConfirmed: (c) => c.packConfirmed(10),
  creditBooked: (c) => c.creditBooked("{day}", "{time}", 9),
  creditsLeft: (c) => c.creditsLeft(9),
  myBookingsBody: (c) => c.myBookingsBody("{list}", 9),
  myBookingsNoPack: (c) => c.myBookingsNoPack("{list}"),
  bookingItem: (c) => c.bookingItem("{call or session}", "{day}", "{time}"),
  sessionActions: (c) => c.sessionActions("{day}", "{time}"),
  moved: (c) => c.moved("{day}", "{time}"),
  cancelledCredit: (c) => c.cancelledCredit(9),
  notFitRefundSession: (c) => c.notFitRefundSession("{amount}"),
  packRefunded: (c) => c.packRefunded("{amount}"),
};

const sections: { title: string; intro?: string; entries: Entry[] }[] = [
  {
    title: "1. First message and menu",
    intro: "What a customer sees first. The greeting is one message in both languages, followed by two buttons: English and हिंदी.",
    entries: [
      ["greeting", "Greeting (then the buttons English / हिंदी)"],
      ["chooseLanguage", "Language buttons again, after \"Change language\""],
      ["menuBody", "Menu question"],
      ["btnBook", "Menu button 1 (max 20 letters)"],
      ["btnPackages", "Menu button 2 (max 20 letters)"],
      ["btnHelp", "Menu button 3 (max 20 letters)"],
      ["btnPerson", "\"Talk to a person\" (a row in the Help list; also a button in the fallback menu and while nothing may be sold) (max 20 letters)"],
      ["handoffAck", "After \"Talk to a person\""],
      ["humanWaitAck", "The first message typed while a person from the team has the chat (once per handoff)"],
      ["bookSoon", "Shown instead of booking while booking is closed"],
      ["askPrompt", "An old \"Ask a question\" button still in an older chat"],
      ["ack", "After a typed message the bot cannot answer yet (also a question in the very first message, after the language tap)"],
      ["mediaNotice", "A voice note, photo, video, sticker, file, location or contact from someone with no booking (first one each day)"],
      ["mediaNoticeCustomer", "The same, from someone with a held time, a payment in progress or a booking"],
    ],
  },
  {
    title: "2. Help list",
    intro: "The list behind \"Help\": the six answers, then My bookings, Talk to a person and Change language (nine rows).",
    entries: [
      ["helpListBody", "List heading"],
      ["faqButton", "List button (max 20 letters)"],
      ["rowMyBookings", "Row: My bookings (max 24 letters)"],
      ["changeLanguageRow", "Row: Change language (max 24 letters)"],
      ...(["what_is_this", "how_it_works", "price", "timings", "refund", "privacy"] as const).flatMap((id): Entry[] => [
        [`faqTitles.${id}`, `Topic title "${id}" (max 24 letters)`],
        [`faqAnswers.${id}`, `Answer "${id}"`],
      ]),
    ],
  },
  {
    title: "3. Booking the first call",
    intro: "The steps before the payment: age check (once per person), service, who it is for, day, time, then pay. Words in {curly brackets} are filled in automatically.",
    entries: [
      ["ageCheck", "Age question (once per person)"],
      ["btnYes", "Age button (max 20 letters)"],
      ["btnNo", "Age button (max 20 letters)"],
      ["ageNo", "After \"No\""],
      ["chooseService", "Which service?"],
      ["btnHealing", "Service button (max 20 letters)"],
      ["btnCleansing", "Service button (max 20 letters); the name comes from config.serviceNames"],
      ["whoFor", "Who is it for?"],
      ["btnMe", "Button (max 20 letters)"],
      ["btnFamily", "Button (max 20 letters)"],
      ["btnPet", "Button (max 20 letters)"],
      ["chooseDay", "Which day? One list with up to 6 days that still have a free time (row titles e.g. \"Wed, 21 Oct\" / \"बुध, 21 अक्टूबर\"); holidays are left out"],
      ["listButtonDays", "Day list: button (max 20 letters)"],
      ["rowDayBoth", "Day list: line under a day with afternoon and evening times (max 72 letters)"],
      ["rowDayAfternoon", "Day list: line under a day with afternoon times only (max 72 letters)"],
      ["rowDayEvening", "Day list: line under a day with evening times only (max 72 letters)"],
      ["timesFor", "Time list: message"],
      ["listButtonTimes", "Time list: button (max 20 letters)"],
      ["sectionAfternoon", "Time list: section before 4 pm (max 24 letters)"],
      ["sectionEvening", "Time list: section from 4 pm (max 24 letters)"],
      ["rowCall", "Time list: line under each time (max 72 letters)"],
      ["anotherDay", "Time list: last row, shows the days again (max 24 letters)"],
      ["noSlots", "No call times free"],
      ["slotTaken", "The chosen time was just taken"],
      ["alreadyHolding", "Customer already has a time held"],
      ["callAlreadyBooked", "Customer already has a booked call"],
      ["payBody", "Pay message (above the pay button). {until} is when the hold ends (India time); {link} is our own payment link, the same one the button opens (section 8)"],
      ["payLabel", "Pay button (max 20 letters)"],
      ["payFailed", "Payment link could not be made"],
      ["payNudge", "About 8 minutes before a held call or session time ends, if it is still unpaid (once; only inside the 24-hour window). \"HELP\" or \"मदद\" on its own reaches a person"],
      ["confirmed", "Payment received: call confirmed (the call language is the language of the chat when booking). No number is given: she calls the customer's own phone"],
    ],
  },
  {
    title: "4. After Amma's call",
    intro: "What the customer gets, depending on what Amma tapped. After \"Session\" the customer chooses a single session, 10 or 20 (a list; section 5). A single session uses the same day and time steps, without the age, service and who-for steps.",
    entries: [
      ["sessionOfferBody", "Session offer: message (above the list of options)"],
      ["btnChooseTime", "Template button \"Choose a time\" (max 20 letters)"],
      ["sessionTimesFor", "Session time list: message"],
      ["rowSession", "Session time list: line under each time (max 72 letters)"],
      ["noSessionSlots", "No session times free"],
      ["sessionNotAvailable", "Session cannot be booked from this message"],
      ["sessionPayBody", "Session pay message ({until}, {link}: as for the call)"],
      ["sessionPayLabel", "Session pay button (max 20 letters)"],
      ["sessionConfirmed", "Session paid and confirmed"],
      ["notFitRefund", "\"Not right fit\": refund"],
      ["missedOffer", "\"Missed\": choose a new time"],
      ["rescheduled", "New time chosen after a missed call (also a call moved by the team)"],
      ["rescheduleNotAvailable", "A call that cannot be moved again"],
      ["missedFinal", "Missed a second time"],
    ],
  },
  {
    title: "5. Sessions, packages and My bookings",
    intro:
      "Prices and the per-session rates are built from `src/config.ts` (price ÷ sessions). Buying a single session uses the same steps as the first call (age check once, service, who for, day, time, pay). A package has no time step: pay, then book each session from the credits.",
    entries: [
      ["packagesBody", "Sessions & packages: list heading"],
      ["packagesButton", "Sessions & packages: list button (max 20 letters)"],
      ["rowIntroTitle", "Row 1: the first call (max 24 letters)"],
      ["rowIntroDesc", "Row 1: line under it (max 72 letters)"],
      ["rowSingleTitle", "Row 2: single session (max 24 letters)"],
      ["rowSingleDesc", "Row 2: line under it (max 72 letters)"],
      ["rowPack10Title", "Row 3: the 10-pack (max 24 letters)"],
      ["rowPack10Desc", "Row 3: line under it (max 72 letters)"],
      ["rowPack20Title", "Row 4: the 20-pack (max 24 letters)"],
      ["rowPack20Desc", "Row 4: line under it (max 72 letters)"],
      ["softGate", "Soft gate: shown when someone who never had the first call picks a session or package (buttons: Book call / Continue)"],
      ["btnContinue", "Soft gate: Continue (max 20 letters)"],
      ["packPayBody", "Package: pay message (above the pay button); the link is open for an hour"],
      ["packPayLabel", "Package: pay button (max 20 letters)"],
      ["packPending", "Package: a payment link is already open"],
      ["packConfirmed", "Package paid: the credits are added (button below: Book a session)"],
      ["btnBookSession", "Button under it (max 20 letters)"],
      ["creditBooked", "A session booked from a package credit"],
      ["maxUpcoming", "Two sessions are already booked"],
      ["noCredits", "No sessions left in the package"],
      ["creditsLeft", "Sessions left (added when there is nothing booked)"],
      ["myBookingsBody", "My bookings: the list and the sessions left, for someone with a package"],
      ["myBookingsNoPack", "My bookings: the list, for someone without a package"],
      ["myBookingsNone", "My bookings: nothing booked"],
      ["bookingItem", "My bookings: one entry (the word is call or session)"],
      ["sessionActions", "My bookings: one session, with the buttons Move and Cancel (when there is more than one booking)"],
      ["btnMove", "Button (max 20 letters)"],
      ["btnCancel", "Button (max 20 letters)"],
      ["bookingNotFound", "A booking that no longer exists or has changed"],
      ["moveTooLate", "Less than 3 hours before: it can no longer be moved or cancelled"],
      ["moveOnlyOnce", "A single session that was already moved once (button: Talk to a person)"],
      ["moved", "A session moved to a new time"],
      ["cancelledCredit", "A package session cancelled in time: the credit is back"],
      ["cancelledSingleRefund", "A single session cancelled 24 hours or more before: refund"],
      ["cancelledSingleNoRefund", "A single session cancelled 3 to 24 hours before: no refund, move instead (buttons: Move / Keep it)"],
      ["notFitRefundSession", "\"Not right fit\" on a first session: the whole purchase is refunded"],
      ["packRefunded", "Unused package sessions refunded"],
    ],
  },
  {
    title: "6. Reminders",
    intro: "Sent the evening before a call or a session. The two words are the first value of the reminder template.",
    entries: [
      ["reminderCall", "Reminder for a call"],
      ["reminderSession", "Reminder for a session"],
      ["wordCall", "The word \"call\" (template value)"],
      ["wordSession", "The word \"session\" (template value)"],
    ],
  },
  {
    title: "7. Safety, noise and re-prompts",
    intro:
      "Sent by code, never by the AI. The crisis and emergency messages go to everyone, whatever their state. When someone types while a booking step is open, the step is sent again with the re-prompt line and, on the day and time steps, the hint.",
    entries: [
      ["crisis", "A message that talks of ending one's life (fixed text; Tele-MANAS 14416 or 1-800-891-4416, and 112)"],
      ["emergency", "A message that describes a medical emergency (fixed text)"],
      ["quietClose", "After the third strike: the last line before 7 quiet days"],
      ["optOutConfirm", "After \"stop\""],
      ["flirtLine", "One line after a flirting message"],
      ["aiFallback", "Menu heading when the AI cannot answer or the day's AI budget is used up"],
      ["aiFallbackNoSell", "The same, while selling is paused after a crisis message"],
      ["btnSeeTimes", "Button under an assistant answer that leads to booking"],
      ["fallbackQuestion", "Sent instead of an assistant answer that failed the output check: questions, objections, booking wishes"],
      ["fallbackConcern", "The same, for a personal concern"],
      ["fallbackBooking", "The same, for a question about an existing booking (the team is told)"],
      ["fallbackOffTopic", "The same, for off-topic, astrology, prohibited, repeated and small-talk messages"],
      ["reprompt", "Re-prompt: added above the step when someone types instead of tapping ({hint} is the next row, or nothing)"],
      ["hintDays", "Hint on the day and time steps (from config.hours)"],
      ["repromptHelp", "From the third re-prompt in a row: a second message with the Talk to a person button"],
      ["callRequest", "A short typed \"call me\", \"can I call\", \"number please\" (config.words.callRequest): the body of the menu message. Not in a chat with a person, while quiet, after a crisis message, or with a booking coming up"],
      ["repromptQuestion", "Above the step again, when the assistant could not answer a question typed in the middle of a booking"],
      ["alreadyBookedStart", "Book tapped by someone who already has a call (with the buttons below)"],
      ["btnKeep", "Button under it (max 20 letters); the other button is Talk to a person"],
    ],
  },
  {
    title: "8. The payment page (our own link)",
    intro:
      "Every pay button and pay message opens our own link (bot.disha-dira.com/p/…), never Razorpay's link directly: WhatsApp turns a Razorpay link into its own \"Pay now\" card, which opens WhatsApp's UPI setup instead of Razorpay's page. While the time is held, our link goes straight on to Razorpay's secure payment page (UPI, cards, net banking). Otherwise it shows one of these small pages, in the chat's language, with one button back to WhatsApp. A link we did not make shows the \"not found\" page in both languages.",
    entries: [
      ["pageBrand", "The name at the top of the page"],
      ["pageBtnWhatsApp", "The button (opens the chat on WhatsApp)"],
      ["pagePaidTitle", "Already paid: heading"],
      ["pagePaidBody", "Already paid: text (a call or a session)"],
      ["pagePaidPackBody", "Already paid: text (a package)"],
      ["pageExpiredTitle", "The hold or the link has ended: heading"],
      ["pageExpiredBody", "The hold has ended: text (a call or a session)"],
      ["pageExpiredPackBody", "The link has ended: text (a package)"],
      ["pageNotFoundTitle", "A link we did not make: heading"],
      ["pageNotFoundBody", "A link we did not make: text"],
      ["pageErrorTitle", "The page could not be opened just now: heading"],
      ["pageErrorBody", "The page could not be opened just now: text"],
    ],
  },
];

const get = (c: Copy, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], c);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ⏎ ");

export function copyKeys(): string[] {
  return sections.flatMap((s) => s.entries.map(([path]) => path));
}

export function renderCopyDoc(): string {
  const out: string[] = [
    "# Message copy for review",
    "",
    "Every message the bot sends to customers on WhatsApp, in English and Hindi, exactly as it is in the code (`src/copy.ts`). **This file is generated** from the code by `test/copydoc.ts`; a test fails when it is out of date. To change a message, change `src/copy.ts` (or ask Claude), then regenerate: `UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts`.",
    "",
    "Words in {curly brackets} are filled in automatically (a day, a time, a number). Prices, call lengths, the hold time, the opening hours and the name of the \"Energy cleansing\" service come from `src/config.ts`.",
    "",
    "Rules the copy follows: it never names an illness, never promises a result, never asks for health details. Amma's page (section 9) is English only.",
    "",
    "Dates and times customers see are in India time: English `Wed, 21 Oct` and `2:30 pm`; Hindi `बुध, 21 अक्टूबर` and `दोपहर 2:30` (`सुबह` before noon, `शाम` from 4 pm).",
  ];
  for (const sec of sections) {
    out.push("", `## ${sec.title}`, "");
    if (sec.intro) out.push(sec.intro, "");
    out.push("| Where it appears | English | हिंदी |", "|---|---|---|");
    for (const [path, where] of sec.entries) {
      const text = (lang: Lang) => {
        const v = get(allCopy[lang], path);
        const key = path.split(".").pop()!;
        if (typeof v === "function") return sample[key](allCopy[lang], lang);
        return String(v);
      };
      out.push(`| ${cell(where)} | ${cell(text("en"))} | ${cell(text("hi"))} |`);
    }
  }
  out.push("", "## 9. Amma's page", "", "English only. No chat text and no health details are ever shown here.", "", "| Label | Text |", "|---|---|");
  const amma = allCopy.en.amma as unknown as Record<string, unknown>;
  for (const key of Object.keys(amma)) {
    const v = amma[key];
    if (typeof v === "function") continue;
    out.push(`| ${key} | ${cell(typeof v === "object" ? JSON.stringify(v) : String(v))} |`);
  }
  out.push("");
  return out.join("\n");
}
