import assert from "node:assert/strict";
import {test} from "node:test";
import {canonical, expireMs, pinHash, rebaseRefs} from "../src/encode.ts";
import {DEFAULT_PLAN_OPTIONS, emptyManifest, planMirror, quotaDay, type LivePin, type Manifest} from "../src/plan.ts";

const NOW = Date.UTC(2026, 10, 23, 22, 0, 0);
const DAY = "2026-11-23";
const opts = {...DEFAULT_PLAN_OPTIONS, now: NOW, budgetDay: DAY};

class Ts {
  constructor(public seconds: number, public nanoseconds = 0) {}
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
}
class Geo { constructor(public latitude: number, public longitude: number) {} }
class Ref { firestore = {}; constructor(public path: string) {} }

function pin(id: string, hash: string, e: number | null = NOW + 3600_000): LivePin {
  return {id, hash, expireMs: e};
}
function manifestOf(entries: Record<string, [string, number | null]>, used = 0, day = DAY): Manifest {
  const out: Manifest["entries"] = {};
  for (const [id, [h, e]] of Object.entries(entries)) out[id] = {h, e};
  return {entries: out, budgetDay: day, budgetUsed: used};
}

test("first run copies every live pin", () => {
  const plan = planMirror([pin("a", "1"), pin("b", "2")], emptyManifest(DAY), opts);
  assert.deepEqual(plan.upserts.sort(), ["a", "b"]);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.next.entries.a.h, "1");
});

test("unchanged pins cost no write; changed pins are rewritten", () => {
  const m = manifestOf({a: ["1", NOW + 1], b: ["2", NOW + 1]});
  const plan = planMirror([pin("a", "1"), pin("b", "3")], m, opts);
  assert.deepEqual(plan.upserts, ["b"]);
  assert.equal(plan.unchanged, 1);
});

test("a pin that left the live set is deleted from dev", () => {
  const m = manifestOf({a: ["1", NOW + 1], gone: ["2", NOW + 9999], expired: ["3", NOW - 1]});
  const plan = planMirror([pin("a", "1")], m, opts);
  assert.deepEqual(plan.deletes.sort(), ["expired", "gone"]);
  assert.equal(plan.next.entries.gone, undefined);
});

test("stray dev ids are cleared on reconcile", () => {
  const plan = planMirror([pin("a", "1")], emptyManifest(DAY), opts, ["a", "stray"]);
  assert.deepEqual(plan.deletes, ["stray"]);
});

test("shrink guard keeps unexpired pins when live suddenly empties", () => {
  const entries: Record<string, [string, number | null]> = {};
  for (let i = 0; i < 30; i++) entries[`p${i}`] = ["h", i < 5 ? NOW - 1 : NOW + 60_000];
  const plan = planMirror([], manifestOf(entries), opts);
  assert.equal(plan.shrinkGuardTripped, true);
  assert.equal(plan.deletes.length, 5);
  assert.equal(plan.guardedDeletes, 25);
});

test("per-run cap defers the rest and the manifest only records what was taken", () => {
  const live = Array.from({length: 12}, (_, i) => pin(`p${i}`, "h"));
  const plan = planMirror(live, emptyManifest(DAY), {...opts, maxOpsPerRun: 5});
  assert.equal(plan.upserts.length, 5);
  assert.equal(plan.deferred, 7);
  assert.equal(Object.keys(plan.next.entries).length, 5);
});

test("daily budget stops writes and resets on a new quota day", () => {
  const live = [pin("a", "1"), pin("b", "2")];
  const spent = planMirror(live, manifestOf({}, 6000), opts);
  assert.equal(spent.upserts.length, 0);
  assert.equal(spent.deferred, 2);
  const nextDay = planMirror(live, manifestOf({}, 6000, "2026-11-22"), opts);
  assert.equal(nextDay.upserts.length, 2);
  assert.equal(nextDay.budgetUsedAfter, 3);
});

test("removed live pins go before new ones when capped", () => {
  const m = manifestOf({gone: ["1", NOW + 60_000]});
  const plan = planMirror([pin("new1", "x"), pin("new2", "y")], m, {...opts, maxOpsPerRun: 1});
  assert.deepEqual(plan.deletes, ["gone"]);
});

test("hash ignores sheet sync clocks but sees real changes", () => {
  const base = {name: "Anfield", expire_at: new Ts(100), p: new Geo(53.4, -2.9), fetched_at: new Ts(1)};
  assert.equal(pinHash(base), pinHash({...base, fetched_at: new Ts(2), updatedFromSheetAt: new Ts(3)}));
  assert.notEqual(pinHash(base), pinHash({...base, expire_at: new Ts(101)}));
  assert.notEqual(pinHash(base), pinHash({...base, p: new Geo(53.5, -2.9)}));
  assert.equal(pinHash({b: 1, a: {d: 2, c: 3}}), pinHash({a: {c: 3, d: 2}, b: 1}));
});

test("canonical tags firestore types and expireMs reads expire_at", () => {
  assert.deepEqual(canonical({t: new Ts(5, 7)}), {t: {__ts: [5, 7]}});
  assert.deepEqual(canonical({r: new Ref("x/y")}), {r: {__ref: "x/y"}});
  assert.equal(expireMs({expire_at: new Ts(2)}), 2000);
  assert.equal(expireMs({}), null);
});

test("references are rebuilt against dev, other values kept", () => {
  const ts = new Ts(1);
  const out = rebaseRefs({r: new Ref("a/b"), list: [new Ref("c/d")], ts}, (p) => `dev:${p}`) as Record<string, unknown>;
  assert.equal(out.r, "dev:a/b");
  assert.deepEqual(out.list, ["dev:c/d"]);
  assert.equal(out.ts, ts);
});

test("quota day follows Pacific midnight", () => {
  assert.equal(quotaDay(new Date(Date.UTC(2026, 10, 24, 7, 59))), "2026-11-23");
  assert.equal(quotaDay(new Date(Date.UTC(2026, 10, 24, 8, 1))), "2026-11-24");
});
