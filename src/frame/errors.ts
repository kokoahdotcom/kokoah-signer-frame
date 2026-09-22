/**
 * Frame-side error type and the guard that every outgoing message passes.
 *
 * @module
 */
import type { SignerError, SignerErrorCode } from "../protocol/index.js";

/** An error answered to the parent as `{ ok: false, error }`. */
export class SignerFailure extends Error {
  readonly code: SignerErrorCode;
  readonly retryable: boolean;
  readonly details: SignerError["details"] | undefined;
  constructor(code: SignerErrorCode, message: string, options: { retryable?: boolean; details?: SignerError["details"] } = {}) {
    super(message);
    this.name = "SignerFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): SignerError {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

/** A run of 64 hex digits: the shape of a private key, a signature half (`r`/`s`) or a hash. */
const HEX64 = /(?:0x)?[0-9a-fA-F]{64}/g;

/** Replaces every 64-hex-digit run in strings (deeply) with a marker. Used on data relayed from HL. */
export function redactHex64<T>(value: T, depth = 0): T {
  if (depth > 32) return null as T;
  if (typeof value === "string") return value.replace(HEX64, "[redacted]") as T;
  if (Array.isArray(value)) return value.map((x) => redactHex64(x, depth + 1)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactHex64(v, depth + 1);
    return out as T;
  }
  return value;
}

/**
 * Last line of defense before `postMessage`: an outgoing message must be plain JSON data (no binary buffers, keys or
 * functions) and must not contain any 64-hex-digit run (private keys, signature `r`/`s`). Returns a reason when the
 * message must not be sent.
 */
export function outgoingProblem(message: unknown): string | null {
  const walk = (x: unknown, depth: number): string | null => {
    if (depth > 32) return "too deep";
    if (x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean" || x === undefined) return null;
    if (typeof x === "function" || typeof x === "symbol" || typeof x === "bigint") return `contains a ${typeof x}`;
    if (x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return "contains binary data";
    if (typeof CryptoKey !== "undefined" && x instanceof CryptoKey) return "contains a CryptoKey";
    if (Array.isArray(x)) {
      for (const y of x) {
        const p = walk(y, depth + 1);
        if (p) return p;
      }
      return null;
    }
    if (typeof x === "object") {
      const proto = Object.getPrototypeOf(x) as unknown;
      if (proto !== Object.prototype && proto !== null) return "contains a non-plain object";
      for (const y of Object.values(x as Record<string, unknown>)) {
        const p = walk(y, depth + 1);
        if (p) return p;
      }
      return null;
    }
    return "contains an unsupported value";
  };
  const structural = walk(message, 0);
  if (structural) return structural;
  let json: string;
  try {
    json = JSON.stringify(message) ?? "";
  } catch {
    return "not serializable";
  }
  HEX64.lastIndex = 0;
  if (HEX64.test(json)) return "contains a 64-hex-digit value (key or signature material)";
  return null;
}
