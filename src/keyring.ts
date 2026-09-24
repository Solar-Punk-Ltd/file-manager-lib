import type { HeldNode, NodeKeys, WrappedKeys } from './types/crypto';
import type { Identity } from './types/identity';
import {
  KEY_CHAIN_LENGTH,
  NODE_CONTENT_CHAIN_LABEL,
  NODE_META_CHAIN_LABEL,
  ROOT_CONTENT_KEY_LABEL,
  ROOT_META_KEY_LABEL,
} from './utils/constants';
import { chainKey, copyKeys, pastChainKey, sameKey, sealKey, unwrapKey, wrapKey, zeroBytes } from './utils/crypto';
import { KeyringError } from './utils/errors';

/**
 * In-memory key chain for one identity: every node's `meta`/`content` key pair at the generation it
 * was last seen, hydrated as the tree is walked.
 *
 * The root is the state node, whose keys come straight from the FMK and never rotate. Every other
 * node's keys sit on two reverse hash chains of its own, rooted in the FMK: a holder of one
 * generation derives every earlier one and none later, so stepping a node one generation on
 * withdraws its future writes from whoever held it before. The current generation is sealed under
 * the parent's and stored in the parent's fork metadata, so reaching a node means having unwrapped
 * every node above it. Nothing here touches the network.
 */
export class Keyring {
  private readonly nodes: Map<string, HeldNode> = new Map();
  private readonly floors: Map<string, number> = new Map();
  private readonly rootTopic: string;

  constructor(private readonly identity: Identity) {
    this.rootTopic = identity.stateTopic.toString();
  }

  /** Keys for `topic` at the generation held, deriving the root's on first use. Throws for a node never reached. */
  async requireKeys(topic: string): Promise<NodeKeys> {
    return copyKeys((await this.requireNode(topic)).keys);
  }

  /** The generation held for `topic` together with its keys, read as one. */
  async requireHeld(topic: string): Promise<{ gen: number; keys: NodeKeys }> {
    const node = await this.requireNode(topic);

    return { gen: node.gen, keys: copyKeys(node.keys) };
  }

  /**
   * `K_content` for `topic`. Throws where {@link requireKeys} would succeed but the node carries no
   * content key — a subtree reached through a `list` grant lists but never opens.
   */
  async requireContentKey(topic: string): Promise<Uint8Array> {
    const { content } = await this.requireKeys(topic);
    if (!content) {
      throw new KeyringError(`No content key for node ${topic.slice(0, 6)} — it was reached through a list grant`);
    }

    return content;
  }

  /** Whether {@link requireKeys} would resolve `topic` without a walk. */
  has(topic: string): boolean {
    return this.nodes.has(topic) || topic === this.rootTopic;
  }

  /** The generation a write to `topic` seals under. */
  genOf(topic: string): number {
    if (topic === this.rootTopic) return 0;

    const node = this.nodes.get(topic);
    if (!node) {
      throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
    }

    return node.gen;
  }

  /**
   * Keys for an owned node at `gen`, including one it has not rotated to yet. A grant issued ahead of
   * a rotation opens the node from the moment it lands.
   */
  async requireKeysAt(topic: string, gen: number): Promise<NodeKeys> {
    return copyKeys(await this.keysAt(topic, gen));
  }

  /**
   * The generation `topic` has to reach before its next write — a revoke recorded but not yet
   * rotated. Only ever raises it.
   */
  raiseFloor(topic: string, gen: number): void {
    if (gen > (this.floors.get(topic) ?? 0)) {
      this.floors.set(topic, gen);
    }
  }

  /** The generation a grant issued now carries: the held one, or a pending rotation's above it. */
  grantGen(topic: string): number {
    return Math.max(this.genOf(topic), this.floors.get(topic) ?? 0);
  }

  /** Keys for a node being created: generation 0 of its own chain. */
  async mint(topic: string): Promise<NodeKeys> {
    const keys = await this.derive(topic, 0);
    this.nodes.set(topic, { gen: 0, keys, foreign: false });

    return copyKeys(keys);
  }

  /**
   * Step an owned node one generation on, or up to its floor. Whoever held it stops following it
   * from its next write.
   */
  async bump(topic: string): Promise<number> {
    const node = await this.requireNode(topic);
    if (node.foreign) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} was shared with this identity — only its owner rotates it`);
    }
    const gen = Math.max(node.gen + 1, this.floors.get(topic) ?? 0);
    if (gen > KEY_CHAIN_LENGTH) {
      throw new KeyringError(`Key chain for node ${topic.slice(0, 6)} is exhausted`);
    }

    this.advance(node, await this.derive(topic, gen), gen);

    return node.gen;
  }

  /** Install a grant's keys: the root of a subtree someone else owns. */
  register(topic: string, keys: NodeKeys, gen: number): void {
    if (this.has(topic)) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} already has keys — refusing to replace them`);
    }

    this.nodes.set(topic, { gen, keys, foreign: true });
  }

  /** Take a re-issued grant's keys. Only ever moves forward: an older grant says nothing new. */
  renew(topic: string, keys: NodeKeys, gen: number): void {
    const node = this.nodes.get(topic);
    if (!node?.foreign) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} is not held through a grant`);
    }

    this.advance(node, keys, gen);
  }

  /** Whether `gen` is past what a grant gave this identity of `topic` — it was rotated since. */
  behind(topic: string, gen: number): boolean {
    const node = this.nodes.get(topic);

    return node !== undefined && node.foreign && gen > node.gen;
  }

  /**
   * Learn an owned node's generation from something written under it — a feed head sealed after
   * another session rotated it. Only ever raises it: sealing below a rotation would hand the next
   * write back to whoever it withdrew.
   */
  async noteGen(topic: string, gen: number): Promise<void> {
    const node = this.nodes.get(topic);
    if (!node || node.foreign || gen <= node.gen) return;

    this.advance(node, await this.derive(topic, gen), gen);
  }

  /**
   * Whether `topic` or a node above it has to rotate before anything is written to it: it lags its
   * parent's generation or its floor, or its fork lags it. Each is still held by someone a rotation
   * withdrew, or reached at a generation its writes would no longer be sealed under.
   */
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

  /** Flag an owned node whose fork may still carry an earlier generation, so its next write re-wraps it first. */
  markForkLag(topic: string): void {
    const node = this.nodes.get(topic);
    if (node && !node.foreign) {
      node.forkLag = true;
    }
  }

  /** `K_meta` for `topic` at `gen` — the key its manifest and feed payload are sealed under. */
  async metaSealKey(topic: string, gen: number): Promise<CryptoKey> {
    return await sealKey((await this.keysAt(topic, gen)).meta);
  }

  /** `K_content` for `topic` at `gen`. Throws where the node was reached through a list grant. */
  async contentSealKey(topic: string, gen: number): Promise<CryptoKey> {
    const { content } = await this.keysAt(topic, gen);
    if (!content) {
      throw new KeyringError(`No content key for node ${topic.slice(0, 6)} — it was reached through a list grant`);
    }

    return await sealKey(content);
  }

  /** Undo a registration whose caller could not finish. */
  drop(topic: string): void {
    const node = this.nodes.get(topic);
    if (!node) return;

    zeroKeys(node.keys);
    this.nodes.delete(topic);
  }

  /** Seal `childTopic`'s keys under `parentTopic`'s, for storing in the parent's fork metadata. */
  async wrapFor(parentTopic: string, childTopic: string): Promise<WrappedKeys> {
    const parent = await this.requireNode(parentTopic);
    const child = await this.requireNode(childTopic);
    const { gen: parentGen, keys: parentKeys } = parent;
    const { gen, keys } = child;

    const wrapped: WrappedKeys = {
      meta: await wrapKey(parentKeys.meta, keys.meta),
      ...(parentKeys.content && keys.content ? { content: await wrapKey(parentKeys.content, keys.content) } : {}),
      gen,
      parentGen,
    };
    child.link = { parent: parentTopic, parentGen };
    child.forkLag = false;

    return wrapped;
  }

  /**
   * Recover and register a child's keys from its fork metadata. `foreign` marks a mount: the chain
   * below it belongs to its sharer.
   */
  async unwrapChild(
    parentTopic: string,
    childTopic: string,
    wrapped: WrappedKeys,
    foreign: boolean = false,
  ): Promise<NodeKeys> {
    const parent = await this.requireNode(parentTopic);
    const parentKeys = await this.keysAt(parentTopic, wrapped.parentGen);

    // No content key above means none below: a list-only chain stays list-only all the way down.
    const parentContent = parentKeys.content;
    const wrappedContent = wrapped.content;

    let keys: NodeKeys;
    try {
      keys = {
        meta: await unwrapKey(parentKeys.meta, wrapped.meta),
        ...(parentContent && wrappedContent ? { content: await unwrapKey(parentContent, wrappedContent) } : {}),
      };
    } catch (err: unknown) {
      throw new KeyringError(
        `Fork ${childTopic.slice(0, 6)} does not unwrap under its parent — the manifest and the key chain disagree`,
        err,
      );
    }

    const link = { parent: parentTopic, parentGen: wrapped.parentGen };
    const known = this.nodes.get(childTopic);
    if (!known || wrapped.gen > known.gen) {
      this.nodes.set(childTopic, {
        gen: wrapped.gen,
        keys,
        link,
        foreign: foreign || parent.foreign || Boolean(known?.foreign),
      });

      return copyKeys(keys);
    }

    // A fork older than the generation held: the rotation's save did not land, or this copy of the
    // parent predates it. Writes seal under the held one, so the fork is re-wrapped before the next.
    if (wrapped.gen < known.gen) {
      known.link = link;
      if (!known.foreign) {
        known.forkLag = true;
      }

      return copyKeys(known.keys);
    }

    // Only what both sides carry: a chain that gained a content key is an upgrade, not a conflict.
    const contentConflict =
      known.keys.content !== undefined && keys.content !== undefined && !sameKey(known.keys.content, keys.content);
    const metaConflict = !sameKey(known.keys.meta, keys.meta);

    if (metaConflict || contentConflict) {
      throw new KeyringError(
        `Fork ${childTopic.slice(0, 6)} unwraps to different keys than the chain already holds for it`,
      );
    }

    const content = known.keys.content ?? keys.content;
    known.keys = { meta: known.keys.meta, ...(content ? { content } : {}) };
    known.link = link;
    known.forkLag = false;

    return copyKeys(known.keys);
  }

  /** Zeroes and drops every key. Copies already handed out are left to the GC. */
  clear(): void {
    for (const node of this.nodes.values()) {
      zeroKeys(node.keys);
    }
    this.nodes.clear();
    this.floors.clear();
  }

  private async requireNode(topic: string): Promise<HeldNode> {
    const known = this.nodes.get(topic);
    if (known) return known;

    if (topic !== this.rootTopic) {
      throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
    }

    const root: HeldNode = {
      gen: 0,
      keys: {
        meta: await this.identity.deriveKeyBytes(ROOT_META_KEY_LABEL),
        content: await this.identity.deriveKeyBytes(ROOT_CONTENT_KEY_LABEL),
      },
      foreign: false,
    };

    const raced = this.nodes.get(topic);
    if (raced) return raced;

    this.nodes.set(topic, root);

    return root;
  }

  private async keysAt(topic: string, gen: number): Promise<NodeKeys> {
    const node = await this.requireNode(topic);
    if (gen === node.gen) return node.keys;

    if (gen < node.gen) {
      return {
        meta: pastChainKey(node.keys.meta, node.gen, gen),
        ...(node.keys.content ? { content: pastChainKey(node.keys.content, node.gen, gen) } : {}),
      };
    }

    if (node.foreign) {
      throw new KeyringError(
        `Node ${topic.slice(0, 6)} is sealed under generation ${gen}, past the ${node.gen} its grant carries — it was rotated, or the grant withdrawn`,
      );
    }

    // Sealed after a rotation this session has not seen yet, by another session of the same identity.
    return await this.derive(topic, gen);
  }

  // Only the owner can: the chain roots come from its FMK.
  private async derive(topic: string, gen: number): Promise<NodeKeys> {
    if (topic === this.rootTopic) {
      throw new KeyringError('The state node never rotates');
    }

    const metaRoot = await this.identity.deriveKeyBytes(`${NODE_META_CHAIN_LABEL}:${topic}`);
    const contentRoot = await this.identity.deriveKeyBytes(`${NODE_CONTENT_CHAIN_LABEL}:${topic}`);
    try {
      return { meta: chainKey(metaRoot, gen), content: chainKey(contentRoot, gen) };
    } finally {
      zeroBytes(metaRoot);
      zeroBytes(contentRoot);
    }
  }

  // Forward only, so two rotations racing on one node settle on the later generation.
  private advance(node: HeldNode, keys: NodeKeys, gen: number): void {
    if (gen <= node.gen) return;

    node.gen = gen;
    node.keys = keys;
  }
}

function zeroKeys(keys: NodeKeys): void {
  zeroBytes(keys.meta);
  if (keys.content) {
    zeroBytes(keys.content);
  }
}
