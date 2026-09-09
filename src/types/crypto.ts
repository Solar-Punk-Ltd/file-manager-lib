import type { Hex } from './utils';

/** A node's two symmetric keys. `meta` unlocks its listing, `content` unlocks its content pointer. */
export interface NodeKeys {
  meta: Uint8Array;
  content: Uint8Array;
}

/**
 * A child's {@link NodeKeys} sealed under its parent's, as stored in the parent's fork metadata.
 * Each value is `iv || ciphertext`, hex-encoded.
 */
export interface WrappedKeys {
  meta: Hex;
  content: Hex;
}
