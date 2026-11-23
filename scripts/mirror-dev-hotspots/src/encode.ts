import {createHash} from "node:crypto";

/*
 * Field values are walked by shape, not by class, so this file needs no
 * Firestore import and can be tested on plain objects.
 */

/*
 * Fields rewritten by every live sheet sync even when nothing else changed.
 * They are still copied, but a change in only these does not cost a dev
 * write. Without this every pin would be rewritten every run and the dev
 * project's free 20k writes a day would run out.
 */
export const VOLATILE_FIELDS = ["fetched_at", "updatedFromSheetAt", "updatedAt", "forecastUpdatedAt"] as const;

interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}
interface GeoPointLike {
  latitude: number;
  longitude: number;
}
interface RefLike {
  path: string;
  firestore: unknown;
}

export function isTimestamp(v: unknown): v is TimestampLike {
  return typeof v === "object" && v !== null && typeof (v as TimestampLike).toMillis === "function" &&
    typeof (v as TimestampLike).seconds === "number";
}
export function isGeoPoint(v: unknown): v is GeoPointLike {
  return typeof v === "object" && v !== null && typeof (v as GeoPointLike).latitude === "number" &&
    typeof (v as GeoPointLike).longitude === "number" && Object.keys(v as object).length <= 2 &&
    !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype;
}
export function isRef(v: unknown): v is RefLike {
  return typeof v === "object" && v !== null && typeof (v as RefLike).path === "string" &&
    "firestore" in (v as object) && Object.getPrototypeOf(v) !== Object.prototype;
}

/* A JSON value with sorted keys and tagged Firestore types. */
export function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (isTimestamp(value)) return {__ts: [value.seconds, value.nanoseconds]};
  if (isRef(value)) return {__ref: value.path};
  if (isGeoPoint(value)) return {__geo: [value.latitude, value.longitude]};
  if (value instanceof Uint8Array) return {__bytes: Buffer.from(value).toString("base64")};
  if (value instanceof Date) return {__date: value.getTime()};
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function pinHash(data: Record<string, unknown>): string {
  const kept: Record<string, unknown> = {};
  const skip = new Set<string>(VOLATILE_FIELDS);
  for (const [key, val] of Object.entries(data)) if (!skip.has(key)) kept[key] = val;
  return createHash("sha256").update(JSON.stringify(canonical(kept))).digest("hex").slice(0, 16);
}

export function expireMs(data: Record<string, unknown>): number | null {
  const v = data.expire_at;
  return isTimestamp(v) ? v.toMillis() : null;
}

/*
 * Copy a live doc's data for a dev write. A document reference points into the
 * live project, so it is rebuilt against dev by path. Everything else
 * (timestamps, geopoints, bytes) is a plain value the dev client accepts.
 */
export function rebaseRefs(value: unknown, toDevRef: (path: string) => unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isRef(value)) return toDevRef(value.path);
  if (isTimestamp(value) || isGeoPoint(value) || value instanceof Uint8Array || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => rebaseRefs(item, toDevRef));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = rebaseRefs(val, toDevRef);
  return out;
}
