/*
 * Pure planning for the one-way live -> dev hotspot mirror. No Firestore here.
 *
 * The manifest is one dev document that remembers, per mirrored id, the hash
 * of what was last copied and that pin's expiry. Each run compares the live
 * active pins against it, so dev is only written when a pin really changed,
 * and a pin that left the live set is deleted from dev.
 */

export interface LivePin {
  id: string;
  /** Stable hash of the copied fields, volatile fields excluded. */
  hash: string;
  /** expire_at in ms, or null when the doc has none. */
  expireMs: number | null;
}

export interface ManifestEntry {
  h: string;
  e: number | null;
}

export interface Manifest {
  entries: Record<string, ManifestEntry>;
  /** Spark quota day (Pacific), YYYY-MM-DD. */
  budgetDay: string;
  /** Writes plus deletes spent on budgetDay, the manifest write included. */
  budgetUsed: number;
}

export interface PlanOptions {
  now: number;
  budgetDay: string;
  /** Upserts plus deletes allowed in one run. */
  maxOpsPerRun: number;
  /** Upserts plus deletes allowed per budget day. */
  dailyBudget: number;
  /**
   * When the live set shrinks below this share of the manifest (and the
   * manifest has more than shrinkGuardMin ids), only pins that have already
   * expired are deleted. A broken live query then cannot empty dev.
   */
  shrinkGuardRatio: number;
  shrinkGuardMin: number;
}

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, "now" | "budgetDay"> = {
  maxOpsPerRun: 500,
  dailyBudget: 6000,
  shrinkGuardRatio: 0.2,
  shrinkGuardMin: 20,
};

export interface MirrorPlan {
  upserts: string[];
  deletes: string[];
  /** Changes left for a later run by the per-run or daily cap. */
  deferred: number;
  /** Stale ids kept because the shrink guard tripped. */
  guardedDeletes: number;
  shrinkGuardTripped: boolean;
  unchanged: number;
  /** Budget used today after this plan, the manifest write included. */
  budgetUsedAfter: number;
  /** Manifest to save after every planned op has committed. */
  next: Manifest;
}

export function emptyManifest(budgetDay: string): Manifest {
  return {entries: {}, budgetDay, budgetUsed: 0};
}

/*
 * existingDevIds: ids already in the dev collection that the manifest does not
 * know about (first run, or a lost manifest). They are treated as stale.
 */
export function planMirror(
  live: LivePin[],
  manifest: Manifest,
  options: PlanOptions,
  existingDevIds: string[] = [],
): MirrorPlan {
  const liveIds = new Set(live.map((pin) => pin.id));
  const known = manifest.entries;

  const fresh: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const pin of live) {
    const entry = known[pin.id];
    if (!entry) fresh.push(pin.id);
    else if (entry.h !== pin.hash) changed.push(pin.id);
    else unchanged += 1;
  }

  const knownCount = Object.keys(known).length;
  const shrinkGuardTripped =
    knownCount > options.shrinkGuardMin && live.length < knownCount * options.shrinkGuardRatio;

  const staleKnown = Object.keys(known).filter((id) => !liveIds.has(id));
  const staleUnknown = existingDevIds.filter((id) => !liveIds.has(id) && !(id in known));
  let guardedDeletes = 0;
  const removable: string[] = [];
  for (const id of staleKnown) {
    const expiry = known[id].e;
    const expired = expiry !== null && expiry <= options.now;
    if (shrinkGuardTripped && !expired) guardedDeletes += 1;
    else removable.push(id);
  }
  if (shrinkGuardTripped) guardedDeletes += staleUnknown.length;
  else removable.push(...staleUnknown);

  // Removed-but-not-expired pins first (the app would still draw them),
  // then new pins, then changed pins, then expired leftovers (already hidden).
  const removedLive = removable.filter((id) => {
    const e = known[id]?.e ?? null;
    return e === null || e > options.now;
  });
  const removedExpired = removable.filter((id) => !removedLive.includes(id));
  const queue: Array<{op: "upsert" | "delete"; id: string}> = [
    ...removedLive.map((id) => ({op: "delete" as const, id})),
    ...fresh.map((id) => ({op: "upsert" as const, id})),
    ...changed.map((id) => ({op: "upsert" as const, id})),
    ...removedExpired.map((id) => ({op: "delete" as const, id})),
  ];

  const sameDay = manifest.budgetDay === options.budgetDay;
  const usedToday = sameDay ? manifest.budgetUsed : 0;
  // One op is held back for the manifest write itself.
  const dayLeft = Math.max(0, options.dailyBudget - usedToday - 1);
  const allowed = Math.max(0, Math.min(options.maxOpsPerRun, dayLeft));
  const taken = queue.slice(0, allowed);
  const deferred = queue.length - taken.length;

  const upserts = taken.filter((item) => item.op === "upsert").map((item) => item.id);
  const deletes = taken.filter((item) => item.op === "delete").map((item) => item.id);

  const budgetUsedAfter = usedToday + taken.length + 1;
  const entries = entriesAfter(known, live, upserts, deletes);
  return {
    upserts,
    deletes,
    deferred,
    guardedDeletes,
    shrinkGuardTripped,
    unchanged,
    budgetUsedAfter,
    next: {entries, budgetDay: options.budgetDay, budgetUsed: budgetUsedAfter},
  };
}

/*
 * The manifest entries once the given upserts and deletes have committed.
 * Called with only the committed ops when a batch fails part way, so the
 * next run retries the rest.
 */
export function entriesAfter(
  known: Record<string, ManifestEntry>,
  live: LivePin[],
  upserts: string[],
  deletes: string[],
): Record<string, ManifestEntry> {
  const byId = new Map(live.map((pin) => [pin.id, pin]));
  const entries: Record<string, ManifestEntry> = {...known};
  for (const id of upserts) {
    const pin = byId.get(id);
    if (pin) entries[id] = {h: pin.hash, e: pin.expireMs};
  }
  for (const id of deletes) delete entries[id];
  return entries;
}

/* The Spark quota day. Firestore free quotas reset at midnight Pacific time. */
export function quotaDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
