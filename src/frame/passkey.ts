/**
 * WebAuthn PRF access for `passkey` mode. The ceremonies run **inside the frame**, started from a click on the frame's
 * own prompt (WebAuthn needs transient user activation in the calling document, and cross-origin iframes also need
 * `allow="publickey-credentials-create; publickey-credentials-get"` on the iframe plus a Permissions-Policy that allows
 * them on the signer origin).
 *
 * The frame never verifies an assertion signature (there is no server); it uses WebAuthn only to obtain the PRF
 * secret, which the authenticator releases after user presence.
 *
 * @module
 */
import type { PasskeySupport } from "../protocol/index.js";
import { bytes, randomBytes } from "./crypto.js";

/** Classified passkey failure. */
export class PasskeyError extends Error {
  /** `unsupported`: fall back to `device`. `cancelled`: the user dismissed the dialog (or it timed out). */
  readonly code: "unsupported" | "cancelled" | "failed";
  constructor(code: PasskeyError["code"], message: string) {
    super(message);
    this.name = "PasskeyError";
    this.code = code;
  }
}

export interface PasskeyCreateOptions {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  userDisplayName: string;
  /** PRF input (the browser hashes it with a WebAuthn-specific context before use). */
  prfSalt: Uint8Array;
  timeoutMs: number;
}

export interface PasskeyCreateResult {
  credentialId: Uint8Array;
  /** `prf.enabled` from the creation response (undefined: the browser didn't say). */
  prfEnabled: boolean | undefined;
  /** Some authenticators already return the PRF output at creation. */
  prfFirst: Uint8Array | undefined;
}

export interface PasskeyGetOptions {
  rpId: string;
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  timeoutMs: number;
}

/** What the frame needs from WebAuthn (a real implementation below, mocks in tests). */
export interface PasskeyProvider {
  support(): Promise<PasskeySupport>;
  create(options: PasskeyCreateOptions): Promise<PasskeyCreateResult>;
  get(options: PasskeyGetOptions): Promise<{ prfFirst: Uint8Array }>;
}

interface PrfExtensionResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | ArrayBufferView; second?: ArrayBuffer | ArrayBufferView };
}

interface PermissionsPolicyLike {
  allowsFeature(feature: string): boolean;
}

function toU8(x: ArrayBuffer | ArrayBufferView | undefined): Uint8Array | undefined {
  if (x === undefined) return undefined;
  if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
  return new Uint8Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
}

function classify(e: unknown): PasskeyError {
  const name = e instanceof Error || (typeof e === "object" && e !== null && "name" in e) ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled", "The passkey request was cancelled or timed out.");
  if (name === "NotSupportedError" || name === "SecurityError") return new PasskeyError("unsupported", `Passkeys are not usable here (${name}).`);
  return new PasskeyError("failed", `The passkey request failed${name ? ` (${name})` : ""}.`);
}

/** WebAuthn-backed provider for the browser. */
export class WebAuthnPasskeyProvider implements PasskeyProvider {
  private readonly win: Window;
  constructor(win: Window) {
    this.win = win;
  }

  async support(): Promise<PasskeySupport> {
    const w = this.win as Window & { PublicKeyCredential?: typeof PublicKeyCredential };
    if (!w.isSecureContext) return { available: false, prf: "unknown", reason: "not a secure context" };
    if (typeof w.PublicKeyCredential !== "function" || typeof w.navigator.credentials?.create !== "function") {
      return { available: false, prf: "unknown", reason: "WebAuthn is not available in this browser" };
    }
    const doc = w.document as Document & { permissionsPolicy?: PermissionsPolicyLike; featurePolicy?: PermissionsPolicyLike };
    const pp = doc.permissionsPolicy ?? doc.featurePolicy;
    if (pp && typeof pp.allowsFeature === "function") {
      if (!pp.allowsFeature("publickey-credentials-create") || !pp.allowsFeature("publickey-credentials-get")) {
        return { available: false, prf: "unknown", reason: "WebAuthn is blocked by Permissions-Policy in the signer frame" };
      }
    }
    const pkc = w.PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
    if (typeof pkc.getClientCapabilities === "function") {
      try {
        const caps = await pkc.getClientCapabilities();
        if (typeof caps["extension:prf"] === "boolean") {
          return caps["extension:prf"] ? { available: true, prf: "supported" } : { available: false, prf: "unsupported", reason: "the WebAuthn PRF extension is not supported" };
        }
      } catch {
        // fall through: unknown
      }
    }
    return { available: true, prf: "unknown" };
  }

  async create(o: PasskeyCreateOptions): Promise<PasskeyCreateResult> {
    const crypto = this.win.crypto;
    let cred: Credential | null;
    try {
      cred = await this.win.navigator.credentials.create({
        publicKey: {
          rp: { id: o.rpId, name: o.rpName },
          user: { id: bytes(o.userId), name: o.userName, displayName: o.userDisplayName },
          challenge: randomBytes(crypto, 32),
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          attestation: "none",
          timeout: o.timeoutMs,
          extensions: { prf: { eval: { first: bytes(o.prfSalt) } } } as AuthenticationExtensionsClientInputs,
        },
      });
    } catch (e) {
      throw classify(e);
    }
    if (cred === null || !("rawId" in cred)) throw new PasskeyError("failed", "No credential was created.");
    const pk = cred as PublicKeyCredential;
    const ext = pk.getClientExtensionResults() as { prf?: PrfExtensionResults };
    return {
      credentialId: new Uint8Array(pk.rawId.slice(0)),
      prfEnabled: ext.prf?.enabled,
      prfFirst: toU8(ext.prf?.results?.first),
    };
  }

  async get(o: PasskeyGetOptions): Promise<{ prfFirst: Uint8Array }> {
    let cred: Credential | null;
    try {
      cred = await this.win.navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(this.win.crypto, 32),
          rpId: o.rpId,
          allowCredentials: [{ type: "public-key", id: bytes(o.credentialId) }],
          userVerification: "preferred",
          timeout: o.timeoutMs,
          extensions: { prf: { eval: { first: bytes(o.prfSalt) } } } as AuthenticationExtensionsClientInputs,
        },
      });
    } catch (e) {
      throw classify(e);
    }
    if (cred === null || !("rawId" in cred)) throw new PasskeyError("failed", "No passkey assertion was returned.");
    const ext = (cred as PublicKeyCredential).getClientExtensionResults() as { prf?: PrfExtensionResults };
    const first = toU8(ext.prf?.results?.first);
    if (!first) throw new PasskeyError("unsupported", "The passkey did not return a PRF result (the authenticator may not support PRF).");
    return { prfFirst: first };
  }
}

/** Provider for environments without WebAuthn. */
export class UnavailablePasskeyProvider implements PasskeyProvider {
  private readonly reason: string;
  constructor(reason = "WebAuthn is not available") {
    this.reason = reason;
  }
  async support(): Promise<PasskeySupport> {
    return { available: false, prf: "unknown", reason: this.reason };
  }
  async create(): Promise<PasskeyCreateResult> {
    throw new PasskeyError("unsupported", this.reason);
  }
  async get(): Promise<{ prfFirst: Uint8Array }> {
    throw new PasskeyError("unsupported", this.reason);
  }
}
