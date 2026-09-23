import type { EpochScope, NodeKeys, WrappedKeys } from './types/crypto';
import type { Identity } from './types/identity';
import {
  EPOCH_CHAIN_LENGTH,
  EPOCH_ROOT_LABEL,
  EPOCH_START,
  ROOT_CONTENT_KEY_LABEL,
  ROOT_META_KEY_LABEL,
} from './utils/constants';
import {
  copyKeys,
  effectiveKey,
  epochSecret,
  generateNodeKeys,
  pastEpochSecret,
  sameKey,
  unwrapKey,
  wrapKey,
} from './utils/crypto';
import { KeyringError } from './utils/errors';

/**
 * In-memory key chain for one identity: every node's `meta`/`content` key pair, hydrated as the
 * tree is walked.
 *
 * The root is the state node, whose keys come straight from the FMK. Every other node's keys are
 * random, sealed under its parent's, and stored in the parent's fork metadata — so reaching a node
 * means having unwrapped every node above it. Nothing here touches the network.
 *
 * Keys are never evicted. A rotation that fails halfway must still leave the owner able to read
 * both generations; only a recipient's view is meant to change.
 */
export class Keyring {
  private readonly keys: Map<string, NodeKeys> = new Map();
  private readonly scopes: Map<string, EpochScope> = new Map();
  private readonly anchors: Map<string, string> = new Map();
  private readonly rootTopic: string;

  constructor(private readonly identity: Identity) {
    this.rootTopic = identity.stateTopic.toString();
  }

  /** Registered keys for `topic`, deriving the root's on first use. Throws if the node was never reached. */
  async requireKeys(topic: string): Promise<NodeKeys> {
    const known = this.keys.get(topic);
    if (known) return copyKeys(known);

    if (topic !== this.rootTopic) {
      throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
    }

    const root: NodeKeys = {
      meta: await this.identity.deriveKeyBytes(ROOT_META_KEY_LABEL),
      content: await this.identity.deriveKeyBytes(ROOT_CONTENT_KEY_LABEL),
    };
    this.keys.set(topic, root);
    await this.openScope(topic);

    return copyKeys(root);
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
    return this.keys.has(topic) || topic === this.rootTopic;
  }

  /** Fresh keys for a node being created, in its parent's epoch scope. */
  mint(topic: string, parentTopic: string): NodeKeys {
    const keys = generateNodeKeys();
    this.keys.set(topic, keys);
    this.anchors.set(topic, this.anchorOf(parentTopic));

    return copyKeys(keys);
  }

  /** Fresh keys for a drive root, which anchors an epoch scope of its own. */
  async mintAnchor(topic: string): Promise<NodeKeys> {
    const keys = generateNodeKeys();
    this.keys.set(topic, keys);
    await this.openScope(topic);

    return copyKeys(keys);
  }

  /** Install keys received from outside the chain */
  register(topic: string, keys: NodeKeys, scope: { epoch: number; secret: Uint8Array }): void {
    if (this.has(topic)) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} already has keys — refusing to replace them`);
    }

    this.keys.set(topic, keys);
    this.adoptScope(topic, scope.epoch, scope.secret);
  }

  /** Anchor a scope on a secret handed in rather than derived — a mount following the sharer's bulletin. */
  adoptScope(anchorTopic: string, epoch: number, secret: Uint8Array): void {
    const scope = this.scopes.get(anchorTopic) ?? { current: epoch, secrets: new Map<number, Uint8Array>() };
    scope.secrets.set(epoch, secret);
    if (epoch > scope.current) {
      scope.current = epoch;
    }

    this.scopes.set(anchorTopic, scope);
    this.anchors.set(anchorTopic, anchorTopic);
  }

  /** Step a scope one place along its chain. Everything in it re-keys on its next write. */
  bumpEpoch(anchorTopic: string): number {
    const scope = this.scopeAt(anchorTopic);
    if (!scope.root) {
      throw new KeyringError(`Epoch scope ${anchorTopic.slice(0, 6)} is a mount — only its sharer can bump it`);
    }
    if (scope.current + 1 > EPOCH_CHAIN_LENGTH) {
      throw new KeyringError(`Epoch chain for ${anchorTopic.slice(0, 6)} is exhausted — the drive has to re-anchor`);
    }

    scope.current += 1;

    return scope.current;
  }

  /** Drive roots and the state node anchor their own scope; everything below inherits it. */
  async openScope(topic: string, current: number = EPOCH_START): Promise<void> {
    if (this.scopes.has(topic)) {
      this.anchors.set(topic, topic);

      return;
    }

    const root = await this.identity.deriveKeyBytes(`${EPOCH_ROOT_LABEL}:${topic}`);
    this.scopes.set(topic, { root, current, secrets: new Map() });
    this.anchors.set(topic, topic);
  }

  /**
   * Learn an owned scope's current epoch from the feed head of any node in it. Ignored for a mount,
   * whose epoch comes from the sharer's bulletin.
   *
   * Only ever raises it. A head read after a bump still reports the epoch it was sealed under, and
   * taking that at face value would walk the scope back and lose the withdrawal.
   */
  noteEpoch(topic: string, epoch: number): void {
    const anchor = this.anchors.get(topic);
    const scope = anchor === undefined ? undefined : this.scopes.get(anchor);
    if (scope?.root && epoch > scope.current) {
      scope.current = epoch;
    }
  }

  /** The epoch a write to `topic` seals under. */
  epochFor(topic: string): number {
    return this.scopeAt(this.anchorOf(topic)).current;
  }

  /** `K_meta` for `topic` at `epoch` — the key its manifest and feed payload are sealed under. */
  async metaSealKey(topic: string, epoch: number): Promise<CryptoKey> {
    const { meta } = await this.requireKeys(topic);

    return await effectiveKey(meta, this.secretFor(topic, epoch));
  }

  /** `K_content` for `topic` at `epoch`. Throws where the node was reached through a list grant. */
  async contentSealKey(topic: string, epoch: number): Promise<CryptoKey> {
    const content = await this.requireContentKey(topic);

    return await effectiveKey(content, this.secretFor(topic, epoch));
  }

  private anchorOf(topic: string): string {
    const anchor = this.anchors.get(topic);
    if (!anchor) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} belongs to no epoch scope — its parent was never resolved`);
    }

    return anchor;
  }

  private scopeAt(anchorTopic: string): EpochScope {
    const scope = this.scopes.get(anchorTopic);
    if (!scope) {
      throw new KeyringError(`No epoch scope anchored at ${anchorTopic.slice(0, 6)}`);
    }

    return scope;
  }

  // One walk of the chain per scope; every older epoch is then a few steps from the current one.
  // An owner also reaches past it, to a node sealed after a bump its root head never recorded.
  private secretFor(topic: string, epoch: number): Uint8Array {
    const scope = this.scopeAt(this.anchorOf(topic));
    const cached = scope.secrets.get(epoch);
    if (cached) return cached;

    const from = scope.root ? Math.max(epoch, scope.current) : scope.current;
    let start = scope.secrets.get(from);
    if (!start) {
      if (!scope.root) {
        throw new KeyringError(`No epoch secret for ${topic.slice(0, 6)} at ${from} and no chain root`);
      }

      start = epochSecret(scope.root, from);
      scope.secrets.set(from, start);
    }

    const secret = pastEpochSecret(start, from, epoch);
    scope.secrets.set(epoch, secret);

    return secret;
  }

  /** The epoch secret a grant hands over: enough to read back, never enough to follow a withdrawal. */
  currentSecret(topic: string): { epoch: number; secret: Uint8Array } {
    const epoch = this.epochFor(topic);

    return { epoch, secret: new Uint8Array(this.secretFor(topic, epoch)) };
  }

  /** Undo a registration whose caller could not finish. */
  drop(topic: string): void {
    const keys = this.keys.get(topic);
    if (!keys) return;

    keys.meta.fill(0);
    keys.content?.fill(0);
    this.keys.delete(topic);
    this.anchors.delete(topic);
  }

  /** Seal `childTopic`'s keys under `parentTopic`'s, for storing in the parent's fork metadata. */
  async wrapFor(parentTopic: string, childTopic: string): Promise<WrappedKeys> {
    const parent = await this.requireKeys(parentTopic);
    const child = await this.requireKeys(childTopic);

    return {
      meta: await wrapKey(parent.meta, child.meta),
      ...(parent.content && child.content ? { content: await wrapKey(parent.content, child.content) } : {}),
    };
  }

  /** Recover and register a child's keys from its fork metadata. */
  async unwrapChild(parentTopic: string, childTopic: string, wrapped: WrappedKeys): Promise<NodeKeys> {
    const parent = await this.requireKeys(parentTopic);

    // No content key above means none below: a list-only chain stays list-only all the way down.
    const parentContent = parent.content;
    const wrappedContent = wrapped.content;

    let keys: NodeKeys;
    try {
      keys = {
        meta: await unwrapKey(parent.meta, wrapped.meta),
        ...(parentContent && wrappedContent ? { content: await unwrapKey(parentContent, wrappedContent) } : {}),
      };
    } catch (err: unknown) {
      throw new KeyringError(
        `Fork ${childTopic.slice(0, 6)} does not unwrap under its parent — the manifest and the key chain disagree`,
        err,
      );
    }

    const known = this.keys.get(childTopic);
    if (known) {
      // Only what both sides carry: a chain that gained a content key is an upgrade, not a conflict.
      const contentConflict =
        known.content !== undefined && keys.content !== undefined && !sameKey(known.content, keys.content);
      const metaConflict = !sameKey(known.meta, keys.meta);

      if (metaConflict || contentConflict) {
        throw new KeyringError(
          `Fork ${childTopic.slice(0, 6)} unwraps to different keys than the chain already holds for it`,
        );
      }

      this.anchors.set(childTopic, this.anchorOf(parentTopic));

      return copyKeys(known);
    }

    this.keys.set(childTopic, keys);
    this.anchors.set(childTopic, this.anchorOf(parentTopic));

    return copyKeys(keys);
  }

  /** Zeroes and drops every key. Copies already handed out are left to the GC. */
  clear(): void {
    for (const keys of this.keys.values()) {
      keys.meta.fill(0);
      keys.content?.fill(0);
    }
    this.keys.clear();
    this.scopes.clear();
    this.anchors.clear();
  }
}
