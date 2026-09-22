# Signer frame threat model

Scope: the browser trading key (a Hyperliquid **named agent**, `kokoah-web`) held by this frame on its own origin (`signer.kokoah.example`), and the path from the Kokoah app to a signed action on Hyperliquid (HL). The ranked organisation-wide threats are in kokoah-infra `docs/SECURITY_BASELINE.md` §0; this document covers the frame's part (items 1, 2, 3 and 6 there).

## 1. What the key can and can't do

An HL agent key **cannot**:
- withdraw or transfer funds (`withdraw3`, `usdSend`, `spotSend`, `usdClassTransfer`, `sendAsset`);
- approve agents or builder fees.

Those need the main wallet. It **can**:
- place, modify and cancel orders on any market, and change leverage and margin;
- sign `vaultTransfer`, `createVault` (10k USDC fee), `createSubAccount`, `reserveRequestWeight` and others (research B §1.7).

A stolen agent key can therefore still drain an account:
- by trading against the attacker's resting orders in thin markets;
- by opening maximum-leverage losing positions;
- through a vault the attacker leads;
- by burning fees (research B §1.8; the 3Commas pattern).

The frame exists so that **code running in the app cannot read the key** and can only get signatures the frame's policy allows.

## 2. Assets and trust boundaries

| Asset | Where | Notes |
|---|---|---|
| Agent private key | Frame memory; encrypted at rest in the signer origin's IndexedDB (`device`/`passkey`) | Never posted, logged or returned (tested) |
| Wrapping key | Non-extractable `CryptoKey` in IndexedDB (`device`); derived on demand from a WebAuthn PRF output (`passkey`) | |
| Signatures | Built inside the frame and sent only to HL `/exchange` | Never posted to the parent: an HL signature plus its action can be replayed until its nonce expires |
| Nonce state, rate and notional counters | IndexedDB `usage` store | Integrity only; not secret |
| Policy baseline | Compiled into the frame bundle | Protected by deploy integrity (SRI, release manifest) |

Trust boundaries:
1. **Parent ↔ frame:** `postMessage`, restricted to allowlisted origins and `window.parent`.
2. **Frame ↔ HL:** HTTPS to the HL API host only (`connect-src`).
3. **Frame ↔ other tabs of the signer origin:** shared IndexedDB, Web Locks and a BroadcastChannel carrying notices only.
4. **Frame ↔ authenticator:** WebAuthn, inside the frame.

## 3. Attackers and what stops them

| # | Attacker | Can | Stopped / limited by | Status |
|---|---|---|---|---|
| A1 | **XSS or a malicious dependency in the app** (app origin) | Send any message the parent can send; show fake UI; trick the user into approving things | Separate origin: it can't read the frame's memory or storage. The frame accepts only strict schemas, never takes prices, builder, registry or nonce from the parent, and applies the **baseline policy**, which the parent can't loosen. No message ever carries the key or a signature | Implemented, unit-tested; origin isolation verified in headless Chromium |
| A2 | A1 plus social engineering | Ask for a passkey unlock and hope the user clicks | The WebAuthn prompt is browser-native and names the signer's RP ID. Unlocking still only yields policy-bounded signatures | Residual: see §5 |
| A3 | Another website | Embed the frame, or `postMessage` it | `frame-ancestors` (header) allows only the app origin; the frame also checks `event.origin` and `event.source` | `frame-ancestors` verified in headless Chromium; origin/source checks unit-tested |
| A4 | **Script running on the signer origin** (a compromised frame deploy or dependency, a CDN or DNS takeover, a browser extension with host access) | Everything: read the key after unlock, decrypt `device` keys, sign anything | Deploy integrity: SRI on every script, the release manifest, external monitoring (kokoah-infra). DNS and registrar controls. Minimal dependencies. CSP stops *injected* code (no inline, no eval, Trusted Types `'none'`, `connect-src` only HL) but not code shipped as the frame itself | **Out of reach of any in-browser control.** This is the real trust anchor; see §4 |
| A5 | Thief with a copy of the disk or browser profile (offline) | Read IndexedDB files | `device`: the ciphertext needs the browser's key store (the CryptoKey is non-extractable; a copy of the IndexedDB files alone doesn't decrypt). `passkey`: needs the authenticator plus user verification (PIN or biometric). `session`: nothing stored | Implemented. Non-extractability verified in Chromium. OS key-store protection is the browser's |
| A6 | Malware or an extension on the device while the browser runs | Drive the browser, or read memory | Out of scope for web code. `passkey` narrows the window to when the key is unlocked | Residual |
| A7 | Network attacker | Tamper with traffic | HTTPS, HSTS (headers) and SRI. HL API over HTTPS | Headers from kokoah-infra |
| A8 | Other tabs or races | Reuse nonces, bypass the rate limit | Web Locks per agent. Nonce reserved in one IndexedDB read-write transaction, serialized across tabs. Counters persisted | Unit-tested with fake-indexeddb (two "tabs"); Web Locks verified in Chromium |
| A9 | A malicious parent that reloads the frame to reset limits | Reset in-memory counters | Rate and daily-notional counters are persisted in IndexedDB | Tested (reload keeps the rate limit) |
| A10 | A malicious parent that feeds fake prices to widen the band | Get orders signed far from the market | The frame fetches mark and mid itself from HL `/info`; there's no protocol field for prices | Tested |
| A11 | Replay of old signed actions | Resubmit captured actions | Signatures never leave the frame except to HL. `expiresAfter` = now + 15 s. Nonces are unique and never reused. Agent addresses are never reused (HL prunes a deregistered agent's nonce state) | Tested |

## 4. What each storage mode protects (plainly)

- **`device`: stops offline storage theft; does not stop same-origin script execution.** Any script that runs on `signer.kokoah.example` can call `crypto.subtle.decrypt` with the stored non-extractable key and get the agent key. That's why the frame lives on its own origin with a strict CSP, SRI and a release manifest, and why that origin's deploy pipeline, CDN and DNS are critical infrastructure.
- **`passkey`: the key can't be unwrapped without a WebAuthn assertion with user verification** (`userVerification: "required"` on both ceremonies; PRF outputs differ with and without it). Code on the signer origin that runs while the key is locked can't use it silently. Once unlocked, the key is in memory for that tab until `lock`, reload or close, and script on the signer origin could read it then. It depends on the authenticator supporting the PRF extension (feature-detected, with fallback to `device`).
- **`session`: nothing at rest.** The key is lost on reload.
- **Always true:**
  - WebCrypto has no secp256k1, so the key is raw bytes in JavaScript memory while in use.
  - JavaScript strings can't be wiped: the frame zeroes the byte arrays it controls, but the viem account and the hex string it was created from live until garbage collection.

## 5. Residual risks and honest limits

1. **The baseline policy is wide.** $1M per order, $25M per day, 10% price band, 60 orders a minute, any market. An attacker controlling the app (A1) can still make the frame sign orders inside those limits, for example crossing their own resting orders in a thin market up to 10% from mark. The spec (SECURITY_BASELINE §3) asks for **explicit in-frame user confirmation for out-of-policy requests**; v1 denies them instead, with no in-frame confirmation of large orders. Recommended next steps:
   - tighter baseline numbers once real usage is known;
   - users setting personal limits (`setLimits`);
   - an in-frame confirmation for orders above a threshold (TODO).
2. **In-frame prompts can be clickjacked by the parent** (made transparent or covered). The browser's own WebAuthn dialog still appears and names the signer, and the result is still policy-bounded. IntersectionObserver v2 visibility checks are a possible hardening (TODO).
3. **Passkeys and headers.** Resolved 2026-09-22: kokoah-infra allows WebAuthn for the signer (`(self)`), and the app delegates it to the signer origin. If a deployment's `Permissions-Policy` disables it again, every `passkey` request falls back to `device` (reported via `storageFallbackReason`).
4. **User limits are not persisted by the frame.** The parent re-applies them after each load, including a reload of the frame alone (the client's `reconnected` event). A compromised parent can drop them back to the baseline, but never below it.
5. **Revocation needs the main wallet.** `revoke` wipes the local key at once (or reports `wipeError` when IndexedDB refuses to delete the stored copy, which would then come back after a reload), but the agent stays registered on HL until the user signs and posts `revokeAgent`. The wiped key is unrecoverable, so that is safe unless the key was already stolen, in which case only the on-chain revoke (or expiry, at most 30 days) stops it.
6. **Out of scope and unverified:** the WebAuthn PRF behaviour of real authenticators (Safari/iCloud Keychain, Windows Hello, Android, security keys) and passkeys inside sandboxed iframes. See README "Manual verification".
7. **`modify` carries no builder field** in HL's schema. Whether a modified order keeps its builder fee is undocumented (shared library note). The policy enforces the builder on `order` only.

## 6. Controls checklist

| Control | Where | Verified by |
|---|---|---|
| Separate origin, own deploy, own release manifest | Infra plus `scripts/postbuild.ts` | Manifest byte-identical to kokoah-infra's generator |
| CSP header (infra) plus `<meta>` CSP (connect-src narrowed to the network's HL host) | `public/_headers`, `vite.config.ts` | `test/config.test.ts` (meta ⊆ header); postbuild check; headless Chromium (violations blocked, none in normal flows) |
| Trusted Types `require-trusted-types-for 'script'`, `trusted-types 'none'` | Header plus meta; the UI uses only `createElement`/`textContent` | Headless Chromium: `innerHTML` and `script.src` throw |
| No inline scripts or styles, SRI on every script and style | `vite.config.ts`, `scripts/postbuild.ts` | Postbuild fails otherwise; Chromium loads with SRI |
| No `eval`/`new Function` in the bundle; no dev-harness code | Postbuild scan | Postbuild |
| `frame-ancestors` = app origin(s) = `VITE_ALLOWED_PARENT_ORIGINS` | Header; postbuild consistency check | Chromium (unlisted origin refused); `test/config.test.ts` |
| Origin allowlist plus `event.source === window.parent`; replies to the exact origin | `core.ts` | `test/messaging.test.ts` |
| Strict schemas, 64 KB cap | `messages.ts`, shared intents | `test/messaging.test.ts`, `test/sign.test.ts` |
| Key and signature never posted; outgoing guard | `errors.ts` | `test/leak.test.ts` |
| Logs: fixed events, whitelisted fields | `log.ts` | `test/leak.test.ts` |
| Baseline policy plus tighten-only limits | `policy.ts` (shared `evaluatePolicy`) | `test/policy.test.ts` |
| Frame-sourced prices and metadata | `market-data.ts` | `test/sign.test.ts` |
| Named agent, `valid_until` ≤ 30 days, never reused, expiry enforced | `core.ts` | `test/agent.test.ts`, `test/lifecycle.test.ts` |
| Nonces unique and increasing across tabs | `nonces.ts` | `test/nonce.test.ts` |
| Testnet default; mainnet needs `VITE_ALLOW_MAINNET_WRITES=true`; shared write guard | `config.ts`, shared `assertWriteAllowed` | `test/config.test.ts` |
