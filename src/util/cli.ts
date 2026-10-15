/** Minimal CLI parsing shared by the scripts: `<positional> --flag --key=value`. */
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (const a of argv) {
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq < 0) flags.set(a.slice(2), true);
    else flags.set(a.slice(2, eq), a.slice(eq + 1));
  }
  return { positional, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

/** Integer flag within [min, max]; throws a clear error instead of silently running with NaN. */
export function intFlag(args: ParsedArgs, name: string, fallback: number, min: number, max: number): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} debe ser un número entero entre ${min} y ${max} (recibido: ${raw})`);
  return n;
}
