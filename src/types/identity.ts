import type { Topic } from '@ethersphere/core-sdk';

import type { Hex } from './utils';

/** Wire format of the sealed FMK, stored as JSON directly in the envelope feed payload. */
export interface IdentityEnvelope {
  v: number;
  /** Public HKDF salt, for both the unlock-key and key-id derivations. */
  salt: Hex;
  /** `iv || ciphertext` of the FMK under the unlock key. */
  sealed: Hex;
  keyId: Hex;
}

/**
 * How a login method proves who it is. A wallet signature, an injected private key and a Swarm ID
 * secret all fit behind this, so adding a login method means adding a `Credential`, not touching the
 * library.
 *
 * The secret must be **stable** for a given user — re-deriving a different value produces a
 * different unlock key, which throws rather than losing data silently.
 */
export interface Credential {
  /** Raw secret bytes to derive the unlock key from. Zeroed by the caller after use. */
  unlockSecret(): Promise<Uint8Array>;
}

export interface IdentityInfo {
  /**
   * Ethereum address that owns every feed the FileManager writes. Derived from the FMK, so any
   * credential unsealing the same envelope reaches the same drives.
   *
   * Not the address the user signed in with — that one belongs to the client and only locates the
   * envelope.
   */
  readonly owner: Hex;
  /**
   * Non-secret fingerprint of the FMK, salted with the envelope it came from — so it identifies one
   * envelope, not the identity. Use `owner` for a stable identifier across login methods.
   */
  readonly keyId: Hex;
}

export interface Identity extends IdentityInfo {
  readonly stateTopic: Topic;
  /**
   * Private key behind `owner`, passed to the port on every feed write. Held as bytes because
   * secp256k1 is outside WebCrypto. Kept off `IdentityInfo` so it stays off the public surface.
   */
  readonly signer: Hex;
  /**
   * 32 bytes from the FMK for `info` — the root of the tree's key chain.
   *
   * Raw rather than a `CryptoKey` because every node key below the root is wrapped into a manifest
   * and, once sharing lands, handed to a grantee; a non-extractable root could not seal them.
   */
  deriveKeyBytes(info: string): Promise<Uint8Array>;
}
