/**
 * House PTR disclosed member name vs registered filer identity.
 */
import type { Owner } from '../shared/types.ts';
import { applyMemberNameAlias } from '../shared/memberIdentity.ts';
import { memberNameMatchKey, sameFilerIdentity } from '../shared/filerIdentityMatch.ts';

export interface HouseMemberIdentity {
  disclosedName: string;
  registeredName: string;
  chamber: string;
  state: string | null;
}

function ptrMemberNamesLooselyMatch(disclosed: string, registered: string): boolean {
  const a = memberNameMatchKey(disclosed).split(' ').filter(Boolean);
  const b = memberNameMatchKey(registered).split(' ').filter(Boolean);
  if (a.length < 2 || b.length < 2) return false;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

/** True when the name printed on the PTR is not the filer we registered. */
export function houseMemberNameMismatch(identity: HouseMemberIdentity): boolean {
  const disclosed = applyMemberNameAlias(identity.disclosedName);
  const registered = applyMemberNameAlias(identity.registeredName);
  const candidate = {
    fullName: disclosed,
    chamber: identity.chamber,
    state: identity.state,
  };
  const registeredCandidate = {
    fullName: registered,
    chamber: identity.chamber,
    state: identity.state,
  };
  if (sameFilerIdentity(candidate, registeredCandidate)) return false;
  if (ptrMemberNamesLooselyMatch(disclosed, registered)) return false;
  return true;
}

/**
 * Letterhead sometimes glues the filer's own name into a self-owned row's asset
 * cell. That must not drive asset ocr_name_hold when the PTR member matches.
 */
export function suppressAssetOcrHoldForMemberBleed(
  assetName: string,
  owner: Owner | null | undefined,
  disclosedName: string | null,
): boolean {
  if (owner !== 'self' || !disclosedName || !assetName.trim()) return false;
  const key = memberNameMatchKey(disclosedName);
  if (!key) return false;
  const assetKey = memberNameMatchKey(assetName);
  if (assetKey && assetKey === key) return true;
  const loose = assetName.toLowerCase();
  return loose.includes(key);
}
