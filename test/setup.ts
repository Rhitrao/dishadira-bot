// Runs before every test file (vitest.config.ts setupFiles). src/config.ts carries the live approval of each WhatsApp template
// (what Meta shows Active); tests start from "none approved" so each test that needs a template switches it on itself.
import { beforeEach } from "vitest";
import { config } from "../src/config";

type Flags = { approved: boolean; hi: { approved: boolean } };
const templates = config.templates as unknown as Record<string, Flags>;

beforeEach(() => {
  for (const t of Object.values(templates)) {
    t.approved = false;
    t.hi.approved = false;
  }
});
