// The console's two typefaces, self-hosted so the CSP needs only `font-src 'self'`: Jost (Latin) and Noto Sans Devanagari (Hindi),
// both SIL Open Font License 1.1 (fonts/OFL-*.txt, NOTICE). Only the Latin and Devanagari subsets, weights 400, 500 and 600, plus Jost 500
// italic for the screen titles (the PRD sets them in italics), from the @fontsource packages (v5.3.0). The files are bundled into the Worker
// as Data modules (wrangler.toml [[rules]]).
// The URLs never change for the same bytes, so they are cached for a year: a changed file must get a new name.
import type { Context } from "hono";
import jost400 from "../fonts/jost-latin-400.woff2";
import jost500 from "../fonts/jost-latin-500.woff2";
import jost600 from "../fonts/jost-latin-600.woff2";
import jost500i from "../fonts/jost-latin-500-italic.woff2";
import deva400 from "../fonts/noto-sans-devanagari-400.woff2";
import deva500 from "../fonts/noto-sans-devanagari-500.woff2";
import deva600 from "../fonts/noto-sans-devanagari-600.woff2";

export const FONT_PATH = "/app/fonts/";

const FILES: Record<string, ArrayBuffer> = {
  "jost-latin-400.woff2": jost400,
  "jost-latin-500.woff2": jost500,
  "jost-latin-600.woff2": jost600,
  "jost-latin-500-italic.woff2": jost500i,
  "noto-sans-devanagari-400.woff2": deva400,
  "noto-sans-devanagari-500.woff2": deva500,
  "noto-sans-devanagari-600.woff2": deva600,
};

// The same character ranges the subsets were cut to, so a browser downloads Devanagari only for a page that has Hindi (or ₹) on it.
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const DEVANAGARI = "U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B09";

const face = (family: string, file: string, weight: number, range: string, style = "normal") =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(${FONT_PATH}${file}) format("woff2");unicode-range:${range}}`;

export const FONT_FACES = [400, 500, 600]
  .flatMap((w) => [face("Jost", `jost-latin-${w}.woff2`, w, LATIN), face("Noto Sans Devanagari", `noto-sans-devanagari-${w}.woff2`, w, DEVANAGARI)])
  .concat(face("Jost", "jost-latin-500-italic.woff2", 500, LATIN, "italic"))
  .join("\n");

// GET /app/fonts/<file>: only the seven files above; anything else is a plain 404. Off (404) unless CONSOLE_V2 is "true", like every /app route.
export function serveFont(c: Context): Response {
  const on = (c.env as { CONSOLE_V2?: string } | undefined)?.CONSOLE_V2 === "true";
  const body = on ? FILES[c.req.param("file") ?? ""] : undefined;
  if (!body) return c.text("Not found", 404);
  return new Response(body, {
    headers: {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
