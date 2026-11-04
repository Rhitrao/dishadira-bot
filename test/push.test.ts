// Web Push without a third-party service (ticket 45, src/push.ts): the RFC 8291 test vector, the VAPID JWT (RFC 8292), the push-service
// host list, the keys from the secrets, and one push's answers. All keys here are made in the test or come from the RFC: none is real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import { allowedEndpoint, b64u, encryptPayload, fromB64u, pushOn, sendPush, validKeys, vapidHeader, vapidJwt, vapidKeys } from "../src/push";
import { deviceName } from "../src/alerts";
import { testKeys, testSubscription, decryptPayload } from "./pushkit";

const NOW = Date.parse("2026-11-04T10:00:00Z");

describe("RFC 8291 (aes128gcm): the test vector of Appendix A", () => {
  it("encrypts the RFC's plaintext to exactly the RFC's message", async () => {
    const asPublic = fromB64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")!;
    const asPrivate = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u(asPublic.slice(1, 33)), y: b64u(asPublic.slice(33, 65)) },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const out = await encryptPayload(
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      fromB64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")!,
      fromB64u("BTBZMqHH6r4Tts7J_aSIgg")!,
      { local: { privateKey: asPrivate, publicRaw: asPublic }, salt: fromB64u("DGv6ra1nlYgDCS1FRnbzlw")! },
    );
    expect(b64u(out)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("a fresh message (own key pair and salt) decrypts on the browser's side, and two messages never look alike", async () => {
    const sub = await testSubscription();
    const a = await encryptPayload(new TextEncoder().encode('{"title":"New booking"}'), fromB64u(sub.p256dh)!, fromB64u(sub.auth)!);
    const b = await encryptPayload(new TextEncoder().encode('{"title":"New booking"}'), fromB64u(sub.p256dh)!, fromB64u(sub.auth)!);
    expect(b64u(a)).not.toBe(b64u(b));
    expect(await decryptPayload(sub, a)).toBe('{"title":"New booking"}');
  });
});

describe("VAPID (RFC 8292)", () => {
  it("the JWT: ES256, aud the push service's origin, sub the business's mailto:, exp at most 24 hours ahead; it verifies with the public key", async () => {
    const env = await testKeys();
    const keys = (await vapidKeys(env))!;
    const jwt = await vapidJwt(keys, "https://fcm.googleapis.com/fcm/send/abc123", NOW);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromB64u(h)!))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(c)!));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe(`mailto:${config.social.contactEmail}`);
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(24 * 3600);
    const pub = await crypto.subtle.importKey("raw", fromB64u(env.VAPID_PUBLIC_KEY)!, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = fromB64u(s)!;
    expect(sig.length).toBe(64); // JWS r || s
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);
    // Another key does not verify it.
    const other = await testKeys();
    const pub2 = await crypto.subtle.importKey("raw", fromB64u(other.VAPID_PUBLIC_KEY)!, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub2, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(false);
    expect(await vapidHeader(keys, "https://web.push.apple.com/QGuQyavXu", NOW)).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
  });

  it("no secrets, one of them, garbage or a mismatched pair: push is off", async () => {
    const good = await testKeys();
    const other = await testKeys();
    expect(await pushOn({} as never)).toBe(false);
    expect(await pushOn({ VAPID_PUBLIC_KEY: good.VAPID_PUBLIC_KEY } as never)).toBe(false);
    expect(await pushOn({ VAPID_PRIVATE_KEY: good.VAPID_PRIVATE_KEY } as never)).toBe(false);
    expect(await pushOn({ VAPID_PUBLIC_KEY: "not a key!", VAPID_PRIVATE_KEY: good.VAPID_PRIVATE_KEY } as never)).toBe(false);
    expect(await pushOn({ VAPID_PUBLIC_KEY: good.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: "AAAA" } as never)).toBe(false);
    expect(await pushOn({ VAPID_PUBLIC_KEY: good.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: other.VAPID_PRIVATE_KEY } as never)).toBe(false);
    expect(await pushOn(good as never)).toBe(true);
  });
});

describe("where a subscription may point", () => {
  it("https on a known push service only (FCM, Mozilla, Apple, Windows)", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bTEST",
      "https://fcm.googleapis.com/wp/dGVzdA",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABTEST",
      "https://web.push.apple.com/QGuQyavXutnMH-TEST",
      "https://wns2-pn1p.notify.windows.com/w/?token=BQYAAABTEST",
    ])
      expect(allowedEndpoint(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x", // not https
      "https://evil.example/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com/x",
      "https://notify.windows.com/w/x", // the bare suffix is not a push host
      "https://xnotify.windows.com/w/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://127.0.0.1/x",
      "javascript:alert(1)",
      "",
      `https://fcm.googleapis.com/${"x".repeat(2000)}`,
    ])
      expect(allowedEndpoint(bad), bad).toBe(false);
  });

  it("the browser's keys: p256dh a P-256 point, auth 16 bytes", async () => {
    const sub = await testSubscription();
    expect(validKeys(sub.p256dh, sub.auth)).toBe(true);
    expect(validKeys(sub.p256dh, "AAAA")).toBe(false);
    expect(validKeys("BAAA", sub.auth)).toBe(false);
    expect(validKeys(sub.p256dh.replace(/^./, "A"), sub.auth)).toBe(false);
    expect(validKeys("<script>", sub.auth)).toBe(false);
  });
});

describe("one push", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs ciphertext with the VAPID header, aes128gcm, a TTL; 201 delivered, 404/410 gone, others retried", async () => {
    const env = await testKeys();
    const keys = (await vapidKeys(env))!;
    const sub = await testSubscription();
    let status = 201;
    const calls: { url: string; init: { headers: Record<string, string>; body: Uint8Array } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => (calls.push({ url, init }), new Response("", { status }))));
    expect(await sendPush(keys, sub, { title: "New booking" }, NOW)).toEqual({ ok: true, gone: false, status: 201 });
    const h = calls[0].init.headers;
    expect(calls[0].url).toBe(sub.endpoint);
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(h.TTL)).toBeGreaterThan(0);
    expect(await decryptPayload(sub, calls[0].init.body)).toBe('{"title":"New booking"}');
    for (const [s, want] of [[410, { ok: false, gone: true }], [404, { ok: false, gone: true }], [500, { ok: false, gone: false }], [429, { ok: false, gone: false }], [403, { ok: false, gone: false }]] as const) {
      status = s;
      expect(await sendPush(keys, sub, {}, NOW)).toMatchObject(want);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    expect(await sendPush(keys, sub, {}, NOW)).toEqual({ ok: false, gone: false, status: 0 });
  });

  it("never posts to an address off the list (a stored row that somehow is): it counts as gone", async () => {
    const keys = (await vapidKeys(await testKeys()))!;
    const sub = await testSubscription();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await sendPush(keys, { ...sub, endpoint: "https://evil.example/x" }, {}, NOW)).toMatchObject({ ok: false, gone: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("the device's name", () => {
  it("browser and system only", () => {
    expect(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")).toBe("Safari on iPhone"); // the home-screen app
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("Edge on Windows");
    expect(deviceName("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe("Chrome on Chromebook");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox on Mac");
    expect(deviceName(undefined)).toBe("Browser");
  });
});
