/**
 * Key wrapping with WebCrypto. WebCrypto has no secp256k1, so the agent key itself is raw bytes in JavaScript; what
 * WebCrypto gives us is a **non-extractable AES-GCM key** to encrypt those bytes at rest:
 *
 * - `device` mode: a random AES-GCM-256 key generated with `extractable: false` and stored in IndexedDB (a CryptoKey
 *   is structured-cloneable and stays non-extractable). A copy of the IndexedDB files is useless without the browser
 *   profile's key store; but any script running on the signer origin can call `decrypt` with it.
 * - `passkey` mode: `HKDF-SHA-256(PRF output, salt) → AES-GCM-256` (non-extractable). The PRF output only exists after
 *   a WebAuthn assertion with user presence, so the key can't be unwrapped silently.
 *
 * The ciphertext is bound to its metadata with AES-GCM additional data (network, storage mode, agent address).
 *
 * @module
 */
import type { NetworkName } from "../protocol/index.js";
import type { WrappedSecret } from "./storage.js";

/** HKDF `info` for the passkey wrapping key. Changing it makes existing passkey records undecryptable. */
export const PRF_HKDF_INFO = "kokoah-signer-frame/v1 agent-key-wrap";

/** Copies bytes into a fresh ArrayBuffer-backed view (WebCrypto wants `ArrayBuffer`, not `SharedArrayBuffer`). */
export function bytes(u: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const src = u instanceof Uint8Array ? u : new Uint8Array(u);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

/** Overwrites a byte array with zeros (best effort: JS strings and engine copies can't be wiped). */
export function wipe(u: Uint8Array | undefined): void {
  if (u) u.fill(0);
}

export function randomBytes(crypto: Crypto, n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(out);
  return out;
}

/** Additional authenticated data binding a ciphertext to its record. */
export function keyAad(network: NetworkName, storageMode: "device" | "passkey", agentAddress: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(`kokoah-signer/v1|${network}|${storageMode}|${agentAddress.toLowerCase()}`));
}

/** A fresh, non-extractable AES-GCM-256 key for `device` mode. */
export async function generateDeviceKey(crypto: Crypto): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Derives the non-extractable AES-GCM-256 wrapping key from a WebAuthn PRF output. */
export async function deriveKeyFromPrf(crypto: Crypto, prfOutput: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  if (prfOutput.byteLength < 32) throw new RangeError("PRF output must be at least 32 bytes");
  const base = await crypto.subtle.importKey("raw", bytes(prfOutput), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(hkdfSalt), info: bytes(new TextEncoder().encode(PRF_HKDF_INFO)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts the secret with a random 96-bit IV. */
export async function wrapSecret(crypto: Crypto, key: CryptoKey, secret: Uint8Array, aad: Uint8Array): Promise<WrappedSecret> {
  const iv = randomBytes(crypto, 12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(aad), tagLength: 128 }, key, bytes(secret));
  return { alg: "AES-GCM", iv, data: new Uint8Array(data) };
}

/** Decrypts and authenticates the secret (throws on a wrong key or tampered record). */
export async function unwrapSecret(crypto: Crypto, key: CryptoKey, wrapped: WrappedSecret, aad: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (wrapped.alg !== "AES-GCM") throw new Error("Unsupported wrapping algorithm");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(wrapped.iv), additionalData: bytes(aad), tagLength: 128 }, key, bytes(wrapped.data));
  return new Uint8Array(plain);
}
