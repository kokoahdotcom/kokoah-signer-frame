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
- The frame posts `ready` before it answers any `hello`. A `ready` **after** a completed handshake therefore means the iframe reloaded: the new frame document has forgotten the handshake (every method answers `NOT_CONNECTED`), theme, remembered `requestId`s and an unlocked passkey key. It keeps the user's limits, which it stores itself (`setLimits`, [§4](#setlimits)). `KokoahSignerClient` then re-runs `hello` with the same params and emits its own `reconnected` event ([§3](#3-the-client)); re-apply `setLimits` (a no-op when nothing changed) and `setTheme` there.
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
| `new KokoahSignerClient(options)` | `frameUrl` (required; https, or http for localhost). Optional: `container` (default `document.body`), `requestTimeoutMs` (30 s), `interactiveTimeoutMs` (300 s, used by `unlock`, `setStorageMode`, `setLimits` and passkey `createAgent`, and the least any request waits while the frame shows a prompt), `helloTimeoutMs` (15 s), `autoShowOnPrompt` (true), `iframeTitle`, `clientInfo`. |
| `iframe` | The `<iframe data-kokoah-signer>`. Hidden (`hidden` attribute) except while the frame shows a prompt. Style it in the app. |
| `frameOrigin` | The only origin the client sends to and accepts messages from. |
| `hello(params?)` | Handshake; cached. Called automatically before the first other request. Repeated automatically, with the same params, when the frame reloads (see `reconnected`). |
| `getStatus()`, `createAgent(p)`, `confirmAgent(p?)`, `unlock()`, `lock()`, `signAndSubmit(p)`, `setLimits(p)`, `revoke(p?)`, `setTheme(p)` | One typed method per protocol method. |
| `request(method, params, timeoutMs?)` | Low-level typed request. |
| `on(event, listener)` → unsubscribe; `off(event, listener)` | Events of [§5](#5-events), plus the client's `reconnected`. Works before `hello()`: subscribe first, because the frame emits `keyExpiringSoon`/`keyExpired` right after the handshake. |
| `setFrameVisible(visible)` | Manual control of the iframe's visibility. |
| `connection` | The last `hello` result, or `null` (before the handshake and while reconnecting). |
| `destroy()` | Removes the iframe; pending requests fail with `DESTROYED`. |

**Reconnecting.** When the frame reloads (a `ready` after a completed handshake, or a `NOT_CONNECTED` answer), the client re-runs `hello` with the params of the first `hello` and, once it succeeds, emits the client-side event **`reconnected`** with the new `HelloResult` (`ClientEventData["reconnected"]`). The frame can't send this event; it isn't part of the wire protocol. Requests still waiting for the old frame document fail at once with the client code **`FRAME_RELOADED`** instead of timing out. `getStatus`, `setLimits`, `setTheme`, `lock` and `confirmAgent` have no effect outside the frame, so the client sends them again to the new frame and the caller never sees the reload. Every other method (above all `signAndSubmit`) surfaces `FRAME_RELOADED`: the action may have been submitted before the reload, and the new frame has forgotten its `requestId`s, so check the order by cloid instead of sending it again.

```ts
signer.on("reconnected", (hello) => {
  if (!helloMatchesConfig(hello)) blockTrading();      // same checks as after the first hello
  void signer.setLimits(userLimits);                   // a no-op: the frame kept the limits it stores
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

**Showing the prompt.** When the frame needs the user (passkey ceremonies, an HLP deposit or a vault withdrawal, a loosening of the user's limits, a large order or many orders in a short time, margin taken out of an isolated position), it emits `promptChanged {visible: true}`. The client then removes `hidden` from the iframe and sets `data-kokoah-signer-prompt="<kind>"`. Style that state as a modal, for example:

```css
iframe[data-kokoah-signer] { position: fixed; inset: 0; margin: auto; width: min(420px, 92vw); height: min(480px, 92vh); border: 0; border-radius: 12px; z-index: 1000; }
```

The iframe must be visible, on top and clickable. Don't cover it or make it transparent.

**The agent approval panel** (`promptChanged` kind `agent-approval`, `hello.capabilities.showsAgentApproval`,
2026-10-23) is the one exception to "style it as a modal": it is shown while the main wallet's own window asks the user
to approve a new key (see `createAgent`), and must sit **beside** that window, never over it (for example docked at a
corner, not centred over the page). It asks for nothing and takes no focus.

**How the prompt resists a hostile page.** Its primary button works only after the prompt has been shown for 800 ms
(where the browser reports occlusion, IntersectionObserver v2, shown whole, wholly in view and unobscured; covering,
fading or clipping part of it starts over). The prompt always fits the frame (its order lines scroll inside it). Where
the browser can't report occlusion (Firefox, Safari, every iOS browser), the fixed-style prompts (`limits`,
`vault-deposit`, `vault-withdraw`, `order`, `margin`, `key-remove` and removing passkey protection) also show a random 3-digit code
the user types before the button works; a wrong code shows a new one, and after three wrong ones the prompt ends with
`USER_CANCELLED` (2026-10-23). Moving the frame to a fragment (`#…`) scrolls it back and starts over. Then a click counts only after the user's own pointer moved over the button inside the frame (a touch
press on it, for pointers that can't hover); events a script dispatches and a pointer that was already resting where
the button appeared don't count, and leaving the button needs new movement. From the keyboard, any prompt confirms
only when the user moved focus to the button with Tab or Shift+Tab inside the frame (not focus moved by a script or
arriving from the parent page) and then holds Enter or Space for 0.8 s; a key press alone never clicks it, and the
button is described to screen readers as "Press and hold Enter or Space to confirm." Resizing the iframe, the frame
losing focus or the page being hidden starts it all over. The `limits`, `vault-deposit`, `vault-withdraw`, `order` and `margin` prompts are
confirmed by **pressing and holding** the button for 0.8 s with the pointer too (a bar fills; releasing early does
nothing). Focus starts on Cancel. So don't resize or move the iframe while `visible`, and give the user a pointer path
to it.

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
    "broadcastChannel": true,
    "vaultTransfers": true,
    "confirmsLooserLimits": true,
    "confirmsLargeOrders": true,
    "confirmsRecentOrders": true
  },
  "builder": { "address": "0x…builder", "feeTenthsBps": 25 },
  "status": { "hasKey": true, "keyState": "active", "expiringSoon": true, "expired": false, "…": "SignerStatus, see getStatus" },
  "limits": { "maxMessageBytes": 65536, "minValidForDays": 1, "maxValidForDays": 30, "expiresAfterMs": 15000, "maxAgentNameLength": 16, "confirmOrdersAboveUsd": 25000, "confirmRecentOrdersAboveUsd": 100000, "recentOrdersWindowMs": 600000, "confirmDailyOrdersAboveUsd": 250000 }
}
```

- **Required check:** compare `network` with the app's network and `builder` with `public-config`. **Refuse to trade on any mismatch** (FRONTEND_IMPLEMENTATION §B3.1, §B6.3).
- `capabilities.passkey.available` is false when WebAuthn is missing or blocked in the frame, with a `reason`, for example `"WebAuthn is blocked by Permissions-Policy in the signer frame"`. `prf` is `"unknown"` when the browser can't say without a ceremony.
- `storageModes` lists what can work here. Offer only those, in that order of preference.
- `vaultTransfers` is true when the frame signs `hlpDeposit` and `vaultWithdraw` (absent in older frames): show HLP
  deposits and vault withdrawals only then.
- `confirmsLooserLimits` is true when the frame stores the user's limits itself and applies a looser `setLimits` only
  after the user's click on its own prompt (see `setLimits`). Only then tell the user to confirm in the signer window.
  Absent in older frames: they keep limits in memory, apply anything within the baseline at once, and the app must
  re-apply limits after every load.
- `confirmsLargeOrders` is true when the frame asks the user before signing orders above `limits.confirmOrdersAboveUsd`
  ($25,000) in all (see `signAndSubmit`). Only then tell the user to confirm such an order in the signer window. Absent
  in older frames, which sign them without asking.
- `confirmsRecentOrders` is true when the frame also asks before orders that would take what it signed without a
  prompt in the last `limits.recentOrdersWindowMs` (10 minutes) above `limits.confirmRecentOrdersAboveUsd` ($100,000),
  or in the last 24 hours above `limits.confirmDailyOrdersAboveUsd` ($250,000; absent in frames before 2026-10-23)
  (see `signAndSubmit`). Absent in older frames.
- `showsAgentApproval` is true when the frame shows its agent approval panel after `createAgent` (see there). Absent
  in older frames.
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
| `replaceExisting` | Required (`true`) when a non-expired key exists. The old key is **wiped** when the new one is created; trading resumes after the new one is confirmed. Replacing a key protected with a passkey by one in another storage mode first needs the user's confirmation in the frame (`promptChanged` kind `key-remove`, 2026-10-23); cancel or timeout: `USER_CANCELLED` / `USER_TIMEOUT`, and the old key stays |

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

**Agent approval panel** (2026-10-23, `hello.capabilities.showsAgentApproval`). Right before `createAgent` answers,
the frame opens its own panel (`promptChanged {visible: true, kind: "agent-approval"}`, the frame's fixed look whatever
`setTheme` set) showing the new key's **full** `agentAddress` and its check code, the address's first and last 8 hex
digits in groups of four (`1a2b 3c4d … 5e6f 7a8b`; protocol `agentAddressCheckCode`, which an app showing the code
must use). It tells the user to approve the wallet's request only if the wallet shows that address, so a request for an
address the page chose stands out. Keep the iframe visible **beside the wallet's window, never over it** while the
panel is up (steps 2–4): it asks for nothing, takes no focus and has only a Hide button. It ends
(`promptChanged {visible: false}`) when `confirmAgent` answers, either way; when the user hides it; when the key is
replaced or removed; or after `AGENT_APPROVAL_PANEL_MS` (5 minutes). A prompt the frame opens meanwhile takes its place
and gives it back when it closes (`promptChanged` with that prompt's kind, then `agent-approval` again). Not shown for
`createLinkedAgent` (the phone shows its matching code instead) or in a frame without a user interface.

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
- A stored key is locked in this browser's other tabs too (2026-10-23): their frames get the notice over their own
  BroadcastChannel (their pages can't stop it) and report `statusChanged` with `locked: true`; a `passkey` key there
  then needs the passkey again. A `device` key unlocks again without a prompt (`unlock`), and is unlocked again on the
  next load: locking is no protection for a device key against a page that calls `unlock`.
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
  reads HL `{"type":"referral","user":<master>}` itself: a referrer already set, or more than $10,000 of volume
  (Hyperliquid's app refuses codes after that), is `POLICY_DENIED` (`REFERRER_ACTION_DENIED`), an unreadable answer
  `MARKET_DATA_UNAVAILABLE`. It signs at most **once per key**
  (recorded in IndexedDB with the nonce, so reloads and other tabs see it). No code configured:
  `REFERRER_ACTION_DENIED`.
- `{ "kind": "startFeeTrial", "origin": "manual", "tier": 1 }` starts Hyperliquid's fee trial for VIP tier `tier`
  (1 = the first entry of `userFees.feeSchedule.tiers.vip`). The frame reads `userFees` for the master itself, takes
  that tier's rates from it and signs `{"type":"startFeeTrial","addBaseRate":"0.00012","crossBaseRate":"0.0004"}`
  (the shape Hyperliquid's app sends). While a trial runs (`trial` not null) or before `nextTrialAvailableTimestamp`
  it answers `POLICY_DENIED` (`FEE_TRIAL_UNAVAILABLE`); an unreadable answer is `MARKET_DATA_UNAVAILABLE`; a tier
  outside the schedule is `COMPILE_FAILED`.

- `{ "kind": "hlpDeposit", "origin": "manual", "usd": "250" }` deposits `usd` USDC (at most 6 decimals) into HLP,
  Hyperliquid's own vault. There is no vault field: the frame signs its own HLP address for its network (shared
  `HLP_VAULT_ADDRESSES`). The frame reads `{"type":"userNonFundingLedgerUpdates","user":<master>,"startTime":<now−24 h>}`
  itself and adds the deposits signed in this browser in the last 5 minutes, in any tab (kept with the nonces in its
  IndexedDB; the ledger can lag); more than 10,000 USDC at once or
  25,000 in 24 hours, or less than 5, is `POLICY_DENIED` (`VAULT_DEPOSIT_LIMIT`), checked before anything is shown.
  Then it shows its own prompt (`promptChanged` kind `vault-deposit`, fixed styling) naming the amount and the 4-day
  lock-up; only the user's press and hold on its button in the frame signs `{"type":"vaultTransfer","vaultAddress":<HLP>,"isDeposit":true,
  "usd":250000000}` (USDC × 10^6), after reading the ledger again under the agent lock. Cancel: `USER_CANCELLED`.
- `{ "kind": "vaultWithdraw", "origin": "manual", "vaultAddress": "0x…", "usd": "120.5" }` withdraws from a vault back
  into the account. The frame reads `{"type":"userVaultEquities","user":<master>}` itself: a vault the account doesn't
  hold, or more than its equity there, is `POLICY_DENIED` (`VAULT_NOT_ALLOWED`). Then it shows its own prompt
  (`promptChanged` kind `vault-withdraw`, fixed styling, press and hold) naming the amount and the vault (2026-10-23;
  before, no prompt). Cancel: `USER_CANCELLED`. Hyperliquid itself refuses a withdrawal inside the lock-up.
- Both are the action type `vaultTransfer`: limits whose `allowedActionTypes` leave it out refuse them with
  `POLICY_DENIED` (`ACTION_TYPE_NOT_ALLOWED`) before anything is shown.

An unreadable ledger or vault list is `MARKET_DATA_UNAVAILABLE`; nothing is signed.

All four results have `cloids: []`; they count toward neither the order rate nor the notional limits.

**Convert stablecoins** is an ordinary `order` intent on one of the network's pinned stablecoin/USDC pairs
(`status.policy.spotCoins`, e.g. `@166` USDT0/USDC on mainnet), for the master account: a market (or IOC limit)
order, one leg, no TP/SL, not reduce-only. The frame reads `spotMetaAndAssetCtxs` itself and signs only when the pair,
its token indices, names and token ids match the pins exactly (else `UNSUPPORTED_MARKET`). Buys carry no builder
(Hyperliquid charges builder fees on spot sells only); sells carry the configured builder. Every other spot market is
`UNSUPPORTED_MARKET`.

**Spot trading** (PHASE3 SPOT) is off until the parent calls `setLimits({ spotTrading: true })` for the master. Then
`order` intents may also use the verified token/USDC pairs in `status.policy.spotTradingCoins` (shared
`VERIFIED_SPOT_PAIRS`: Hyperliquid's own "Strict" spot list, e.g. `@107` HYPE/USDC and `@142` UBTC/USDC on mainnet,
`PURR/USDC` and `@1035` HYPE/USDC on testnet), with the same checks against the frame's own `spotMetaAndAssetCtxs`
(pair index and name, token indices, names and token ids; any mismatch or any other pair is `UNSUPPORTED_MARKET`):

- market orders (IOC) and `limit` orders with `tif` `Gtc`, `Ioc` or `Alo`, within the price bands of §7;
- one leg, not reduce-only, no trigger order types, no TP/SL legs, no `modify` (cancel and re-place instead):
  `POLICY_DENIED` / `SPOT_NOT_ALLOWED`. Hyperliquid's own app offers no stop or take-profit orders on spot;
- buys carry no builder; sells carry the configured builder;
- master account only (`VAULT_NOT_ALLOWED` for a sub-account, whatever its own limits say);
- mainnet: one order on a verified pair is at most **10% of the pair's 24 h notional volume** as the frame read it
  (`POLICY_DENIED` / `ORDER_NOTIONAL_EXCEEDED`); stablecoin pairs and testnet have no such cap.

```jsonc
{ "kind": "order", "coin": "@107", "side": "sell", "orderType": "limit", "size": "1.5", "price": "41.2", "tif": "Alo", "origin": "manual" }
```

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
5. Reads the user's stored limits again (another tab may have changed them) and evaluates the policy
   ([§7](#7-policy)) of the account the intent is for, on the compiled action and again on the exact wire action.
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
  - `UNSUPPORTED_MARKET` (outcome markets, and every spot market except the pinned stablecoin and verified pairs that
    the frame's own `spotMeta` confirms: the frame trades perps, HIP-3 perps and verified spot pairs only; on mainnet,
    anything but cancels and reduce-only orders on a HIP-3 dex that isn't pinned or has a new deployer, see
    [§7](#7-policy));
  - `COMPILE_FAILED` (`details.compileCode`: `UNKNOWN_MARKET`, `DELISTED_MARKET`, `SIZE_PRECISION`, `PRICE_PRECISION`, `CROSS_NOT_ALLOWED`, `MARGIN_PRECISION`, `SCHEDULE_TOO_SOON`, …; the message includes the rounded suggestion);
  - `POLICY_DENIED` (`details.violations`: every `{ code, message }` from shared `evaluatePolicy`, plus the frame's own rules);
  - `MARKET_DATA_UNAVAILABLE` (retryable);
  - `SIGNER_BUSY` (retryable; the signing lock wasn't free within 20 s);
  - `USER_CANCELLED`, `USER_TIMEOUT`, `PROMPT_BUSY` (an HLP deposit or a large order the user didn't confirm; nothing sent);
  - `REQUEST_ID_REUSED`;
  - `MAINNET_WRITES_DISABLED`;
  - `STORAGE_FAILED` (retryable; the nonce, or the user's stored limits, could not be read or written: nothing was signed).

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

**Large orders** (`hello.capabilities.confirmsLargeOrders`). When the orders of one action come to more than
`hello.limits.confirmOrdersAboveUsd` ($25,000) in all, each counted as size × max(limit price, trigger price, mark) and
reduce-only orders included (a $10,000 entry with a take-profit and a stop-loss counts about $30,000), the frame signs
them only after the user confirms its own prompt (`promptChanged` kind `order`, fixed styling, press and hold). The
prompt lists each order as it will be signed, for example `Buy 0.3 BTC at $100,000 (limit) · about $30,000` or
`Sell 0.3 BTC at market, down to $99,010 · reduce-only · about $30,000`, with the total and the sub-account if any.
- It asks only about orders its rules allow (checked first) and doesn't hold up other requests meanwhile (a smaller
  order or a cancel signs at once; a second large order while one is asked about is `PROMPT_BUSY`).
- After the user confirms, it reads prices, dexes and leverage again and checks everything again under the agent lock:
  a market that moved past the band while the prompt was open is `POLICY_DENIED` (`PRICE_OUTSIDE_BAND`).
- Cancel or no answer within 120 s: `USER_CANCELLED` / `USER_TIMEOUT` with `details.prompt: "order"`. Nothing was sent,
  so the `requestId` may be used again. Show something like "You cancelled the order in the signer. Nothing was sent."
- The client doesn't time `signAndSubmit` out while a prompt is open (it waits up to `interactiveTimeoutMs`, and gets its
  full timeout again once the prompt closes). While the call waits, tell the user to confirm in the Kokoah signer
  window, and keep the iframe on top: a modal `<dialog>` of the app must step aside, or the user can't reach the button.

**Many orders without a prompt** (`hello.capabilities.confirmsRecentOrders`, 2026-10-23). The frame keeps rolling
totals of the orders it signed without a prompt in the last `hello.limits.recentOrdersWindowMs` (10 minutes) and the
last 24 hours, counted as above, across every account of the key's master, in every tab and across reloads and new
keys. Orders that would take the first above `hello.limits.confirmRecentOrdersAboveUsd` ($100,000), or the second above
`hello.limits.confirmDailyOrdersAboveUsd` ($250,000), wait for the same `order` prompt, which then also says how much
went out without a confirmation in that time; confirming it starts both totals again (confirming a large order whose
prompt didn't show them leaves them). Confirmed orders never count. So a hijacked page can't trade large amounts as
many orders just under $25,000, however it spreads them out: at most $250,000 a day without the user. A frame without a UI refuses them (`POLICY_DENIED`,
`ORDER_NOTIONAL_EXCEEDED`). When another tab signed orders between the check and the signature, the call fails with
`SIGNER_BUSY` (retryable, nothing sent): send it again and it asks.

**Taking margin out of an isolated position** (`updateIsolatedMargin` with a negative `amountUsd`, 2026-10-23) waits for
the frame's own prompt (`promptChanged` kind `margin`, fixed styling, press and hold) naming the amount and the market:
it moves the position toward liquidation, which no notional cap covers. Cancel or timeout: `USER_CANCELLED` /
`USER_TIMEOUT`; a frame without a UI refuses it. Adding margin signs at once.

### `setLimits`

Personal limits (Settings, §B11.4). They **replace** the previous limits of one account (`{}` resets the master to the
baseline) and can never go beyond the frame's baseline: a value above it rejects the whole call
(`LIMIT_LOOSENING_REJECTED`) and changes nothing.

→ `{ "maxOrderNotionalUsd": 5000, "maxDailyNotionalUsd": 50000, "maxLeverage": 10, "requireStopLossForNewEntries": true }`

Limits are kept **per account**. Without `account` (or with the key's master) the call sets the master's limits. With a
sub-account's address it sets that sub-account's own limits, which apply **on top of the master's**:
`{ "account": "0x…sub", "maxOrderNotionalUsd": 1000 }`. Each field set replaces the master's value for that
sub-account (still within the baseline); each field left out keeps the master's value, whenever the master's limits
are set or changed. So a sub-account that sets only `maxLeverage` keeps the master's notional limits, stop-loss rule
and daily counter. `{ "account": "0x…sub" }` alone removes them, so the sub-account uses the master's limits again. A
sub-account without its own limits always uses the master's. At most 64 sub-accounts can have their own limits.
Setting limits for an address grants nothing: `vaultAddress` is still checked on HL at signing.

← `{ "policy": PolicySummary }` ([§7](#7-policy)). The frame also emits `statusChanged` when the limits changed.

| Field | Constraint (the baseline is in §7) |
|---|---|
| `maxOrderNotionalUsd`, `maxDailyNotionalUsd`, `maxOrdersPerMinute`, `priceBandPct` | ≤ baseline |
| `maxLeverage` | Integer from 1 to the baseline's 50. Effective cap per market = `min(value, market maximum)`. For new orders on a market whose maximum is above it, the frame reads the account's current leverage (`activeAssetData`) |
| `allowedCoins` | Non-empty list of HL coin names (a subset of the baseline) |
| `requireStopLossForNewEntries` | `true` tightens; `false` or omitted: not required |
| `allowedActionTypes` | A subset of the baseline action types; leave out `vaultTransfer` to turn HLP deposits and vault withdrawals off. At least one other type stays |
| `spotTrading` | `true` turns spot trading on (the verified pairs in `spotTradingCoins`, see `signAndSubmit`); omitted or `false`: off, the default. It is the one setting that starts off, and it never goes beyond the baseline |
| `account` | Optional sub-account address (see above) |

**Stored by the frame** (`hello.capabilities.confirmsLooserLimits`). The frame keeps the limits in its own IndexedDB on
the signer origin, **per network** (the master's, each sub-account's own, and `spotTrading`):
- they survive reloads of the frame or the app;
- they bind every tab: a change made in one tab applies to the next signature in every other tab (the frame reads the
  stored limits again before each signature, under the agent's signing lock), and the other tabs emit `statusChanged`;
- they need no key: the app may set the master's limits before a key exists, and they outlive a revoked or renewed
  key. A sub-account's limits still need a key (`NO_KEY`), to tell the master from its sub-accounts;
- they are per network, not per wallet: in a browser where two wallets trade one after the other, the stored master
  limits apply to whichever wallet's key the frame holds, and switching to a wallet whose limits in the app's settings
  are looser shows the loosening prompt once.

**Tighten silently, loosen with the user's confirmation.** Each call is compared with the limits stored now, on the values in force
for that account (its own, else the master's, else the baseline's):

| Change | What happens | Answer |
|---|---|---|
| Identical to the stored limits (the app sends them again at every handshake) | Nothing: no write, no `statusChanged`, no prompt | At once |
| Only tightens (lower numbers, fewer coins or action types, stop-loss required, spot trading off) | Stored and applied | At once |
| Loosens anything | The frame shows its own prompt (`promptChanged` kind `limits`, fixed styling the parent's theme can't change) listing every change in plain words, for example `Largest order: $100 → $5,000`. Applied only when the user presses and holds **Loosen limits** | After the confirmation, or `USER_CANCELLED` / `USER_TIMEOUT` (120 s) with nothing changed |

Loosening means any of:
- a higher number;
- a field removed (the baseline, or for a sub-account the master's value, applies again), including `{}`;
- `spotTrading: true` while it is off;
- more `allowedCoins` or `allowedActionTypes` (or the list removed);
- `requireStopLossForNewEntries` dropped while it is required;
- `{ "account": "0x…sub" }` alone while the master's values are looser than the sub-account's own;
- a sub-account getting `maxDailyNotionalUsd` of its own while the master has a daily limit: it then has a daily
  counter of its own on top of the master's, so the day's total can grow.

Timing and order:
- While the prompt is open, the stored (stricter) limits keep applying to every signature, in every tab.
- Calls from one tab are compared and stored in the order they arrive; a request sent after a tightening (for example
  `signAndSubmit` or `getStatus`) sees it. A tightening sent while a loosening waits for the user is applied at once.
- A second loosening from the same tab waits for the first prompt to close, then is compared again and shows its own
  prompt. `PROMPT_BUSY` only when another kind of prompt (passkey, HLP deposit) is open.
- If the stored limits change (another tab, or a tightening from this one) while the user is looking at the prompt,
  the confirmed loosening is not applied: `SIGNER_BUSY` (retryable). Send it again to show the current changes.
- Keep the iframe visible while `promptChanged.visible` is true (the client does). The prompt has one line per changed
  field (up to nine), so give the iframe room for it or let it scroll.

Re-applying: send the user's limits after `hello` on every load and on `reconnected`, as before. With a frame that
stores them, that is a no-op unless the app's settings differ from the frame's (for example after a change on another
device): a tightening applies, a loosening asks the user. When the user cancels, read `status.policy.userLimits` and
`accountLimits` for the limits in force. Without IndexedDB in the frame (`capabilities.indexedDB: false`) the limits
last for this frame load only.

- Counting: orders per minute are counted per key across all accounts. Daily notional is counted per key across all
  accounts for the baseline $25M. For personal limits, a sub-account whose own limits set `maxDailyNotionalUsd` has a
  counter of its own against that limit; the master and every other sub-account share one counter against the
  master's `maxDailyNotionalUsd`.
- Errors:
  - `LIMIT_LOOSENING_REJECTED`, with `details.fields` listing the fields above the baseline (or, in a frame with no user
    interface, the fields that would loosen the stored limits);
  - `USER_CANCELLED`, `USER_TIMEOUT` (nothing changed), `PROMPT_BUSY`;
  - `SIGNER_BUSY` (retryable): the stored limits changed while the user was confirming, or kept changing in other tabs;
  - `STORAGE_FAILED` (retryable): the stored limits could not be read or written; nothing changed;
  - `NO_KEY` (a sub-account's limits without a key), `INVALID_REQUEST`.

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

- The local key (memory and storage) is wiped **immediately**, in every tab of this browser, if its name matches `agentName`. A key protected with a passkey is wiped only after the user confirms it in the frame's own prompt (`promptChanged` kind `key-remove`, fixed styling, press and hold; no passkey needed, so a lost passkey can still be removed; 2026-10-23); cancel or timeout: `USER_CANCELLED` / `USER_TIMEOUT` with `details.prompt: "key-remove"`, and the key stays.
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
| `statusChanged` | `SignerStatus` | Key created, confirmed, locked, unlocked, revoked, expired, changed in another tab; limits changed (in this tab or another) |
| `keyExpiringSoon` | `{ agentAddress, validUntil, msRemaining }` | Once per key per frame load, when it expires within 7 days (right after `hello`, and on a timer). Show the renew banner. Also in `status.expiringSoon` |
| `keyExpired` | `{ agentAddress, validUntil }` | Once per key per frame load, at `validUntil − 15 s`. The frame refuses to sign from then on. Also in `status.expired` |
| `promptChanged` | `{ visible: boolean, kind: "passkey-create" \| "passkey-unlock" \| "vault-deposit" \| "vault-withdraw" \| "limits" \| "order" \| "margin" \| "key-remove" \| "agent-approval" \| null }` | The frame needs (or no longer needs) a click inside it. **Show the iframe, clickable, while `visible` is true**, whatever the kind (`vault-withdraw`, `margin`, `key-remove` and `agent-approval` since 2026-10-23). `agent-approval` is the panel shown while the main wallet approves a new key: beside the wallet's window, never over it (see `createAgent`) |
| `reconnected` (client-side, not sent by the frame) | `HelloResult` | `KokoahSignerClient` re-ran `hello` after the frame reloaded ([§3](#3-the-client)). Re-apply `setLimits` (a no-op when stored) and `setTheme` |

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
| `UNSUPPORTED_MARKET` | Outcome market, a spot pair the frame can't verify, or (mainnet) anything but a cancel or reduce-only order on a HIP-3 dex that isn't pinned or has a new deployer | Don't offer the ticket; on such a dex, offer only cancels and reduce-only closes (leverage and margin changes go through Hyperliquid itself) |
| `COMPILE_FAILED` | Market unknown/delisted, precision, margin mode… (`details.compileCode`) | Show the message (it carries the rounded suggestion) |
| `POLICY_DENIED` | Policy refused (`details.violations`) | Show each violation's `message` |
| `REGION_BLOCKED` | Kokoah's region check, asked by the frame itself (`VITE_ELIGIBILITY_URL`), doesn't allow this visitor to add risk. Asked only for orders and changes that aren't reduce-only, leverage and margin changes, an HLP deposit, `setReferrer` and `startFeeTrial`; cancels, reduce-only orders and vault withdrawals never ask. A "not allowed" answer holds (kept on the signer origin) until a later answer allows; without one on record, a check that can't be reached lets signing go on | Say trading isn't available in the user's region; closing and cancelling still work |
| `MARKET_DATA_UNAVAILABLE` | HL `/info` failed | Retry later |
| `HL_UNAVAILABLE` | HL `/info` unreachable during `confirmAgent` | Retry later |
| `REQUEST_ID_REUSED` | Same `requestId`, different intent | Bug: log it |
| `SIGNER_BUSY` | Signing lock busy for 20 s; or `setLimits`: the stored limits changed while the user was confirming | Retry |
| `LIMIT_LOOSENING_REJECTED` | `setLimits` above the baseline, or a loosening in a frame with no user interface (`details.fields`) | Show which limit can't be raised |
| `PASSKEY_UNAVAILABLE` | WebAuthn/PRF not usable | Offer `device` or `session` |
| `PASSKEY_FAILED` | The WebAuthn ceremony failed | Retry |
| `USER_CANCELLED` / `USER_TIMEOUT` | The user cancelled or didn't act within 120 s (a passkey ceremony, an HLP deposit, looser limits, a large order). `details.prompt` names the prompt's kind | Let them retry; nothing changed |
| `PROMPT_BUSY` | A prompt is already open (`details.prompt`: the kind asked for) | Wait |
| `UNLOCK_FAILED` | Stored key can't be decrypted | Revoke and create a new key |
| `STORAGE_FAILED` | IndexedDB read or write failed (the key, or the stored limits) | Retry, or use `session` |
| `MAINNET_WRITES_DISABLED` | The build doesn't allow mainnet writes | Configuration error |
| `INTERNAL_ERROR` | Unexpected failure, or an outgoing message failed the safety check | Report |
| Client only: `TIMEOUT`, `DESTROYED`, `HANDSHAKE_FAILED` | See §3 | For `signAndSubmit`: retry with the **same** `requestId` |

HL errors inside `signAndSubmit` results (`error` on `rejected`, per-order errors in `outcome`) use shared `mapHlError` codes, not these.

## 7. Policy

The frame evaluates `@kokoah/shared` `evaluatePolicy` twice: on the compiled subject (intent plus wire action) and on the exact wire action it will sign. It also adds rules of its own.

The baseline is built into the frame and can't be loosened:

| Rule | Baseline |
|---|---|
| Allowed action types | `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`, `scheduleCancel`, `noop`, `startFeeTrial`, `vaultTransfer` (HLP deposits and vault withdrawals, on their own rules). Everything else is denied, and fund movements, vault/sub-account actions, approvals, TWAP etc. are hard-denied by the shared policy anyway |
| `setReferrer` | Only with the frame's `VITE_HL_REFERRAL_CODE` (shared policy `referralCode`), for the master, while HL reports no referrer, once per key. No code configured: denied |
| Spot | The network's pinned stablecoin/USDC pairs (shared `STABLECOIN_PAIRS`) with one IOC order; once the parent sets `spotTrading: true`, also the verified token/USDC pairs (shared `VERIFIED_SPOT_PAIRS`) with market orders and GTC, IOC and post-only limits. Every pair is checked against the frame's own `spotMetaAndAssetCtxs`; master account only; no triggers, reduce-only, TP/SL or modify; builder on sells and none on buys; on mainnet one order on a verified pair ≤ 10% of its 24 h volume. Spot legs skip the leverage and stop-loss rules but count toward notional and rate limits. Every other spot market is denied |
| HIP-3 (mainnet) | Only the dexes pinned in shared `perpDexs.ts` (name and deployer), checked against the `perpDexs` the frame reads itself. On any other dex HL lists (not pinned, or a new deployer) only cancels (`cancel`, `cancelByCloid`; `scheduleCancel` touches no market) and reduce-only orders (closes, position TP/SL, reduce-only modifies) are signed, so a user can leave it; entries, modifies that aren't reduce-only and every `updateLeverage` and `updateIsolatedMargin` (either way) are `UNSUPPORTED_MARKET`. Without HL's `perpDexs` nothing on a HIP-3 dex is signed (its asset ids need it). Testnet: every dex |
| Builder | Every `order` carries exactly `{ b: VITE_BUILDER_ADDRESS, f: VITE_BUILDER_FEE_TENTHS_BPS }` |
| `vaultAddress` | Absent (the master), or one of the master's own sub-accounts as listed by HL `subAccounts`, read by the frame itself. Vaults and any other address are denied (`VAULT_NOT_ALLOWED`) |
| Price band | Orders that execute now (market, IOC, and marketable limits: a buy at or above min(mark, mid), a sell at or below max(mark, mid)) within **5%** of HL's mark, so a market order's slippage can use at most about 5% (the shared schema accepts up to 10%; the IOC limit it gives must still be in the band). Resting GTC/ALO limits that don't cross may sit up to **50%** from mark (shared `RESTING_PRICE_BAND_PCT`), which still stops typos like 8500 for 85000. Triggers: the limit within 10% of its trigger; an untriggered trigger up to 50% from mark; a trigger that would fire now banded at 5% from mark. Mark and mid come from the frame's own HL reads. `setLimits.priceBandPct` tightens the 5% band only |
| Leverage | **50x**, and never above each market's own maximum (`updateLeverage` above it is denied). Where a market allows more than the cap (the baseline's or the user's), the frame reads the account's leverage on HL itself and refuses new entries while it is set higher |
| Rate | **60 orders per minute** per agent (TP/SL legs count; cancels don't). Persisted, so a reload doesn't reset it |
| Notional | $250,000 per order, $25,000,000 per UTC day per key across every account (reduce-only orders exempt) |
| Large orders | More than $25,000 of orders in one action (reduce-only included) only after the user confirms the frame's own prompt (`signAndSubmit`, "Large orders") |
| `expiresAfter` | Required; the frame uses now + 15 s (window ≤ 30 s) |
| Origins | `manual`, `ai_ticket` |

`status.policy` (`PolicySummary`) shows the master's effective values; `accountLimits` lists sub-accounts with limits of
their own:

```json
{
  "allowedActionTypes": ["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop", "startFeeTrial", "vaultTransfer"],
  "allowedCoins": "*", "maxOrderNotionalUsd": 250000, "maxDailyNotionalUsd": 25000000, "maxLeverage": 50,
  "maxOrdersPerMinute": 60, "priceBandPct": 5, "requireStopLossForNewEntries": false,
  "builder": { "address": "0x…builder", "feeTenthsBps": 25 }, "vaultAddressAllowed": false, "ownSubAccountsAllowed": true,
  "expiresAfterMs": 15000, "allowedOrigins": ["manual", "ai_ticket"], "spotCoins": ["@166", "@150"], "spotTrading": false, "spotTradingCoins": ["PURR/USDC", "@1", "…", "@107", "@142"], "referralCode": null,
  "userLimits": null,
  "accountLimits": { "0x…sub": { "maxOrderNotionalUsd": 1000 } }
}
```

Denials come back as `POLICY_DENIED` with every violation, for example:

```json
{ "code": "POLICY_DENIED", "message": "The action is not allowed by the signer policy.", "retryable": false,
  "details": { "violations": [ { "code": "PRICE_OUTSIDE_BAND", "message": "ETH buy at 2300 is 15% from the mark price 2000 and would fill immediately; orders that execute now must be within 5% of the mark (a resting limit can be up to 50% away)." } ] } }
```

## 8. Key storage and passkeys

| Mode | At rest | After a reload | Protects against | Doesn't protect against |
|---|---|---|---|---|
| `passkey` | Key encrypted with AES-GCM; the wrapping key is `HKDF(WebAuthn PRF output)`; non-extractable | **Locked** until the user unlocks with the passkey (user verification) | Stolen disk or profile copy; silent use of the stored key by code that runs later | Script running on the signer origin **after** unlock (the key is in memory) |
| `device` | Key encrypted with a **non-extractable** AES-GCM `CryptoKey` stored in IndexedDB | Unlocked automatically | Other origins and JavaScript export of the key | **A copy of the browser profile** (Chromium stores the CryptoKey's bytes in the same IndexedDB files: THREAT_MODEL A5) and **any script running on the signer origin** (it can call `decrypt`). That is why the frame's origin, CSP, SRI and deploy integrity matter, and why `passkey` is the stronger choice |
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
- So are the user's limits: stored per network, read again before each signature under the agent lock, and announced to
  the other tabs (`statusChanged`) through the same BroadcastChannel.

## 10. Rules for the parent

- Create **one** `KokoahSignerClient` per app. Never create a signer iframe per component.
- Use a fresh UUID `requestId` per user submission. On `unknown` or `TIMEOUT`, **never** resubmit with a new id: query `orderStatus` by cloid, or repeat the same id.
- Don't send prices, registries, nonces or builders; the frame ignores or rejects them. The ticket's own numbers are for display and risk estimates only.
- The main wallet signs only readable typed data: `approveAgent`, `revokeAgent`, builder fee. **Never** an L1 action.
- Never log or forward signatures, and never ask for a seed phrase.
- Re-apply `setLimits` (the master's and each sub-account's) and `setTheme` after each `hello` and on `reconnected`. A frame
  with `confirmsLooserLimits` stores the limits, so this is a no-op unless they differ; never loosen them silently in
  the app either: show what the frame's prompt will ask.
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
