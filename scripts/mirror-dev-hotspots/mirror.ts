/*
 * One-way, read-only copy of live active hotspot pins into ferro-maps-dev.
 *
 *   live  ferro-maps-staging-v2  hotspots_test where expire_at > now   READ ONLY
 *   dev   ferro-maps-dev         hotspots_test + _devMirror/hotspots_test
 *
 * Nothing is ever written to the live project. The live account is
 * roles/datastore.viewer, so a write would be refused there anyway.
 *
 * Auth is keyless in CI: google-github-actions/auth writes one Workload
 * Identity Federation credential file per service account.
 *
 * Env:
 *   LIVE_CREDENTIALS_FILE   credential file for the ferro-maps-staging-v2 viewer account
 *   DEV_CREDENTIALS_FILE    credential file for the ferro-maps-dev datastore.user account
 *   LIVE_MIRROR_SA          optional, the exact live account email the file must impersonate
 *   DEV_MIRROR_SA           optional, the same for dev
 *   MIRROR_DRY_RUN          "true" plans and reports, writes nothing
 *   MIRROR_RECONCILE        "true" also lists dev ids, to clear pins the manifest lost
 *
 * Only counts are printed. Never credential contents, never document contents.
 * The repo is public, so its Actions logs are public too.
 */
import {readFileSync} from "node:fs";
import {Firestore, Timestamp} from "@google-cloud/firestore";
import {checkCredential} from "./src/credentials.ts";
import {expireMs, pinHash, rebaseRefs} from "./src/encode.ts";
import {
  DEFAULT_PLAN_OPTIONS,
  emptyManifest,
  entriesAfter,
  planMirror,
  quotaDay,
  type LivePin,
  type Manifest,
} from "./src/plan.ts";

export const LIVE_PROJECT = "ferro-maps-staging-v2";
export const DEV_PROJECT = "ferro-maps-dev";
const COLLECTION = "hotspots_test";
const MANIFEST_PATH = `_devMirror/${COLLECTION}`;
/* More active live pins than this means something is wrong. Dev is left alone. */
const MAX_LIVE_PINS = 5000;
const BATCH = 400;

function fail(message: string): never {
  console.error(`mirror: ${message}`);
  process.exit(1);
}

function flag(name: string): boolean {
  return ["true", "1", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

/* Opens Firestore for one project from a checked credential file. */
function firestoreFor(fileEnv: string, accountEnv: string, project: string): {db: Firestore; account: string} {
  const path = process.env[fileEnv]?.trim();
  if (!path) fail(`${fileEnv} is not set`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${fileEnv} is not a readable JSON file`);
  }
  const check = checkCredential(json, project, process.env[accountEnv]);
  if (!check.ok) fail(`${fileEnv}: ${check.reason}`);
  const db = new Firestore({projectId: project, keyFilename: path, preferRest: true});
  return {db, account: check.serviceAccount};
}

async function readManifest(dev: Firestore, day: string): Promise<{manifest: Manifest; found: boolean}> {
  const snap = await dev.doc(MANIFEST_PATH).get();
  if (!snap.exists) return {manifest: emptyManifest(day), found: false};
  const data = snap.data() ?? {};
  let entries: Manifest["entries"] = {};
  try {
    entries = JSON.parse(String(data.entriesJson ?? "{}"));
  } catch {
    return {manifest: emptyManifest(day), found: false};
  }
  return {
    manifest: {entries, budgetDay: String(data.budgetDay ?? ""), budgetUsed: Number(data.budgetUsed ?? 0)},
    found: true,
  };
}

async function main(): Promise<void> {
  const dryRun = flag("MIRROR_DRY_RUN");
  if ((LIVE_PROJECT as string) === (DEV_PROJECT as string)) fail("live and dev are the same project");
  const {db: live, account: liveAccount} = firestoreFor("LIVE_CREDENTIALS_FILE", "LIVE_MIRROR_SA", LIVE_PROJECT);
  const {db: dev, account: devAccount} = firestoreFor("DEV_CREDENTIALS_FILE", "DEV_MIRROR_SA", DEV_PROJECT);
  if (liveAccount === devAccount) fail("live and dev use the same service account");

  const now = new Date();
  const day = quotaDay(now);

  // 1. Live read. Any failure stops here, before dev is touched.
  let docs: Array<{id: string; data: Record<string, unknown>}>;
  try {
    const snap = await live.collection(COLLECTION).where("expire_at", ">", Timestamp.fromDate(now)).get();
    docs = snap.docs.map((doc) => ({id: doc.id, data: doc.data()}));
  } catch (err) {
    fail(`live read failed (${(err as {code?: unknown}).code ?? "unknown"}); dev left unchanged`);
  }
  if (docs.length > MAX_LIVE_PINS) fail(`live returned ${docs.length} pins, over ${MAX_LIVE_PINS}; dev left unchanged`);
  const pins: LivePin[] = docs.map((doc) => ({id: doc.id, hash: pinHash(doc.data), expireMs: expireMs(doc.data)}));
  const dataById = new Map(docs.map((doc) => [doc.id, doc.data]));

  // 2. Dev state: one manifest read. A missing manifest (first run) or a
  //    reconcile request lists the dev ids once, so strays are cleared.
  const {manifest, found} = await readManifest(dev, day);
  let existing: string[] = [];
  if (!found || flag("MIRROR_RECONCILE")) {
    const ids = await dev.collection(COLLECTION).select().get();
    existing = ids.docs.map((doc) => doc.id);
  }

  const plan = planMirror(pins, manifest, {...DEFAULT_PLAN_OPTIONS, now: now.getTime(), budgetDay: day}, existing);
  const counts = {
    live: pins.length,
    upserts: plan.upserts.length,
    deletes: plan.deletes.length,
    unchanged: plan.unchanged,
    deferred: plan.deferred,
    guardedDeletes: plan.guardedDeletes,
    shrinkGuard: plan.shrinkGuardTripped,
    budgetUsedToday: plan.budgetUsedAfter,
    dryRun,
  };
  if (dryRun) {
    console.log(`mirror: dry run ${JSON.stringify(counts)}`);
    return;
  }

  // 3. Dev writes in batches. The manifest records only what committed.
  const ops = [
    ...plan.deletes.map((id) => ({op: "delete" as const, id})),
    ...plan.upserts.map((id) => ({op: "upsert" as const, id})),
  ];
  const doneUpserts: string[] = [];
  const doneDeletes: string[] = [];
  let error: unknown = null;
  const toDevRef = (path: string) => dev.doc(path);
  for (let i = 0; i < ops.length && !error; i += BATCH) {
    const chunk = ops.slice(i, i + BATCH);
    const batch = dev.batch();
    for (const item of chunk) {
      const ref = dev.collection(COLLECTION).doc(item.id);
      if (item.op === "delete") batch.delete(ref);
      else batch.set(ref, rebaseRefs(dataById.get(item.id), toDevRef) as Record<string, unknown>);
    }
    try {
      await batch.commit();
      for (const item of chunk) (item.op === "delete" ? doneDeletes : doneUpserts).push(item.id);
    } catch (err) {
      error = err;
    }
  }

  const entries = entriesAfter(manifest.entries, pins, doneUpserts, doneDeletes);
  const used = (manifest.budgetDay === day ? manifest.budgetUsed : 0) + doneUpserts.length + doneDeletes.length + 1;
  await dev.doc(MANIFEST_PATH).set({
    source: `${LIVE_PROJECT}/${COLLECTION}`,
    entriesJson: JSON.stringify(entries),
    count: Object.keys(entries).length,
    budgetDay: day,
    budgetUsed: used,
    lastRunAt: Timestamp.fromDate(now),
    lastStatus: error ? "partial" : "ok",
  });

  const result = {...counts, upserts: doneUpserts.length, deletes: doneDeletes.length, budgetUsedToday: used};
  if (error) fail(`dev write failed part way (${(error as {code?: unknown}).code ?? "unknown"}) ${JSON.stringify(result)}`);
  console.log(`mirror: ok ${JSON.stringify(result)}`);
}

main().catch((err) => fail(`unexpected ${(err as {code?: unknown}).code ?? (err as Error)?.name ?? "error"}`));
