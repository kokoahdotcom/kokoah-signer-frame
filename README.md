# kokoah-signer-frame

The **Kokoah signer frame** is a tiny, separately deployed static page on its own origin (for example `https://signer.kokoah.example/`). The Kokoah web app ([`kokoah-frontend`](../kokoah-frontend)) embeds it in an iframe and talks to it only through `postMessage`.

The frame holds the **browser trading key**: a Hyperliquid (HL) *agent* key that can place, cancel and modify orders and change leverage, but can't withdraw. It creates the key, stores it, checks every request against its own policy, signs, and **submits to Hyperliquid itself**. An XSS or a malicious dependency in the app can't read the key; it can only ask for signatures the frame's policy allows.

This repo also ships **`KokoahSignerClient`**, the typed, dependency-free client the frontend uses (`@kokoah/signer-frame/client`).

- Protocol spec with examples: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Threat model: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- Issues found in `@kokoah/shared`: [`docs/SHARED_ISSUES.md`](docs/SHARED_ISSUES.md)
- Where it fits: `kokoah-dev/specs/FRONTEND_SPEC.md` §2, `FRONTEND_IMPLEMENTATION.md` §B6.3; kokoah-infra [`README`](../kokoah-infra/README.md), [`headers/`](../kokoah-infra/headers/README.md) and [`docs/SECURITY_BASELINE.md`](../kokoah-infra/docs/SECURITY_BASELINE.md) §3.

```
 app.kokoah.example (frontend)                  signer.kokoah.example (this repo)             Hyperliquid
 ┌──────────────────────────────┐  postMessage  ┌────────────────────────────────────┐  HTTPS  ┌────────────┐
 │ KokoahSignerClient           │──────────────▶│ origin allowlist + strict schemas   │────────▶│ /info      │
 │  hello / createAgent / …     │◀──────────────│ own market data (/info)             │         │ (prices,   │
 │  signAndSubmit(intent)       │  results,     │ compileAction (+builder) → policy   │         │  metadata, │
 │ main wallet signs only       │  events       │ → nonce (Web Locks + IndexedDB)     │────────▶│ /exchange  │
 │ approveAgent / revokeAgent   │               │ → sign (agent key) → submit         │         └────────────┘
 └──────────────────────────────┘               │ key: memory / IndexedDB (encrypted) │
                                                └────────────────────────────────────┘
```

## Security in one screen

- **Separate origin.** App code can't read the frame's memory or storage.
- **What the frame accepts.** Messages from `window.parent` only, and only from the exact origins in the build-time allowlist. Replies go to that origin, never `*`. Every message is validated against a strict schema and capped at 64 KB. Anything else is dropped and counted.
- **What the frame trusts.** It never trusts prices, market metadata, builder or nonce from the parent. It fetches HL `/info` itself and compiles with shared `compileAction` using the configured builder.
- **Baseline policy** (shared `evaluatePolicy`), which the parent can only tighten, with the user's **personal limits** on top. The frame stores those itself (IndexedDB on its origin, per network): they survive reloads and bind every tab; tightening applies silently, loosening only after the user's click on the frame's own prompt. The baseline:
  - trading actions only;
  - builder required;
  - no `vaultAddress`;
  - price band against HL's mark: 5% for orders that execute now (market, IOC, marketable limits), 50% for resting limits and untriggered triggers;
  - leverage up to 50x, never above the market's maximum;
  - $250,000 per order and $25,000,000 a day per key (reduce-only orders exempt);
  - more than $25,000 of orders in one action (reduce-only included) only after the user presses and holds the button of the frame's own prompt, which names every order;
  - 60 orders a minute (persisted);
  - `expiresAfter` = now + 15 s.
- **Keys.**
  - A named agent (default `kokoah-web`; the app gives each device its own name, e.g. `kokoah-a1b2`) with `valid_until` ≤ 30 days; a fresh key every time, never reused.
  - Stored as `device` (the default: AES-GCM with a **non-extractable** key in IndexedDB), `passkey` (WebAuthn PRF → HKDF → AES-GCM; unlocking needs user verification: the device PIN or biometric) or `session` (memory only). `setStorageMode` moves an existing key between `device` and `passkey` with no new approval.
  - `device` keeps the key from other origins and from JavaScript export, **not** from a copied browser profile (Chromium stores the non-extractable key's bytes beside the ciphertext) or script running on the signer origin. `passkey` needs the authenticator and user verification. The origin's deploy integrity is the real trust anchor (see the threat model).
- **Nonces.** `max(now + HL clock offset, last + 1)`, serialized per agent with Web Locks and reserved atomically in IndexedDB, so tabs can't collide.
- **Hardening.**
  - Strict CSP: the infra header plus a `<meta>` copy with `connect-src` limited to this network's HL host.
  - Trusted Types `'none'`: no HTML sinks anywhere.
  - No inline scripts or styles, no eval.
  - SRI on every script and style, and a release manifest.
  - The key and signatures never appear in any message or log line (tested). A final guard refuses to post any 64-hex value.
- **Network.** **Testnet by default.** A mainnet build requires `VITE_ALLOW_MAINNET_WRITES=true`, and `hello`/`getStatus` report the network.

## Commands

Node 24 (`.nvmrc`) and pnpm 10.34.5 through corepack. No global installs.

```sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck        # tsc --noEmit over src, test, dev, scripts
corepack pnpm test             # vitest + jsdom + fake-indexeddb; no network (fetch is mocked)
corepack pnpm build            # frame → dist/ + release-manifest.json, client → dist-client/
corepack pnpm check            # all three
corepack pnpm dev              # dev harness (see below)
corepack pnpm test:integration # read-only HL *testnet* /info checks (HL_INTEGRATION=testnet); never /exchange
corepack pnpm smoke:browser    # real-browser checks in headless Chromium (needs Chromium; CHROME_PATH to override)
```

`pnpm build` runs:
1. `vite build`: static output with content-hashed assets, a CSP `<meta>` and no inline script.
2. [`scripts/postbuild.ts`](scripts/postbuild.ts), which:
   - adds `integrity="sha384-…"` to every script and stylesheet;
   - fails on inline scripts or styles, third-party resources, `eval`/`new Function`, source maps, dev-harness code, a CSP `<meta>` that differs from the configuration, `_headers` whose `frame-ancestors`/`connect-src` don't match the configuration or whose `Permissions-Policy` doesn't allow WebAuthn for `self`, or (when kokoah-infra is checked out next to this repo) `_headers` that differ from kokoah-infra's signer copy in anything but deployment-specific origins (`frame-ancestors`, the CSP report endpoint);
   - writes **`release-manifest.json`** (`kokoah.release-manifest/v1`, see kokoah-infra `docs/RELEASE_MANIFEST.md`). The output is byte-identical to kokoah-infra's own `release-manifest.ts` for the same inputs.
3. `tsc -p tsconfig.client.json`: the client and protocol types into `dist-client/`.

Build output:

| Path | What |
|---|---|
| `dist/` | The site: `index.html`, `assets/index-<hash>.js`, `assets/style-<hash>.css`, `_headers` |
| `release-manifest.json` | SHA-384 of every deployed file (`_headers` excluded), site, version, commit, build time. CI regenerates it with the vendored kokoah-infra tool (`tools/kokoah-infra/`), attests it and publishes it |
| `dist-client/` | `client/index.{js,d.ts}`, `protocol/index.{js,d.ts}` for `@kokoah/signer-frame/client` |

## Build configuration

Every value is a **public, build-time** `VITE_*` variable. It is validated by [`src/frame/config.ts`](src/frame/config.ts) at build time (the build fails) and again at startup (the frame refuses to run). See [`.env.example`](.env.example).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VITE_HL_NETWORK` | no | `testnet` | `testnet` or `mainnet`; anything else is an error |
| `VITE_ALLOW_MAINNET_WRITES` | for mainnet | `false` | Must be exactly `true` for a mainnet build, otherwise the build fails. The shared write guard (`assertWriteAllowed`) enforces it again at signing time |
| `VITE_ALLOWED_PARENT_ORIGINS` | yes | – | Comma-separated exact origins allowed to talk to the frame. HTTPS only in production builds. **Must match `frame-ancestors` in `public/_headers`** (postbuild checks it) |
| `VITE_BUILDER_ADDRESS` | yes | – | Kokoah builder address, attached to every order. Must equal the backend's `public-config` builder (the frontend compares them after `hello`) |
| `VITE_BUILDER_FEE_TENTHS_BPS` | yes | – | Builder fee in tenths of a basis point (25 = 0.025%), 0–100 |
| `VITE_AGENT_NAME` | no | `kokoah-web` | Default agent name, 1–16 characters |
| `VITE_HL_REFERRAL_CODE` | no | – | Kokoah's Hyperliquid referral code (1–20 of `A–Z a–z 0–9 _ -`), the only code `setReferrer` may carry; keep it equal to the backend's `HL_REFERRAL_CODE`. Unset: `setReferrer` is denied |
| `VITE_ELIGIBILITY_URL` | no | – | Kokoah's region check, `GET /v1/eligibility` on its API (https; http only to localhost in development). The frame asks it itself before signing anything that adds risk and refuses with `REGION_BLOCKED` where the region is blocked; its origin joins `connect-src`. Unset: no check (development and tests) |
| `VITE_HL_API_URL_OVERRIDE` | no | – | **Development builds only** (dev harness mock/proxy). Rejected in production builds |

Post-build variables (not in the bundle):
- `SIGNER_SITE_ORIGIN`: the manifest's `site`; default `https://signer.kokoah.example`;
- `RELEASE`: default the commit;
- `GIT_COMMIT` / `GITHUB_SHA`;
- `SOURCE_DATE_EPOCH`.

**`.env.production` is committed with placeholders** so that `pnpm build` works out of the box: testnet, the infra placeholder domain, and builder `0x…0001`. A real deploy **must** set every variable in the pipeline's environment; environment variables override the file. The placeholder builder fails closed: HL rejects orders for a builder the user never approved, the frontend refuses to trade when `hello.builder` differs from `public-config`, and postbuild refuses a mainnet build with it. `.env.development` configures `pnpm dev`.

## Deploying

- **Its own origin, its own deploy.**
  - Serve `dist/` as a purely static site on the signer origin (a Cloudflare Pages project or an S3/CloudFront distribution), separate from the app.
  - Keep it **same-site** with the app (both under the same registrable domain). Otherwise browsers treat the frame as third-party: Safari partitions or deletes its storage, and passkeys, IndexedDB and Web Locks behave differently.
- **Headers.**
  - `public/_headers` is a verbatim copy of kokoah-infra `headers/cloudflare/signer/_headers`; CloudFront uses `signer.response-headers-policy.json`.
  - `frame-ancestors` must list exactly the app origin(s) in `VITE_ALLOWED_PARENT_ORIGINS`. A staging build needs the staging copy of the headers (replace `public/_headers`); postbuild fails on a mismatch.
  - `frame-ancestors`, `report-to` and `report-uri` can't be set from `<meta>`, so they exist only in the header. **Deploying without the headers leaves the frame embeddable by anyone.** The origin checks in the frame still hold, but clickjacking protection is lost.
- **Cache.**
  - `/assets/*`: `public, max-age=31536000, immutable`.
  - `index.html`: revalidating.
  - There is no service worker.
- **Turn off every CDN feature that rewrites HTML or injects scripts** (Rocket Loader, Email Obfuscation, Web Analytics, Zaraz). They break SRI and CSP and make the served HTML differ from the manifest.
- **Release integrity.** CI (`.github/workflows/ci.yml`, copied from kokoah-infra `ci/workflows/static-site.yml`):
  - builds;
  - regenerates the manifest with `tools/kokoah-infra/release-manifest.ts --no-inline`;
  - attests it with Sigstore and publishes it on tags.
  
  After deploying, run `monitor-deploy` from kokoah-infra against the signer domain.
- **Vercel.** `kokoah-infra/vercel` builds the frame from its commit with the deployment's origins in `_headers`, serves those headers through the Build Output routes and checks the live headers after each deploy.
- **Mainnet.** Set `VITE_HL_NETWORK=mainnet` **and** `VITE_ALLOW_MAINNET_WRITES=true`, the real builder and the real app origin, in the production pipeline only. On an origin that served testnet, a mainnet build ignores the testnet key and limits stored there (keys, limits, locks and broadcasts are per network): users create a new trading key. HLP deposits go to mainnet's HLP (`0xdfc24b077bc1425ad1dea75bcb6f8158e10df303`) within 10,000 USDC per deposit and 25,000 per 24 hours.

### Requested kokoah-infra changes

These aren't in this repo's power; they are for the kokoah-infra owners.

1. **Passkey mode needs WebAuthn on the signer origin. Done (2026-09-22).** kokoah-infra now sends `publickey-credentials-create=(self), publickey-credentials-get=(self)` on the signer, and the app delegates both to the signer origin (`(self "https://signer.kokoah.example")`). When replacing the placeholder domains, keep the app's delegation in sync with the real signer origin. `public/_headers` is identical to kokoah-infra's copy, and `pnpm build` fails if it drifts or disables WebAuthn again. `pnpm smoke:browser` serves the real header and verifies both states in Chromium: the full PRF flow with the signer's own headers, and the fallback when the app doesn't delegate WebAuthn.
2. **Mainnet builds (2026-10-05).** `kokoah-infra/vercel/build.sh` builds testnet only and doesn't pass `VITE_ALLOW_MAINNET_WRITES`; a mainnet frame build needs `VITE_HL_NETWORK=mainnet` and `VITE_ALLOW_MAINNET_WRITES=true` (without the second, `vite build` fails by design).
3. Chrome for Testing 153 logs "Unrecognized feature: 'bluetooth'" and "'browsing-topics'" for the signer `Permissions-Policy`. This is harmless, but noisy in the console.
3. A staging signer needs its own `_headers` (staging `frame-ancestors`).

## Frontend integration (kokoah-frontend)

1. **Link the package** (pnpm):
   ```jsonc
   // kokoah-frontend/package.json
   "dependencies": {
     "@kokoah/shared": "link:../kokoah-shared",
     "@kokoah/signer-frame": "link:../kokoah-signer-frame"
   }
   ```
   `dist-client/` is git-ignored: build it once after cloning or pulling:
   ```sh
   (cd ../kokoah-signer-frame && corepack pnpm install --frozen-lockfile && corepack pnpm build)   # or: corepack pnpm build:client
   ```
   The client has **no runtime dependencies**; its types reference `@kokoah/shared`.
2. **Create one client at startup** (`VITE_SIGNER_FRAME_URL`, e.g. `https://signer.kokoah.example/`). It creates a hidden iframe with `allow="publickey-credentials-get; publickey-credentials-create"`. The app's CSP needs `frame-src` for the signer origin (the infra app policy has it).
   ```ts
   import { KokoahSignerClient, SignerRequestError } from "@kokoah/signer-frame/client";
   export const signer = new KokoahSignerClient({ frameUrl: import.meta.env.VITE_SIGNER_FRAME_URL });
   ```
3. **Subscribe to events first, then handshake, and refuse to trade on any mismatch:**
   ```ts
   signer.on("statusChanged", setSignerStatus);          // before hello: keyExpiringSoon/keyExpired fire right after it
   signer.on("keyExpiringSoon", showRenewBanner);
   const hello = await signer.hello();
   setSignerStatus(hello.status);                         // status.expiringSoon / status.expired / status.expiresAt
   const ok = hello.network === env.VITE_HL_NETWORK
     && hello.builder.address === publicConfig.builder.address.toLowerCase()
     && hello.builder.feeTenthsBps === publicConfig.builder.feeTenthsBps;
   ```
4. **Events.**
   - `statusChanged`: key state for the banners in §B6.1.
   - `keyExpiringSoon` / `keyExpired`: renew banner. They fire once per key per frame load; `hello.status` and `getStatus()` carry the same state (`expiringSoon`, `expired`, `expiresAt`), so drive the banner from the status.
   - `promptChanged`: while `visible`, the iframe **must be shown and clickable**. The client unhides it and sets `data-kokoah-signer-prompt`; style it as a modal:
     ```css
     iframe[data-kokoah-signer] { position: fixed; inset: 0; margin: auto; width: min(420px, 92vw); height: min(480px, 92vh); border: 0; border-radius: 12px; z-index: 1000; box-shadow: 0 10px 40px rgb(0 0 0 / 0.5); }
     ```
   - `reconnected` (client-side, payload: the new `HelloResult`): the frame reloaded and the client re-ran `hello` with the same params. The new frame has forgotten the theme, remembered `requestId`s and an unlocked passkey key; it keeps the user limits it stores. Re-check `network`/`builder`, re-apply `setLimits` (a no-op when unchanged) and `setTheme` in the listener (requests the listener starts synchronously go out before requests that waited for the reconnect), and refresh the status from `hello.status`:
     ```ts
     signer.on("reconnected", (hello) => { checkHello(hello); void signer.setLimits(limits); void signer.setTheme(theme); setSignerStatus(hello.status); });
     ```
   - Call `setTheme({ variables: { "--ks-accent": … }, colorScheme })` to match the app.
5. **Enable trading (J3):**
   ```ts
   import { buildExchangeRequest, getNetworkConfig, signatureFromHex } from "@kokoah/shared";
   const net = getNetworkConfig(env.VITE_HL_NETWORK === "mainnet" ? "mainnet" : "testnet");
   const created = await signer.createAgent({ userAddress, validForDays: 30, storageMode, signatureChainId: toHex(wallet.chainId) });
   // show created.agentAddress, agentName, validUntil and the permissions, then:
   const sig = signatureFromHex(await wallet.signTypedData(created.approveAgent.typedData));
   const body = buildExchangeRequest({ network: net, action: created.approveAgent.action, nonce: created.approveAgent.nonce, signature: sig });
   await fetch(net.exchangeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
   await signer.confirmAgent({ timeoutMs: 20_000 });
   ```
   `buildExchangeRequest` guards mainnet writes; posting user-signed actions to mainnet from the app needs the mainnet network config (`getNetworkConfig("mainnet", { allowMainnetWrites: true })`) in the production build only. Renew with `createAgent({ …, replaceExisting: true })`.
6. **Trade (J4/J5):**
   ```ts
   const r = await signer.signAndSubmit({ requestId: crypto.randomUUID(), intent });
   if (r.status === "unknown") pollOrderStatusByCloid(r.cloids[0]);  // never resubmit with a new requestId
   ```
   Show `r.marketOrder` (mid and IOC price signed) for market orders, `r.outcome.statuses` for `ok`, and `r.error` for `rejected`. The final state comes from the WebSocket. With `hello.capabilities.confirmsLargeOrders`, orders above `hello.limits.confirmOrdersAboveUsd` ($25,000 in all, reduce-only included) wait for the user's press and hold in the frame (`promptChanged` kind `order`): tell the user to confirm in the signer window, keep the iframe reachable, and treat `USER_CANCELLED` / `USER_TIMEOUT` as "nothing was sent". See [PROTOCOL `signAndSubmit`](docs/PROTOCOL.md#signandsubmit).
7. **Security center (J11):** `revoke()` → sign `revokeAgent.typedData` → post it like step 5. If the result has `wipeError` (`wiped: false`), the stored copy couldn't be deleted: still post `revokeAgent`, tell the user, and call `revoke()` again.
8. **Link phone:** on the phone, after claiming the pairing, `createLinkedAgent({ userAddress, agentName, validForDays: 30, storageMode: "device", link: { pairingId, secret } })` returns the pending key's address, expiry and the 6-digit `matchCode` to show; the computer approves the key with its main wallet, then the phone calls `confirmAgent`. See [PROTOCOL §12](docs/PROTOCOL.md#12-link-phone).
9. **Settings (§B11.4):** `setLimits({...})` after every `hello` and on every `reconnected`; the frame stores the limits, so identical ones change nothing. Tightening applies at once. With `hello.capabilities.confirmsLooserLimits`, anything looser (a higher number, `{}`, spot trading on, …) waits for the user's click on the frame's prompt (`promptChanged` kind `limits`; tell the user to confirm in the signer window), and cancel or timeout leave the limits as they were (`USER_CANCELLED` / `USER_TIMEOUT`). Above the baseline: `LIMIT_LOOSENING_REJECTED`. See [PROTOCOL `setLimits`](docs/PROTOCOL.md#setlimits).
10. **Errors:** `SignerRequestError.code` is one of the `SignerErrorCode`s in [PROTOCOL §6](docs/PROTOCOL.md#6-errors), with recommended handling.

## Dev harness

`corepack pnpm dev` starts two Vite dev servers on two origins, like production:
- the **harness** (a stand-in for the app): `http://localhost:47801`;
- the **frame**: `http://localhost:47802`.

The harness page ([`dev/`](dev/)):
- embeds the frame through `KokoahSignerClient`;
- has a throwaway in-memory "main wallet" that signs `approveAgent`/`revokeAgent`;
- has buttons for every method and intent templates (including denied ones);
- shows every response and event.

Ports can be changed with `DEV_HARNESS_PORT` and `DEV_FRAME_PORT`; `0` picks free ports.

- **HL traffic goes to the harness's `/hl` mock** ([`dev/mock-hl.ts`](dev/mock-hl.ts)). `/exchange` is **never forwarded**: the mock verifies the agent signature with shared `recoverL1Signer`, checks expiry and nonce reuse, and answers like HL.
- `DEV_HL_MODE=testnet` makes `/hl/info` a **read-only** proxy to HL testnet `/info` (real market data). `extraAgents` stays simulated.
- In dev mode the frame has no CSP `<meta>` (Vite's dev client uses inline code). Use `pnpm smoke:browser` for CSP checks.
- `dev/` is excluded from the production build, and postbuild fails if harness code shows up in `dist/`.

## Tests

`corepack pnpm test` runs the vitest suite in jsdom with fake-indexeddb and a mocked HL API. It covers:
- **origin allowlist**: wrong origin or source ignored and counted; replies only to the exact origin;
- **validation**: malformed and oversized messages;
- **`createAgent`**: named agent with `valid_until`; typed data equal to shared `buildApproveAgent`; a fresh address every time; reuse refused;
- **`confirmAgent`**: HL `extraAgents`, polling, expiry clamping;
- **`createLinkedAgent`** (Link phone): a fresh pending key, the matching code over exactly that key, no typed data, the link secret never echoed, strict params;
- **signing happy path**: signer recovered with shared `recoverL1Signer` equals the agent; body equals shared `buildExchangeRequest` of shared `compileAction`; builder present;
- **results**: `ok`, `rejected`, `unknown`; `requestId` idempotency;
- **policy denials**: vault/transfer/withdraw wire actions, builder mismatch or missing, price band, leverage (market maximum and tightened), per-minute rate (persisted across reloads), notional, coins, stop-loss, origin; `setLimits` above the baseline rejected and tightening applied;
- **stored limits**: survive a reload and need no key; bind another tab (with and without BroadcastChannel, and while a signature waits for the lock); tightening and identical limits never prompt; every kind of loosening prompts and lists its changes; cancel and timeout change nothing; a confirmation against limits changed meanwhile is refused; the same for sub-account limits;
- **prices**: parent-supplied prices impossible or ignored; HL's mark is used;
- **expiry**: an expired key refuses to sign; `keyExpiringSoon` / `keyExpired`;
- **storage**: `device` round-trip (ciphertext only, non-extractable key, tamper detection); `session` wiped on reload; `passkey` with a mocked PRF (prompt, second click, cancel/retry, timeout, wrong PRF, fallbacks, credential reuse);
- **nonces**: strictly increasing across concurrent calls and across two simulated tabs sharing IndexedDB, with and without Web Locks;
- **`revoke`**: wipes the key in this tab and in others;
- **leaks**: the key and signatures never appear in any posted message or log line;
- **config and CSP**: config validation; the meta CSP ⊆ the infra header CSP;
- **postbuild**: SRI, manifest;
- **the client**: against a real `FrameCore`, including prompt visibility, timeouts, origin filtering and `destroy`.

Two more suites run on demand:
- `test/integration/` is **read-only** HL testnet `/info` and is skipped unless `HL_INTEGRATION=testnet`.
- `pnpm smoke:browser` drives headless Chromium over the DevTools protocol, with 26 checks listed in [`scripts/smoke-browser.ts`](scripts/smoke-browser.ts):
  - the real CSP, Trusted Types and SRI with no violations;
  - HTML sinks and foreign `fetch` blocked;
  - `frame-ancestors` enforced;
  - cross-site `postMessage`;
  - IndexedDB persistence with a non-extractable key;
  - the client's automatic re-handshake (`reconnected`) when only the iframe reloads;
  - the signer's real `Permissions-Policy` (served unchanged) allowing WebAuthn, and the passkey fallback when the app doesn't delegate it;
  - the full WebAuthn **PRF** flow with a virtual authenticator when WebAuthn is allowed.

## Manual verification (can't be automated here)

- **Real authenticators and PRF.** Chrome (Google Password Manager, security keys), Safari 18+ (iCloud Keychain), Firefox 139+, Windows Hello and Android, each in a **cross-origin iframe** with a user click. Check `hello.capabilities.passkey`, create, reload, unlock, and the fallback when PRF is unsupported. PRF support per platform is uncertain (research B §2.2).
- **Deployed headers.** Run kokoah-infra `check-domain` against the signer domain. Confirm `frame-ancestors`, CSP and Permissions-Policy, and that no CDN feature rewrote the HTML (compare with `release-manifest.json` using `monitor-deploy`).
- **Testnet end to end** (kokoah-frontend E2E suite with a funded throwaway testnet wallet): `approveAgent` → `confirmAgent` → order with builder fee → cancel → revoke. It should confirm three things:
  - that HL accepts the frame's named agent with `valid_until`;
  - that the zero-address revoke deregisters it (shared issue #6);
  - that `expiresAfter` of 15 s is accepted.
- **Safari/iOS storage.** Behaviour of IndexedDB and the 7-day storage cap for the signer frame inside the app and the installed PWA.

## Repository layout

| Path | What |
|---|---|
| `src/protocol/` | Protocol types and constants (shared by the frame and the client; no runtime deps) |
| `src/client/` | `KokoahSignerClient` |
| `src/frame/` | The frame. `core.ts` (messages, lifecycle, signing), `policy.ts`, `nonces.ts`, `storage.ts`, `crypto.ts`, `passkey.ts`, `market-data.ts`, `hl.ts`, `messages.ts`, `prompt.ts`, `config.ts`, `errors.ts`, `log.ts`, `main.ts` |
| `index.html`, `public/_headers` | Frame page and headers |
| `scripts/postbuild.ts`, `scripts/smoke-browser.ts` | SRI, checks and manifest; real-browser smoke test |
| `dev/` | Dev harness (never built into `dist/`) |
| `test/` | Vitest suite; `test/integration/` is read-only testnet |
| `tools/kokoah-infra/` | Vendored kokoah-infra scripts for CI (`VERSION` lists their hashes) |

## Known gaps / TODO

- **Out-of-policy orders are denied, not confirmed** (SECURITY_BASELINE §3 asks for a confirmation). Orders above $25,000 in one action already need the user's press and hold in the frame.
- **Tune the baseline limits.** $250,000 per order and a 5% band (since 2026-10-14) are still wide backstops, and $25M per day is unchanged.
- **Clickjacking of the in-frame prompt is harder, not impossible.** The button needs the user's own pointer movement and, for loosening, HLP deposits and large orders, a press and hold; without IntersectionObserver v2 (Firefox, Safari, iOS) a transparent frame under a decoy can't be detected (THREAT_MODEL §5 item 2).
- **Loosening limits relies on the user reading the frame's prompt**; the clickjacking caveat above applies (THREAT_MODEL A23).
- **Outcome markets aren't supported, nor unverified spot tokens** (`UNSUPPORTED_MARKET`): spot is limited to
  Convert's stablecoin pairs and, once the user turns spot trading on, the verified pairs (Hyperliquid's "Strict" list),
  with no trigger orders.
- **The shared-library workarounds** listed in `docs/SHARED_ISSUES.md`.
