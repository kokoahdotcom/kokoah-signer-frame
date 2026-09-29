# Signer frame threat model

Scope: the browser trading key (a Hyperliquid **named agent**, `kokoah-web`) held by this frame on its own origin (`signer.kokoah.example`), and the path from the Kokoah app to a signed action on Hyperliquid (HL). The ranked organisation-wide threats are in kokoah-infra `docs/SECURITY_BASELINE.md` §0; this document covers the frame's part (items 1, 2, 3 and 6 there).

## 1. What the key can and can't do

An HL agent key **cannot**:
- withdraw or transfer funds (`withdraw3`, `usdSend`, `spotSend`, `usdClassTransfer`, `sendAsset`);
- approve agents or builder fees.

Those need the main wallet. It **can**:
- place, modify and cancel orders on any market, and change leverage and margin;
- do all of that **for the master's sub-accounts and for any vault the master leads**, by setting `vaultAddress` on
  the request (sub-accounts and vaults have no key of their own);
- sign `vaultTransfer`, `createVault` (10k USDC fee), `createSubAccount`, `agentSendAsset`, `reserveRequestWeight` and
  others (research B §1.7);
- sign `setReferrer` (any code) and `startFeeTrial`, and trade spot. The frame allows only Kokoah's own code once, the
  fee trial, spot on the pinned stablecoin pairs, and, once the user turns spot trading on, spot on the verified token
  pairs (A14–A17).

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
| A5 | Thief with a copy of the disk or browser profile (offline) | Read IndexedDB files | `passkey`: needs the authenticator plus user verification (PIN or biometric). `session`: nothing stored. **`device`: no protection in Chromium** (verified 2026-09-29): "non-extractable" only blocks `exportKey` in JavaScript; Chromium writes the CryptoKey's raw bytes into the profile's IndexedDB files next to the ciphertext, so a profile copy (a stolen laptop without disk encryption, a backup, an infostealer's zip of the profile) decrypts the agent key. Safari may wrap keys with the Keychain (untested); Firefox likely doesn't (untested) | **Residual for `device` keys** (the default): a copied profile gives the agent key until it expires or is revoked. Mitigations: offer `passkey` where PRF is supported, revoke lost devices (Security → Revoke all), keep agent lifetimes short |
| A6 | Malware or an extension on the device while the browser runs | Drive the browser, or read memory | Out of scope for web code. `passkey` narrows the window to when the key is unlocked | Residual |
| A7 | Network attacker | Tamper with traffic | HTTPS, HSTS (headers) and SRI. HL API over HTTPS | Headers from kokoah-infra |
| A8 | Other tabs or races | Reuse nonces, bypass the rate limit | Web Locks per agent. Nonce reserved in one IndexedDB read-write transaction, serialized across tabs. Counters persisted | Unit-tested with fake-indexeddb (two "tabs"); Web Locks verified in Chromium |
| A9 | A malicious parent that reloads the frame to reset limits | Reset in-memory counters | Rate and daily-notional counters are persisted in IndexedDB | Tested (reload keeps the rate limit) |
| A10 | A malicious parent that feeds fake prices to widen the band | Get orders signed far from the market | The frame fetches mark and mid itself from HL `/info`; there's no protocol field for prices | Tested |
| A11 | Replay of old signed actions | Resubmit captured actions | Signatures never leave the frame except to HL. `expiresAfter` = now + 15 s. Nonces are unique and never reused. Agent addresses are never reused (HL prunes a deregistered agent's nonce state) | Tested |
| A12 | A1 asks the frame to act for **another account** (`intent.vaultAddress`): a vault the user leads, someone else's sub-account, a made-up address | Trade that account with the user's key | `vaultAddress` is signed only for an address that HL's own `subAccounts` answer lists with `master` equal to the key's master. The frame reads it itself (its own `fetch`, `connect-src` HL only), never from the parent; there is no protocol field for ownership; the policy object's `allowedVaultAddresses` is replaced by the one verified address or by nothing. Cached 30 s (a re-read on a miss once the list is 5 s old); a failed or unreadable read signs nothing. Sub-accounts can't change master, so a cached "owned" can't become wrong; a stale "not owned" only denies. The address is inside the signed hash, so an action signed for one account can't be replayed for another | Unit-tested (`test/subaccounts.test.ts`) |
| A13 | A1 spreads orders over many sub-accounts to escape limits | Multiply the daily notional cap | The baseline $25M/day holds per key across every account (per-account figures only feed personal limits); orders per minute are per key | Unit-tested |
| A14 | A1 asks the frame to **set a referrer** (`setReferrer`) | Point the account's referral rewards at the attacker's code | The intent has no code field (strict schema); the frame signs only its own build value `VITE_HL_REFERRAL_CODE`, and the shared policy allows `setReferrer` only with exactly that `referralCode`. The frame reads HL `referral` itself and signs only while no referrer is set, and at most once per key (recorded with the nonce in the same IndexedDB transaction, so reloads and other tabs see it). Master account only. No code configured: denied | Unit-tested (`test/revenue.test.ts`, shared `accountActions.test.ts`) |
| A15 | A1 uses **Convert** to trade spot | Trade an illiquid or look-alike spot token, rest spot orders, or trade spot for a sub-account | While spot trading is off (the default; A17 covers it on), spot is denied except the network's pinned stablecoin/USDC pairs (shared `STABLECOIN_PAIRS`: pair index, token indices, names and token ids), which the frame checks against the `spotMetaAndAssetCtxs` it fetches itself; only those pairs enter its registry. One IOC order, within the 10% band of HL's mark, counted toward notional and rate limits; no triggers, reduce-only, TP/SL or modify; master account only. Worst case is the same class as A1 on perps: a conversion at up to 10% from mark | Unit-tested |
| A16 | A1 **starts the fee trial** (`startFeeTrial`) | Start Hyperliquid's fee trial without the user asking, or with made-up rates | Allowed by design (agent-signed on HL). The intent names a VIP tier by number; the rates come from the `userFees` fee schedule the frame reads itself, and nothing is signed while a trial runs or before `nextTrialAvailableTimestamp`. Master account only. HL allows one trial per 90 days and the user keeps paying their current rates during it, so the effect is bounded to using up the trial early or on a tier the user wouldn't pick (see §5) | Unit-tested |
| A17 | A1 uses **spot trading** (PHASE3 SPOT) | Turn spot trading on, then buy a token the attacker holds at an inflated price from the attacker's own asks: an unverified token it deployed, a look-alike of a real token, a thin verified token whose mark it moved first, or orders far from the market; or trade spot for a sub-account | Off by default: `setLimits({ spotTrading: true })` turns it on, per load, and the parent can't go beyond the baseline. Only the pinned pairs are ever signed: Convert's stablecoins and the verified tokens against USDC (shared `VERIFIED_SPOT_PAIRS`, Hyperliquid's own "Strict" list, by token id), each confirmed against the `spotMetaAndAssetCtxs` the frame fetches itself (pair index and name, token indices, names, ids); an unverified or look-alike token is `UNSUPPORTED_MARKET`. One order per action: market (IOC) or GTC / IOC / post-only limits, executes-now within 10% of HL's mark (resting within 50%), no triggers, reduce-only, TP/SL or modify; builder on sells, none on buys; counted toward notional and rate limits; master account only. On mainnet one order on a verified pair is at most 10% of the pair's 24 h volume as the frame read it, so a thin book can't take a large order. Worst case: buying a verified token at up to 10% above a mark the attacker may have moved, one capped order at a time (see §5) | Unit-tested (`test/spot.test.ts`, shared `spotPolicy.test.ts`, `spotPairs.test.ts`) |
| A18 | A1 trades a **HIP-3 market whose deployer it controls** | The deployer sets the oracle and mark the price band trusts, and can halt and settle: buy from the attacker's asks, then liquidate or settle at its price | Mainnet: only the HIP-3 dexes pinned in shared `perpDexs.ts` (name and deployer), confirmed against the `perpDexs` the frame fetches itself; an unpinned dex or a changed deployer is `UNSUPPORTED_MARKET`. Testnet accepts every dex (test money) | Unit-tested (shared `perpDexs.test.ts`, `test/sign.test.ts`) |
| A19 | A1 signs a **`scheduleCancel` far ahead**, or **loops cancels / `noop`** | Cancel every order (stop-losses included) days later; use up the address's HL request allowance | `scheduleCancel` is at most 1 h ahead (shared `compile.ts`, `SCHEDULE_TOO_FAR`). Every signed action counts toward 120 per minute per key, checked in the same IndexedDB transaction that records it | Unit-tested (shared `actions.test.ts`, `test/nonce.test.ts`) |
| A20 | A1 uses **several tabs without Web Locks**, or **sub-accounts without limits of their own** | Multiply the per-minute and daily limits | The limits are checked again inside the IndexedDB transaction that reserves the nonce and records the usage. A sub-account without limits of its own shares the master's daily counter | Unit-tested (`test/nonce.test.ts`, `test/subaccounts.test.ts`) |
| A21 | A1 **themes the frame** and asks to remove passkey protection (`setStorageMode` → device) | Disguise the prompt so one click permanently downgrades the key to auto-unlock | That prompt ignores `setTheme`: the frame's own fixed colors and sizes, "Remove passkey protection?", button "Remove protection" | `test/storage.test.ts` |

## 4. What each storage mode protects (plainly)

- **`device`: keeps the key from other origins and from JavaScript export; stops neither a copied browser profile nor same-origin script execution.** In Chromium the non-extractable CryptoKey's bytes are stored in the profile's IndexedDB files beside the ciphertext, so a copy of the profile decrypts the key offline (A5). Any script that runs on `signer.kokoah.example` can call `crypto.subtle.decrypt` with the stored key and get the agent key. That's why the frame lives on its own origin with a strict CSP, SRI and a release manifest, and why that origin's deploy pipeline, CDN and DNS are critical infrastructure.
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
4. **User limits are not persisted by the frame.** The parent re-applies them after each load, including a reload of the frame alone (the client's `reconnected` event). A compromised parent can drop them back to the baseline, but never below it. Per-account limits (`setLimits` with `account`) work the same way, and a sub-account without its own limits uses the master's.
5. **Revocation needs the main wallet.** `revoke` wipes the local key at once (or reports `wipeError` when IndexedDB refuses to delete the stored copy, which would then come back after a reload), but the agent stays registered on HL until the user signs and posts `revokeAgent`. The wiped key is unrecoverable, so that is safe unless the key was already stolen, in which case only the on-chain revoke (or expiry, at most 30 days) stops it.
6. **Out of scope and unverified:** the WebAuthn PRF behaviour of real authenticators (Safari/iCloud Keychain, Windows Hello, Android, security keys) and passkeys inside sandboxed iframes. See README "Manual verification".
7. **`modify` carries no builder field** in HL's schema. Whether a modified order keeps its builder fee is undocumented (shared library note). The policy enforces the builder on `order` only.
8. **Spot trading on thin verified tokens.** A spot token's mark comes from its own book. For a verified token with a
   thin book, an attacker controlling the app (A1) who also trades that token can move the mark with small trades and
   then have the frame buy from its asks at up to 10% above that mark. The 10%-of-24 h-volume cap per order (mainnet)
   and the user's own notional limits bound each order, not the day; wash trades can raise the volume figure at the
   cost of fees. The verified list is Hyperliquid's own "Strict" list, which includes thin tokens; tightening it (or an
   in-frame confirmation for spot buys) is a product decision. Unverified tokens are never signed.
9. **Fee trial and referral code.** `startFeeTrial` is in the baseline, so an attacker controlling the app (A1) can
   start the user's fee trial at a moment the user didn't choose (once per 90 days, per HL). The app explains the
   terms and asks before it sends the action; the frame cannot tell a real click from A1. `setReferrer` can only ever
   carry Kokoah's own code (A14), so A1 gains nothing by triggering it.
10. **Sub-accounts trust HL's answer.** Ownership comes from HL `subAccounts` over HTTPS; a compromised HL API is out of scope (it could also lie about prices). Whether HL charges the builder fee on a sub-account's orders with only the master's `approveBuilderFee`, or needs an approval for the sub-account itself, is **unverified** (checked on funded testnet by the coordinator). The frame puts the builder on every sub-account order either way; if HL refuses them, sub-account trading fails closed ("builder fee not approved") rather than trading without the fee.

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
| `vaultAddress` only for the master's own sub-accounts, read from HL by the frame | `core.ts` (shared `SubAccountOwnership`), `policy.ts` | `test/subaccounts.test.ts` |
| Frame-sourced prices and metadata | `market-data.ts` | `test/sign.test.ts` |
| Named agent, `valid_until` ≤ 30 days, never reused, expiry enforced | `core.ts` | `test/agent.test.ts`, `test/lifecycle.test.ts` |
| Nonces unique and increasing across tabs | `nonces.ts` | `test/nonce.test.ts` |
| Testnet default; mainnet needs `VITE_ALLOW_MAINNET_WRITES=true`; shared write guard | `config.ts`, shared `assertWriteAllowed` | `test/config.test.ts` |
| Link phone: the phone's own key, a matching code over that key, the link secret never stored, logged or echoed, no `approveAgent` on the phone | `core.ts` `createLinkedAgent`, shared `deviceLinkCode` | `test/link.test.ts`, shared `test/link.test.ts` |
| `setReferrer` only with the frame's own code, only while HL reports no referrer, once per key; `startFeeTrial` master-only; spot only on the pinned stablecoin pairs verified against the frame's own `spotMeta` | `core.ts` `runAccountAction`, `policy.ts`, `market-data.ts`, shared `evaluatePolicy` and `STABLECOIN_PAIRS` | `test/revenue.test.ts`, shared `accountActions.test.ts` and `spotPolicy.test.ts` |
| Spot trading off by default; on, only the pinned verified pairs confirmed against the frame's own `spotMeta`; no triggers, reduce-only or modify; master only; mainnet order ≤ 10% of 24 h volume | `policy.ts` (`applyUserLimits`, `evaluateFramePolicy`), `market-data.ts`, shared `VERIFIED_SPOT_PAIRS`, `verifiedSpotPairs`, `spotOrderVolumeProblem` | `test/spot.test.ts`, shared `spotPolicy.test.ts` and `spotPairs.test.ts` |

## 7. Link phone

"Link phone" lets a user who is signed in on a computer trade on a phone with no wallet app on the phone. The flow is
in [PROTOCOL.md §12](PROTOCOL.md#12-link-phone); the backend's side is in kokoah-backend `docs/API.md` ("Linked
devices", with the same threat model).

**What never travels:** the phone's frame creates the phone's **own** agent key (`createLinkedAgent`), stored like any
other key (`device` by default, `passkey` optional, non-extractable wrapping key in IndexedDB). No private key, seed or
signature is ever in a QR code, a link, a screenshot, the backend or a message to the app. The QR code carries only a
one-time pairing token and a link secret.

| Control | How |
|---|---|
| **Pairing token** | 32 random bytes, stored only as a SHA-256 hash, **one-time** (consumed atomically when the phone claims it), **expires 5 minutes** after it is created, carried in the **URL fragment** (`/link#t=…&k=…`) so it never appears in a request line, server or proxy log or `Referer`; the phone removes the fragment from the address bar at once. It is **bound to the computer's session and address**: only that session can see, approve or cancel the pairing, the phone gets a session for that address only, and the pairing dies with that session. One open pairing per account |
| **Relay protection** | The computer generates a 16-byte link secret that stays in the fragment and never reaches a server. Both devices show `deviceLinkCode` (6 digits, HMAC-SHA256 keyed with that secret over pairing id, account, agent address, agent name and expiry); the phone's code comes from the frame, computed over the key the frame actually holds. The computer refuses to build the `approveAgent` until the user confirms the codes match; "They don't match" cancels the pairing and is logged |
| **One readable approval** | The computer builds its own `approveAgent` for exactly the relayed address, name and expiry (≤ 30 days); the main wallet signs readable EIP-712. The phone's frame refuses to sign until `confirmAgent` finds that address under that name in `extraAgents` |
| **Linked-device session** | Issued only after the backend itself sees the approved agent on Hyperliquid, so it needs a main-wallet signature just like a SIWE sign-in. It expires with the key (at most 30 days, 7-day idle timeout) and is revoked with the device. It can trade through its own agent key and read and change what a normal session can, **except**: link further devices, remove other devices' keys, or change security settings (personal limits, sessions, devices). Withdrawals and sends need the main wallet, which the phone does not have |
| **Rate limits** | Every pairing endpoint is rate-limited per IP, and creating pairings also per account |
| **Audit trail** | Pairing started, cancelled (including "codes didn't match"), phone linked and device revoked are entries in the Security center's activity |
| **Revoke** | Each device on its own from the computer's Security center: the main wallet revokes that agent name on Hyperliquid and the backend revokes the device and its sessions. A phone can unlink itself (its session and its local key), but its agent stays on Hyperliquid until the computer revokes it or it expires |

Attacks and what stops them:

| Attacker | Can | Stopped / limited by | Residual |
|---|---|---|---|
| Someone who photographs or intercepts the QR code | Claim the token first and get their key shown on the computer | One-time token: the user's phone says the link was already used and shows no code, and the attacker's code is not on the user's phone; 5-minute expiry | A user who approves without comparing the codes |
| A compromised backend or relay (without the app) | Swap in its own agent address, name or expiry | The link secret is not on the server, so it can't produce a matching code | None for key substitution; it can still refuse service |
| A phishing QR for the attacker's account | Link the victim's phone to the attacker's account | The phone shows the account it is joining and the computer that asked, before creating a key | The victim ignores the account shown |
| A stolen linked phone | Trade within the frame's policy and the user's limits | No withdrawals or sends (no main wallet); can't link devices, revoke others or loosen limits; revoke it from the computer | Trading losses until revoked or expired (≤ 30 days) |
| XSS in the app (A1) on either device | As A1 | Unchanged: the key stays in the frame. On the computer, A1 could already ask the main wallet for any approval | As A1 |
