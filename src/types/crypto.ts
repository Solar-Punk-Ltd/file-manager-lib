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
 * Each value is `iv || ciphertext`, hex-encoded.
 */
export interface WrappedKeys {
  meta: Hex;
  content?: Hex;
}
