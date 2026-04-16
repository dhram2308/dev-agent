## ADDED Requirements

### Requirement: Credential store abstraction

The system SHALL provide a `CredentialStore` interface exposing `get(provider)`, `set(provider, tokenSet)`, `delete(provider)`, and `list()` operations that persist credential material independently of any single backend implementation. All OAuth and PAT credentials managed by the agent SHALL flow through this abstraction.

#### Scenario: Reading a stored credential

- **WHEN** any caller invokes `CredentialStore.get('gitlab')`
- **THEN** the store SHALL return a `TokenSet { kind: 'oauth' | 'pat', accessToken, refreshToken?, expiresAt?, scopes?, metadata? }` object, or `null` if no credential is stored for that provider

#### Scenario: Storing a new credential atomically

- **WHEN** a caller invokes `CredentialStore.set('figma', tokenSet)` with a new token set
- **THEN** the store SHALL persist the full token set atomically (no partial writes)
- **AND** a subsequent `get('figma')` on the same or a new process SHALL return the same token set

#### Scenario: Listing configured providers

- **WHEN** the UI calls `CredentialStore.list()`
- **THEN** the store SHALL return an array of `{ provider, kind, hasRefreshToken, expiresAt, lastRefreshAt }` entries for every stored credential, without leaking the secret material itself

### Requirement: Backend auto-selection at boot

The system SHALL choose a `CredentialStore` backend at process startup by probing available environments in a fixed order and selecting the first viable one. The chosen backend SHALL be logged at INFO level.

#### Scenario: Desktop environment with working OS keychain

- **WHEN** the backend starts on macOS, Windows, or Linux with a running Secret Service daemon
- **AND** the keychain probe (`getPassword` on a canary entry) succeeds
- **THEN** the `KeychainBackend` SHALL be selected
- **AND** a log line `CredentialStore: backend=keychain` SHALL be emitted

#### Scenario: Headless Linux or Docker without keychain

- **WHEN** the keychain probe fails (no daemon, no GUI session)
- **AND** `$MI_DEV_AGENT_OAUTH_TOKENS` is not set
- **THEN** the `EncryptedFileBackend` SHALL be selected
- **AND** a log line `CredentialStore: backend=encrypted-file` SHALL be emitted

#### Scenario: Cloud / CI with pre-provisioned tokens

- **WHEN** `$MI_DEV_AGENT_OAUTH_TOKENS` is set with a valid JSON bundle
- **THEN** the `EnvVarBackend` SHALL be selected regardless of keychain availability
- **AND** `set()` calls against this backend SHALL reject with a clear error (read-only backend)

### Requirement: Keychain backend

The `KeychainBackend` SHALL use the `cross-keychain` library to read and write credentials to the OS-native credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service), using service name `mi-dev-agent` and account names of the form `oauth:<provider>` or `pat:<provider>`.

#### Scenario: Writing to keychain

- **WHEN** `KeychainBackend.set('gitlab', tokenSet)` is called
- **THEN** the serialized token set SHALL be stored under `service=mi-dev-agent, account=oauth:gitlab`

#### Scenario: Deleting from keychain

- **WHEN** `KeychainBackend.delete('gitlab')` is called
- **THEN** the entry under `service=mi-dev-agent, account=oauth:gitlab` SHALL be removed
- **AND** a subsequent `get('gitlab')` SHALL return `null`

### Requirement: Encrypted file backend

The `EncryptedFileBackend` SHALL persist credentials in `~/.config/mi-dev-agent/credentials.enc` using AES-256-GCM with a key derived from `sha256(machine-id || ($CRED_ENC_KEY || ''))`. The file SHALL be created with mode `0600`. Each `set()` SHALL rewrite the entire file atomically via temp-file + fsync + rename.

#### Scenario: First write creates encrypted file

- **WHEN** `EncryptedFileBackend.set('figma', tokenSet)` is called on a fresh system
- **THEN** `~/.config/mi-dev-agent/credentials.enc` SHALL be created with mode `0600`
- **AND** its contents SHALL be AES-256-GCM ciphertext decryptable with the derived key

#### Scenario: Atomic update

- **WHEN** an `EncryptedFileBackend.set()` call is interrupted mid-write
- **THEN** the original `credentials.enc` SHALL remain intact (temp file + rename semantics)
- **AND** the next `get()` SHALL return the pre-update value

#### Scenario: File moved to a different machine

- **WHEN** `credentials.enc` is copied from machine A to machine B (different machine-id)
- **AND** `$CRED_ENC_KEY` is not set on machine B
- **THEN** `EncryptedFileBackend.get()` SHALL fail with a decryption error
- **AND** the UI SHALL prompt for re-authentication

### Requirement: Env-var backend (read-only)

The `EnvVarBackend` SHALL read a pre-provisioned token bundle from `$MI_DEV_AGENT_OAUTH_TOKENS` (JSON encoded as base64) and expose it via `get()` / `list()`. `set()` and `delete()` SHALL return an error indicating the backend is read-only.

#### Scenario: Reading pre-provisioned tokens

- **WHEN** `$MI_DEV_AGENT_OAUTH_TOKENS` contains a valid base64-encoded JSON bundle for `gitlab`
- **AND** `EnvVarBackend.get('gitlab')` is called
- **THEN** the deserialized token set SHALL be returned

#### Scenario: Rejected write against env backend

- **WHEN** `EnvVarBackend.set('gitlab', tokenSet)` is called
- **THEN** the call SHALL reject with error code `CRED_STORE_READ_ONLY`
- **AND** the caller SHALL be responsible for surfacing the error to the operator

### Requirement: Credential redaction in logs and UI

The system SHALL never log, serialize to SSE, or expose through any API the secret material (access token, refresh token, client secret) in plaintext. Only masked forms (`****last4`) and non-secret metadata (expiresAt, scopes, provider) SHALL be exposed.

#### Scenario: Log output never contains a full token

- **WHEN** any module logs a credential-bearing object
- **THEN** the log line SHALL contain only `****` followed by the last 4 characters of the secret
- **AND** automated redaction tests SHALL fail CI if a full token string is detected in any log