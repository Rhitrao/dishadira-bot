// Notes for each customer (ticket 47): before, during and after a ₹99 call or a session, and one pinned "About this person" note.
// The practice's own record: the owner, and the practitioner for her own customers (can(notes), the People rule); staff never, since notes
// can hold health details. Written on the person page, on the Today card ("Add note") and from the Calendar (its Open goes to the person
// page with that booking chosen). The phase is chosen from the time (before the start: Before; until the end: During; after: After) and can
// be changed. The author or the owner may edit or delete a note; the About note is edited in place by anyone who may write notes.
// Kept when the chat text is wiped; deleted by People → Remove their data (src/wipe.ts). Never in the export, the AI, emails, the digest,
// notifications or logs. The audit log has ids only (NOTE_ADD / NOTE_EDIT / NOTE_DELETE), never the text.
// Every POST: the console's Origin check (src/console.ts), the member's own form token, and can() again.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, memberCsrf, type Member } from "./auth";
import { prices } from "./business";
import { config } from "./config";
import type { ConsoleCtx, ConsoleVars } from "./console"; // types only: console.ts mounts this router
import { rupees } from "./copy";
import type { Env } from "./env";
import { notesCopy, type NotesCopy } from "./notes-copy";
import { peopleCopy } from "./people-copy";
import { iso } from "./slots";
import { clock, confirmStep, dayName, firstName } from "./ui";

export const notes = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

export type Phase = "BEFORE" | "DURING" | "AFTER" | "ABOUT";
const TIMED: Phase[] = ["BEFORE", "DURING", "AFTER"];
const isTimed = (v: unknown): v is "BEFORE" | "DURING" | "AFTER" => typeof v === "string" && (TIMED as string[]).includes(v);
export type BookingKind = "CALL" | "SESSION";

// Before the booking's start: Before; from the start until its end: During; from the end: After.
export const phaseAt = (nowMs: number, startUtc: string, endUtc: string): "BEFORE" | "DURING" | "AFTER" =>
  nowMs < Date.parse(startUtc) ? "BEFORE" : nowMs < Date.parse(endUtc) ? "DURING" : "AFTER";

// ---------- who ----------
const OWN = `(EXISTS (SELECT 1 FROM intros i WHERE i.conversation_id = ?1 AND i.practitioner_id = ?2 AND i.state NOT IN ('HELD','EXPIRED'))
  OR EXISTS (SELECT 1 FROM sessions se WHERE se.conversation_id = ?1 AND se.practitioner_id = ?2 AND se.state NOT IN ('OFFERED','HELD','EXPIRED')))`;
// The target can() needs for a person: their practitioner is this member when she has (or had) a booking with them (as People decides).
export async function personTarget(db: Env["DB"], m: Member, convId: number): Promise<{ practitionerId: number | null } | null> {
  const row = await db.prepare(`SELECT id, ${OWN} AS own FROM conversations WHERE id = ?1`).bind(convId, m.id).first<{ id: number; own: number }>();
  return row ? { practitionerId: row.own ? m.id : null } : null;
}
export const maySeeNotes = (m: Member, practitionerId: number | null) => can(m, "notes", { practitionerId }) === "yes";
const isOwner = (m: Member) => can(m, "business_settings") === "yes";
const mayChange = (m: Member, n: { authorId: number | null }) => isOwner(m) || (n.authorId !== null && n.authorId === m.id);

// ---------- the data ----------
export type Booking = { kind: BookingKind; id: number; startUtc: string; endUtc: string; state: string; practitionerId: number | null; origin: string | null; paise: number | null; payState: string | null };
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
// A person's calls and sessions that were booked (not a hold, not an offer), newest first. ?2: a practitioner's id to see only hers, or -1.
export async function bookingsOf(db: Env["DB"], convId: number, practitionerId = -1): Promise<Booking[]> {
  const { results } = await db
    .prepare(
      `SELECT 'CALL' AS kind, i.id, s.start_utc AS startUtc, s.end_utc AS endUtc, i.state, i.practitioner_id AS practitionerId, NULL AS origin,
         (SELECT COALESCE(p.paid_paise, p.amount_paise) FROM payments p WHERE p.purpose = 'INTRO' AND p.target_id = i.id AND p.state IN ${PAID_LIKE} ORDER BY p.id LIMIT 1) AS paise,
         (SELECT p.state FROM payments p WHERE p.purpose = 'INTRO' AND p.target_id = i.id AND p.state IN ${PAID_LIKE} ORDER BY p.id LIMIT 1) AS payState
       FROM intros i JOIN slots s ON s.id = i.slot_id WHERE i.conversation_id = ?1 AND i.state NOT IN ('HELD','EXPIRED') AND (?2 < 0 OR i.practitioner_id = ?2)
       UNION ALL
       SELECT 'SESSION', se.id, s.start_utc, s.end_utc, se.state, se.practitioner_id, se.origin,
         (SELECT COALESCE(p.paid_paise, p.amount_paise) FROM payments p WHERE p.purpose = 'SESSION' AND p.target_id = se.id AND p.state IN ${PAID_LIKE} ORDER BY p.id LIMIT 1),
         (SELECT p.state FROM payments p WHERE p.purpose = 'SESSION' AND p.target_id = se.id AND p.state IN ${PAID_LIKE} ORDER BY p.id LIMIT 1)
       FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.conversation_id = ?1 AND se.state NOT IN ('OFFERED','HELD','EXPIRED') AND (?2 < 0 OR se.practitioner_id = ?2)
       ORDER BY startUtc DESC`,
    )
    .bind(convId, practitionerId)
    .all<Booking>();
  return results;
}
const scopeFor = (m: Member) => (m.role === "PRACTITIONER" ? m.id : -1);
export const bookingKey = (b: { kind: BookingKind; id: number }) => `${b.kind}-${b.id}`;
// "₹99 call", "₹799 session", "Session from a package": what the booking was, at the amount paid (the price in force if none).
export function bookingWhat(n: NotesCopy, b: Pick<Booking, "kind" | "origin" | "paise">): string {
  if (b.kind === "CALL") return n.callWord(rupees(b.paise ?? prices().intro));
  if (b.origin === "CREDIT") return n.packageSession;
  return n.sessionWord(rupees(b.paise ?? prices().single));
}
const bookingLabel = (n: NotesCopy, b: Booking, locale: string) => `${bookingWhat(n, b)} · ${dayName(b.startUtc, locale)}, ${clock(b.startUtc, locale)}`;

export type Note = { id: number; bookingKind: BookingKind | null; bookingId: number | null; phase: Phase; body: string; authorId: number | null; author: string | null; createdAt: string; editedAt: string | null };
const NOTE_SQL = `SELECT n.id, n.booking_kind AS bookingKind, n.booking_id AS bookingId, n.phase, n.body, n.author_id AS authorId,
  COALESCE(NULLIF(m.display_name, ''), substr(m.email, 1, instr(m.email, '@') - 1)) AS author, n.created_at AS createdAt, n.edited_at AS editedAt
  FROM notes n LEFT JOIN members m ON m.id = n.author_id`;
export async function notesOf(db: Env["DB"], convId: number): Promise<Note[]> {
  return (await db.prepare(`${NOTE_SQL} WHERE n.conversation_id = ?1 ORDER BY n.created_at, n.id`).bind(convId).all<Note>()).results;
}
export const noteCount = async (db: Env["DB"], convId: number) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM notes WHERE conversation_id = ?1").bind(convId).first<{ n: number }>())?.n ?? 0;
// The newest After note's first line (the gist's facts).
export async function lastAfterLine(db: Env["DB"], convId: number): Promise<string | null> {
  const r = await db.prepare("SELECT body FROM notes WHERE conversation_id = ?1 AND phase = 'AFTER' ORDER BY created_at DESC, id DESC LIMIT 1").bind(convId).first<{ body: string }>();
  const line = r?.body.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
  return line && line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

// ---------- small words ----------
function ago(locale: string, utc: string, nowMs: number): string {
  const p = peopleCopy(locale);
  const m = Math.max(0, Math.round((nowMs - Date.parse(utc)) / 60_000));
  if (m < 1) return p.justNow;
  if (m < 60) return p.minAgo(m);
  const h = Math.round(m / 60);
  return h < 48 ? p.hoursAgo(h) : p.daysAgo(Math.round(h / 24));
}
const phaseName = (n: NotesCopy, ph: Phase) => n[`phase${ph}`];
const token = (c: ConsoleCtx, scope: string) => memberCsrf(c.get("jwt"), c.get("member"), scope);
const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
const FLASH: Record<string, keyof NotesCopy> = { saved: "saved", changed: "changed", deleted: "deleted", empty: "empty" };
function flashLine(c: ConsoleCtx, n: NotesCopy, where?: string) {
  const code = c.req.query("n");
  if (!code || (where !== undefined && c.req.query("nb") !== where)) return "";
  const text = code === "long" ? n.tooLong(config.notes.maxChars) : FLASH[code] ? (n[FLASH[code]] as string) : "";
  return text ? html`<p class="nflash" role="status">${text}</p>` : "";
}

export const NOTES_CSS = raw(`<style>
.nts .lbl{display:block;font-weight:500;margin:0 0 8px}
.nts textarea{display:block;width:100%;min-height:112px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:12px;resize:vertical}
.nts select{display:block;width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px}
.nts fieldset{border:0;margin:16px 0 0;padding:0;min-width:0}.nts legend{font-weight:500;padding:0;margin:0 0 8px}
.nts .opts{display:flex;flex-wrap:wrap;gap:8px}
.nts .opts label{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer}
.nts .opts label:has(input:checked){border-color:var(--accent);background:var(--accent-tint)}
.nts .opts input{width:20px;height:20px;margin:0;accent-color:var(--accent);flex:none}
.nts .help{color:var(--muted);font-size:16px;margin:8px 0 0}
.nts .field+.field{margin-top:16px}
.nts .acts{margin-top:16px}
.nts h3{font-size:20px;font-weight:600;margin:0}
.nts .ph{font-size:16px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--bronze);margin:16px 0 0}
[lang=hi] .nts .ph{letter-spacing:0}
.nts .note{padding:12px 0 0;margin:8px 0 0;border-top:1px solid var(--line)}
.nts .ph+.note{border-top:0;margin-top:0;padding-top:4px}
.nb{white-space:pre-line;overflow-wrap:anywhere;margin:0}
.nm{color:var(--muted);font-size:16px;margin:4px 0 0}
.nflash{font-weight:600;color:var(--done);margin:0 0 12px}
details.nx>summary{list-style:none;cursor:pointer}details.nx>summary::-webkit-details-marker{display:none}
details.nx[open]>summary{margin-bottom:8px}
.nx-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:flex-start}
.nx-row>details{flex:0 0 auto}.nx-row>details[open]{flex:1 1 100%}
.nx-row details.confirm>summary{min-height:48px;padding:10px 12px;border-color:transparent;background:transparent}
details.nx[open]>summary.btn.primary{background:transparent;border-color:transparent;color:var(--accent);box-shadow:none;padding-left:0;font-weight:600}
.tnotes{border-top:1px solid var(--line);margin:4px 0 12px;padding-top:4px}
.tnotes .ph{margin-top:12px}
</style>`);

// The form's fields: the text, which booking it is about, and when (Before / During / After), chosen from the time and changeable.
async function formFields(n: NotesCopy, o: { idp: string; bookings: Booking[]; chosen: Booking | null; nowMs: number; locale: string; text?: string; showBooking: boolean }) {
  const phase = o.chosen ? phaseAt(o.nowMs, o.chosen.startUtc, o.chosen.endUtc) : "BEFORE";
  const select = o.showBooking
    ? html`<div class="field"><label class="lbl" for="${o.idp}-b">${n.bookingLabel}</label><select id="${o.idp}-b" name="booking"><option value="">${n.noBooking}</option>${o.bookings.map(
        (b) => html`<option value="${bookingKey(b)}"${o.chosen && bookingKey(o.chosen) === bookingKey(b) ? raw(" selected") : ""}>${bookingLabel(n, b, o.locale)}</option>`,
      )}</select></div>`
    : o.chosen
      ? hidden("booking", bookingKey(o.chosen))
      : "";
  return html`<div class="field"><label class="lbl" for="${o.idp}-t">${n.noteLabel}</label><textarea id="${o.idp}-t" name="text" rows="4" maxlength="${config.notes.maxChars}" required placeholder="${n.notePlaceholder}">${o.text ?? ""}</textarea></div>
${select}<fieldset><legend>${n.phaseLabel}</legend><div class="opts">${TIMED.map(
    (p) => html`<label><input type="radio" name="phase" value="${p}"${p === phase ? raw(" checked") : ""}> ${phaseName(n, p)}</label>`,
  )}</div></fieldset><p class="help">${n.limit(config.notes.maxChars)}</p>`;
}

function noteHtml(c: ConsoleCtx, n: NotesCopy, note: Note, nowMs: number, back: string, csrf: { edit: string; del: string } | null) {
  const loc = c.get("member").locale;
  const meta = [n.by(note.author ? firstName(note.author) : n.someone, ago(loc, note.createdAt, nowMs)), note.editedAt ? n.edited(ago(loc, note.editedAt, nowMs)) : ""].filter(Boolean).join(" · ");
  const acts = csrf
    ? html`<div class="nx-row"><details class="nx"><summary class="btn quiet">${n.edit}</summary><form method="post" action="/app/notes/edit/${note.id}">${hidden("csrf", csrf.edit)}${hidden("back", back)}
<label class="lbl" for="ne-${note.id}">${n.editLabel}</label><textarea id="ne-${note.id}" name="text" rows="4" maxlength="${config.notes.maxChars}" required>${note.body}</textarea>
<div class="acts"><button class="btn primary" type="submit">${n.saveEdit}</button></div></form></details>${confirmStep({
        label: n.delete, effect: n.deleteEffect, confirm: n.deleteYes, post: { action: `/app/notes/delete/${note.id}`, csrf: csrf.del, fields: { back } },
      })}</div>`
    : "";
  return html`<div class="note" id="note-${note.id}"><p class="nb">${note.body}</p><p class="nm">${meta}</p>${acts}</div>`;
}

// ---------- the person page's Notes card ----------
// `pick`: the booking chosen in the link ("CALL-12", from the Calendar's Open), which opens the form with it chosen.
export async function notesCard(c: ConsoleCtx, convId: number, practitionerId: number | null) {
  const m = c.get("member");
  if (!maySeeNotes(m, practitionerId)) return "";
  const loc = m.locale;
  const n = notesCopy(loc);
  const nowMs = Date.now();
  const db = c.env.DB;
  const back = `/app/people/${convId}#notes`;
  const [all, bookings] = await Promise.all([notesOf(db, convId), bookingsOf(db, convId, scopeFor(m))]);
  const about = all.find((x) => x.phase === "ABOUT") ?? null;
  const timed = all.filter((x) => x.phase !== "ABOUT");

  const csrfFor = async (note: Note) => (mayChange(m, note) ? { edit: await token(c, `notes-edit:${note.id}`), del: await token(c, `notes-delete:${note.id}`) } : null);

  // About this person: one note, edited in place.
  const aboutCsrf = await token(c, `notes-about:${convId}`);
  const aboutForm = html`<details class="nx"><summary class="btn${about ? " quiet" : ""}">${about ? n.aboutEdit : n.aboutAdd}</summary><form method="post" action="/app/notes/${convId}/about">${hidden("csrf", aboutCsrf)}${hidden("back", back)}
<label class="lbl" for="na-${convId}">${n.aboutLabel}</label><textarea id="na-${convId}" name="text" rows="4" maxlength="${config.notes.maxChars}">${about?.body ?? ""}</textarea>
<div class="acts"><button class="btn primary" type="submit">${n.saveAbout}</button></div></form></details>`;
  const aboutMeta = about ? n.by(about.author ? firstName(about.author) : n.someone, ago(loc, about.editedAt ?? about.createdAt, nowMs)) : "";
  const aboutHtml = html`<div class="card nts" id="notes-about"><h3>${n.phaseABOUT}</h3>${
    about ? html`<p class="nb" style="margin-top:8px">${about.body}</p><p class="nm">${aboutMeta}</p>` : html`<p class="muted">${n.aboutEmpty}</p>`
  }<div class="nx-row">${aboutForm}</div></div>`;

  // The form: the booking from the link, else the one happening now, else the next, else the last one.
  const pick = c.req.query("b");
  const upcoming = [...bookings].reverse().find((b) => Date.parse(b.endUtc) > nowMs) ?? null;
  const chosen = bookings.find((b) => bookingKey(b) === pick) ?? upcoming ?? bookings[0] ?? null;
  const addHtml = html`<div class="card nts" id="notes-add"><details class="nx"${pick && chosen ? raw(" open") : ""}><summary class="btn primary">${n.addNoteLong}</summary>
<form method="post" action="/app/notes/${convId}/add">${hidden("csrf", await token(c, `notes-add:${convId}`))}${hidden("back", back)}${await formFields(n, { idp: `nn-${convId}`, bookings, chosen, nowMs, locale: loc, showBooking: true })}
<div class="acts"><button class="btn primary" type="submit">${n.save}</button></div></form></details></div>`;

  // The notes, by booking (newest booking first), then by phase; notes about no booking last.
  const groups: unknown[] = [];
  const phases = async (list: Note[]) =>
    Promise.all(
      TIMED.filter((p) => list.some((x) => x.phase === p)).map(
        async (p) => html`<p class="ph">${phaseName(n, p)}</p>${await Promise.all(list.filter((x) => x.phase === p).map(async (x) => noteHtml(c, n, x, nowMs, back, await csrfFor(x))))}`,
      ),
    );
  for (const b of bookings) {
    const list = timed.filter((x) => x.bookingKind === b.kind && x.bookingId === b.id);
    if (list.length) groups.push(html`<div class="card nts" id="notes-${bookingKey(b)}"><h3>${bookingLabel(n, b, loc)}</h3>${await phases(list)}</div>`);
  }
  const shown = new Set(bookings.map(bookingKey));
  const loose = timed.filter((x) => !x.bookingKind || !shown.has(`${x.bookingKind}-${x.bookingId}`));
  if (loose.length) groups.push(html`<div class="card nts"><h3>${n.general}</h3>${await phases(loose)}</div>`);

  const body = html`${NOTES_CSS}${flashLine(c, n)}${aboutHtml}${addHtml}${groups.length ? groups : html`<div class="empty"><p>${n.noNotes}</p></div>`}`;
  return html`<div id="notes"><section><h2 class="sec"><span>${n.secNotes}</span>${all.length ? html`<span class="n">${all.length}</span>` : ""}</h2>${body}</section></div>`;
}

// ---------- Today ----------
type TodayBooking = { kind: BookingKind; id: number; convId: number; practitionerId: number | null; startUtc: string; endUtc: string };
const todayBack = (b: TodayBooking) => `/app#b-${b.kind === "CALL" ? "intro" : "session"}-${b.id}`;

// "Add note" on a Today card: the booking chosen, the phase from the time.
export async function todayAddNote(c: ConsoleCtx, b: TodayBooking) {
  const m = c.get("member");
  if (!maySeeNotes(m, b.practitionerId)) return "";
  const n = notesCopy(m.locale);
  const key = bookingKey(b);
  const chosen = { ...b, state: "", origin: null, paise: null, payState: null };
  const flash = flashLine(c, n, key);
  return html`${NOTES_CSS}${flash}<div class="nts nx-row"><details class="nx"><summary class="btn quiet">${n.addNote}</summary><form method="post" action="/app/notes/${b.convId}/add">${hidden("csrf", await token(c, `notes-add:${b.convId}`))}${hidden("back", todayBack(b))}
${await formFields(n, { idp: `nt-${key}`, bookings: [], chosen, nowMs: Date.now(), locale: m.locale, showBooking: false })}<div class="acts"><button class="btn primary" type="submit">${n.save}</button></div></form></details></div>`;
}

// The next booking on Today: its Before notes and the After notes of the person's booking before it (and the About note), so the
// practitioner is prepared before she calls.
export async function todayNotes(c: ConsoleCtx, b: TodayBooking) {
  const m = c.get("member");
  if (!maySeeNotes(m, b.practitionerId)) return "";
  const n = notesCopy(m.locale);
  const db = c.env.DB;
  const [all, bookings] = await Promise.all([notesOf(db, b.convId), bookingsOf(db, b.convId)]);
  const about = all.find((x) => x.phase === "ABOUT");
  const before = all.filter((x) => x.phase === "BEFORE" && x.bookingKind === b.kind && x.bookingId === b.id);
  const prev = bookings.find((x) => x.startUtc < b.startUtc && !(x.kind === b.kind && x.id === b.id)) ?? null;
  const after = prev ? all.filter((x) => x.phase === "AFTER" && x.bookingKind === prev.kind && x.bookingId === prev.id) : [];
  if (!about && !before.length && !after.length) return "";
  const nowMs = Date.now();
  const one = (x: Note) => noteHtml(c, n, x, nowMs, todayBack(b), null);
  return html`${NOTES_CSS}<div class="nts tnotes">${about ? html`<p class="ph">${n.phaseABOUT}</p>${one(about)}` : ""}${before.length ? html`<p class="ph">${n.beforeThis}</p>${before.map(one)}` : ""}${
    prev && after.length ? html`<p class="ph">${n.afterLast(`${bookingWhat(n, prev)}, ${dayName(prev.startUtc, m.locale)}`)}</p>${after.map(one)}` : ""
  }</div>`;
}

// The Inbox thread: a compact link to the person page's notes, for whoever may read them.
export async function notesLink(c: ConsoleCtx, convId: number) {
  const m = c.get("member");
  const t = await personTarget(c.env.DB, m, convId);
  if (!t || !maySeeNotes(m, t.practitionerId)) return "";
  const k = await noteCount(c.env.DB, convId);
  const n = notesCopy(m.locale);
  return html`<p class="nlink"><a class="tap" href="/app/people/${convId}#notes">${k ? n.notesLink(k) : n.notesLinkNone}</a></p>`;
}

// ---------- the POSTs ----------
type Form = Record<string, string | undefined>;
// Newlines as the textarea counts them (a browser sends \r\n), trimmed; the limit is in characters.
const cleanText = (v: unknown) => String(v ?? "").replace(/\r\n?/g, "\n").trim();
const tooLong = (t: string) => t.length > config.notes.maxChars;
// Back to the page the form was on (inside /app only), with the outcome for the notes' own status line.
// Only a path inside the console, never another site (as src/console.ts backTo, which can't be imported here: console.ts imports this file).
export function insideApp(raw: string): string {
  return /^\/app(?:[/?#]|$)/.test(raw) && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/app";
}
function backWith(raw: string | undefined, fallback: string, code: string, where?: string): string {
  const [path, hash] = insideApp(raw ?? fallback).split("#");
  const u = new URL(path, "https://console.invalid");
  u.searchParams.delete("nb");
  u.searchParams.set("n", code);
  if (where) u.searchParams.set("nb", where);
  return `${u.pathname}${u.search}${hash ? `#${hash}` : ""}`;
}
const audit = (c: ConsoleCtx, action: string, convId: number, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(c.get("email"), action, `conv:${convId}`, detail, c.get("member").workspaceId, c.get("member").id)
    .run();
const refuse = (c: ConsoleCtx) => c.text("Forbidden", 403);

async function personFor(c: ConsoleCtx, convId: number) {
  if (!Number.isInteger(convId) || convId <= 0) return null;
  const m = c.get("member");
  const t = await personTarget(c.env.DB, m, convId);
  return t && maySeeNotes(m, t.practitionerId) ? t : null;
}

notes.post("/:conv{[0-9]+}/add", async (c) => {
  const m = c.get("member");
  const convId = Number(c.req.param("conv"));
  if (!(await personFor(c, convId))) return refuse(c);
  const f = (await c.req.parseBody()) as Form;
  if (f.csrf !== (await token(c, `notes-add:${convId}`))) return refuse(c);
  const fallback = `/app/people/${convId}#notes`;
  const where = f.booking || undefined;
  const text = cleanText(f.text);
  if (!text) return c.redirect(backWith(f.back, fallback, "empty", where), 303);
  if (tooLong(text)) return c.redirect(backWith(f.back, fallback, "long", where), 303);
  if (!isTimed(f.phase)) return c.text("Bad request", 400);
  let booking: Booking | null = null;
  if (f.booking) {
    booking = (await bookingsOf(c.env.DB, convId, scopeFor(m))).find((b) => bookingKey(b) === f.booking) ?? null;
    if (!booking) return c.text("Bad request", 400);
  }
  const res = await c.env.DB.prepare("INSERT INTO notes (conversation_id, booking_kind, booking_id, phase, body, author_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(convId, booking?.kind ?? null, booking?.id ?? null, f.phase, text, m.id, iso(Date.now()))
    .run();
  await audit(c, "NOTE_ADD", convId, `note ${res.meta.last_row_id}${booking ? `, ${booking.kind.toLowerCase()} ${booking.id}` : ""}, ${f.phase.toLowerCase()}`);
  return c.redirect(backWith(f.back, fallback, "saved", where), 303);
});

// The About note: written, changed or (emptied) deleted in place.
notes.post("/:conv{[0-9]+}/about", async (c) => {
  const m = c.get("member");
  const convId = Number(c.req.param("conv"));
  if (!(await personFor(c, convId))) return refuse(c);
  const f = (await c.req.parseBody()) as Form;
  if (f.csrf !== (await token(c, `notes-about:${convId}`))) return refuse(c);
  const fallback = `/app/people/${convId}#notes`;
  const text = cleanText(f.text);
  if (tooLong(text)) return c.redirect(backWith(f.back, fallback, "long"), 303);
  const db = c.env.DB;
  const old = await db.prepare("SELECT id FROM notes WHERE conversation_id = ?1 AND phase = 'ABOUT'").bind(convId).first<{ id: number }>();
  const now = iso(Date.now());
  if (!text) {
    if (!old) return c.redirect(backWith(f.back, fallback, "empty"), 303);
    await db.prepare("DELETE FROM notes WHERE id = ?1").bind(old.id).run();
    await audit(c, "NOTE_DELETE", convId, `note ${old.id}, about`);
    return c.redirect(backWith(f.back, fallback, "deleted"), 303);
  }
  if (old) {
    await db.prepare("UPDATE notes SET body = ?2, author_id = ?3, edited_at = ?4 WHERE id = ?1").bind(old.id, text, m.id, now).run();
    await audit(c, "NOTE_EDIT", convId, `note ${old.id}, about`);
    return c.redirect(backWith(f.back, fallback, "changed"), 303);
  }
  const res = await db
    .prepare("INSERT INTO notes (conversation_id, phase, body, author_id, created_at) VALUES (?1, 'ABOUT', ?2, ?3, ?4) ON CONFLICT DO NOTHING")
    .bind(convId, text, m.id, now)
    .run();
  if (res.meta.changes) await audit(c, "NOTE_ADD", convId, `note ${res.meta.last_row_id}, about`);
  return c.redirect(backWith(f.back, fallback, "saved"), 303);
});

// Edit or delete one note: the author or the owner, who may still see this person's notes.
async function noteFor(c: ConsoleCtx, id: number) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await c.env.DB.prepare("SELECT id, conversation_id AS convId, author_id AS authorId, phase, booking_kind AS bookingKind, booking_id AS bookingId FROM notes WHERE id = ?1")
    .bind(id)
    .first<{ id: number; convId: number; authorId: number | null; phase: Phase; bookingKind: BookingKind | null; bookingId: number | null }>();
  if (!row || row.phase === "ABOUT" || !(await personFor(c, row.convId)) || !mayChange(c.get("member"), row)) return null;
  return row;
}

notes.post("/edit/:id{[0-9]+}", async (c) => {
  const note = await noteFor(c, Number(c.req.param("id")));
  if (!note) return refuse(c);
  const f = (await c.req.parseBody()) as Form;
  if (f.csrf !== (await token(c, `notes-edit:${note.id}`))) return refuse(c);
  const fallback = `/app/people/${note.convId}#notes`;
  const text = cleanText(f.text);
  if (!text) return c.redirect(backWith(f.back, fallback, "empty"), 303);
  if (tooLong(text)) return c.redirect(backWith(f.back, fallback, "long"), 303);
  await c.env.DB.prepare("UPDATE notes SET body = ?2, edited_at = ?3 WHERE id = ?1").bind(note.id, text, iso(Date.now())).run();
  await audit(c, "NOTE_EDIT", note.convId, `note ${note.id}`);
  return c.redirect(backWith(f.back, fallback, "changed"), 303);
});

notes.post("/delete/:id{[0-9]+}", async (c) => {
  const note = await noteFor(c, Number(c.req.param("id")));
  if (!note) return refuse(c);
  const f = (await c.req.parseBody()) as Form;
  if (f.csrf !== (await token(c, `notes-delete:${note.id}`))) return refuse(c);
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind(note.id).run();
  await audit(c, "NOTE_DELETE", note.convId, `note ${note.id}`);
  return c.redirect(backWith(f.back, `/app/people/${note.convId}#notes`, "deleted"), 303);
});
