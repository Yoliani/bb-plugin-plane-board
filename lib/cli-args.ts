// argv parsing for `bb plane-board`. The CLI takes `--flag value` pairs and
// positionals in any order; a flag named in BOOLEAN_FLAGS never swallows the
// token after it, so `search --json checkout` searches for "checkout".

/** Flags that stand alone. Everything else consumes the next token. */
const BOOLEAN_FLAGS = new Set(["json"]);

export interface ParsedArgv {
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgv(argv: string[]): ParsedArgv {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index++;
  }

  return { flags, positionals };
}

/** A flag's value, or null when it is absent or was given as a bare switch. */
export function flagValue(parsed: ParsedArgv, name: string): string | null {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : null;
}

export function hasFlag(parsed: ParsedArgv, name: string): boolean {
  return parsed.flags[name] !== undefined;
}
