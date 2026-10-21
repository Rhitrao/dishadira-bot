// Builds docs/COPY.md from src/copy.ts, so the review document can never drift from what the bot sends.
// test/copy.test.ts fails when the file is out of date; regenerate it with:  UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts
import { allCopy, type Copy, type Lang } from "../src/copy";

type Entry = [path: string, where: string];

const sample: Record<string, (c: Copy, lang: Lang) => string> = {
  timesFor: (c) => c.timesFor("{day}"),
  sessionTimesFor: (c) => c.sessionTimesFor("{day}"),
  callAlreadyBooked: (c) => c.callAlreadyBooked("{day}", "{time}"),
  payBody: (c) => c.payBody("{day}", "{time}"),
  confirmed: (c, lang) => c.confirmed("{day}", "{time}", lang, "{number}"),
  sessionPayBody: (c) => c.sessionPayBody("{day}", "{time}"),
  sessionConfirmed: (c) => c.sessionConfirmed("{day}", "{time}"),
  rescheduled: (c) => c.rescheduled("{day}", "{time}", "{number}"),
  reminderCall: (c) => c.reminderCall("{day}", "{time}"),
  reminderSession: (c) => c.reminderSession("{day}", "{time}"),
  alreadyBookedStart: (c) => c.alreadyBookedStart("{day}", "{time}"),
  reprompt: (c) => c.reprompt("{hint}"),
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
      ["btnHow", "Menu button 2 (max 20 letters)"],
      ["btnPerson", "Menu button 3 (max 20 letters)"],
      ["handoffAck", "After \"Talk to a person\""],
      ["bookSoon", "Shown instead of booking while booking is closed"],
      ["askPrompt", "An old \"Ask a question\" button still in an older chat"],
      ["ack", "After a typed message the bot cannot answer yet (also a question in the very first message, after the language tap)"],
      ["mediaNotice", "A voice note, photo, video, sticker, file, location or contact from someone with no booking (first one each day)"],
      ["mediaNoticeCustomer", "The same, from someone with a held time, a payment in progress or a booking"],
    ],
  },
  {
    title: "2. How it works list",
    intro: "The list behind \"How it works\". Its last row is \"Change language\", in the language of the chat.",
    entries: [
      ["faqBody", "List heading"],
      ["faqButton", "List button (max 20 letters)"],
      ["changeLanguageRow", "Last row of the list (max 24 letters)"],
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
      ["chooseDay", "Which day? (up to 3 day buttons, e.g. \"Wed, 21 Oct\" / \"बुध, 21 अक्टूबर\")"],
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
      ["payBody", "Pay message (above the pay button)"],
      ["payLabel", "Pay button (max 20 letters)"],
      ["payFailed", "Payment link could not be made"],
      ["confirmed", "Payment received: call confirmed (the call language is the language of the chat when booking)"],
    ],
  },
  {
    title: "4. After Amma's call",
    intro: "What the customer gets, depending on what Amma tapped. The session uses the same day and time steps, without the age, service and who-for steps.",
    entries: [
      ["sessionOfferBody", "Session offer: message"],
      ["btnChooseTime", "Session offer: button (max 20 letters)"],
      ["sessionTimesFor", "Session time list: message"],
      ["rowSession", "Session time list: line under each time (max 72 letters)"],
      ["noSessionSlots", "No session times free"],
      ["sessionNotAvailable", "Session cannot be booked from this message"],
      ["sessionPayBody", "Session pay message"],
      ["sessionPayLabel", "Session pay button (max 20 letters)"],
      ["sessionConfirmed", "Session paid and confirmed"],
      ["notFitRefund", "\"Not right fit\": refund"],
      ["missedOffer", "\"Missed\": choose a new time"],
      ["rescheduled", "New time chosen after a missed call"],
      ["rescheduleNotAvailable", "A call that cannot be moved again"],
      ["missedFinal", "Missed a second time"],
    ],
  },
  {
    title: "5. Reminders",
    intro: "Sent the evening before a call or a session. The two words are the first value of the reminder template.",
    entries: [
      ["reminderCall", "Reminder for a call"],
      ["reminderSession", "Reminder for a session"],
      ["wordCall", "The word \"call\" (template value)"],
      ["wordSession", "The word \"session\" (template value)"],
    ],
  },
  {
    title: "6. Safety, noise and re-prompts",
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
      ["reprompt", "Re-prompt: added above the step when someone types instead of tapping ({hint} is the next row, or nothing)"],
      ["hintDays", "Hint on the day and time steps (from config.hours)"],
      ["repromptHelp", "From the third re-prompt in a row: a second message with the Talk to a person button"],
      ["alreadyBookedStart", "Book tapped by someone who already has a call (with the buttons below)"],
      ["btnKeep", "Button under it (max 20 letters); the other button is Talk to a person"],
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
    "Rules the copy follows: it never names an illness, never promises a result, never asks for health details. Amma's page (section 7) is English only.",
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
  out.push("", "## 7. Amma's page", "", "English only. No chat text and no health details are ever shown here.", "", "| Label | Text |", "|---|---|");
  const amma = allCopy.en.amma as unknown as Record<string, unknown>;
  for (const key of Object.keys(amma)) {
    const v = amma[key];
    if (typeof v === "function") continue;
    out.push(`| ${key} | ${cell(typeof v === "object" ? JSON.stringify(v) : String(v))} |`);
  }
  out.push("");
  return out.join("\n");
}
