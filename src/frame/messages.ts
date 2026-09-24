/**
 * Strict validation of incoming requests. Everything the parent sends is untrusted: envelopes and params are checked
 * against exact schemas (unknown keys rejected), strings are length-capped and the whole message is size-capped
 * before any other work happens. Intents are validated separately with `@kokoah/shared` `safeParseActionIntent`.
 *
 * @module
 */
import { LINK_PAIRING_ID_PATTERN, LINK_SECRET_PATTERN } from "@kokoah/shared/link";
import * as v from "valibot";
import {
  BASELINE_ACTION_TYPES,
  ID_PATTERN,
  MAX_AGENT_NAME_LENGTH,
  MAX_CONFIRM_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_VALID_FOR_DAYS,
  METHODS,
  MIN_VALID_FOR_DAYS,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  REQUEST_ID_PATTERN,
  THEME_VARIABLES,
  type MethodName,
  type MethodParams,
} from "../protocol/index.js";

const Address = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 0x-prefixed 20-byte hex address"),
  v.transform((x) => x.toLowerCase() as `0x${string}`),
);
const ChainIdHex = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{1,16}$/, "Must be a hex chain id"),
  v.transform((x) => x.toLowerCase() as `0x${string}`),
);
const AgentName = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9._-]+$/, "Agent name may contain A-Z a-z 0-9 . _ - only"),
  v.maxLength(MAX_AGENT_NAME_LENGTH),
  v.check((x) => !/valid_until/.test(x), 'Agent name must not contain "valid_until"'),
);
const Empty = v.strictObject({});
const PositiveFinite = v.pipe(v.number(), v.finite(), v.minValue(0));
// Echoed in every status: no run of 64 hex digits, which the outgoing guard would refuse to post (no HL coin has one).
const Coin = v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.regex(/^(?!.*[0-9A-Fa-f]{64})\S+$/, "Coin must be an HL coin name (no spaces, no run of 64 hex digits)"));

/** Per-method params schemas. */
export const PARAMS_SCHEMAS = {
  hello: v.strictObject({
    protocolVersion: v.number(),
    client: v.optional(v.strictObject({ name: v.pipe(v.string(), v.maxLength(64)), version: v.pipe(v.string(), v.maxLength(64)) })),
  }),
  getStatus: Empty,
  createAgent: v.strictObject({
    userAddress: Address,
    validForDays: v.pipe(v.number(), v.integer(), v.minValue(MIN_VALID_FOR_DAYS), v.maxValue(MAX_VALID_FOR_DAYS)),
    storageMode: v.picklist(["passkey", "device", "session"]),
    agentName: v.optional(AgentName),
    signatureChainId: v.optional(ChainIdHex),
    replaceExisting: v.optional(v.boolean()),
  }),
  createLinkedAgent: v.strictObject({
    userAddress: Address,
    agentName: AgentName,
    validForDays: v.pipe(v.number(), v.integer(), v.minValue(MIN_VALID_FOR_DAYS), v.maxValue(MAX_VALID_FOR_DAYS)),
    storageMode: v.picklist(["passkey", "device", "session"]),
    replaceExisting: v.optional(v.boolean()),
    link: v.strictObject({
      pairingId: v.pipe(v.string(), v.regex(LINK_PAIRING_ID_PATTERN, "pairingId must be a lowercase UUID")),
      secret: v.pipe(v.string(), v.regex(LINK_SECRET_PATTERN, "secret must be 16 bytes of base64url")),
    }),
  }),
  confirmAgent: v.strictObject({
    timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CONFIRM_TIMEOUT_MS))),
  }),
  unlock: Empty,
  lock: Empty,
  signAndSubmit: v.strictObject({
    requestId: v.pipe(v.string(), v.regex(REQUEST_ID_PATTERN, "requestId must be 1-128 of A-Z a-z 0-9 _ . : - with no run of 64 hex digits")),
    // Validated (strictly) by @kokoah/shared safeParseActionIntent.
    intent: v.unknown(),
  }),
  setLimits: v.strictObject({
    maxOrderNotionalUsd: v.optional(PositiveFinite),
    maxDailyNotionalUsd: v.optional(PositiveFinite),
    maxLeverage: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    maxOrdersPerMinute: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    priceBandPct: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100))),
    allowedCoins: v.optional(v.pipe(v.array(Coin), v.minLength(1), v.maxLength(500))),
    requireStopLossForNewEntries: v.optional(v.boolean()),
    allowedActionTypes: v.optional(v.pipe(v.array(v.picklist(BASELINE_ACTION_TYPES)), v.minLength(1), v.maxLength(BASELINE_ACTION_TYPES.length))),
    account: v.optional(Address),
  }),
  revoke: v.strictObject({
    agentName: v.optional(AgentName),
    signatureChainId: v.optional(ChainIdHex),
  }),
  setStorageMode: v.strictObject({
    to: v.picklist(["passkey", "device"]),
  }),
  setTheme: v.strictObject({
    variables: v.optional(v.record(v.picklist(THEME_VARIABLES), v.pipe(v.string(), v.maxLength(120)))),
    colorScheme: v.optional(v.picklist(["light", "dark", "light dark"])),
  }),
} satisfies Record<MethodName, v.GenericSchema>;

const EnvelopeHeader = v.object({
  protocol: v.literal(PROTOCOL_NAME),
  version: v.literal(PROTOCOL_VERSION),
  kind: v.literal("request"),
  id: v.pipe(v.string(), v.regex(ID_PATTERN)),
});

const RequestEnvelope = v.strictObject({
  protocol: v.literal(PROTOCOL_NAME),
  version: v.literal(PROTOCOL_VERSION),
  kind: v.literal("request"),
  id: v.pipe(v.string(), v.regex(ID_PATTERN)),
  method: v.pipe(v.string(), v.maxLength(32)),
  params: v.optional(v.unknown()),
});

/** Result of {@link classifyMessage}. */
export type Classified =
  /** Not for us or unreadable: drop silently (counted). */
  | { kind: "ignore"; reason: string }
  /** Readable id but invalid: answer with an error. */
  | { kind: "invalid"; id: string; method: string; code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNKNOWN_METHOD" | "UNSUPPORTED_VERSION"; message: string; issues?: Array<{ message: string; path?: string }> }
  | { [M in MethodName]: { kind: "request"; id: string; method: M; params: MethodParams[M] } }[MethodName];

function issuesOf(issues: readonly v.BaseIssue<unknown>[]): Array<{ message: string; path?: string }> {
  return issues.slice(0, 20).map((i) => {
    const path = v.getDotPath(i);
    return path ? { message: i.message, path } : { message: i.message };
  });
}

/** Serialized size, or null when the value can't be serialized (cycles, BigInt, …). */
export function messageSize(data: unknown): number | null {
  try {
    const s = JSON.stringify(data);
    return typeof s === "string" ? s.length : null;
  } catch {
    return null;
  }
}

/**
 * Classifies a message that already passed the origin and source checks. Order: header (else ignore) → size →
 * envelope → method → params.
 */
export function classifyMessage(data: unknown, maxBytes: number = MAX_MESSAGE_BYTES): Classified {
  // Messages without our header (wallet extensions, dev tools, other libraries) are ignored.
  if (typeof data !== "object" || data === null || (data as { protocol?: unknown }).protocol !== PROTOCOL_NAME) {
    return { kind: "ignore", reason: "not-kokoah" };
  }
  const header = v.safeParse(EnvelopeHeader, data);
  const size = messageSize(data);
  if (!header.success) {
    if ((data as { version?: unknown }).version !== PROTOCOL_VERSION) {
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string" && ID_PATTERN.test(id)) {
        return { kind: "invalid", id, method: "unknown", code: "UNSUPPORTED_VERSION", message: `Unsupported protocol version; this frame speaks version ${PROTOCOL_VERSION}` };
      }
    }
    return { kind: "ignore", reason: "bad-header" };
  }
  const id = header.output.id;
  const rawMethod = (data as { method?: unknown }).method;
  const methodForReply = typeof rawMethod === "string" && rawMethod.length <= 32 ? rawMethod : "unknown";
  if (size === null) return { kind: "invalid", id, method: methodForReply, code: "INVALID_REQUEST", message: "Message is not serializable" };
  if (size > maxBytes) return { kind: "invalid", id, method: methodForReply, code: "PAYLOAD_TOO_LARGE", message: `Message is larger than ${maxBytes} bytes` };

  const env = v.safeParse(RequestEnvelope, data);
  if (!env.success) return { kind: "invalid", id, method: methodForReply, code: "INVALID_REQUEST", message: "Malformed request envelope", issues: issuesOf(env.issues) };
  const method = env.output.method;
  if (!(METHODS as readonly string[]).includes(method)) return { kind: "invalid", id, method: methodForReply, code: "UNKNOWN_METHOD", message: `Unknown method "${method}"` };
  const m = method as MethodName;
  const schema = PARAMS_SCHEMAS[m] as v.GenericSchema;
  const params = v.safeParse(schema, env.output.params ?? {});
  if (!params.success) return { kind: "invalid", id, method: m, code: "INVALID_REQUEST", message: `Invalid params for ${m}`, issues: issuesOf(params.issues) };
  return { kind: "request", id, method: m, params: params.output } as Classified;
}
