import type { Hex } from './utils';

/**
 * A node's two symmetric keys. `meta` unlocks its listing, `content` unlocks its content pointer.
 *
 * `content` is absent on a subtree reached through a `list` grant: the grantee walks the structure
 * but opens nothing in it, and every node below inherits the same half of the chain.
 */
export interface NodeKeys {
  meta: Uint8Array;
  content?: Uint8Array;
}

/**
 * A child's {@link NodeKeys} sealed under its parent's, as stored in the parent's fork metadata.
 * Each key is `iv || ciphertext`, hex-encoded.
 */
export interface WrappedKeys {
  meta: Hex;
  content?: Hex;
  /** The child's key generation. */
  gen: number;
  /** The parent generation the keys are sealed under. Behind the parent's current one, the child is due a rotation. */
  parentGen: number;
}

export interface HeldNode {
  gen: number;
  keys: NodeKeys;
  link?: { parent: string; parentGen: number };
  // Reached through someone else's grant: the chain is theirs, so this identity only counts down it.
  foreign: boolean;
  // Its fork in the parent was last seen at an earlier generation: a rotation whose save did not land.
  forkLag?: boolean;
}
