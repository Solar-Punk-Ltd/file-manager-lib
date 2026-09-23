import type { ShareEntry } from '../types/share';
import type { GranteeListUpdate, Hex } from '../types/utils';

export function applyGranteeUpdate(entry: ShareEntry, update: GranteeListUpdate): void {
  entry.granteeList = { reference: update.granteeListRef, historyRef: update.historyRef };
  entry.act = { reference: update.contentRef ?? entry.act.reference, historyRef: update.historyRef };
}

/** `shares` with `entry` in place of the one it updates, or appended. The input is left untouched. */
export function withShareEntry(shares: ShareEntry[], entry: ShareEntry): ShareEntry[] {
  const ix = shares.findIndex((e) => e.id === entry.id);

  return ix === -1 ? [...shares, entry] : shares.map((e, i) => (i === ix ? entry : e));
}

/** Everyone holding a live grant in the drive — the grantee list its bulletin is published to. */
export function bulletinAudience(shares: ShareEntry[], driveId: string): Hex[] {
  const live = shares.filter((e) => e.driveId === driveId && e.revokedAt === undefined);

  return [...new Set(live.flatMap((e) => e.grantees))];
}
