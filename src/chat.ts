// How a chat reads in the console (the Inbox thread and the person page): never an empty bubble. A tap shows as its label ("Tapped: Book
// ₹99 call"), a photo or file as one line (inbound media is never downloaded), a template or a message with buttons as its text plus a
// short description. Messages whose text the privacy wipe removed (src/wipe.ts) collapse into one quiet line per run:
// "12 earlier messages were deleted after 7 days, for privacy".
import { html } from "hono/html";
import { consoleCopy, type ConsoleCopy } from "./console-copy";
import type { Env } from "./env";
import { retentionMinutes } from "./wipe";

export const THREAD_LATEST = 20; // the thread shows this many of the latest messages, with "Show earlier messages" for the rest
export const THREAD_ALL = 200;

export type ChatRow = { dir: string; kind: string; body: string | null; wipedAt: string | null };
// The SQL condition for the rows a thread shows: everything except an outgoing message that never had text (a reply skipped because a
// newer message came in). Wiped rows stay, so they can be counted.
export const SHOWN_SQL = "NOT (direction = 'OUT' AND body IS NULL AND wiped_at IS NULL)";

export const isWiped = (l: ChatRow) => l.wipedAt !== null || (l.dir === "OUT" && l.body === null);

const MEDIA: Record<string, keyof ConsoleCopy> = {
  image: "sentPhoto", video: "sentVideo", audio: "sentAudio", voice: "sentAudio", document: "sentFile", sticker: "sentSticker", location: "sentLocation", contacts: "sentContact",
};
const NOTE: Record<string, keyof ConsoleCopy> = { buttons: "withButtons", list: "withList", cta: "withLink" };

// What a message that still has its text says, in the member's words. `tap`: the customer tapped a button (drawn quieter).
export function describe(l: ChatRow, locale: string | null | undefined): { text: string; note?: string; tap?: boolean } {
  const cc = consoleCopy(locale);
  if (l.dir === "IN") {
    if (l.kind === "interactive" || l.kind === "button") return { text: l.body ? cc.tapped(l.body) : cc.tappedButton, tap: true };
    if (l.kind === "text" && l.body) return { text: l.body };
    if (MEDIA[l.kind]) return { text: cc[MEDIA[l.kind]] as string, tap: true };
    return { text: l.body || cc.sentOther, tap: !l.body };
  }
  const body = l.body ?? "";
  if (l.kind === "template" || body.startsWith("template:")) {
    const name = body.replace(/^template:/, "");
    const what = (cc as Record<string, unknown>)[`tpl_${name}`];
    return { text: cc.templateSent(typeof what === "string" ? what : cc.tplOther), tap: true };
  }
  const note = NOTE[l.kind];
  return { text: body || cc.sentOther, note: note ? (cc[note] as string) : undefined };
}

// Runs of wiped messages become one item; `earlier` when live messages follow it.
export type ThreadItem<T> = { wiped: number; earlier: boolean } | { line: T };
export function collapseWiped<T extends ChatRow>(lines: T[]): ThreadItem<T>[] {
  const out: ThreadItem<T>[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (!isWiped(l)) out.push({ line: l });
    else if (last && "wiped" in last) last.wiped++;
    else out.push({ wiped: 1, earlier: false });
  }
  out.forEach((x, i) => {
    if ("wiped" in x) x.earlier = out.slice(i + 1).some((y) => "line" in y);
  });
  return out;
}

// "7 days" / "10 minutes": how long chat text is kept, from CHAT_RETENTION_MINUTES.
export function keptFor(env: Env, locale: string | null | undefined): string {
  const cc = consoleCopy(locale);
  const min = retentionMinutes(env);
  return min >= 1440 && min % 1440 === 0 ? cc.keptDays(min / 1440) : cc.keptMinutes(min);
}

export const wipedLine = (n: number, earlier: boolean, kept: string, locale: string | null | undefined) =>
  html`<p class="wiped" role="note">${consoleCopy(locale).chatWiped(n, kept, earlier)}</p>`;

export const earlierLink = (href: string, locale: string | null | undefined) => html`<p class="earlier"><a href="${href}">${consoleCopy(locale).showEarlier}</a></p>`;
