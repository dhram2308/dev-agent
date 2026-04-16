// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Encrypted File Credential Backend
//
// Fallback backend when no OS keychain is available (headless
// servers, Docker containers, CI runners).
//
// Storage:
//   ~/.config/mi-dev-agent/credentials.enc  (mode 0o600)
//
// Encryption:
//   AES-256-GCM
//   Key = SHA-256(machineId + $CRED_ENC_KEY)
//   IV  = random 12 bytes per write
//   Format: <16-byte auth tag><12-byte iv><ciphertext>
//
// Machine ID sources (in order):
//   1. /etc/machine-id
//   2. /var/lib/dbus/machine-id
//   3. ~/.config/mi-dev-agent/.machine-id  (auto-generated UUID)
//
// Writes are atomic: write → fsync → rename.
// ═══════════════════════════════════════════════════════════════

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {
  CredentialStore,
  TokenSet,
  ProviderStatus,
  ConnectorStatus,
} from './types';
import { CredentialStoreError } from './types';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mi-dev-agent');
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.enc');
const MACHINE_ID_FILE = path.join(CONFIG_DIR, '.machine-id');
const FILE_MODE = 0o600;

const ALGO = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Read a file synchronously, returning `null` if it doesn't exist.
 */
function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Obtain a stable machine identifier.
 *
 * Priority:
 *   1. /etc/machine-id            (standard on systemd-based Linux)
 *   2. /var/lib/dbus/machine-id   (older Linux)
 *   3. ~/.config/mi-dev-agent/.machine-id  (auto-generated fallback)
 */
function getMachineId(): string {
  // Try system-provided IDs first.
  const systemId =
    readFileOrNull('/etc/machine-id') ??
    readFileOrNull('/var/lib/dbus/machine-id');

  if (systemId && systemId.length > 0) return systemId;

  // Fallback: generate a stable UUID and persist it.
  ensureDir(CONFIG_DIR);

  const existing = readFileOrNull(MACHINE_ID_FILE);
  if (existing && existing.length > 0) return existing;

  const generated = crypto.randomUUID();
  fs.writeFileSync(MACHINE_ID_FILE, generated, { mode: FILE_MODE });
  return generated;
}

/**
 * Derive the 256-bit encryption key.
 */
function deriveKey(): Buffer {
  const machineId = getMachineId();
  const userKey = process.env.CRED_ENC_KEY ?? '';
  return crypto.createHash('sha256').update(machineId + userKey).digest();
}

/**
 * Ensure a directory exists (recursive).
 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Encrypt a UTF-8 plaintext string.
 * Returns: <authTag:16><iv:12><ciphertext>
 */
function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Layout: authTag | iv | ciphertext
  return Buffer.concat([authTag, iv, encrypted]);
}

/**
 * Decrypt a buffer produced by {@link encrypt}.
 */
function decrypt(data: Buffer, key: Buffer): string {
  if (data.length < AUTH_TAG_LENGTH + IV_LENGTH + 1) {
    throw new CredentialStoreError(
      'Encrypted credential file is too short / corrupted',
      'CRED_FILE_CORRUPT',
    );
  }

  const authTag = data.subarray(0, AUTH_TAG_LENGTH);
  const iv = data.subarray(AUTH_TAG_LENGTH, AUTH_TAG_LENGTH + IV_LENGTH);
  const ciphertext = data.subarray(AUTH_TAG_LENGTH + IV_LENGTH);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new CredentialStoreError(
      `Failed to decrypt credential file (wrong key or corrupted data): ${(err as Error).message}`,
      'CRED_DECRYPT_FAILED',
    );
  }
}

/**
 * Derive {@link ConnectorStatus} from a token set.
 */
function deriveStatus(ts: TokenSet): ConnectorStatus {
  if (ts.expiresAt !== undefined && ts.expiresAt <= Date.now()) {
    return ts.refreshToken ? 'RE_AUTH_REQUIRED' : 'REVOKED';
  }
  return 'CONNECTED';
}

// ═══════════════════════════════════════════════════════════════
// EncryptedFileBackend
// ═══════════════════════════════════════════════════════════════

export class EncryptedFileBackend implements CredentialStore {
  public readonly backendName = 'encrypted-file';

  private readonly _key: Buffer;
  private readonly _filePath: string;

  constructor(filePath?: string) {
    this._key = deriveKey();
    this._filePath = filePath ?? CRED_FILE;
  }

  // ── Internal store read / write ──────────────────────────────

  /**
   * Read and decrypt the entire credential store.
   * Returns an empty object if the file doesn't exist.
   */
  private _readStore(): Record<string, TokenSet> {
    try {
      const raw = fs.readFileSync(this._filePath);
      const json = decrypt(raw, this._key);
      return JSON.parse(json) as Record<string, TokenSet>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      // Re-throw CredentialStoreError as-is.
      if (err instanceof CredentialStoreError) throw err;
      throw new CredentialStoreError(
        `Failed to read credential file: ${(err as Error).message}`,
        'CRED_FILE_READ_ERROR',
      );
    }
  }

  /**
   * Encrypt and atomically write the credential store.
   *
   * Steps: write .tmp → fsync → rename → ensure 0o600.
   */
  private _writeStore(store: Record<string, TokenSet>): void {
    ensureDir(path.dirname(this._filePath));

    const json = JSON.stringify(store, null, 0);
    const encrypted = encrypt(json, this._key);

    const tmpPath = this._filePath + '.tmp';

    // Write to temp file.
    const fd = fs.openSync(tmpPath, 'w', FILE_MODE);
    try {
      fs.writeSync(fd, encrypted);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Atomic rename.
    fs.renameSync(tmpPath, this._filePath);

    // Ensure correct permissions (rename preserves source mode, but be safe).
    fs.chmodSync(this._filePath, FILE_MODE);
  }

  // ── CredentialStore implementation ───────────────────────────

  async get(provider: string): Promise<TokenSet | null> {
    const store = this._readStore();
    return store[provider] ?? null;
  }

  async set(provider: string, tokenSet: TokenSet): Promise<void> {
    const store = this._readStore();
    store[provider] = tokenSet;
    this._writeStore(store);
  }

  async delete(provider: string): Promise<void> {
    const store = this._readStore();
    if (!(provider in store)) return;
    delete store[provider];
    this._writeStore(store);
  }

  async list(): Promise<ProviderStatus[]> {
    const store = this._readStore();

    return Object.entries(store).map(([provider, ts]) => ({
      provider,
      kind: ts.kind,
      status: deriveStatus(ts),
      hasRefreshToken: !!ts.refreshToken,
      expiresAt: ts.expiresAt,
      metadata: ts.metadata,
    }));
  }
}
