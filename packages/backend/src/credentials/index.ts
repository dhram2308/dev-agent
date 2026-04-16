// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Credential Store (auto-selection + singleton)
//
// Probes backends in order of preference and exposes a single
// CredentialStore instance for the rest of the application.
//
// Selection logic:
//   1. If ENABLE_CREDENTIAL_STORE === 'false' → NoOpStore
//   2. Try KeychainBackend (probe with canary entry)
//   3. If keychain fails AND $MI_DEV_AGENT_OAUTH_TOKENS is set → EnvVarBackend
//   4. If keychain fails AND no env tokens → EncryptedFileBackend
//
// Usage:
//   import { credentialStore } from './credentials';
//   const tokens = await credentialStore.get('jira');
//
// Or await initialization explicitly:
//   import { getCredentialStore } from './credentials';
//   const store = await getCredentialStore();
// ═══════════════════════════════════════════════════════════════

import type { CredentialStore, TokenSet, ProviderStatus } from './types';
import { CredentialStoreError } from './types';
import { KeychainBackend } from './keychain-backend';
import { EncryptedFileBackend } from './encrypted-file-backend';
import { EnvVarBackend } from './env-backend';

// Re-export everything consumers might need.
export type {
  AuthMode,
  ConnectorStatus,
  TokenSet,
  ProviderStatus,
  CredentialStore,
} from './types';
export { CredentialStoreError } from './types';
export { maskSecret } from './redaction';
export { KeychainBackend } from './keychain-backend';
export { EncryptedFileBackend } from './encrypted-file-backend';
export { EnvVarBackend } from './env-backend';

// ═══════════════════════════════════════════════════════════════
// No-op store (backward compatibility / disabled mode)
// ═══════════════════════════════════════════════════════════════

/**
 * Fallback store used when `ENABLE_CREDENTIAL_STORE=false`.
 *
 * Reads from the env bundle if available, rejects writes.
 * This ensures existing deployments that rely purely on env vars
 * keep working without any code changes.
 */
class NoOpStore implements CredentialStore {
  public readonly backendName = 'noop';
  private readonly _envFallback = new EnvVarBackend();

  async get(provider: string): Promise<TokenSet | null> {
    // Silently try env vars — returns null if unset.
    try {
      return await this._envFallback.get(provider);
    } catch {
      return null;
    }
  }

  async set(_provider: string, _tokenSet: TokenSet): Promise<void> {
    throw new CredentialStoreError(
      'Credential store is disabled (ENABLE_CREDENTIAL_STORE=false)',
      'CRED_STORE_DISABLED',
      _provider,
    );
  }

  async delete(_provider: string): Promise<void> {
    throw new CredentialStoreError(
      'Credential store is disabled (ENABLE_CREDENTIAL_STORE=false)',
      'CRED_STORE_DISABLED',
      _provider,
    );
  }

  async list(): Promise<ProviderStatus[]> {
    try {
      return await this._envFallback.list();
    } catch {
      return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton + lazy initialization
// ═══════════════════════════════════════════════════════════════

let _instance: CredentialStore | null = null;
let _initPromise: Promise<CredentialStore> | null = null;

/**
 * Simple log helper — uses console so we don't create a circular
 * dependency on the logger module (which may itself need credentials).
 */
function log(level: 'info' | 'warn', msg: string): void {
  const ts = new Date().toISOString();
  const fn = level === 'warn' ? console.warn : console.info;
  fn(`[${ts}] [credential-store] ${msg}`);
}

/**
 * Initialize and return the credential store.
 *
 * Safe to call multiple times — returns the same promise / instance.
 */
async function initStore(): Promise<CredentialStore> {
  // Fast path: disabled via env.
  if (process.env.ENABLE_CREDENTIAL_STORE === 'false') {
    log('info', 'Credential store disabled via ENABLE_CREDENTIAL_STORE=false — using noop backend');
    return new NoOpStore();
  }

  // 1. Try keychain.
  try {
    const keychainOk = await KeychainBackend.probe();
    if (keychainOk) {
      log('info', 'Credential store backend: keychain');
      return new KeychainBackend();
    }
    log('info', 'Keychain probe failed — falling back');
  } catch {
    log('warn', 'Keychain probe threw — falling back');
  }

  // 2. If env tokens are available, use them.
  if (process.env.MI_DEV_AGENT_OAUTH_TOKENS) {
    log('info', 'Credential store backend: env-var ($MI_DEV_AGENT_OAUTH_TOKENS)');
    return new EnvVarBackend();
  }

  // 3. Encrypted file fallback.
  log('info', 'Credential store backend: encrypted-file');
  return new EncryptedFileBackend();
}

/**
 * Get (or lazily create) the credential store singleton.
 *
 * ```ts
 * const store = await getCredentialStore();
 * const jiraTokens = await store.get('jira');
 * ```
 */
export async function getCredentialStore(): Promise<CredentialStore> {
  if (_instance) return _instance;
  if (!_initPromise) {
    _initPromise = initStore().then((store) => {
      _instance = store;
      return store;
    });
  }
  return _initPromise;
}

// ═══════════════════════════════════════════════════════════════
// Synchronous proxy singleton
// ═══════════════════════════════════════════════════════════════

/**
 * Proxy-based singleton that can be imported synchronously.
 *
 * All method calls are forwarded to the lazily-initialized real
 * store.  If initialization hasn't finished yet, the returned
 * promises will await it transparently.
 *
 * ```ts
 * import { credentialStore } from './credentials';
 * const tokens = await credentialStore.get('jira');
 * ```
 */
export const credentialStore: CredentialStore = {
  get backendName(): string {
    return _instance?.backendName ?? 'initializing';
  },

  async get(provider: string): Promise<TokenSet | null> {
    const store = await getCredentialStore();
    return store.get(provider);
  },

  async set(provider: string, tokenSet: TokenSet): Promise<void> {
    const store = await getCredentialStore();
    return store.set(provider, tokenSet);
  },

  async delete(provider: string): Promise<void> {
    const store = await getCredentialStore();
    return store.delete(provider);
  },

  async list(): Promise<ProviderStatus[]> {
    const store = await getCredentialStore();
    return store.list();
  },
};
