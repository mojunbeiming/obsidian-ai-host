/**
 * Credentials: Obsidian's keychain first, the old plaintext field only as a
 * migration source.
 *
 * The host is injected rather than imported so this module is testable with a
 * fake, and so the one place that touches `app.secretStorage` is `main.ts`.
 * `app.secretStorage` only exists from Obsidian 1.11.4, so `host` can be null;
 * in that case a key the user pastes is *not* written anywhere, and the UI says
 * so instead of silently putting it back in `data.json`.
 *
 * The old field is read once per secret id and never written. `migrate` moves it
 * into the keychain; after that the caller rewrites the settings object, which
 * no longer carries the plaintext field at all.
 */

import { secretIdForProvider, type AiLegacySecret } from "../sdk/src/ai/aiSettingsSchema";

/** The part of `app.secretStorage` this module needs. */
export interface SecretHost {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
  listSecrets?(): string[];
}

/** The old plaintext source, read-only from here. */
export interface LegacySecretSource {
  read(secretId: string): string | null;
  clear(secretId: string): void;
}

export type SecretOrigin = "keychain" | "legacy" | "none";

export interface SecretValue {
  value: string;
  origin: SecretOrigin;
}

export interface SecretWriteResult {
  ok: boolean;
  reason?: "unavailable";
}

export interface SecretMigrationResult {
  migrated: number;
  skipped: number;
  /** True when there is no keychain at all, so nothing could be moved. */
  unavailable: boolean;
  ids: string[];
}

export class AiSecretStore {
  constructor(
    private readonly host: SecretHost | null,
    private readonly legacy: LegacySecretSource | null = null,
  ) {}

  /** Whether a key can be stored at all. */
  get available(): boolean {
    return this.host !== null;
  }

  /** Read one secret: keychain, then the legacy field, then nothing. */
  read(secretId: string): SecretValue {
    const fromKeychain = this.safeHostRead(secretId);
    if (fromKeychain) return { value: fromKeychain, origin: "keychain" };
    const fromLegacy = this.safeLegacyRead(secretId);
    if (fromLegacy) return { value: fromLegacy, origin: "legacy" };
    return { value: "", origin: "none" };
  }

  /** Read for a provider id, hiding the id derivation from callers. */
  readForProvider(providerId: string): SecretValue {
    return this.read(secretIdForProvider(providerId));
  }

  /** Store for a provider id; empty value clears it. */
  writeForProvider(providerId: string, value: string): SecretWriteResult {
    return this.write(secretIdForProvider(providerId), value);
  }

  /**
   * Store a value, or clear it when empty.
   *
   * There is no `deleteSecret` in the Obsidian API, so an empty string is the
   * documented way to remove one; the legacy copy is cleared at the same time so
   * a later fallback cannot resurrect a key the user just removed.
   */
  write(secretId: string, value: string): SecretWriteResult {
    const text = typeof value === "string" ? value.trim() : "";
    if (!this.host) {
      this.legacy?.clear(secretId);
      return { ok: false, reason: "unavailable" };
    }
    try {
      this.host.setSecret(secretId, text);
      this.legacy?.clear(secretId);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  /** Clear both locations. */
  clear(secretId: string): void {
    try {
      this.host?.setSecret(secretId, "");
    } catch {
      // A failed clear must not block the caller; the legacy copy is still removed.
    }
    this.legacy?.clear(secretId);
  }

  /**
   * Move legacy plaintext keys into the keychain.
   *
   * An existing keychain value wins: the user may have re-entered the key after
   * the old file was written, and overwriting it with a stale one is how a
   * working setup becomes a 401. Without a keychain nothing is changed at all --
   * "migrated" must not mean "deleted from the only place it existed".
   */
  migrate(entries: readonly AiLegacySecret[]): SecretMigrationResult {
    const result: SecretMigrationResult = { migrated: 0, skipped: 0, unavailable: false, ids: [] };
    if (!this.host) {
      result.unavailable = true;
      result.skipped = entries.length;
      return result;
    }
    for (const entry of entries) {
      const secretId = secretIdForProvider(entry.providerId);
      if (this.safeHostRead(secretId)) {
        result.skipped += 1;
        continue;
      }
      try {
        this.host.setSecret(secretId, entry.apiKey);
        result.migrated += 1;
        result.ids.push(secretId);
      } catch {
        result.skipped += 1;
      }
    }
    return result;
  }

  private safeHostRead(secretId: string): string {
    try {
      const value = this.host?.getSecret(secretId) ?? "";
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
  }

  private safeLegacyRead(secretId: string): string {
    try {
      return this.legacy?.read(secretId)?.trim() ?? "";
    } catch {
      return "";
    }
  }
}