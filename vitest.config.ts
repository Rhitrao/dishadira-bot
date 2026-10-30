// `npm test`. Additions to vitest's defaults: test/setup.ts runs first in every file, and a .woff2 import is the file's bytes (an ArrayBuffer), as wrangler's Data rule
// makes it in the Worker, instead of Vite's asset URL. The manual eval uses vitest.eval.config.ts instead.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["test/setup.ts"] }, // every test starts with no template approved (test/setup.ts)
  plugins: [
    {
      name: "woff2-as-data",
      enforce: "pre",
      load(id: string) {
        if (!id.endsWith(".woff2")) return null;
        const b64 = readFileSync(id).toString("base64");
        return `const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); export default u.buffer;`;
      },
    },
  ],
});
