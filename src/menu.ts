// The main menu: [Book ₹99 call] [Sessions & packages] [Help]. While nothing may be sold (after a crisis message) it has neither selling button, and
// shows Help and Talk to a person instead. `withPerson` (the fallback when the AI cannot answer or a budget is used up) swaps in Talk to a person
// for Sessions & packages, because a person is the one thing that always works (Talk to a person is also in the Help list).
import type { Copy } from "./copy";
import type { Out } from "./send";

export const menuOut = (cp: Copy, noSell: boolean, body = cp.menuBody, withPerson = false): Out => ({
  type: "buttons",
  body,
  buttons: noSell
    ? [{ id: "menu_how", title: cp.btnHelp }, { id: "menu_person", title: cp.btnPerson }]
    : withPerson
      ? [{ id: "menu_book", title: cp.btnBook }, { id: "menu_how", title: cp.btnHelp }, { id: "menu_person", title: cp.btnPerson }]
      : [{ id: "menu_book", title: cp.btnBook }, { id: "menu_pack", title: cp.btnPackages }, { id: "menu_how", title: cp.btnHelp }],
});
