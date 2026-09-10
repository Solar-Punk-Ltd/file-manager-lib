import { Bytes, FeedIndex, type Topic } from '@ethersphere/core-sdk';

import { provisionIdentity, resolveIdentity, swarmClientCredential } from '@/identity';
import type { Keyring as RealKeyring } from '@/keyring';
import type { Credential, Identity, IdentityEnvelope, SwarmClient } from '@/types';
import { getFeedData } from '@/utils/bee';
import {
  FEED_INDEX_NONE,
  FEED_INDEX_ZERO,
  FMK_LENGTH,
  KDF_EPOCH,
  ROOT_CONTENT_KEY_LABEL,
  ROOT_META_KEY_LABEL,
  UNLOCK_KDF_LABEL,
  UNLOCK_SALT_LENGTH,
} from '@/utils/constants';
import { GCM_IV_LENGTH } from '@/utils/crypto';
import { IdentityError, KeyringError } from '@/utils/errors';
import { deriveIdentity, envelopeTopic, sealKey, unsealKey } from '@/utils/identity';

const { Keyring } = jest.requireActual('@/keyring');

const GCM_TAG_LENGTH = 16;
const DUMMY_BATCH_ID = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';
const LOGIN_OWNER = '1'.repeat(40);
const FIXED_FMK = new Uint8Array(FMK_LENGTH).fill(0x2a);
const FIXED_SALT = new Uint8Array(UNLOCK_SALT_LENGTH).fill(0x11);
const topicOf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

// The envelope feed, one slot per topic. Writes to a taken slot no-op, as Bee does.
const slots = new Map<string, string>();

function putSlot(topic: Topic | string, payload: string): void {
  slots.set(topic.toString(), payload);
}

function getSlot(topic: Topic | string): IdentityEnvelope {
  return JSON.parse(slots.get(topic.toString()) as string) as IdentityEnvelope;
}

/** A client that only does what the identity flow asks of it: a secret, an owner and a feed write. */
function mockClient(secretByte = 0x7f): SwarmClient {
  return {
    owner: LOGIN_OWNER,
    deriveSecret: async (): Promise<Uint8Array> => new Uint8Array(32).fill(secretByte),
    writeFeed: jest.fn(async (_batchId: string, topic: string, payload: string) => {
      if (!slots.has(topic)) slots.set(topic, payload);

      return { reference: '0'.repeat(64), index: '0' };
    }),
  } as unknown as SwarmClient;
}

const secretOf = async (client: SwarmClient): Promise<Uint8Array> => await client.deriveSecret(UNLOCK_KDF_LABEL);

describe('Identity envelope and key chain', () => {
  beforeEach(() => {
    slots.clear();
    (getFeedData as jest.Mock).mockImplementation(async (_client: SwarmClient, topic: Topic) => {
      const stored = slots.get(topic.toString());

      return stored
        ? { feedIndex: FEED_INDEX_ZERO, feedIndexNext: FeedIndex.fromBigInt(1n), payload: Bytes.fromUtf8(stored) }
        : { feedIndex: FEED_INDEX_NONE, feedIndexNext: FEED_INDEX_ZERO, payload: new Bytes(new Uint8Array(32)) };
    });
  });

  describe('provision and resolve', () => {
    it('should return undefined when the credential has no envelope yet', async () => {
      const client = mockClient();

      await expect(resolveIdentity(client, swarmClientCredential(client))).resolves.toBeUndefined();
    });

    it('should seal a new identity into the envelope slot', async () => {
      const client = mockClient();
      const identity = await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const topic = await envelopeTopic(await secretOf(client));
      expect(client.writeFeed).toHaveBeenCalledWith(
        DUMMY_BATCH_ID,
        topic.toString(),
        expect.any(String),
        // Never appended to: the envelope has exactly one slot.
        '0',
        undefined,
        undefined,
      );

      const envelope = getSlot(topic);
      expect(envelope.v).toBe(KDF_EPOCH);
      expect(envelope.keyId).toBe(identity.keyId);
      // `iv || ciphertext || tag` — the FMK is only ever on the wire sealed.
      expect(new Bytes(envelope.sealed).toUint8Array()).toHaveLength(GCM_IV_LENGTH + FMK_LENGTH + GCM_TAG_LENGTH);
    });

    it('should unseal the same identity it provisioned', async () => {
      const client = mockClient();
      const provisioned = await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const resolved = await resolveIdentity(client, swarmClientCredential(client));

      expect(resolved).toBeDefined();
      expect(resolved?.owner).toBe(provisioned.owner);
      expect(resolved?.keyId).toBe(provisioned.keyId);
      expect(resolved?.signer).toBe(provisioned.signer);
      expect(resolved?.stateTopic.toString()).toBe(provisioned.stateTopic.toString());
      expect(await resolved?.deriveKeyBytes(ROOT_META_KEY_LABEL)).toEqual(
        await provisioned.deriveKeyBytes(ROOT_META_KEY_LABEL),
      );
    });

    it('should own feeds under an address of its own, not the login address', async () => {
      const client = mockClient();
      const identity = await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      expect(identity.owner).not.toBe(client.owner);
    });

    it('should not see another credential envelope', async () => {
      const client = mockClient(0x7f);
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const other = mockClient(0x11);

      // A different secret addresses a different topic, so this is a first run, not a failure.
      await expect(resolveIdentity(other, swarmClientCredential(other))).resolves.toBeUndefined();
    });

    it('should give two credentials two unrelated identities', async () => {
      const a = mockClient(0x7f);
      const b = mockClient(0x11);

      const first = await provisionIdentity(a, swarmClientCredential(a), DUMMY_BATCH_ID);
      const second = await provisionIdentity(b, swarmClientCredential(b), DUMMY_BATCH_ID);

      expect(second.owner).not.toBe(first.owner);
      expect(second.keyId).not.toBe(first.keyId);
      expect(slots.size).toBe(2);
    });
  });

  describe('derivation', () => {
    it('should derive the same identity from the same FMK', async () => {
      const first = await deriveIdentity(FIXED_FMK.slice(), FIXED_SALT);
      const second = await deriveIdentity(FIXED_FMK.slice(), FIXED_SALT);

      expect(second.owner).toBe(first.owner);
      expect(second.signer).toBe(first.signer);
      expect(second.stateTopic.toString()).toBe(first.stateTopic.toString());
      expect(second.keyId).toBe(first.keyId);
    });

    it('should keep the keyId envelope-scoped but the identity salt-independent', async () => {
      const identity = await deriveIdentity(FIXED_FMK.slice(), FIXED_SALT);
      const resalted = await deriveIdentity(FIXED_FMK.slice(), new Uint8Array(UNLOCK_SALT_LENGTH).fill(0x22));

      // Same drives — a second credential on this FMK must reach them.
      expect(resalted.owner).toBe(identity.owner);
      expect(resalted.stateTopic.toString()).toBe(identity.stateTopic.toString());
      // Different fingerprint — the two envelopes must not be publicly linkable.
      expect(resalted.keyId).not.toBe(identity.keyId);
    });

    it('should address a different envelope for every secret', async () => {
      const one = await envelopeTopic(new Uint8Array(32).fill(0x01));
      const two = await envelopeTopic(new Uint8Array(32).fill(0x02));

      expect(one.toString()).not.toBe(two.toString());
      expect((await envelopeTopic(new Uint8Array(32).fill(0x01))).toString()).toBe(one.toString());
    });

    it('should reject an FMK of the wrong length', async () => {
      await expect(deriveIdentity(new Uint8Array(FMK_LENGTH - 1), FIXED_SALT)).rejects.toThrow(IdentityError);
    });
  });

  describe('unlock failures', () => {
    it('should throw when the credential derives a different secret', async () => {
      const { sealed } = await sealKey(new Uint8Array(32).fill(0x7f), FIXED_SALT, FIXED_FMK.slice());
      const envelope: IdentityEnvelope = {
        v: KDF_EPOCH,
        salt: new Bytes(FIXED_SALT).toString(),
        sealed: new Bytes(sealed).toString(),
        keyId: 'unused',
      };

      await expect(unsealKey(new Uint8Array(32).fill(0x80), envelope)).rejects.toThrow(IdentityError);
      await expect(unsealKey(new Uint8Array(32).fill(0x80), envelope)).rejects.toThrow(
        /does not unlock the stored identity/,
      );
    });

    it('should throw when the envelope salt was tampered with', async () => {
      const client = mockClient();
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const topic = await envelopeTopic(await secretOf(client));
      const envelope = getSlot(topic);
      // The salt is public and unauthenticated on its own, but it feeds the unlock key — so a flipped
      // byte surfaces as a GCM failure rather than as a wrong FMK.
      const salt = new Bytes(envelope.salt).toUint8Array();
      salt[0] ^= 0xff;
      putSlot(topic, JSON.stringify({ ...envelope, salt: new Bytes(salt).toString() }));

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(IdentityError);
    });

    it('should throw when the sealed FMK was tampered with', async () => {
      const client = mockClient();
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const topic = await envelopeTopic(await secretOf(client));
      const envelope = getSlot(topic);
      const sealed = new Bytes(envelope.sealed).toUint8Array();
      sealed[sealed.length - 1] ^= 0xff;
      putSlot(topic, JSON.stringify({ ...envelope, sealed: new Bytes(sealed).toString() }));

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(IdentityError);
    });

    it('should refuse an envelope from a newer key-derivation epoch', async () => {
      const client = mockClient();
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const topic = await envelopeTopic(await secretOf(client));
      putSlot(topic, JSON.stringify({ ...getSlot(topic), v: KDF_EPOCH + 1 }));

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(
        /Unsupported identity envelope version/,
      );
    });

    it('should refuse an envelope whose keyId does not match its FMK', async () => {
      const client = mockClient();
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      const topic = await envelopeTopic(await secretOf(client));
      putSlot(topic, JSON.stringify({ ...getSlot(topic), keyId: new Bytes(new Uint8Array(32).fill(9)).toString() }));

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(
        /written by a different key/,
      );
    });

    it('should refuse a malformed envelope', async () => {
      const client = mockClient();
      const topic = await envelopeTopic(await secretOf(client));
      putSlot(topic, JSON.stringify({ v: KDF_EPOCH, salt: new Bytes(FIXED_SALT).toString() }));

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(/malformed/);
    });

    it('should refuse a payload that is not JSON', async () => {
      const client = mockClient();
      putSlot(await envelopeTopic(await secretOf(client)), 'not-json');

      await expect(resolveIdentity(client, swarmClientCredential(client))).rejects.toThrow(/not valid JSON/);
    });
  });

  describe('provisioning over an existing identity', () => {
    it('should refuse to provision twice for the same credential', async () => {
      const client = mockClient();
      await provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID);

      await expect(provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID)).rejects.toThrow(
        /already exists/,
      );
    });

    it('should throw when the write lost a race and the slot holds a foreign envelope', async () => {
      const client = mockClient();
      const topic = await envelopeTopic(await secretOf(client));

      // Bee no-ops on a taken index, so a lost race looks like a successful write. The slot fills in
      // behind us, between the emptiness check and the read-back.
      (client.writeFeed as jest.Mock).mockImplementation(async () => {
        const { sealed } = await sealKey(new Uint8Array(32).fill(0x7f), FIXED_SALT, FIXED_FMK.slice());
        putSlot(
          topic,
          JSON.stringify({
            v: KDF_EPOCH,
            salt: new Bytes(FIXED_SALT).toString(),
            sealed: new Bytes(sealed).toString(),
            keyId: 'other',
          }),
        );

        return { reference: '0'.repeat(64), index: '0' };
      });

      await expect(provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID)).rejects.toThrow(
        /not the expected/,
      );
    });

    it('should refuse to return an identity whose envelope never landed', async () => {
      const client = mockClient();
      // A write that silently goes nowhere: the read-back is the only thing standing between this and
      // an identity the next session cannot find.
      (client.writeFeed as jest.Mock).mockResolvedValue({ reference: '0'.repeat(64), index: '0' });

      await expect(provisionIdentity(client, swarmClientCredential(client), DUMMY_BATCH_ID)).rejects.toThrow(
        /Could not re-confirm the identity/,
      );
    });
  });

  describe('credential contract', () => {
    it('should zero the secret the credential handed over', async () => {
      const secret = new Uint8Array(32).fill(0x7f);
      const credential: Credential = { unlockSecret: async () => secret };
      const client = mockClient();

      await resolveIdentity(client, credential);

      expect(secret.every((b) => b === 0)).toBe(true);
    });
  });

  describe('Keyring', () => {
    let identity: Identity;
    let keyring: RealKeyring;
    let root: string;

    beforeEach(async () => {
      identity = await deriveIdentity(FIXED_FMK.slice(), FIXED_SALT);
      keyring = new Keyring(identity);
      root = identity.stateTopic.toString();
    });

    it('should derive the root keys from the FMK', async () => {
      const keys = await keyring.requireKeys(root);

      expect(keys.meta).toEqual(await identity.deriveKeyBytes(ROOT_META_KEY_LABEL));
      expect(keys.content).toEqual(await identity.deriveKeyBytes(ROOT_CONTENT_KEY_LABEL));
      expect(keys.meta).not.toEqual(keys.content);
    });

    it('should refuse a node whose parent was never resolved', async () => {
      await expect(keyring.requireKeys(topicOf(1))).rejects.toThrow(KeyringError);
      expect(keyring.has(topicOf(1))).toBe(false);
      expect(keyring.has(root)).toBe(true);
    });

    it('should recover a child key from its parent', async () => {
      const child = topicOf(1);
      const minted = keyring.mint(child);
      const wrapped = await keyring.wrapFor(root, child);

      // A fresh session: nothing cached, the root re-derived from the same FMK.
      const reopened = new Keyring(await deriveIdentity(FIXED_FMK.slice(), FIXED_SALT));
      const unwrapped = await reopened.unwrapChild(root, child, wrapped);

      expect(unwrapped).toEqual(minted);
    });

    it('should not store a child key in the clear', async () => {
      const child = topicOf(1);
      const minted = keyring.mint(child);
      const wrapped = await keyring.wrapFor(root, child);

      expect(wrapped.meta).not.toContain(new Bytes(minted.meta).toString());
      expect(wrapped.content).not.toContain(new Bytes(minted.content).toString());
    });

    it('should refuse a child wrapped under a different parent', async () => {
      const parent = topicOf(1);
      const child = topicOf(2);
      keyring.mint(parent);
      keyring.mint(child);
      const wrapped = await keyring.wrapFor(root, child);

      // Same ciphertext, wrong key-encryption key: GCM authenticates, so this cannot half-succeed.
      await expect(keyring.unwrapChild(parent, topicOf(3), wrapped)).rejects.toThrow(KeyringError);
      await expect(keyring.unwrapChild(parent, topicOf(3), wrapped)).rejects.toThrow(
        /does not unwrap under its parent/,
      );
    });

    it('should hand out copies, so a clear cannot zero a key still in use', async () => {
      const keys = await keyring.requireKeys(root);
      const held = new Uint8Array(keys.meta);

      keyring.clear();

      // The regression this guards: `clear()` used to zero the very array a mid-flight write held,
      // which sealed the write under an all-zero key instead of failing.
      expect(keys.meta).toEqual(held);
      expect(keys.meta.some((b) => b !== 0)).toBe(true);
    });

    it('should re-derive the root after a clear', async () => {
      const before = await keyring.requireKeys(root);
      keyring.clear();

      expect(await keyring.requireKeys(root)).toEqual(before);
      // Node keys are random, so only the root survives a clear.
      await expect(keyring.requireKeys(topicOf(1))).rejects.toThrow(KeyringError);
    });
  });
});
