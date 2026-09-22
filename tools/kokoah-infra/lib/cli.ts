// Small helpers shared by the CLIs. No third-party dependencies.
import { parseArgs, type ParseArgsConfig } from 'node:util';

export const EXIT_OK = 0;
/** A check failed (mismatch, missing control, policy violation). */
export const EXIT_CHECK_FAILED = 1;
/** Bad usage, or the tool could not do its job (network error, unreadable input). */
export const EXIT_ERROR = 2;

export class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig['options']>;

export interface Parsed<T> {
  values: T;
  positionals: string[];
}

/**
 * Parse argv with node:util parseArgs. Always adds --help.
 * Throws UsageError on unknown or malformed options.
 */
export function parseCli<T extends Record<string, unknown>>(
  argv: string[],
  options: Options,
  allowPositionals = false,
): Parsed<T & { help?: boolean }> {
  try {
    const result = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals,
      strict: true,
    });
    return {
      values: result.values as T & { help?: boolean },
      positionals: result.positionals,
    };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export function parsePositiveInt(name: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Run a CLI main function with uniform error handling and exit codes.
 * `main` returns the exit code.
 */
export async function runCli(usage: string, main: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n\n${usage}\n`);
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    process.exitCode = EXIT_ERROR;
  }
}
