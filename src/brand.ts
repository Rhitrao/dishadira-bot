// The console's brand files (ticket 39): the sun-and-path mark, the full logo, the home-screen icons and the web app manifest, so
// the team can "Add to Home Screen". Small files bundled into the Worker as Data modules (wrangler.toml [[rules]]), served like the
// fonts (src/fonts.ts): only these names, the right type, a year-long cache (a changed file must get a new name), and 404 unless
// CONSOLE_V2 is "true", like every /app route. The CSP allows them with img-src 'self' and manifest-src 'self'.
import type { Context } from "hono";
import { config } from "./config";
import mark from "../images/mark-112.webp";
import logo from "../images/logo-328.webp";
import icon192 from "../images/icon-192.png";
import icon512 from "../images/icon-512.png";
import touch from "../images/apple-touch-icon.png";

export const BRAND_PATH = "/app/brand/";
export const MANIFEST_PATH = "/app/manifest.webmanifest";

const FILES: Record<string, { body: ArrayBuffer; type: string }> = {
  "mark-112.webp": { body: mark, type: "image/webp" },
  "logo-328.webp": { body: logo, type: "image/webp" },
  "icon-192.png": { body: icon192, type: "image/png" },
  "icon-512.png": { body: icon512, type: "image/png" },
  "apple-touch-icon.png": { body: touch, type: "image/png" },
};

const on = (c: Context) => (c.env as { CONSOLE_V2?: string } | undefined)?.CONSOLE_V2 === "true";
const LONG = "public, max-age=31536000, immutable";

// GET /app/brand/<file>
export function serveBrand(c: Context): Response {
  const f = on(c) ? FILES[c.req.param("file") ?? ""] : undefined;
  if (!f) return c.text("Not found", 404);
  return new Response(f.body, { headers: { "Content-Type": f.type, "Cache-Control": LONG, "X-Content-Type-Options": "nosniff" } });
}

// The manifest's words and colours come from config.brand. It changes with config, so it is cached for a day, not a year.
export const manifest = () => ({
  name: config.brand.name,
  short_name: config.brand.shortName,
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  theme_color: config.brand.themeColor,
  background_color: config.brand.background,
  icons: [
    { src: `${BRAND_PATH}icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BRAND_PATH}icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

// GET /app/manifest.webmanifest
export function serveManifest(c: Context): Response {
  if (!on(c)) return c.text("Not found", 404);
  return new Response(JSON.stringify(manifest()), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}

// The <head> lines every console page carries: the tab icon, the home-screen icon and the manifest. Access lets the manifest through
// only with the sign-in cookie, hence crossorigin="use-credentials".
export const HEAD_LINKS =
  `<link rel="icon" type="image/png" href="${BRAND_PATH}icon-192.png"><link rel="apple-touch-icon" href="${BRAND_PATH}apple-touch-icon.png">` +
  `<link rel="manifest" href="${MANIFEST_PATH}" crossorigin="use-credentials"><meta name="theme-color" media="(prefers-color-scheme: light)" content="${config.brand.themeColor}">` +
  `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${config.brand.themeColorDark}">` +
  `<meta name="apple-mobile-web-app-title" content="${config.brand.shortName}"><meta name="mobile-web-app-capable" content="yes">`;
