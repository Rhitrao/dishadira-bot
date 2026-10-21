// Helpers for tests that need a real slot: the i-th slot of a day, and the India date of an instant.
import { generateSlots, istDay, type SlotKind } from "../src/slots";

export const ymdOf = (ms: number) => istDay(ms);
export const slotAt = (ymd: string, kind: SlotKind, i: number): [string, string] => {
  const s = generateSlots(ymd, kind)[i];
  return [s.startUtc, s.endUtc];
};
