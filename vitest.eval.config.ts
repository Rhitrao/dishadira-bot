// Used only by .github/workflows/eval.yml (the manual run against the real model). The normal `npm test` never loads this file or the live eval.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/agent-evals/live.eval.ts"], testTimeout: 900_000, hookTimeout: 60_000 },
});
