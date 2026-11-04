// Test helpers for the phone alerts (ticket 45): a VAPID key pair and a browser's subscription made fresh in the test (never real keys),
// and the browser's side of RFC 8291, so a test can read what a push really carried.
import { b64u, fromB64u } from "../src/push";

let n = 0;

// A fresh server key pair, as the two Worker secrets.
export async function testKeys(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { VAPID_PUBLIC_KEY: b64u(raw), VAPID_PRIVATE_KEY: jwk.d! };
}

export type TestSub = { endpoint: string; p256dh: string; auth: string; key: CryptoKey };

// A browser's subscription: its push-service address, its ECDH key pair and its auth secret.
export async function testSubscription(host = "fcm.googleapis.com"): Promise<TestSub> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const path = host === "web.push.apple.com" ? "/QGuQyavXuTEST" : host.endsWith("mozilla.com") ? "/wpush/v2/gAAAATEST" : "/fcm/send/dGVzdA:APA91bTEST";
  return { endpoint: `https://${host}${path}${++n}`, p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))), key: pair.privateKey };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

// What the browser reads: the header (salt, record size, the server's one-time key), then the one record.
export async function decryptPayload(sub: TestSub, body: Uint8Array | ArrayBuffer): Promise<string> {
  const b = body instanceof Uint8Array ? body : new Uint8Array(body);
  const salt = b.slice(0, 16);
  const idlen = b[20];
  const asPublic = b.slice(21, 21 + idlen);
  const peer = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm, sub.key, 256));
  const uaPublic = fromB64u(sub.p256dh)!;
  const ikm = await hkdf(fromB64u(sub.auth)!, ecdh, cat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, b.slice(21 + idlen)));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("no last-record delimiter");
  return new TextDecoder().decode(plain.slice(0, end));
}
