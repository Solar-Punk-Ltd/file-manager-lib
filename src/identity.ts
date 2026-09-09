import type { BeeRequestOptions } from '@ethersphere/bee-js';
import { Bytes, type Topic } from '@ethersphere/core-sdk';

import type { Credential, Identity, IdentityEnvelope } from './types/identity';
import type { SwarmClient } from './types/swarmClient';
import type { FeedResultWithIndex, Hex } from './types/utils';
import { assertIdentityEnvelope } from './utils/asserts';
import { getFeedData } from './utils/bee';
import { errorMessage } from './utils/common';
import {
  FEED_INDEX_NONE,
  FMK_LENGTH,
  IDENTITY_ENVELOPE_FEED_INDEX,
  KDF_EPOCH,
  UNLOCK_KDF_LABEL,
  UNLOCK_SALT_LENGTH,
} from './utils/constants';
import { generateRandomBytes, zeroBytes } from './utils/crypto';
import { IdentityError } from './utils/errors';
import { envelopeTopic, sealKey, unsealKey } from './utils/identity';
import { Logger } from './utils/logger';

const logger = Logger.getInstance();

// The FileManager Key (FMK) is the root of all index encryption. It is sealed under a
// credential-derived key and stored as an envelope the credential can locate without holding the
// FMK, so every login method that unseals it reaches the same drives. See encryption-and-act.md §2.1.

/**
 * The default credential, derived from the backend's own key material.
 *
 * On `SnahaClient` the secret is scoped to `(identity, app origin)`, so an identity provisioned on
 * one origin does not unseal on another. Pass a different `Credential` to work around that.
 */
export function swarmClientCredential(swarmClient: SwarmClient): Credential {
  return {
    async unlockSecret(): Promise<Uint8Array> {
      return await swarmClient.deriveSecret(UNLOCK_KDF_LABEL);
    },
  };
}

// One unlockSecret() per operation — it derives both the envelope's topic and the key that opens it,
// and a wallet-backed credential would otherwise prompt for a second signature.
async function withUnlockSecret<T>(credential: Credential, fn: (secret: Uint8Array) => Promise<T>): Promise<T> {
  const secret = await credential.unlockSecret();
  try {
    return await fn(secret);
  } finally {
    zeroBytes(secret);
  }
}

/**
 * Read the envelope feed's only slot.
 *
 * Slot 0 first: a provisioned envelope is then one chunk fetch, with no feed lookup for the node to
 * run. Bee answers a *missing* chunk with a 500 rather than a 404, though, so a first login lands in
 * the fallback and re-asks over the feed endpoint, which reports an empty feed properly.
 *
 */
async function readEnvelopeFeed(
  swarmClient: SwarmClient,
  topic: Topic,
  requestOptions?: BeeRequestOptions,
): Promise<FeedResultWithIndex> {
  try {
    return await getFeedData(swarmClient, topic, swarmClient.owner, IDENTITY_ENVELOPE_FEED_INDEX, requestOptions);
  } catch (err: unknown) {
    logger.debug(`Envelope slot read failed, falling back to the feed head: ${errorMessage(err)}`);

    return await getFeedData(swarmClient, topic, swarmClient.owner, undefined, requestOptions);
  }
}

/**
 * Read the envelope for `credential` and unseal it.
 *
 * Returns `undefined` when no envelope exists — a first run, not a failure. An envelope that exists
 * but cannot be unsealed throws: the credential re-derived a different secret, and continuing would
 * show an empty drive list instead of an error.
 */
export async function resolveIdentity(
  swarmClient: SwarmClient,
  credential: Credential,
  requestOptions?: BeeRequestOptions,
): Promise<Identity | undefined> {
  return await withUnlockSecret(credential, async (secret) => {
    const topic = await envelopeTopic(secret);
    const { payload, feedIndex } = await readEnvelopeFeed(swarmClient, topic, requestOptions);

    if (feedIndex.equals(FEED_INDEX_NONE)) {
      logger.debug('No identity envelope found for this credential.');
      return undefined;
    }

    let envelope: unknown;
    try {
      envelope = payload.toJSON();
    } catch (err: unknown) {
      throw new IdentityError('Identity envelope is not valid JSON', err);
    }

    assertIdentityEnvelope(envelope);

    if (envelope.v !== KDF_EPOCH) {
      throw new IdentityError(`Unsupported identity envelope version ${envelope.v}`);
    }

    const identity = await unsealKey(secret, envelope);

    if (identity.keyId !== envelope.keyId) {
      throw new IdentityError('Identity envelope was written by a different key');
    }

    logger.debug('Identity unsealed.');

    return identity;
  });
}

/**
 * Create an identity for `credential` and write its envelope.
 *
 * Only for a credential with no envelope yet. It does not overwrite — Bee silently no-ops on a taken
 * index, so a concurrent provisioning race loses data rather than erroring. Call this from one place.
 *
 * Separate from `resolveIdentity` because it writes: a user with no stamp can still initialize and
 * read, they just cannot provision.
 */
export async function provisionIdentity(
  swarmClient: SwarmClient,
  credential: Credential,
  batchId: Hex,
  requestOptions?: BeeRequestOptions,
): Promise<Identity> {
  return await withUnlockSecret(credential, async (secret) => {
    const topic = await envelopeTopic(secret);
    const { feedIndex } = await readEnvelopeFeed(swarmClient, topic, requestOptions);

    if (!feedIndex.equals(FEED_INDEX_NONE)) {
      throw new IdentityError('Identity envelope already exists for this credential');
    }

    // Must stay fresh per envelope: a second credential joining this identity and reusing this salt
    // would produce an identical keyId in both, publicly linking the two logins.
    const salt = generateRandomBytes(UNLOCK_SALT_LENGTH).toUint8Array();
    const fmkBytes = generateRandomBytes(FMK_LENGTH).toUint8Array();

    const { identity, sealed } = await sealKey(secret, salt, fmkBytes).finally(() => zeroBytes(fmkBytes));

    const envelope: IdentityEnvelope = {
      v: KDF_EPOCH,
      salt: new Bytes(salt).toString(),
      sealed: new Bytes(sealed).toString(),
      keyId: identity.keyId,
    };

    await swarmClient.writeFeed(
      batchId,
      topic.toString(),
      JSON.stringify(envelope),
      // Decimal, per the port contract. FeedIndex.toString() emits 16-char hex and would silently
      // address the wrong slot.
      IDENTITY_ENVELOPE_FEED_INDEX.toString(),
      undefined,
      requestOptions,
    );

    logger.debug('Identity envelope provisioned.');

    return identity;
  });
}
