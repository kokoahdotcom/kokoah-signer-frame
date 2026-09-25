# Kokoah signer frame protocol, v1

This is the contract between the Kokoah web app (the **parent**, `kokoah-frontend`) and the **signer frame** (this repo): a separately deployed page on its own origin (for example `https://signer.kokoah.example/`) that the app embeds in an iframe. The frame holds the browser trading key (a Hyperliquid named agent, `kokoah-web`). It checks its own policy, signs trading actions and submits them to Hyperliquid itself. The app never sees the key.

- The types are in [`src/protocol/index.ts`](../src/protocol/index.ts). They ship as `@kokoah/signer-frame/protocol` and are re-exported by `@kokoah/signer-frame/client`. If this document and that file disagree, the file wins; please report the mismatch.
- Use [`KokoahSignerClient`](../src/client/index.ts) rather than raw `postMessage`. It implements everything below (see [§3](#3-the-client)).
- Protocol version: **1**. Frame version: `hello.frameVersion`.

Contents:
1. [Transport and envelopes](#1-transport-and-envelopes)
2. [Lifecycle](#2-lifecycle)
3. [The client](#3-the-client)
4. [Methods](#4-methods)
5. [Events](#5-events)
6. [Errors](#6-errors)
7. [Policy](#7-policy)
8. [Key storage and passkeys](#8-key-storage-and-passkeys)
9. [Several tabs](#9-several-tabs)
10. [Rules for the parent](#10-rules-for-the-parent)
11. [Versioning](#11-versioning)
12. [Link phone](#12-link-phone)

---

## 1. Transport and envelopes

All messages are plain, structured-clone-safe JSON-like objects sent with `window.postMessage`.

| Direction | Envelope |
|---|---|
| parent → frame | `{ protocol: "kokoah-signer", version: 1, kind: "request", id, method, params }` |
| frame → parent | `{ protocol: "kokoah-signer", version: 1, kind: "response", id, method, ok: true, result }` |
| frame → parent | `{ protocol: "kokoah-signer", version: 1, kind: "response", id, method, ok: false, error }` |
| frame → parent | `{ protocol: "kokoah-signer", version: 1, kind: "event", event, data }` |

**`id`** is 1–64 characters of `A–Z a–z 0–9 _ . : -`, unique per request, and echoed in the response. It must not be 64 hex digits (see the outgoing guard below); such a request is dropped. Responses can arrive in any order.

**What the frame accepts.** The frame processes a message only when all of these hold:
- `event.source === window.parent`;
- `event.origin` is **exactly** one of the origins in the frame's build-time allowlist (`VITE_ALLOWED_PARENT_ORIGINS`, e.g. `https://app.kokoah.example`);
- the message carries the `protocol`/`version` header.

Anything else (other windows, other origins, wallet-extension chatter) is **dropped silently** and counted in `status.metrics.ignoredMessages`.

**Replies** go to that exact origin with `postMessage(msg, origin)`, never `"*"`. Events go to the origin that completed `hello`.

**Validation.** Every request is validated strictly before any work is done:
- the serialized message may be at most **65,536** characters (`PAYLOAD_TOO_LARGE`);
- params are exact schemas: unknown keys, wrong types and out-of-range values give `INVALID_REQUEST` with `details.issues`;
- intents are validated with `@kokoah/shared` `safeParseActionIntent` (strict; `INVALID_INTENT`).

A request whose `id` can be read gets an error response. One whose header can't be read is dropped.

**Outgoing guard.** Before posting, the frame checks that the message contains no binary data, no key objects and no 64-hex-digit value (the shape of a private key or of a signature's `r`/`s`). A message that fails is replaced by an `INTERNAL_ERROR` response. 64-hex values inside data relayed from Hyperliquid (for example a transaction hash) are replaced with `[redacted]`. Strings the frame echoes back from the parent (`id`, `requestId`, `setLimits.allowedCoins`) are validated so they can't contain one.

## 2. Lifecycle

```
parent                                     frame (iframe, other origin)
  │  <iframe src=frameUrl allow="publickey-credentials-get; publickey-credentials-create">
  │ ◀──────────── event ready ────────────  (posted to each allowed origin; the browser delivers only the matching one)
  │ ── request hello ───────────────────▶
  │ ◀── response hello {network, builder…}  (the frame now sends events to this origin)
  │ ── getStatus / createAgent / … ─────▶
  │ ◀── events: statusChanged, keyExpiringSoon, keyExpired, promptChanged
```

- Until `hello` succeeds, every other method answers `NOT_CONNECTED`.
- `hello` may be repeated; it is idempotent.
- The frame buffers messages that arrive while it is still starting, so sending `hello` right after the iframe's `load` event is safe. `KokoahSignerClient` also retries `hello`.
- The frame posts `ready` before it answers any `hello`. A `ready` **after** a completed handshake therefore means the iframe reloaded: the new frame document has forgotten the handshake (every method answers `NOT_CONNECTED`), user limits, theme, remembered `requestId`s and an unlocked passkey key. `KokoahSignerClient` then re-runs `hello` with the same params and emits its own `reconnected` event ([§3](#3-the-client)); re-apply `setLimits` and `setTheme` there.
- After `hello`, the frame immediately emits `keyExpiringSoon` or `keyExpired` if they apply. These are emitted once per key per frame load, so **register listeners before calling `hello`** (`client.on()` works before the handshake). The same state is in `hello.status` and `getStatus` (`expiringSoon`, `expired`, `expiresAt`): an app that subscribed late reads it from there.

## 3. The client

```ts
import { KokoahSignerClient, SignerRequestError } from "@kokoah/signer-frame/client";

const signer = new KokoahSignerClient({ frameUrl: import.meta.env.VITE_SIGNER_FRAME_URL }); // creates a hidden iframe
// Subscribe first: the frame emits keyExpiringSoon / keyExpired right after hello.
signer.on("statusChanged", (status) => store.setSignerStatus(status));
signer.on("keyExpiringSoon", () => ui.showRenewBanner());
signer.on("promptChanged", ({ visible, kind }) => ui.setSignerPromptOpen(visible, kind));
const hello = await signer.hello();
if (hello.network !== config.network || hello.builder.address !== publicConfig.builder.address
    || hello.builder.feeTenthsBps !== publicConfig.builder.feeTenthsBps) {
  // refuse to trade: configuration error
}
store.setSignerStatus(hello.status);                 // includes expiringSoon / expired
```

| Member | Notes |
|---|---|
| `new KokoahSignerClient(options)` | `frameUrl` (required; https, or http for localhost). Optional: `container` (default `document.body`), `requestTimeoutMs` (30 s), `interactiveTimeoutMs` (300 s, used by `unlock` and passkey `createAgent`), `helloTimeoutMs` (15 s), `autoShowOnPrompt` (true), `iframeTitle`, `clientInfo`. |
| `iframe` | The `<iframe data-kokoah-signer>`. Hidden (`hidden` attribute) except while the frame shows a prompt. Style it in the app. |
| `frameOrigin` | The only origin the client sends to and accepts messages from. |
| `hello(params?)` | Handshake; cached. Called automatically before the first other request. Repeated automatically, with the same params, when the frame reloads (see `reconnected`). |
| `getStatus()`, `createAgent(p)`, `confirmAgent(p?)`, `unlock()`, `lock()`, `signAndSubmit(p)`, `setLimits(p)`, `revoke(p?)`, `setTheme(p)` | One typed method per protocol method. |
| `request(method, params, timeoutMs?)` | Low-level typed request. |
| `on(event, listener)` → unsubscribe; `off(event, listener)` | Events of [§5](#5-events), plus the client's `reconnected`. Works before `hello()`: subscribe first, because the frame emits `keyExpiringSoon`/`keyExpired` right after the handshake. |
| `setFrameVisible(visible)` | Manual control of the iframe's visibility. |
| `connection` | The last `hello` result, or `null` (before the handshake and while reconnecting). |
| `destroy()` | Removes the iframe; pending requests fail with `DESTROYED`. |

**Reconnecting.** When the frame reloads (a `ready` after a completed handshake, or a `NOT_CONNECTED` answer), the client re-runs `hello` with the params of the first `hello` and, once it succeeds, emits the client-side event **`reconnected`** with the new `HelloResult` (`ClientEventData["reconnected"]`). The frame can't send this event; it isn't part of the wire protocol.

```ts
signer.on("reconnected", (hello) => {
  if (!helloMatchesConfig(hello)) blockTrading();      // same checks as after the first hello
  void signer.setLimits(userLimits);                   // the new frame runs the baseline policy until then
  void signer.setTheme(theme);
  store.setSignerStatus(hello.status);                 // e.g. a passkey key is locked again
});
```

- Requests made while reconnecting wait for the new handshake. They are sent **after** the requests that `reconnected` listeners start synchronously, so limits re-applied in the listener are in place first.
- A request that the reloaded frame answers with `NOT_CONNECTED` (it did nothing for it) is sent once more after the new handshake.
- Requests that were in flight in the old frame document get no answer (`TIMEOUT`). For `signAndSubmit`, the new frame doesn't know their `requestId`: query `orderStatus` by cloid.
- If the new handshake fails, the next request retries it; `reconnected` is emitted when one succeeds.

**Errors.** Every failure is a `SignerRequestError` with:
- `code`: a `SignerErrorCode` ([§6](#6-errors)), or one of the client codes `TIMEOUT`, `DESTROYED`, `HANDSHAKE_FAILED`;
- `message`;
- `retryable`;
- `details`;
- `method`.

**Iframe attributes set by the client:**
- `allow="publickey-credentials-get; publickey-credentials-create"`, which is needed for passkeys;
- `referrerpolicy="no-referrer"`;
- `title`;
- `hidden`.

The client sets no `sandbox`. If the app adds one, it must include `allow-scripts allow-same-origin`; without `allow-same-origin` the frame loses its origin and its storage. Passkeys in sandboxed iframes are unverified.

**Showing the prompt.** When the frame needs a click (passkey ceremonies), it emits `promptChanged {visible: true}`. The client then removes `hidden` from the iframe and sets `data-kokoah-signer-prompt="<kind>"`. Style that state as a modal, for example:

```css
iframe[data-kokoah-signer] { position: fixed; inset: 0; margin: auto; width: min(420px, 92vw); height: 240px; border: 0; border-radius: 12px; z-index: 1000; }
```

The iframe must be visible, on top and clickable. Don't cover it or make it transparent.

## 4. Methods

In the examples, `→` is the `params` the parent sends and `←` is the `result` it receives. Addresses are lower-case hex.

### `hello`

→ `{ "protocolVersion": 1, "client": { "name": "kokoah-frontend", "version": "1.4.2" } }` (`client` is optional)

← 
```json
{
  "protocolVersion": 1,
  "frameVersion": "0.1.0",
  "frameOrigin": "https://signer.kokoah.example",
  "network": "testnet",
  "mainnetWritesEnabled": false,
  "capabilities": {
    "storageModes": ["passkey", "device", "session"],
    "passkey": { "available": true, "prf": "supported" },
    "webLocks": true,
    "indexedDB": true,
    "broadcastChannel": true
  },
  "builder": { "address": "0x…builder", "feeTenthsBps": 25 },
  "status": { "hasKey": true, "keyState": "active", "expiringSoon": true, "expired": false, "…": "SignerStatus, see getStatus" },
  "limits": { "maxMessageBytes": 65536, "minValidForDays": 1, "maxValidForDays": 30, "expiresAfterMs": 15000, "maxAgentNameLength": 16 }
}
```

- **Required check:** compare `network` with the app's network and `builder` with `public-config`. **Refuse to trade on any mismatch** (FRONTEND_IMPLEMENTATION §B3.1, §B6.3).
- `capabilities.passkey.available` is false when WebAuthn is missing or blocked in the frame, with a `reason`, for example `"WebAuthn is blocked by Permissions-Policy in the signer frame"`. `prf` is `"unknown"` when the browser can't say without a ceremony.
- `storageModes` lists what can work here. Offer only those, in that order of preference.
- `status` is the frame's `SignerStatus` at the handshake (see `getStatus`), including the key's expiry state.
- Errors: `UNSUPPORTED_VERSION`.

### `getStatus`

→ `{}`

← `SignerStatus`:
```json
{
  "hasKey": true,
  "keyState": "active",
  "agentAddress": "0x9f…agent",
  "agentName": "kokoah-web",
  "userAddress": "0x11…user",
  "validUntil": 1792670400000,
  "expiresAt": 1792670385000,
  "expiringSoon": false,
  "expired": false,
  "storageMode": "device",
  "locked": false,
  "network": "testnet",
  "mainnetWritesEnabled": false,
  "clockOffsetMs": -120,
  "policy": { "…": "see §7" },
  "metrics": { "ignoredMessages": 0, "rejectedRequests": 1, "policyDenials": 1, "submitted": 12 }
}
```

`keyState` values:

| `keyState` | Meaning | Parent action |
|---|---|---|
| `none` | No key on this device | "Enable trading" (J3) |
| `pending` | Key created, not yet confirmed on HL | Get `approveAgent` signed and posted, then `confirmAgent` |
| `active` | Confirmed and not expired | Trade (if `locked`, `unlock` first) |
| `expired` | At or after `validUntil − 15 s` | Renew: `createAgent({ replaceExisting: true })` |

- `locked` is true when a key exists but isn't in memory: a passkey key after a reload, or any stored key after `lock`.
- `expiresAt` is when the frame stops signing with the key: `validUntil − 15 s` (the `expiresAfter` window), on the frame's HL-corrected clock. `null` without a key.
- `expiringSoon` is true when the key expires within 7 days and hasn't expired: show the renew banner. `expired` is true when `keyState` is `expired`. They are the same conditions as the `keyExpiringSoon` and `keyExpired` events, which fire only once per key; use these fields as the source of truth.
- `clockOffsetMs` is the HL server time minus the device time, measured by the frame with `exchangeStatus`. Show a clock-skew warning when it is large (spec §22.3).

### `createAgent`

Creates a **fresh** key (never reused; the frame refuses an address it has generated before) for a **named** agent with an expiry. Kokoah never uses the unnamed agent slot, because Hyperliquid's own app uses it.

→
```json
{ "userAddress": "0x11…user", "validForDays": 30, "storageMode": "passkey",
  "agentName": "kokoah-web", "signatureChainId": "0xa4b1", "replaceExisting": false }
```

| Param | Rules |
|---|---|
| `userAddress` | Master account (the main wallet), 20-byte hex |
| `validForDays` | Integer 1–30 |
| `storageMode` | `passkey` \| `device` \| `session` ([§8](#8-key-storage-and-passkeys)). `device` is the recommended default: it survives reloads with no prompt. Offer `passkey` as an opt-in upgrade (`setStorageMode`) |
| `agentName` | Optional, 1–16 of `A–Z a–z 0–9 . _ -`, not containing `valid_until`. Default `kokoah-web`. Hyperliquid allows 3 named agents per account, and approving a name again replaces that agent: give each device its own name (e.g. `kokoah-a1b2`) so enabling a second device doesn't cut off the first |
| `signatureChainId` | Optional hex chain id of the main wallet's current chain. Default: the network's default (`0x66eee` testnet, `0xa4b1` mainnet). Browser wallets usually want their connected chain |
| `replaceExisting` | Required (`true`) when a non-expired key exists. The old key is **wiped** when the new one is created; trading resumes after the new one is confirmed |

←
```json
{
  "agentAddress": "0x9f…agent",
  "agentName": "kokoah-web",
  "validUntil": 1792670400000,
  "storageMode": "passkey",
  "requestedStorageMode": "passkey",
  "keyState": "pending",
  "approveAgent": {
    "action": { "type": "approveAgent", "signatureChainId": "0xa4b1", "hyperliquidChain": "Testnet",
                "agentAddress": "0x9f…agent", "agentName": "kokoah-web valid_until 1792670400000", "nonce": 1790078400000 },
    "typedData": { "domain": { "name": "HyperliquidSignTransaction", "version": "1", "chainId": 42161, "verifyingContract": "0x0000000000000000000000000000000000000000" },
                   "types": { "HyperliquidTransaction:ApproveAgent": [ { "name": "hyperliquidChain", "type": "string" }, { "name": "agentAddress", "type": "address" }, { "name": "agentName", "type": "string" }, { "name": "nonce", "type": "uint64" } ] },
                   "primaryType": "HyperliquidTransaction:ApproveAgent",
                   "message": { "hyperliquidChain": "Testnet", "agentAddress": "0x9f…agent", "agentName": "kokoah-web valid_until 1792670400000", "nonce": 1790078400000 } },
    "nonce": 1790078400000
  }
}
```

- `approveAgent` is exactly `@kokoah/shared` `buildApproveAgent(...)`.
- `validUntil` is `now + validForDays` days on the frame's HL-corrected clock.

**Parent flow (J3):**
1. Show the key's address, name, expiry and permissions (spec §4.4).
2. Sign `approveAgent.typedData` with the main wallet (`signTypedData`).
3. Post `buildExchangeRequest({ network, action: approveAgent.action, nonce: approveAgent.nonce, signature })` to HL `/exchange`.
4. Call `confirmAgent`.

- `storageFallbackReason` is set when `passkey` was requested but `device` was used (WebAuthn blocked, no PRF support), or when `device`/`passkey` fell back to `session` (no IndexedDB). Tell the user.
- With `storageMode: "passkey"`, the frame shows its prompt and waits for a click inside it ([§8](#8-key-storage-and-passkeys)). The response arrives after the ceremony, or with `USER_CANCELLED`/`USER_TIMEOUT` (120 s).
- Errors:
  - `KEY_EXISTS` (`details.agentAddress`, `details.keyState`);
  - `USER_CANCELLED`, `USER_TIMEOUT`, `PROMPT_BUSY`;
  - `PASSKEY_FAILED`;
  - `STORAGE_FAILED`;
  - `MAINNET_WRITES_DISABLED`;
  - `INVALID_REQUEST`.

### `createLinkedAgent`

"Link phone" ([§12](#12-link-phone)): creates this device's **own** fresh key for an account whose main wallet is on
**another** device (the computer). It is the same key lifecycle as `createAgent` (fresh address, stored `pending`,
same storage modes and fallbacks, `replaceExisting`), with two differences: the agent name comes from the pairing,
and instead of `approveAgent` typed data the frame returns the 6-digit **matching code** for the key it holds.

→
```json
{ "userAddress": "0x11…user", "agentName": "kokoah-ph12", "validForDays": 30, "storageMode": "device",
  "replaceExisting": false,
  "link": { "pairingId": "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f", "secret": "AAECAwQFBgcICQoLDA0ODw" } }
```

| Param | Rules |
|---|---|
| `userAddress` | The account the backend's pairing is bound to, 20-byte hex |
| `agentName` | **Required**, 1–16 of `A–Z a–z 0–9 . _ -`, no `valid_until`: the name the computer will approve (it picked a free slot, or the slot the user chose to replace) |
| `validForDays` | Integer 1–30 |
| `storageMode` | As in `createAgent` |
| `replaceExisting` | As in `createAgent` |
| `link.pairingId` | The backend's pairing id, a lowercase UUID |
| `link.secret` | The link secret from the QR code's URL fragment: 16 bytes as base64url (22 characters). Used for the code only; never stored, logged or echoed |

←
```json
{ "agentAddress": "0x9f…agent", "agentName": "kokoah-ph12", "validUntil": 1792670400000,
  "storageMode": "device", "requestedStorageMode": "device", "keyState": "pending",
  "pairingId": "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f", "matchCode": "482913" }
```

- `matchCode` is `@kokoah/shared/link` `deviceLinkCode({ secret, pairingId, userAddress, agentAddress, agentName,
  validUntil })`: HMAC-SHA256 keyed with the link secret over those fields, 6 digits. The computer computes the same
  code from the fields the backend relays; if anyone swapped the agent address (or the name or expiry), the codes
  differ.
- No `approveAgent` is returned: there is no main wallet on this device. The computer builds its own `approveAgent`
  for exactly `agentAddress`, `agentName` and `validUntil`, and the phone calls `confirmAgent` once the backend says
  it was approved.
- The key refuses to sign (`KEY_PENDING`) until `confirmAgent` finds it on Hyperliquid under `userAddress` with that
  name.
- Errors: as `createAgent`; `INVALID_REQUEST` for a missing name or a malformed `link`.

### `confirmAgent`

The frame itself asks Hyperliquid (`info extraAgents` for `userAddress`) whether the agent is registered, and marks the key `active` when it is.

→ `{ "timeoutMs": 20000 }` (optional, 0–60,000. The frame polls every second until then. Default 0: check once.)

← `SignerStatus` with `keyState: "active"`.

- Idempotent: an `active` key returns the status at once.
- The frame keeps the **earlier** of its own `validUntil` and the one HL reports. It never signs past the expiry it asked for.
- Errors:
  - `AGENT_NOT_FOUND` (retryable: not listed yet);
  - `AGENT_MISMATCH` (listed under another name);
  - `HL_UNAVAILABLE`;
  - `NO_KEY`;
  - `KEY_EXPIRED`;
  - `KEY_CHANGED`.

### `unlock`

→ `{}`

← `SignerStatus` with `locked: false`.

- `device`: decrypts silently.
- `passkey`: shows the prompt, then runs a WebAuthn assertion with PRF inside the frame. Keep the iframe visible while `promptChanged.visible` is true. If the user dismisses the OS dialog, the prompt stays so they can retry or cancel.
- Errors:
  - `NO_KEY`;
  - `UNLOCK_FAILED` (the record can't be decrypted: revoke and create a new key);
  - `PASSKEY_UNAVAILABLE`, `PASSKEY_FAILED`;
  - `USER_CANCELLED`, `USER_TIMEOUT`, `PROMPT_BUSY`.

### `lock`

→ `{}`

← `SignerStatus`.

- Drops the key from memory. Stored keys stay stored.
- A `session` key is **discarded** (it can't be unlocked again).
- An in-flight `signAndSubmit` that hasn't signed yet fails with `KEY_CHANGED`.

### `setStorageMode`

Changes how the **existing** stored key is protected, with **no new `approveAgent`** (same key, same agent, no wallet
signature). This is how the app offers passkey protection as an optional upgrade after enabling trading with `device`.

→ `{ "to": "passkey" }` or `{ "to": "device" }`

← `SignerStatus` with the new `storageMode`.

- `device` → `passkey`: the frame decrypts the stored key with its device key, then shows its passkey prompt (one click,
  one biometric), creates a passkey and re-encrypts the key under its PRF secret. The device-key record is replaced. A
  key that is unlocked in this tab stays unlocked; after a reload it is locked until `unlock`.
- `passkey` → `device`: the frame shows its prompt ("Remove passkey protection"), decrypts the key with the passkey and
  re-encrypts it under a new non-extractable device key. After a reload it unlocks silently.
- The secret is always read from the stored ciphertext, never from memory, and wiped after use. Other tabs get
  `statusChanged` with the new mode.
- Same mode: returns the status at once. Keep the iframe visible while `promptChanged.visible` is true.
- Errors:
  - `NO_KEY` (no key, or its stored copy is gone);
  - `STORAGE_FAILED` (a `session` key, or no IndexedDB: create a new key instead);
  - `PASSKEY_UNAVAILABLE` (WebAuthn blocked or no PRF), `PASSKEY_FAILED`, `UNLOCK_FAILED`;
  - `USER_CANCELLED`, `USER_TIMEOUT`, `PROMPT_BUSY` (nothing changed);
  - `KEY_CHANGED`.

### `signAndSubmit`

→
```json
{
  "requestId": "4f7c1a52-0b8e-4a3e-9d0a-2b7f5e1c9d10",
  "intent": { "kind": "order", "coin": "ETH", "side": "buy", "orderType": "limit", "size": "0.5", "price": "2500.5",
              "takeProfit": { "triggerPrice": "2700" }, "stopLoss": { "triggerPrice": "2400" }, "origin": "manual" }
}
```

`intent` is a `@kokoah/shared` `ActionIntentInput`:
- `order`;
- `cancel`;
- `modify`;
- `updateLeverage`;
- `updateIsolatedMargin`;
- `scheduleCancel`;
- `noop`.

`origin` must be `manual` or `ai_ticket`. Guardian intents are signed by the server, never by this frame.

Or an **account action** (`@kokoah/shared/actions` `AccountIntentInput`), for the key's master account only, with no
other fields (a code, a `vaultAddress` or another origin is `INVALID_INTENT`):
- `{ "kind": "setReferrer", "origin": "manual" }` sets Kokoah's Hyperliquid referral code. The code is the frame's own
  build value (`VITE_HL_REFERRAL_CODE`, shown as `status.policy.referralCode`), never the parent's. The frame first
  reads HL `{"type":"referral","user":<master>}` itself: a referrer already set is `POLICY_DENIED`
  (`REFERRER_ACTION_DENIED`), an unreadable answer `MARKET_DATA_UNAVAILABLE`. It signs at most **once per key**
  (recorded in IndexedDB with the nonce, so reloads and other tabs see it). No code configured:
  `REFERRER_ACTION_DENIED`.
- `{ "kind": "startFeeTrial", "origin": "manual" }` starts Hyperliquid's fee trial (`{"type":"startFeeTrial"}`).

Both results have `cloids: []`; they count toward neither the order rate nor the notional limits.

**Convert stablecoins** is an ordinary `order` intent on one of the network's pinned stablecoin/USDC pairs
(`status.policy.spotCoins`, e.g. `@166` USDT0/USDC on mainnet), for the master account: a market (or IOC limit)
order, one leg, no TP/SL, not reduce-only. The frame reads `spotMetaAndAssetCtxs` itself and signs only when the pair,
its token indices, names and token ids match the pins exactly (else `UNSUPPORTED_MARKET`). Buys carry no builder
(Hyperliquid charges builder fees on spot sells only); sells carry the configured builder. Every other spot market is
`UNSUPPORTED_MARKET`.

```jsonc
{ "kind": "order", "coin": "@166", "side": "buy", "orderType": "market", "size": "25", "slippageBps": 50, "origin": "manual" }
```

`intent.vaultAddress` trades for a **sub-account** ("strategy account") of the key's master. The frame signs it only
when HL's own `{"type":"subAccounts","user":<master>}` lists that address with `master` equal to the key's master
(read by the frame itself, cached 30 s, re-read on a miss once the list is 5 s old). Anything else — a vault the master
leads, another user's sub-account, the master's own address — is `POLICY_DENIED` with `VAULT_NOT_ALLOWED`; when HL's
list can't be read nothing is signed and the answer is `MARKET_DATA_UNAVAILABLE` (retryable).

**The parent never supplies prices, registries, builder or nonce.** There is no field for them, and unknown fields are rejected. The frame then does the following, in order:
1. Validates the intent (`safeParseActionIntent`). With `vaultAddress`, checks on HL that it is one of the master's
   sub-accounts (above).
2. Fetches its **own** market metadata and mark/mid prices from HL `/info` (`metaAndAssetCtxs`, per perp dex; `perpDexs` for HIP-3; cached about 3 s). It syncs its clock with `exchangeStatus`.
3. Compiles with `compileAction`, using the configured builder `{b, f}`. Market orders become IOC limits at the frame's own mid ± `slippageBps`.
4. Takes the per-agent Web Lock (serialized across tabs).
5. Evaluates the policy ([§7](#7-policy)) of the account the intent is for, on the compiled action and again on the
   exact wire action.
6. Reserves a nonce, `max(now + clockOffset, last + 1)`, persisted in IndexedDB. One key signs for every account, so
   nonces stay unique and increasing across accounts (HL tracks nonces per signer).
7. Signs with `expiresAfter = now + 15 s` (and `vaultAddress` for a sub-account, inside the signed hash).
8. Submits to HL `/exchange` itself.

←
```json
{
  "requestId": "4f7c1a52-0b8e-4a3e-9d0a-2b7f5e1c9d10",
  "status": "ok",
  "actionType": "order",
  "nonce": 1790078401234,
  "expiresAfter": 1790078416234,
  "cloids": ["0x6b6f0101…parent", "0x6b6f0101…tp", "0x6b6f0101…sl"],
  "exchangeResponse": { "status": "ok", "response": { "type": "order", "data": { "statuses": [ { "resting": { "oid": 77738308 } }, "waitingForFill", "waitingForFill" ] } } },
  "outcome": { "ok": true, "type": "order", "statuses": [ { "kind": "resting", "oid": 77738308 }, { "kind": "waitingForFill" }, { "kind": "waitingForFill" } ] },
  "replayed": false
}
```

| `status` | Meaning | What the parent does |
|---|---|---|
| `ok` | HL accepted the request. Per-order results (including per-order errors such as `MIN_TRADE_NOTIONAL`) are in `outcome.statuses`, mapped by shared `parseExchangeResponse` | Show placed / filled / per-order rejection; final state comes from the WebSocket |
| `rejected` | HL rejected the whole request; `error` is shared `mapHlError` output (e.g. `UNKNOWN_SIGNER`, `RATE_LIMITED`, `INVALID_NONCE`, `ACTION_EXPIRED`) | Show `error.message`. For `UNKNOWN_SIGNER`, re-check the key (`confirmAgent`) |
| `unknown` | The request may or may not have reached HL (timeout, network error, HTTP 5xx). `error.code` is `OUTCOME_UNKNOWN` | Show "Checking…" and query HL `orderStatus` by **cloid** until resolved. **Never resubmit with a new `requestId`** |

- **`marketOrder`** (market orders only): `{ midPrice, limitPrice, slippageBps }`. These are the mid the frame fetched and the IOC price it signed. Show them in the result:
  ```json
  "marketOrder": { "midPrice": "2500", "limitPrice": "2512.5", "slippageBps": 50 }
  ```
- **Idempotency.** `requestId` (1–128 of `A–Z a–z 0–9 _ . : -`) is the idempotency key for the frame's session. It must not contain a run of 64 hex digits (`INVALID_REQUEST`, before anything is signed): the id is echoed in the result, and the outgoing guard would otherwise replace the answer to an order that already reached Hyperliquid with `INTERNAL_ERROR`. A UUID (`crypto.randomUUID()`) is fine.
  - The same `requestId` with the same intent returns the first result with `replayed: true`, while in flight or after. The frame never signs twice for one id.
  - The same `requestId` with a different intent gives `REQUEST_ID_REUSED`.
  - A request refused **before** it was sent (validation, policy, locked, market data) doesn't use up its id; the parent may retry it.
  - After a client-side `TIMEOUT`, call again with the **same** `requestId`: you get the real result.
  - The frame remembers the last 1,000 ids until it reloads. Across reloads, use `orderStatus` by cloid.
- Errors:
  - `NO_KEY`, `KEY_PENDING`, `KEY_EXPIRED`, `LOCKED`, `KEY_CHANGED`;
  - `INVALID_INTENT` (`details.issues`);
  - `UNSUPPORTED_MARKET` (outcome markets, and every spot market except the pinned stablecoin pairs: the frame trades
    perps, HIP-3 perps and stablecoin conversions only);
  - `COMPILE_FAILED` (`details.compileCode`: `UNKNOWN_MARKET`, `DELISTED_MARKET`, `SIZE_PRECISION`, `PRICE_PRECISION`, `CROSS_NOT_ALLOWED`, `MARGIN_PRECISION`, `SCHEDULE_TOO_SOON`, …; the message includes the rounded suggestion);
  - `POLICY_DENIED` (`details.violations`: every `{ code, message }` from shared `evaluatePolicy`, plus the frame's own rules);
  - `MARKET_DATA_UNAVAILABLE` (retryable);
  - `SIGNER_BUSY` (retryable; the signing lock wasn't free within 20 s);
  - `REQUEST_ID_REUSED`;
  - `MAINNET_WRITES_DISABLED`;
  - `STORAGE_FAILED`.

**Intent examples (J5):**

```jsonc
// Close all (market, reduce-only)
{ "kind": "order", "coin": "BTC", "side": "sell", "orderType": "market", "size": "0.01", "reduceOnly": true, "slippageBps": 100, "origin": "manual" }
// Position TP/SL
{ "kind": "order", "coin": "BTC", "side": "sell", "orderType": "stopMarket", "size": "0.01", "triggerPrice": "95000", "reduceOnly": true, "positionTpsl": true, "origin": "manual" }
// Edit an order
{ "kind": "modify", "target": { "oid": 77738308 }, "order": { "coin": "ETH", "side": "buy", "orderType": "limit", "size": "0.5", "price": "2490" }, "origin": "manual" }
// Cancel by cloid
{ "kind": "cancel", "cancels": [ { "coin": "ETH", "cloid": "0x6b6f0101000000000000000000000001" } ], "origin": "manual" }
// Leverage / isolated margin / dead-man's switch / burn a nonce
{ "kind": "updateLeverage", "coin": "xyz:SP500", "leverage": 5, "marginMode": "isolated", "origin": "manual" }
{ "kind": "updateIsolatedMargin", "coin": "ETH", "amountUsd": "-25", "origin": "manual" }
{ "kind": "scheduleCancel", "time": 1790078460000, "origin": "manual" }
{ "kind": "noop", "origin": "manual" }
```

Sizes and prices must already be valid for the market (shared `formatSize`, `checkPrice`). The frame rejects them rather than sign a different number than the user saw.

### `setLimits`

Personal limits (Settings, §B11.4). They can only **tighten** the frame's baseline, and they **replace** the previous limits of that account (`{}` resets the master to the baseline). Loosening anything rejects the whole call and changes nothing.

→ `{ "maxOrderNotionalUsd": 5000, "maxDailyNotionalUsd": 50000, "maxLeverage": 10, "requireStopLossForNewEntries": true }`

Limits are kept **per account**. Without `account` (or with the key's master) the call sets the master's limits. With a
sub-account's address it sets that sub-account's own limits, which replace the master's for it:
`{ "account": "0x…sub", "maxOrderNotionalUsd": 1000 }`. `{ "account": "0x…sub" }` alone removes them, so the
sub-account uses the master's limits again. A sub-account without its own limits always uses the master's. At most 64
sub-accounts can have their own limits. Setting limits for an address grants nothing: `vaultAddress` is still checked
on HL at signing.

← `{ "policy": PolicySummary }` ([§7](#7-policy)). The frame also emits `statusChanged`.

| Field | Constraint (the baseline is in §7) |
|---|---|
| `maxOrderNotionalUsd`, `maxDailyNotionalUsd`, `maxOrdersPerMinute`, `priceBandPct` | ≤ baseline |
| `maxLeverage` | Integer ≥ 1. Effective cap per market = `min(value, market maximum)`. For new orders the frame reads the account's current leverage (`activeAssetData`) |
| `allowedCoins` | Non-empty list of HL coin names (a subset of the baseline) |
| `requireStopLossForNewEntries` | `true` tightens; `false` is a no-op |
| `allowedActionTypes` | A subset of the baseline action types |
| `account` | Optional sub-account address (see above) |

- User limits live in the frame's memory: re-apply them (the master's and every sub-account's) after `hello` on every load and on `reconnected` (store them in settings).
- Counting: orders per minute are counted per key across all accounts. Daily notional is counted per account for its
  own `maxDailyNotionalUsd`, and per key across all accounts for the baseline $25M.
- Errors:
  - `LIMIT_LOOSENING_REJECTED`, with `details.fields` listing the fields that would loosen;
  - `INVALID_REQUEST`.

### `revoke`

→ `{ "agentName": "kokoah-web", "signatureChainId": "0xa4b1" }` (both optional; the name defaults to this device's key's name, else `kokoah-web`)

←
```json
{
  "wiped": true,
  "agentAddress": "0x9f…agent",
  "agentName": "kokoah-web",
  "revokeAgent": { "action": { "type": "approveAgent", "…": "…", "agentAddress": "0x0000000000000000000000000000000000000000", "agentName": "kokoah-web" }, "typedData": { "…": "…" }, "nonce": 1790078500000 },
  "status": { "hasKey": false, "keyState": "none", "…": "…" }
}
```

- The local key (memory and storage) is wiped **immediately**, in every tab of this browser, if its name matches `agentName`.
- If its stored copy can't be deleted (IndexedDB failure), the result has `wiped: false`, the key's `agentAddress` and a `wipeError`. The key is out of memory in this tab, but a reload would bring it back. Post `revokeAgent` anyway (Hyperliquid then rejects the key) and call `revoke` again: a later `revoke` deletes a stored copy with that name even when it is no longer in memory.
- `revokeAgent` is shared `buildRevokeAgent`: the main wallet signs it and the parent posts it with `buildExchangeRequest`. Until it is posted, the agent is still registered on HL, but nobody has its key any more.
- Revoking another name (for example another device's `kokoah-pwa`) returns its typed data and leaves this device's key alone (`wiped: false`).

### `setTheme`

→ `{ "variables": { "--ks-accent": "#3ecf8e", "--ks-radius": "8px", "--ks-font": "Inter, system-ui, sans-serif" }, "colorScheme": "dark" }`

← `{ "applied": ["--ks-accent", "--ks-radius", "--ks-font"] }`

Allowed variables:
- `--ks-bg`, `--ks-fg`, `--ks-muted`, `--ks-accent`, `--ks-accent-fg`, `--ks-danger`, `--ks-border`, `--ks-focus`: colors (hex, `rgb()`, `hsl()`, `oklch()`, named);
- `--ks-radius`, `--ks-font-size`: a length;
- `--ks-padding`: 1–4 lengths;
- `--ks-font`: a font stack.

`colorScheme` is `light`, `dark` or `light dark`. Values are validated (no `url()`, no `var()`) and applied through the CSSOM. Errors: `INVALID_REQUEST` (`details.fields`).

## 5. Events

| Event | `data` | When |
|---|---|---|
| `ready` | `{ protocolVersion: 1 }` | Once, when the frame has started |
| `statusChanged` | `SignerStatus` | Key created, confirmed, locked, unlocked, revoked, expired, changed in another tab; limits changed |
| `keyExpiringSoon` | `{ agentAddress, validUntil, msRemaining }` | Once per key per frame load, when it expires within 7 days (right after `hello`, and on a timer). Show the renew banner. Also in `status.expiringSoon` |
| `keyExpired` | `{ agentAddress, validUntil }` | Once per key per frame load, at `validUntil − 15 s`. The frame refuses to sign from then on. Also in `status.expired` |
| `promptChanged` | `{ visible: boolean, kind: "passkey-create" \| "passkey-unlock" \| null }` | The frame needs (or no longer needs) a click inside it. **Show the iframe, clickable, while `visible` is true** |
| `reconnected` (client-side, not sent by the frame) | `HelloResult` | `KokoahSignerClient` re-ran `hello` after the frame reloaded ([§3](#3-the-client)). Re-apply `setLimits` and `setTheme` |

Example: `{ "protocol": "kokoah-signer", "version": 1, "kind": "event", "event": "promptChanged", "data": { "visible": true, "kind": "passkey-unlock" } }`

## 6. Errors

`error` is `{ code, message, retryable, details? }`. `message` is plain English and safe to show. `details` never contains secrets.

| Code | Meaning | Recommended handling (§B6.3) |
|---|---|---|
| `INVALID_REQUEST` | Params failed validation (`details.issues`, `details.fields`) | Bug: log it |
| `PAYLOAD_TOO_LARGE` | Message > 64 KB | Bug |
| `UNSUPPORTED_VERSION` | Protocol version mismatch | Configuration error; block trading |
| `UNKNOWN_METHOD` | Method not in v1 | Bug or version skew |
| `NOT_CONNECTED` | `hello` not done yet | Call `hello` (the client does) |
| `NO_KEY` | No key on this device | Route to "Enable trading" |
| `KEY_EXISTS` | `createAgent` without `replaceExisting` | Ask to replace, or keep the key |
| `KEY_PENDING` | Not confirmed yet | Finish approval, then `confirmAgent` |
| `KEY_EXPIRED` | Expired | Route to "Renew" |
| `KEY_CHANGED` | Key replaced, revoked or locked mid-request | Refresh status; retry |
| `LOCKED` | Key not in memory | `unlock` |
| `AGENT_NOT_FOUND` | HL doesn't list the agent yet | Retry `confirmAgent` (maybe with `timeoutMs`) |
| `AGENT_MISMATCH` | HL lists the agent under another name | Revoke and re-create |
| `INVALID_INTENT` | Intent failed shared validation | Bug in the intent builder; show `details.issues` in dev |
| `UNSUPPORTED_MARKET` | Spot or outcome market | Don't offer the ticket |
| `COMPILE_FAILED` | Market unknown/delisted, precision, margin mode… (`details.compileCode`) | Show the message (it carries the rounded suggestion) |
| `POLICY_DENIED` | Policy refused (`details.violations`) | Show each violation's `message` |
| `MARKET_DATA_UNAVAILABLE` | HL `/info` failed | Retry later |
| `HL_UNAVAILABLE` | HL `/info` unreachable during `confirmAgent` | Retry later |
| `REQUEST_ID_REUSED` | Same `requestId`, different intent | Bug: log it |
| `SIGNER_BUSY` | Signing lock busy for 20 s | Retry |
| `LIMIT_LOOSENING_REJECTED` | `setLimits` tried to loosen (`details.fields`) | Show which limit can't be raised |
| `PASSKEY_UNAVAILABLE` | WebAuthn/PRF not usable | Offer `device` or `session` |
| `PASSKEY_FAILED` | The WebAuthn ceremony failed | Retry |
| `USER_CANCELLED` / `USER_TIMEOUT` | The user cancelled or didn't act within 120 s | Let them retry |
| `PROMPT_BUSY` | A prompt is already open | Wait |
| `UNLOCK_FAILED` | Stored key can't be decrypted | Revoke and create a new key |
| `STORAGE_FAILED` | IndexedDB write failed | Retry, or use `session` |
| `MAINNET_WRITES_DISABLED` | The build doesn't allow mainnet writes | Configuration error |
| `INTERNAL_ERROR` | Unexpected failure, or an outgoing message failed the safety check | Report |
| Client only: `TIMEOUT`, `DESTROYED`, `HANDSHAKE_FAILED` | See §3 | For `signAndSubmit`: retry with the **same** `requestId` |

HL errors inside `signAndSubmit` results (`error` on `rejected`, per-order errors in `outcome`) use shared `mapHlError` codes, not these.

## 7. Policy

The frame evaluates `@kokoah/shared` `evaluatePolicy` twice: on the compiled subject (intent plus wire action) and on the exact wire action it will sign. It also adds rules of its own.

The baseline is built into the frame and can't be loosened:

| Rule | Baseline |
|---|---|
| Allowed action types | `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`, `scheduleCancel`, `noop`, `startFeeTrial`. Everything else is denied, and fund movements, vault/sub-account actions, approvals, TWAP etc. are hard-denied by the shared policy anyway |
| `setReferrer` | Only with the frame's `VITE_HL_REFERRAL_CODE` (shared policy `referralCode`), for the master, while HL reports no referrer, once per key. No code configured: denied |
| Spot | Only the network's pinned stablecoin/USDC pairs (shared `STABLECOIN_PAIRS`, checked against the frame's own `spotMetaAndAssetCtxs`), master account only: one IOC order, builder on sells and none on buys. Spot legs skip the leverage and stop-loss rules but count toward notional and rate limits. Every other spot market is denied |
| Builder | Every `order` carries exactly `{ b: VITE_BUILDER_ADDRESS, f: VITE_BUILDER_FEE_TENTHS_BPS }` |
| `vaultAddress` | Absent (the master), or one of the master's own sub-accounts as listed by HL `subAccounts`, read by the frame itself. Vaults and any other address are denied (`VAULT_NOT_ALLOWED`) |
| Price band | Orders that execute now (market, IOC, and marketable limits: a buy at or above min(mark, mid), a sell at or below max(mark, mid)) within **10%** of HL's mark; market-order slippage ≤ 10%. Resting GTC/ALO limits that don't cross may sit up to **50%** from mark (shared `RESTING_PRICE_BAND_PCT`), which still stops typos like 8500 for 85000. Triggers: the limit within 10% of its trigger; an untriggered trigger up to 50% from mark; a trigger that would fire now banded at 10% from mark. Mark and mid come from the frame's own HL reads. `setLimits.priceBandPct` tightens the 10% band only |
| Leverage | Each market's own maximum (`updateLeverage` above it is denied) |
| Rate | **60 orders per minute** per agent (TP/SL legs count; cancels don't). Persisted, so a reload doesn't reset it |
| Notional | $1,000,000 per order, $25,000,000 per UTC day per key across every account (reduce-only orders exempt) |
| `expiresAfter` | Required; the frame uses now + 15 s (window ≤ 30 s) |
| Origins | `manual`, `ai_ticket` |

`status.policy` (`PolicySummary`) shows the master's effective values; `accountLimits` lists sub-accounts with limits of
their own:

```json
{
  "allowedActionTypes": ["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop", "startFeeTrial"],
  "allowedCoins": "*", "maxOrderNotionalUsd": 1000000, "maxDailyNotionalUsd": 25000000, "maxLeverage": "market",
  "maxOrdersPerMinute": 60, "priceBandPct": 10, "requireStopLossForNewEntries": false,
  "builder": { "address": "0x…builder", "feeTenthsBps": 25 }, "vaultAddressAllowed": false, "ownSubAccountsAllowed": true,
  "expiresAfterMs": 15000, "allowedOrigins": ["manual", "ai_ticket"], "spotCoins": ["@166", "@150"], "referralCode": null,
  "userLimits": null,
  "accountLimits": { "0x…sub": { "maxOrderNotionalUsd": 1000 } }
}
```

Denials come back as `POLICY_DENIED` with every violation, for example:

```json
{ "code": "POLICY_DENIED", "message": "The action is not allowed by the signer policy.", "retryable": false,
  "details": { "violations": [ { "code": "PRICE_OUTSIDE_BAND", "message": "ETH buy at 2300 is 15% from the mark price 2000 and would fill immediately; orders that execute now must be within 10% of the mark (a resting limit can be up to 50% away)." } ] } }
```

## 8. Key storage and passkeys

| Mode | At rest | After a reload | Protects against | Doesn't protect against |
|---|---|---|---|---|
| `passkey` | Key encrypted with AES-GCM; the wrapping key is `HKDF(WebAuthn PRF output)`; non-extractable | **Locked** until the user unlocks with the passkey (user verification) | Stolen disk or profile copy; silent use of the stored key by code that runs later | Script running on the signer origin **after** unlock (the key is in memory) |
| `device` | Key encrypted with a **non-extractable** AES-GCM `CryptoKey` stored in IndexedDB | Unlocked automatically | Offline theft of the storage files | **Any script running on the signer origin** (it can call `decrypt`). That is why the frame's origin, CSP, SRI and deploy integrity matter |
| `session` | Nothing stored | Gone (create a new key) | Anything at rest | Script on the signer origin while the tab is open |

**Passkey ceremonies:**
- Both happen **inside the frame**, started by a click on the frame's own button (WebAuthn needs user activation in the frame document).
- The frame emits `promptChanged {visible: true}`, shows a short text and two buttons ("Create passkey"/"Unlock with passkey", and "Cancel"), and hides them afterwards.
- Some authenticators return the PRF secret only on an assertion. The frame then asks for a second click ("Confirm your passkey").
- Renewing a passkey key reuses the existing passkey credential.
- `setStorageMode` moves an existing key between `device` and `passkey` without a new approval (one prompt).
- Both ceremonies use `userVerification: "required"` (device PIN or biometric, not just a touch). Authenticators derive the PRF output from different secrets with and without user verification, so the frame never lets the browser choose. An authenticator that can't verify the user fails the ceremony.
- The WebAuthn RP ID is the signer's host (e.g. `signer.kokoah.example`).

**Requirements:**
- The iframe needs `allow="publickey-credentials-get; publickey-credentials-create"` (the client sets it).
- The signer's `Permissions-Policy` header must allow those features for `self` (kokoah-infra's signer headers and `public/_headers` do; `pnpm build` fails otherwise), and the app's own `Permissions-Policy` must delegate them to the signer origin. When either is missing, `hello.capabilities.passkey.available` is `false` and `passkey` requests fall back to `device` with a `storageFallbackReason`. See the [README](../README.md#requested-kokoah-infra-changes).

## 9. Several tabs

- **One key per browser profile.** `device` and `passkey` keys live in the signer origin's IndexedDB and are shared by every tab.
  - Each tab unlocks a passkey key separately; the key never travels between tabs.
  - A `session` key belongs to its tab only.
- **Signing is serialized** per agent with the Web Locks API, across tabs. Nonces are reserved in an IndexedDB read-write transaction, which the browser runs one at a time across tabs. So two tabs can never use the same nonce, even without Web Locks. Without Web Locks, the arrival order at HL across tabs isn't guaranteed, which HL tolerates.
- Create, confirm and revoke in one tab update the other tabs' frames through a `BroadcastChannel` notice (no key material). They emit `statusChanged`.
- The per-minute rate and the daily notional are shared by all tabs.

## 10. Rules for the parent

- Create **one** `KokoahSignerClient` per app. Never create a signer iframe per component.
- Use a fresh UUID `requestId` per user submission. On `unknown` or `TIMEOUT`, **never** resubmit with a new id: query `orderStatus` by cloid, or repeat the same id.
- Don't send prices, registries, nonces or builders; the frame ignores or rejects them. The ticket's own numbers are for display and risk estimates only.
- The main wallet signs only readable typed data: `approveAgent`, `revokeAgent`, builder fee. **Never** an L1 action.
- Never log or forward signatures, and never ask for a seed phrase.
- Re-apply `setLimits` (the master's and each sub-account's) and `setTheme` after each `hello` and on `reconnected`.
- Put `vaultAddress` on every intent for a sub-account (orders, cancels, modifies, leverage, margin, `scheduleCancel`):
  the account a request acts for is part of the signed hash.

## 11. Versioning

- `version: 1` is in every envelope. Additive changes (new optional params, new result fields, new events, new error codes) keep version 1: ignore unknown fields and codes.
- Breaking changes create version 2. A frame answers other versions with `UNSUPPORTED_VERSION`.

## 12. Link phone

A user signed in on a computer starts trading on a phone with no wallet app on the phone. **No key ever travels**: the
phone's frame creates its own key; the computer's main wallet approves that key's address with one readable
`approveAgent` signature. The pairing API is in kokoah-backend `docs/API.md` ("Linked devices"); the threat model is in
[THREAT_MODEL.md §7](THREAT_MODEL.md#7-link-phone).

1. **Computer** (signed in with its main wallet): picks the agent name (a free slot of Hyperliquid's three named
   agents, or the slot the user chose to replace), asks the backend for a pairing (`POST /v1/devices/link`, a one-time
   token that expires in 5 minutes, bound to this session and address) and generates a 16-byte link secret itself. It
   shows a QR code for `https://<app>/link#t=<token>&k=<secret>`. The fragment never reaches a server.
2. **Phone** opens the link, removes the fragment from the address bar, claims the token (`POST /v1/link/claim`,
   one-time), and calls `createLinkedAgent` with the pairing's account and agent name and the link secret. It sends
   only `agentAddress` and `validUntil` to the backend, and shows `matchCode`.
3. **Computer** receives the phone's device name, agent address and expiry from the backend, computes
   `deviceLinkCode` itself and shows the same 6 digits. The user checks that both screens match; the app refuses to
   continue otherwise ("They don't match" cancels the pairing).
4. **Computer** builds `buildApproveAgent({ agentAddress, agentName, validUntil, … })`, the main wallet signs it (one
   readable signature), the app posts it to Hyperliquid and tells the backend, which checks `extraAgents` itself.
5. **Phone** calls `confirmAgent` and gets a Kokoah session for the account, marked as a linked device.

The phone's key is an ordinary agent key: the frame's baseline policy and the user's limits apply, it can't withdraw or
send, and it can be revoked on its own (by name, with the main wallet) from the computer's Security center.
