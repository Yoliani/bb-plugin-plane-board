// The account record and the rules around it, shared by the backend and the
// settings UI's types.
//
// An account is split in two: everything here lives in the plugin's kv storage
// and is edited through the Accounts panel, while its API key lives in a
// `secret` setting named by `keySetting`. Secret settings are declared once per
// plugin load, so they cannot be created on demand — hence a fixed pool of
// slot names that accounts claim and release.

/** Settings keys available to hold an API key. The first is the original name. */
export const KEY_SLOTS = ["apiKey", "apiKey_2", "apiKey_3", "apiKey_4", "apiKey_5"];

export const MAX_ACCOUNTS = KEY_SLOTS.length;

export interface StoredAccount {
  /** Stable, slug-shaped, and used in board URLs. */
  id: string;
  label: string;
  /** Server root: https://api.plane.so for Plane Cloud. */
  serverUrl: string;
  workspace: string;
  /** Only needed when the web UI is not served from serverUrl. */
  webUrl: string;
  /** Identifier, name, or UUID of the project to open first. */
  defaultProject: string;
  /** Which entry of KEY_SLOTS holds this account's API key. */
  keySetting: string;
}

/** A URL- and settings-safe id derived from the label. */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return slug === "" ? "account" : slug;
}

/** `slugify`, then a numeric suffix until it is unique among `taken`. */
export function uniqueId(label: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  const base = slugify(label);
  if (!existing.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** The first key slot no account holds, or null when every slot is taken. */
export function freeKeySlot(accounts: StoredAccount[]): string | null {
  const used = new Set(accounts.map((account) => account.keySetting));
  return KEY_SLOTS.find((slot) => !used.has(slot)) ?? null;
}
