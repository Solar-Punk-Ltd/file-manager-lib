import { Bytes } from '@ethersphere/core-sdk';

import type { NodeKeys } from '../types/crypto';
import type { GrantBlob, ShareEntry } from '../types/share';
import type { GranteeListUpdate } from '../types/utils';

export function applyGranteeUpdate(entry: ShareEntry, update: GranteeListUpdate): void {
  entry.granteeList = { reference: update.granteeListRef, historyRef: update.historyRef };
  entry.act = { reference: update.contentRef ?? entry.act.reference, historyRef: update.historyRef };
}

/** `shares` with `entry` in place of the one it updates, or appended. The input is left untouched. */
export function withShareEntry(shares: ShareEntry[], entry: ShareEntry): ShareEntry[] {
  const ix = shares.findIndex((e) => e.id === entry.id);

  return ix === -1 ? [...shares, entry] : shares.map((e, i) => (i === ix ? entry : e));
}

/**
 * The keys a grant blob carries. A file has no manifest, so a file grant carries no `K_meta` — but
 * every fork is sealed under one, and the recipient must be able to re-wrap it on each relocation,
 * so `meta` fills the slot.
 */
export function grantNodeKeys(blob: GrantBlob, meta: Uint8Array): NodeKeys {
  return {
    meta: blob.meta ? new Bytes(blob.meta).toUint8Array() : meta,
    ...(blob.content ? { content: new Bytes(blob.content).toUint8Array() } : {}),
  };
}
