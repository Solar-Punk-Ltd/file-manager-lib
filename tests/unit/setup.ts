jest.mock('@/utils/bee', () => ({
  ...jest.requireActual('@/utils/bee'),
  getFeedData: jest.fn(),
  fetchStamp: jest.fn(),
  writeSealedRefFeed: jest.fn(),
  writeEncryptedFeed: jest.fn(),
  openFeedRef: jest.fn(),
}));

jest.mock('@/utils/mantaray', () => ({
  ...jest.requireActual('@/utils/mantaray'),
  loadMantaray: jest.fn(),
  getAllNodeEntries: jest.fn(),
}));

/**
 * Unit tests fake the cipher, not the chain.
 *
 * Fork metadata in these specs is written by hand, and a real `wrapFor` seals a child's keys under
 * a parent key minted at runtime — no static fixture can produce that ciphertext. So wrapping is
 * hex here while everything else keeps its real shape: keys stay per-node, are still registered
 * only by minting or unwrapping, and `requireKeys` still throws for a node nothing walked to. The
 * real AES path runs in the integration suite, which mocks nothing.
 */
jest.mock('@/keyring', () => {
  const { Bytes } = jest.requireActual('@ethersphere/core-sdk');
  const { generateNodeKeys } = jest.requireActual('@/utils/crypto');
  const { KeyringError } = jest.requireActual('@/utils/errors');

  interface Keys {
    meta: Uint8Array;
    content: Uint8Array;
  }

  class TestKeyring {
    private readonly keys = new Map<string, Keys>();
    private readonly rootTopic: string;

    constructor(identity: { stateTopic: { toString: () => string } }) {
      this.rootTopic = identity.stateTopic.toString();
    }

    async requireKeys(topic: string): Promise<Keys> {
      const known = this.keys.get(topic);
      if (known) return known;

      if (topic !== this.rootTopic) {
        throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
      }

      return this.mint(topic);
    }

    has(topic: string): boolean {
      return this.keys.has(topic) || topic === this.rootTopic;
    }

    mint(topic: string): Keys {
      const keys = generateNodeKeys() as Keys;
      this.keys.set(topic, keys);

      return keys;
    }

    register(topic: string, keys: Keys): void {
      this.keys.set(topic, keys);
    }

    async wrapFor(parentTopic: string, childTopic: string): Promise<{ meta: string; content: string }> {
      await this.requireKeys(parentTopic);
      const child = await this.requireKeys(childTopic);

      return { meta: new Bytes(child.meta).toString(), content: new Bytes(child.content).toString() };
    }

    async unwrapChild(
      parentTopic: string,
      childTopic: string,
      wrapped: { meta: string; content: string },
    ): Promise<Keys> {
      const known = this.keys.get(childTopic);
      if (known) return known;

      await this.requireKeys(parentTopic);
      const keys: Keys = {
        meta: new Bytes(wrapped.meta).toUint8Array(),
        content: new Bytes(wrapped.content).toUint8Array(),
      };
      this.keys.set(childTopic, keys);

      return keys;
    }

    clear(): void {
      this.keys.clear();
    }
  }

  return { Keyring: TestKeyring };
});

export {};
