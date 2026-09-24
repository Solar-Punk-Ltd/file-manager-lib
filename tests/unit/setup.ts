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
 * hex here and every generation of a node shares one key, while the rest keeps its real shape: keys
 * stay per-node and are registered only by minting or unwrapping, `requireKeys` still throws for a
 * node nothing walked to, and generations, parent links and staleness behave as the real chain's.
 * The real AES path runs in the integration suite, which mocks nothing.
 */
jest.mock('@/keyring', () => {
  const { Bytes } = jest.requireActual('@ethersphere/core-sdk');
  const { generateRandomBytes, sealKey } = jest.requireActual('@/utils/crypto');
  const { KeyringError } = jest.requireActual('@/utils/errors');

  interface Keys {
    meta: Uint8Array;
    content?: Uint8Array;
  }

  interface Wrapped {
    meta: string;
    content?: string;
    gen: number;
    parentGen: number;
  }

  interface Held {
    gen: number;
    keys: Keys;
    link?: { parent: string; parentGen: number };
    foreign: boolean;
    forkLag?: boolean;
  }

  const freshKeys = (): Keys => ({
    meta: generateRandomBytes(32).toUint8Array(),
    content: generateRandomBytes(32).toUint8Array(),
  });

  class TestKeyring {
    private readonly nodes = new Map<string, Held>();
    private readonly floors = new Map<string, number>();
    private readonly rootTopic: string;

    constructor(identity: { stateTopic: { toString: () => string } }) {
      this.rootTopic = identity.stateTopic.toString();
    }

    private node(topic: string): Held {
      const known = this.nodes.get(topic);
      if (known) return known;

      if (topic !== this.rootTopic) {
        throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
      }

      const root: Held = { gen: 0, keys: freshKeys(), foreign: false };
      this.nodes.set(topic, root);

      return root;
    }

    async requireKeys(topic: string): Promise<Keys> {
      return this.node(topic).keys;
    }

    async requireHeld(topic: string): Promise<{ gen: number; keys: Keys }> {
      const { gen, keys } = this.node(topic);

      return { gen, keys };
    }

    async requireContentKey(topic: string): Promise<Uint8Array> {
      const { content } = this.node(topic).keys;
      if (!content) {
        throw new KeyringError(`No content key for node ${topic.slice(0, 6)} — it was reached through a list grant`);
      }

      return content;
    }

    async requireKeysAt(topic: string, _gen: number): Promise<Keys> {
      return this.node(topic).keys;
    }

    raiseFloor(topic: string, gen: number): void {
      if (gen > (this.floors.get(topic) ?? 0)) {
        this.floors.set(topic, gen);
      }
    }

    grantGen(topic: string): number {
      return Math.max(this.genOf(topic), this.floors.get(topic) ?? 0);
    }

    markForkLag(topic: string): void {
      const node = this.nodes.get(topic);
      if (node && !node.foreign) {
        node.forkLag = true;
      }
    }

    has(topic: string): boolean {
      return this.nodes.has(topic) || topic === this.rootTopic;
    }

    genOf(topic: string): number {
      return this.node(topic).gen;
    }

    // Registers before returning, so a caller that does not await still finds the node.
    mint(topic: string): Promise<Keys> {
      const keys = freshKeys();
      this.nodes.set(topic, { gen: 0, keys, foreign: false });

      return Promise.resolve(keys);
    }

    async bump(topic: string): Promise<number> {
      const node = this.node(topic);
      if (node.foreign) {
        throw new KeyringError(`Node ${topic.slice(0, 6)} was shared with this identity — only its owner rotates it`);
      }

      node.gen = Math.max(node.gen + 1, this.floors.get(topic) ?? 0);

      return node.gen;
    }

    register(topic: string, keys: Keys, gen: number): void {
      if (this.has(topic)) {
        throw new KeyringError(`Node ${topic.slice(0, 6)} already has keys — refusing to replace them`);
      }

      this.nodes.set(topic, { gen, keys, foreign: true });
    }

    renew(topic: string, keys: Keys, gen: number): void {
      const node = this.nodes.get(topic);
      if (node && gen > node.gen) {
        node.gen = gen;
        node.keys = keys;
      }
    }

    behind(topic: string, gen: number): boolean {
      const node = this.nodes.get(topic);

      return node !== undefined && node.foreign && gen > node.gen;
    }

    async noteGen(topic: string, gen: number): Promise<void> {
      const node = this.nodes.get(topic);
      if (node && !node.foreign && gen > node.gen) {
        node.gen = gen;
      }
    }

    isStale(topic: string): boolean {
      let current = topic;
      let node = this.nodes.get(current);
      while (node && !node.foreign) {
        if (node.forkLag || node.gen < (this.floors.get(current) ?? 0)) return true;
        if (!node.link) return false;

        const parent = this.nodes.get(node.link.parent);
        if (!parent) return false;
        if (node.link.parentGen < parent.gen) return true;

        current = node.link.parent;
        node = parent;
      }

      return false;
    }

    async metaSealKey(topic: string, _gen: number): Promise<CryptoKey> {
      return await sealKey(this.node(topic).keys.meta);
    }

    async contentSealKey(topic: string, _gen: number): Promise<CryptoKey> {
      return await sealKey(await this.requireContentKey(topic));
    }

    drop(topic: string): void {
      this.nodes.delete(topic);
    }

    async wrapFor(parentTopic: string, childTopic: string): Promise<Wrapped> {
      const parent = this.node(parentTopic);
      const child = this.node(childTopic);
      child.link = { parent: parentTopic, parentGen: parent.gen };
      child.forkLag = false;

      return {
        meta: new Bytes(child.keys.meta).toString(),
        ...(parent.keys.content && child.keys.content ? { content: new Bytes(child.keys.content).toString() } : {}),
        gen: child.gen,
        parentGen: parent.gen,
      };
    }

    async unwrapChild(parentTopic: string, childTopic: string, wrapped: Wrapped, foreign = false): Promise<Keys> {
      const parent = this.node(parentTopic);
      const link = { parent: parentTopic, parentGen: wrapped.parentGen };
      const known = this.nodes.get(childTopic);
      if (known && known.gen > wrapped.gen) {
        known.link = link;
        if (!known.foreign) {
          known.forkLag = true;
        }
        return known.keys;
      }
      if (known && known.gen === wrapped.gen) {
        known.link = link;
        known.forkLag = false;
        return known.keys;
      }

      const keys: Keys = {
        meta: new Bytes(wrapped.meta).toUint8Array(),
        ...(parent.keys.content && wrapped.content ? { content: new Bytes(wrapped.content).toUint8Array() } : {}),
      };
      this.nodes.set(childTopic, {
        gen: wrapped.gen,
        keys,
        link,
        foreign: foreign || parent.foreign || Boolean(known?.foreign),
      });

      return keys;
    }

    clear(): void {
      this.nodes.clear();
      this.floors.clear();
    }
  }

  return { Keyring: TestKeyring };
});

export {};
