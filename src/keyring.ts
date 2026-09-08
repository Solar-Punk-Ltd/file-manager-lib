import type { Identity } from './types/identity';
import type { NodeKeys, WrappedKeys } from './types/utils';
import { ROOT_CONTENT_KEY_LABEL, ROOT_META_KEY_LABEL } from './utils/constants';
import { generateNodeKeys, unwrapKey, wrapKey } from './utils/crypto';
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
  private readonly rootTopic: string;

  constructor(private readonly identity: Identity) {
    this.rootTopic = identity.stateTopic.toString();
  }

  /** Registered keys for `topic`, deriving the root's on first use. Throws if the node was never reached. */
  async requireKeys(topic: string): Promise<NodeKeys> {
    const known = this.keys.get(topic);
    if (known) return known;

    if (topic !== this.rootTopic) {
      throw new KeyringError(`No keys for node ${topic.slice(0, 6)} — its parent was never resolved`);
    }

    const root: NodeKeys = {
      meta: await this.identity.deriveKeyBytes(ROOT_META_KEY_LABEL),
      content: await this.identity.deriveKeyBytes(ROOT_CONTENT_KEY_LABEL),
    };
    this.keys.set(topic, root);

    return root;
  }

  /** Fresh keys for a node being created. Registered immediately so the first save can use them. */
  mint(topic: string): NodeKeys {
    const keys = generateNodeKeys();
    this.keys.set(topic, keys);

    return keys;
  }

  register(topic: string, keys: NodeKeys): void {
    this.keys.set(topic, keys);
  }

  /** Seal `childTopic`'s keys under `parentTopic`'s, for storing in the parent's fork metadata. */
  async wrapFor(parentTopic: string, childTopic: string): Promise<WrappedKeys> {
    const parent = await this.requireKeys(parentTopic);
    const child = await this.requireKeys(childTopic);

    return {
      meta: await wrapKey(parent.meta, child.meta),
      content: await wrapKey(parent.content, child.content),
    };
  }

  /** Recover and register a child's keys from its fork metadata. Cached children skip the unwrap. */
  async unwrapChild(parentTopic: string, childTopic: string, wrapped: WrappedKeys): Promise<NodeKeys> {
    const known = this.keys.get(childTopic);
    if (known) return known;

    const parent = await this.requireKeys(parentTopic);

    let keys: NodeKeys;
    try {
      keys = {
        meta: await unwrapKey(parent.meta, wrapped.meta),
        content: await unwrapKey(parent.content, wrapped.content),
      };
    } catch (err: unknown) {
      throw new KeyringError(
        `Fork ${childTopic.slice(0, 6)} does not unwrap under its parent — the manifest and the key chain disagree`,
        err,
      );
    }

    this.keys.set(childTopic, keys);

    return keys;
  }

  clear(): void {
    this.keys.clear();
  }
}
