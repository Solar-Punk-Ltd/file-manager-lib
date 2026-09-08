import { Bytes, PrivateKey, Topic } from '@ethersphere/core-sdk';

import { type Identity, type IdentityEnvelope } from '../types/identity';
import type { Hex } from '../types/utils';

import {
  FMK_LENGTH,
  IDENTITY_ENVELOPE_TOPIC_LABEL,
  KEY_ID_LABEL,
  SIGNER_LABEL,
  STATE_TOPIC_LABEL,
  UNLOCK_KDF_LABEL,
} from './constants';
import { decryptBytes, deriveAesKey, deriveBits, encryptBytes, importDerivationKey, zeroBytes } from './crypto';
import { IdentityError } from './errors';

const NO_SALT = new Uint8Array(0);

/**
 * Where the envelope lives, under the credential's address.
 *
 * Unsalted — the envelope's salt is inside the envelope, so it cannot address it.
 */
export async function envelopeTopic(secret: Uint8Array): Promise<Topic> {
  const base = await importDerivationKey(secret);

  return new Topic(await deriveBits(base, IDENTITY_ENVELOPE_TOPIC_LABEL, NO_SALT));
}

/**
 * Import raw FMK bytes and derive the values hanging off them. The caller owns `fmkBytes` and must
 * zero it once this resolves.
 */
export async function deriveIdentity(fmkBytes: Uint8Array, salt: Uint8Array): Promise<Identity> {
  if (fmkBytes.length !== FMK_LENGTH) {
    throw new IdentityError(`FMK must be ${FMK_LENGTH} bytes, got ${fmkBytes.length}`);
  }

  const fmk = await importDerivationKey(fmkBytes);

  // Unsalted: both must be identical for every credential that unseals this FMK, or the same user
  // reaches different drives depending on how they logged in.
  const topicBytes = await deriveBits(fmk, STATE_TOPIC_LABEL, NO_SALT);
  const signerBytes = await deriveBits(fmk, SIGNER_LABEL, NO_SALT);

  // Salted, for the opposite reason: this one is written to the wire in the clear, and an unsalted
  // fingerprint would be identical across envelopes, linking a user's login addresses.
  const keyIdBytes = await deriveBits(fmk, KEY_ID_LABEL, salt);

  const signer = new PrivateKey(signerBytes);

  return IdentityBase.build(
    fmk,
    new Topic(topicBytes),
    new Bytes(keyIdBytes).toString(),
    signer.publicKey().address().toString(),
    signer.toHex(),
  );
}

async function deriveUnlockKey(secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await importDerivationKey(secret);

  return await deriveAesKey(base, UNLOCK_KDF_LABEL, salt);
}

/** Generate the identity and seal the FMK under the credential's unlock key. */
export async function sealKey(
  secret: Uint8Array,
  salt: Uint8Array,
  keyBytes: Uint8Array,
): Promise<{ identity: Identity; sealed: Uint8Array }> {
  const identity = await deriveIdentity(keyBytes, salt);
  const unlockKey = await deriveUnlockKey(secret, salt);
  const sealed = await encryptBytes(unlockKey, keyBytes);

  return { identity, sealed };
}

export async function unsealKey(secret: Uint8Array, envelope: IdentityEnvelope): Promise<Identity> {
  const salt = new Bytes(envelope.salt).toUint8Array();
  const unlockKey = await deriveUnlockKey(secret, salt);

  const keyBytes = await decryptBytes(unlockKey, new Bytes(envelope.sealed).toUint8Array()).catch((err: unknown) => {
    // AES-GCM authenticates, so a failure here means the wrong credential.
    throw new IdentityError(
      'This credential does not unlock the stored identity. If you signed in with a wallet, it may have produced a different signature than last time.',
      err,
    );
  });

  return await deriveIdentity(keyBytes, salt).finally(() => zeroBytes(keyBytes));
}

/** An unlocked FileManager identity. Construct via {@link resolveIdentity} or {@link provisionIdentity}. */
class IdentityBase implements Identity {
  private constructor(
    private readonly fmk: CryptoKey,
    readonly stateTopic: Topic,
    readonly keyId: Hex,
    readonly owner: Hex,
    readonly signer: Hex,
  ) {}

  static build(fmk: CryptoKey, stateTopic: Topic, keyId: Hex, owner: Hex, signer: Hex): Identity {
    return new IdentityBase(fmk, stateTopic, keyId, owner, signer);
  }

  // eslint-disable-next-line require-await
  async deriveKeyBytes(info: string): Promise<Uint8Array> {
    return deriveBits(this.fmk, info, NO_SALT);
  }
}
