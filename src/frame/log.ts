/**
 * Logging for the frame. Only fixed event names and a whitelist of scalar fields (addresses, codes, counts, network)
 * can be logged; there is no way to log an object, an error or a string that could hold key or signature material
 * (docs/ENGINEERING_CONVENTIONS.md §8).
 *
 * @module
 */

export type LogEvent =
  | "frame.started"
  | "frame.config_invalid"
  | "key.created"
  | "key.confirmed"
  | "key.unlocked"
  | "key.storage_changed"
  | "key.locked"
  | "key.revoked"
  | "key.revoke_failed"
  | "key.expired"
  | "key.reloaded"
  | "key.unlock_failed"
  | "limits.changed"
  | "sign.denied"
  | "sign.submitted"
  | "sign.result"
  | "message.blocked"
  | "clock.synced"
  | "error.internal";

type Field = string | number | boolean;
const ALLOWED_FIELDS = new Set([
  "network",
  "agent",
  "storageMode",
  "fallback",
  "actionType",
  "status",
  "code",
  "codes",
  "count",
  "offsetMs",
  "reason",
  "errorName",
  "requestId",
  "version",
]);
const SAFE_VALUE = /^[A-Za-z0-9_.:,\- ]{0,120}$/;

export type Logger = (event: LogEvent, fields?: Readonly<Record<string, Field>>) => void;

/** Keeps only whitelisted fields whose values look harmless (no long hex, no free text). */
export function sanitizeFields(fields: Readonly<Record<string, Field>> | undefined): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === "string") {
      // Addresses are 40 hex digits; anything with a longer hex run is dropped.
      if (!SAFE_VALUE.test(v) && !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
      if (/[0-9a-fA-F]{41,}/.test(v)) continue;
    }
    out[k] = v;
  }
  return out;
}

/** Console logger (info level, one line per event). */
export const consoleLogger: Logger = (event, fields) => {
  console.info(`[kokoah-signer] ${event}`, JSON.stringify(sanitizeFields(fields)));
};

/** Logger that drops everything (tests). */
export const silentLogger: Logger = () => {};
