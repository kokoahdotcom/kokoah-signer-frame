import { afterEach, describe, expect, it } from "vitest";
import { outgoingProblem, redactHex64 } from "../src/frame/errors.js";
import { sanitizeFields } from "../src/frame/log.js";
import { FrameHarness, limitOrder, MockPasskeys, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

function forms(hex: `0x${string}`): string[] {
  const bare = hex.slice(2);
  return [bare.toLowerCase(), bare.toUpperCase(), Buffer.from(bare, "hex").toString("base64"), Buffer.from(bare, "hex").toString("base64url")];
}

describe("the private key never leaves the frame", () => {
  it("no posted message (responses and events) contains the key or any signature, over a full lifecycle", async () => {
    const logs: string[] = [];
    h = await FrameHarness.create({ passkeys: new MockPasskeys(), logger: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`) });
    const { privateKey } = await h.activeAgent("device");
    await h.ok("getStatus");
    await h.ok("signAndSubmit", { requestId: "ok", intent: limitOrder() });
    h.hl.responder = () => new Response(JSON.stringify({ status: "err", response: "Invalid nonce: duplicate nonce" }));
    await h.ok("signAndSubmit", { requestId: "rej", intent: limitOrder() });
    h.hl.responder = () => "network-error";
    await h.ok("signAndSubmit", { requestId: "unk", intent: limitOrder() });
    h.hl.responder = null;
    await h.fail("signAndSubmit", { requestId: "deny", intent: limitOrder({ price: "9999" }) });
    await h.ok("setLimits", { maxOrdersPerMinute: 30 });
    await h.ok("lock");
    await h.ok("unlock");
    // A passkey key too.
    const pending = h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey", replaceExisting: true });
    await h.clickPrompt();
    await pending;
    const passkeyKey = h.generatedKeys.at(-1)!;
    await h.ok("revoke", {});

    const posted = h.parent.postMessage.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(posted.length).toBeGreaterThan(15);
    const secrets = [...forms(privateKey), ...forms(passkeyKey)];
    for (const call of h.hl.exchangeCalls) secrets.push(call.body.signature.r.slice(2), call.body.signature.s.slice(2));
    for (const msg of posted) {
      for (const s of secrets) expect(msg.toLowerCase()).not.toContain(s.toLowerCase());
      expect(outgoingProblem(JSON.parse(msg))).toBeNull();
    }
    for (const line of logs) for (const s of secrets) expect(line.toLowerCase()).not.toContain(s.toLowerCase());
    expect(logs.some((l) => l.startsWith("sign.submitted"))).toBe(true);
  });

  it("the outgoing guard blocks binary data and 64-hex values", () => {
    expect(outgoingProblem({ a: 1, b: ["x", { c: null }] })).toBeNull();
    expect(outgoingProblem({ k: `0x${"ab".repeat(32)}` })).toMatch(/64-hex/);
    expect(outgoingProblem({ k: "AB".repeat(32) })).toMatch(/64-hex/);
    expect(outgoingProblem({ k: new Uint8Array(32) })).toMatch(/binary/);
    expect(outgoingProblem({ k: new ArrayBuffer(8) })).toMatch(/binary/);
    expect(outgoingProblem({ k: new Date() })).toMatch(/non-plain/);
    // Addresses (40 hex) and cloids (32 hex) are fine.
    expect(outgoingProblem({ a: `0x${"cd".repeat(20)}`, c: `0x${"ef".repeat(16)}` })).toBeNull();
    expect(redactHex64({ x: [`hash 0x${"12".repeat(32)} end`] })).toEqual({ x: ["hash [redacted] end"] });
  });

  it("log fields are whitelisted and hex-safe", () => {
    expect(sanitizeFields({ agent: `0x${"ab".repeat(20)}`, code: "POLICY_DENIED", privateKey: "0x01", reason: `x ${"ab".repeat(32)}`, count: 3 })).toEqual({
      agent: `0x${"ab".repeat(20)}`,
      code: "POLICY_DENIED",
      count: 3,
    });
  });
});
