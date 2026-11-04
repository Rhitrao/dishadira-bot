// `npm run vapid-keys`: prints a fresh key pair for the team's phone alerts (ticket 45, docs/GO-LIVE.md "Phone alerts").
// Paste each value as a Worker secret (Cloudflare → Workers & Pages → the Worker → Settings → Variables and Secrets → Add → Secret,
// or `npx wrangler secret put VAPID_PUBLIC_KEY --env live`). Never into git, a chat, a ticket or a screenshot. Nothing is saved.
const { subtle } = globalThis.crypto;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)); // 0x04 || x || y, 65 bytes
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("");
console.log("Add both as secrets of the Worker (dishadira-bot-live, and dishadira-bot-test if you want alerts there), then deploy.");
console.log("Keep the private key secret. A new pair later means every phone must tap Turn on again.");
