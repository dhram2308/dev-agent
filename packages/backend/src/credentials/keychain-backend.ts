// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Keychain Credential Backend
//
// Stores credentials in the OS keychain via `cross-keychain`.
// This is the preferred backend on developer machines where a
// desktop session (and therefore a keychain daemon) is available.
//
// Storage layout:
//   service:  mi-dev-agent
//   account:  oauth:<provider>  |  pat:<provider>  |  ...
//   password: JSON-serialized TokenSet
//
// A provider registry is stored as a separate keychain entry
// (_registry) so that list() can enumerate without OS-level
// keychain search (which is not exposed by cross-keychain).
// ═══════════════════════════════════════════════════════════════

import type {
  CredentialStore,
  TokenSet,
  ProviderStatus,
  ConnectorStatus,
} from './types';
import { CredentialStoreError } from './types';

// cross-keychain is an optional peer — imported dynamically in probe()
// to avoid hard crashes when the native module is unavailable.
let keychain: typeof import('cross-keychain') | null = null;

const SERVICE_NAME = 'mi-dev-agent';
const REGISTRY_ACCOUNT = '_registry';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Build the keychain account string from provider + kind.
 * Format: `<kind>:<provider>` (e.g. `oauth:jira`, `pat:gitlab`).
 */
function accountKey(provider: string, kind: string): string {
  return `${kind}:${provider}`;
}

/**
 * Derive the {@link ConnectorStatus} from a TokenSet.
 */
function deriveStatus(ts: TokenSet): ConnectorStatus {
  if (ts.expiresAt !== undefined && ts.expiresAt <= Date.now()) {
    return ts.refreshToken ? 'RE_AUTH_REQUIRED' : 'REVOKED';
  }
  return 'CONNECTED';
}

// ═══════════════════════════════════════════════════════════════
// KeychainBackend
// ═══════════════════════════════════════════════════════════════

export class KeychainBackend implements CredentialStore {
  public readonly backendName = 'keychain';

  /**
   * In-memory mirror of the `_registry` entry.
   * Maps provider → kind so we know the full account key.
   */
  private _registry = new Map<string, string>();
  private _registryLoaded = false;

  // ── Registry persistence ─────────────────────────────────────

  /**
   * Load the registry from the keychain into memory (once).
   */
  private async _loadRegistry(): Promise<void> {
    if (this._registryLoaded) return;

    const kc = await this._keychain();
    try {
      const raw = await kc.getPassword(SERVICE_NAME, REGISTRY_ACCOUNT);
      if (raw) {
        const parsed: Record<string, string> = JSON.parse(raw);
        for (const [provider, kind] of Object.entries(parsed)) {
          this._registry.set(provider, kind);
        }
      }
    } catch {
      // No registry yet — that's fine on first run.
    }
    this._registryLoaded = true;
  }

  /**
   * Persist the current registry map back to the keychain.
   */
  private async _saveRegistry(): Promise<void> {
    const kc = await this._keychain();
    const obj: Record<string, string> = {};
    for (const [provider, kind] of this._registry) {
      obj[provider] = kind;
    }
    await kc.setPassword(SERVICE_NAME, REGISTRY_ACCOUNT, JSON.stringify(obj));
  }

  /**
   * Lazy-load the cross-keychain module.
   */
  private async _keychain(): Promise<typeof import('cross-keychain')> {
    if (keychain) return keychain;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      keychain = require('cross-keychain') as typeof import('cross-keychain');
      return keychain;
    } catch (err) {
      throw new CredentialStoreError(
        `cross-keychain module not available: ${(err as Error).message}`,
        'KEYCHAIN_UNAVAILABLE',
      );
    }
  }

  // ── CredentialStore implementation ───────────────────────────

  async get(provider: string): Promise<TokenSet | null> {
    const kc = await this._keychain();
    await this._loadRegistry();

    const kind = this._registry.get(provider);
    if (!kind) return null;

    try {
      const raw = await kc.getPassword(SERVICE_NAME, accountKey(provider, kind));
      if (!raw) return null;
      return JSON.parse(raw) as TokenSet;
    } catch (err) {
      throw new CredentialStoreError(
        `Failed to read credentials for "${provider}" from keychain: ${(err as Error).message}`,
        'KEYCHAIN_READ_ERROR',
        provider,
      );
    }
  }

  async set(provider: string, tokenSet: TokenSet): Promise<void> {
    const kc = await this._keychain();
    await this._loadRegistry();

    const oldKind = this._registry.get(provider);

    // If the kind changed, remove the old entry first.
    if (oldKind && oldKind !== tokenSet.kind) {
      try {
        await kc.deletePassword(SERVICE_NAME, accountKey(provider, oldKind));
      } catch {
        // Best-effort cleanup; the old entry may already be gone.
      }
    }

    try {
      await kc.setPassword(
        SERVICE_NAME,
        accountKey(provider, tokenSet.kind),
        JSON.stringify(tokenSet),
      );
    } catch (err) {
      throw new CredentialStoreError(
        `Failed to store credentials for "${provider}" in keychain: ${(err as Error).message}`,
        'KEYCHAIN_WRITE_ERROR',
        provider,
      );
    }

    // Update and persist the registry.
    this._registry.set(provider, tokenSet.kind);
    await this._saveRegistry();
  }

  async delete(provider: string): Promise<void> {
    const kc = await this._keychain();
    await this._loadRegistry();

    const kind = this._registry.get(provider);
    if (!kind) return; // Nothing to delete.

    try {
      await kc.deletePassword(SERVICE_NAME, accountKey(provider, kind));
    } catch (err) {
      throw new CredentialStoreError(
        `Failed to delete credentials for "${provider}" from keychain: ${(err as Error).message}`,
        'KEYCHAIN_DELETE_ERROR',
        provider,
      );
    }

    this._registry.delete(provider);
    await this._saveRegistry();
  }

  async list(): Promise<ProviderStatus[]> {
    await this._loadRegistry();

    const results: ProviderStatus[] = [];
    for (const [provider] of this._registry) {
      const tokenSet = await this.get(provider);
      if (!tokenSet) {
        results.push({
          provider,
          kind: (this._registry.get(provider) as TokenSet['kind']) ?? 'oauth',
          status: 'NOT_CONNECTED',
          hasRefreshToken: false,
        });
        continue;
      }

      results.push({
        provider,
        kind: tokenSet.kind,
        status: deriveStatus(tokenSet),
        hasRefreshToken: !!tokenSet.refreshToken,
        expiresAt: tokenSet.expiresAt,
        metadata: tokenSet.metadata,
      });
    }

    return results;
  }

  // ── Static probe ─────────────────────────────────────────────

  /**
   * Test whether the OS keychain is accessible.
   *
   * Writes a canary entry, reads it back, and deletes it.
   * Returns `true` if everything worked, `false` otherwise.
   */
  static async probe(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const kc = require('cross-keychain') as typeof import('cross-keychain');
      const canary = `probe-${Date.now()}`;

      await kc.setPassword(SERVICE_NAME, '_probe', canary);
      const readBack = await kc.getPassword(SERVICE_NAME, '_probe');
      await kc.deletePassword(SERVICE_NAME, '_probe');

      return readBack === canary;
    } catch {
      return false;
    }
  }
}
