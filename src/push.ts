// Web Push with no third-party service (ticket 45): the standard protocol (RFC 8030), the server's identity by VAPID (RFC 8292: an ES256
// JWT in a `vapid` Authorization header) and the payload encrypted for the phone (RFC 8291, aes128gcm), all with Web Crypto in the Worker.
// The push service (Google, Mozilla, Apple, Microsoft) only ever sees ciphertext; only the team member's own browser can read it.
// Keys: the Worker secrets VAPID_PUBLIC_KEY (65-byte uncompressed P-256 point) and VAPID_PRIVATE_KEY (32-byte scalar), both base64url,
// made with `npm run vapid-keys`. Without them (or with keys that don't parse) everything push-related is off.
import { config } from "./config";
import type { Env } from "./env";

// ---- base64url ----
export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ---- the server's keys ----
export type VapidKeys = { publicKey: string; publicRaw: Uint8Array; signKey: CryptoKey };
// A P-256 point as Web Crypto's JWK wants it (x and y from the uncompressed 0x04 || x || y form).
const jwkOf = (point: Uint8Array, d?: Uint8Array): JsonWebKey => ({
  kty: "EC", crv: "P-256", x: b64u(point.slice(1, 33)), y: b64u(point.slice(33, 65)), ...(d ? { d: b64u(d) } : {}), ext: true,
});
const isPoint = (p: Uint8Array | null): p is Uint8Array => p !== null && p.length === 65 && p[0] === 4;

const keyCache = new Map<string, Promise<VapidKeys | null>>();

// The keys from the two secrets, or null when either is missing or doesn't parse as a matching P-256 pair.
export function vapidKeys(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY">): Promise<VapidKeys | null> {
  const pub = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const priv = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (!pub || !priv) return Promise.resolve(null);
  const id = `${pub}|${priv}`;
  let p = keyCache.get(id);
  if (!p) {
    p = (async () => {
      const point = fromB64u(pub);
      const d = fromB64u(priv);
      if (!isPoint(point) || !d || d.length !== 32) return null;
      try {
        const signKey = await crypto.subtle.importKey("jwk", jwkOf(point, d), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
        // The pair must match: sign once and verify with the public key, so a pasted mix-up is caught here, not at the push service.
        const verify = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        const probe = utf8("vapid-check");
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, probe);
        if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, sig, probe))) return null;
        return { publicKey: pub, publicRaw: point, signKey };
      } catch {
        return null;
      }
    })();
    keyCache.set(id, p);
  }
  return p;
}
export const pushOn = async (env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY">) => (await vapidKeys(env)) !== null;

// ---- VAPID (RFC 8292) ----
// The JWT: {"typ":"JWT","alg":"ES256"}, claims aud (the push service's origin), exp (at most 24 hours ahead; we use config.push.jwtHours)
// and sub (a mailto: of the business's contact address). Web Crypto's ECDSA signature is already JWS's r || s form.
export async function vapidJwt(keys: VapidKeys, endpoint: string, nowMs = Date.now()): Promise<string> {
  const header = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + config.push.jwtHours * 3600, sub: `mailto:${config.social.contactEmail}` })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.signKey, utf8(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(new Uint8Array(sig))}`;
}
export const vapidHeader = async (keys: VapidKeys, endpoint: string, nowMs = Date.now()) => `vapid t=${await vapidJwt(keys, endpoint, nowMs)}, k=${keys.publicKey}`;

// ---- the payload, encrypted for the browser (RFC 8291, with RFC 8188's aes128gcm in one record) ----
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// `uaPublic` (the subscription's p256dh) and `authSecret` (its auth) come from the browser. `local` and `salt` are for the RFC's test
// vector only: normally a fresh key pair and salt are made for every message.
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  test?: { local: { privateKey: CryptoKey; publicRaw: Uint8Array }; salt: Uint8Array },
): Promise<Uint8Array> {
  let local = test?.local;
  if (!local) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    local = { privateKey: pair.privateKey, publicRaw: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
  }
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const peer = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const ikm = await hkdf(authSecret, ecdh, concat(utf8("WebPush: info\0"), uaPublic, local.publicRaw), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  // One record: the plaintext, then 0x02 (the last record's delimiter), no padding.
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  // Header: salt (16) || record size (4, big-endian, 4096) || key id length (1) || key id (the server's one-time public key, 65)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = local.publicRaw.length;
  return concat(header, local.publicRaw, sealed);
}

// ---- where a subscription may point ----
// Only https and only a known push service (config.push.hosts: an exact host, or ".suffix" for a family of hosts), so the Worker
// never posts to an address someone typed into a form.
export function allowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > config.push.maxEndpointChars) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return config.push.hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) && host.length > h.length : host === h));
}

// The subscription's keys as the browser gave them: p256dh a P-256 point, auth 16 bytes.
export function validKeys(p256dh: string, auth: string): boolean {
  const a = fromB64u(auth);
  return isPoint(fromB64u(p256dh)) && a !== null && a.length === 16;
}

// ---- one push ----
export type Sub = { endpoint: string; p256dh: string; auth: string };
export type PushResult = { ok: boolean; gone: boolean; status: number };

// POST the encrypted message to the subscription's push service. 201 (or any 2xx) is delivered to the service; 404 and 410 mean the
// subscription is gone (the caller deletes it); anything else, a timeout included, may be tried again.
export async function sendPush(keys: VapidKeys, sub: Sub, payload: object, nowMs = Date.now()): Promise<PushResult> {
  if (!allowedEndpoint(sub.endpoint) || !validKeys(sub.p256dh, sub.auth)) return { ok: false, gone: true, status: 0 };
  try {
    const body = await encryptPayload(utf8(JSON.stringify(payload)), fromB64u(sub.p256dh)!, fromB64u(sub.auth)!);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(keys, sub.endpoint, nowMs),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(config.push.ttlSeconds),
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(config.push.timeoutMs),
    });
    return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 };
  }
}
