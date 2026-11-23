import {createHash} from "node:crypto";
import {isPpPlaceId} from "../contract.js";
import {
  PAY_MODES,
  type AudCode,
  type CanPark,
  type FeeUnit,
  type PayMode,
  type PrivatePlace,
  type SrcType,
  isSrcType,
} from "./types.js";

export function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function norm(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

export function normaliseName(value: unknown): string {
  return norm(value);
}

export function normalisePostcode(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, "");
}

/* Half away from zero, then 4 decimal places. Used only for the stable id. */
export function formatCoord(value: number): string {
  const scaled = Math.abs(value) * 10000;
  const rounded = Math.round(scaled) / 10000;
  const body = rounded.toFixed(4);
  return value < 0 ? `-${body}` : body;
}

/*
 * Legacy document id: sha256(name|postcode|lat|lng).
 * New documents use the sheet Place ID (`PP-######`). The hash is only used
 * to find and delete those old documents.
 */
export function placeId(name: unknown, postcode: unknown, lat: number, lng: number): string {
  const key = [
    normaliseName(name),
    normalisePostcode(postcode),
    formatCoord(lat),
    formatCoord(lng),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

/* `PP-000001`. Blank, Google place ids, and other text are not ids. */
export function sheetPlaceId(value: unknown): string | null {
  const raw = text(value).toUpperCase();
  return isPpPlaceId(raw) ? raw : null;
}

/*
 * Great Britain and Northern Ireland. A point outside this box is not a
 * London parking pin, including (0,0) and a swapped lat/lng that still
 * fails the box.
 */
export const UK_LAT_MIN = 49.8;
export const UK_LAT_MAX = 60.9;
export const UK_LNG_MIN = -8.7;
export const UK_LNG_MAX = 1.8;

export function inUk(lat: number, lng: number): boolean {
  return lat >= UK_LAT_MIN && lat <= UK_LAT_MAX && lng >= UK_LNG_MIN && lng <= UK_LNG_MAX;
}

/* Decimal, comma-decimal, scientific, hemisphere suffix, or DMS. `UNCLEAR` is not a coordinate. */
export function parseCoord(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.toUpperCase() === "UNCLEAR") return null;
  if (/[°º]/.test(raw)) return parseDms(raw);
  let body = raw;
  const hemi = /([NnSsEeWw])$/.exec(body);
  if (hemi) body = body.slice(0, -1).trim();
  body = body.replace(/\s+/g, "");
  if (/^[+-]?\d+,\d+$/.test(body)) body = body.replace(",", ".");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(body)) return null;
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  if (!hemi) return n;
  const pole = hemi[1].toUpperCase();
  if (pole === "S" || pole === "W") return n > 0 ? -n : n;
  return n < 0 ? Math.abs(n) : n;
}

function parseDms(raw: string): number | null {
  const match = new RegExp(
    "^\\s*([+-])?\\s*(\\d{1,3})\\s*[°º]\\s*(\\d{1,2}(?:[.,]\\d+)?)?\\s*['′]?\\s*" +
    "(\\d{1,2}(?:[.,]\\d+)?)?\\s*(?:\"|″)?\\s*([NnSsEeWw])?\\s*$",
  ).exec(raw);
  if (!match) return null;
  const degrees = Number(match[2]);
  const minutes = match[3] ? Number(match[3].replace(",", ".")) : 0;
  const seconds = match[4] ? Number(match[4].replace(",", ".")) : 0;
  if (minutes >= 60 || seconds >= 60) return null;
  let value = degrees + minutes / 60 + seconds / 3600;
  const hemi = (match[5] || "").toUpperCase();
  if (match[1] === "-" || hemi === "S" || hemi === "W") value = -Math.abs(value);
  return Number.isFinite(value) ? value : null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/* Keep the sheet order when it is in the UK. Swap only when that is what lands in the UK. */
export function orientUk(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && inUk(lat, lng)) return {lat, lng};
  if (Math.abs(lng) <= 90 && Math.abs(lat) <= 180 && inUk(lng, lat)) return {lat: lng, lng: lat};
  return null;
}

const PAIR = new RegExp(
  "^\\s*([+-]?\\d+(?:[.,]\\d+)?(?:[eE][+-]?\\d+)?[NnSsEeWw]?)" +
  "\\s*[,;/]\\s*" +
  "([+-]?\\d+(?:[.,]\\d+)?(?:[eE][+-]?\\d+)?[NnSsEeWw]?)\\s*$",
);

/* A Google Maps URL that carries a point. Prose around the URL is ignored. */
export function pointFromMapsUrl(value: unknown): LatLng | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = value;
  const at = /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*\d+)?/.exec(source);
  if (at) return orientUk(Number(at[1]), Number(at[2]));
  const packed = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(source);
  if (packed) return orientUk(Number(packed[1]), Number(packed[2]));
  const query = /[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(source);
  if (query) return orientUk(Number(query[1]), Number(query[2]));
  return null;
}

/* A whole cell that is `lat, lng`, or a Google Maps URL that carries a point. */
export function pointFromText(value: unknown): LatLng | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = value.trim();
  const pair = PAIR.exec(source);
  if (pair) {
    const lat = parseCoord(pair[1]);
    const lng = parseCoord(pair[2]);
    if (lat == null || lng == null) return null;
    return orientUk(lat, lng);
  }
  return pointFromMapsUrl(source);
}

export function coordinatePoint(latValue: unknown, lngValue: unknown): LatLng | null {
  const lat = parseCoord(latValue);
  const lng = parseCoord(lngValue);
  if (lat != null && lng != null) return orientUk(lat, lng);
  const latText = text(latValue);
  const lngText = text(lngValue);
  if (latText && !lngText) return pointFromText(latValue);
  if (lngText && !latText) return pointFromText(lngValue);
  return null;
}

const LAT_HEADERS = ["Latitude", "Lat"];
const LNG_HEADERS = ["Longitude", "Lng", "Lon", "Long"];
const COORD_TEXT_HEADERS = new Set([
  "coordinates",
  "coordinate",
  "google maps link",
  "google maps",
  "map link",
  "geo (as captured)",
]);
const MAPS_URL_HEADERS = new Set([
  "source urls (primary first)",
  "source url",
  "google maps link",
  "google maps",
  "map link",
]);

function namedValue(values: Record<string, unknown>, names: readonly string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(values)) {
    if (!wanted.has(key.trim().toLowerCase())) continue;
    if (text(value) !== "") return value;
  }
  return undefined;
}

/*
 * Latitude and Longitude first, including a combined `lat, lng` cell and a
 * swapped pair. Other coordinate headers are used only when those two are empty.
 */
export function rowCoordinates(values: Record<string, unknown>): LatLng | null {
  const direct = coordinatePoint(namedValue(values, LAT_HEADERS), namedValue(values, LNG_HEADERS));
  if (direct) return direct;
  for (const [key, value] of Object.entries(values)) {
    const header = key.trim().toLowerCase();
    if (COORD_TEXT_HEADERS.has(header)) {
      const point = pointFromText(value);
      if (point) return point;
    } else if (MAPS_URL_HEADERS.has(header)) {
      const point = pointFromMapsUrl(value);
      if (point) return point;
    }
  }
  return null;
}

export function mapCanPark(value: unknown): CanPark {
  switch (norm(value)) {
  case "yes":
    return 1;
  case "conditional":
    return 2;
  case "no":
    return 3;
  default:
    return 0;
  }
}

/* Missing and unrecognised audiences are omitted. They are never public. */
export function mapAud(value: unknown): AudCode | undefined {
  switch (norm(value)) {
  case "customers only":
    return "c";
  case "guests only":
    return "g";
  case "patients and visitors":
    return "g";
  case "permit holders":
    return "p";
  case "anyone":
  case "anyone (paid)":
    return "a";
  default:
    return undefined;
  }
}

/*
 * Evidence class. Partial official text is `official`.
 * Blank omits the field. Any other non-blank text is `none`.
 * The raw sentence is never returned.
 */
export function mapSrcType(value: unknown): SrcType | undefined {
  const s = norm(value);
  if (!s) return undefined;
  let mapped: SrcType;
  if (s === "official site: clear answer" || s === "official site: partial info") {
    mapped = "official";
  } else if (s === "google maps only") {
    mapped = "gmaps";
  } else if (/\bon-?site\b|\bsite visit\b|\bvisited\b/.test(s)) {
    mapped = "onsite";
  } else {
    mapped = "none";
  }
  if (!isSrcType(mapped)) {
    throw new Error(`srcType ${mapped} is not an allowed value`);
  }
  return mapped;
}

export function isApproxPrecision(value: unknown): boolean {
  const s = norm(value);
  if (!s) return false;
  if (s === "postcode centroid" || s === "area centre" || s === "area center" || s === "street") {
    return true;
  }
  return s.startsWith("nearby poi");
}

function expandYear(raw: string): number {
  if (raw.length === 4) return Number(raw);
  const yy = Number(raw);
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}

function utcDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString();
}

function dateOnlyFromDate(date: Date): string | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  const utcMidnight = date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  if (utcMidnight) return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  if (localMidnight) return utcDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return date.toISOString();
}

/* ISO `YYYY-MM-DD`, `dd/mm/yyyy`, and `dd/mm/yy`. Date-only values are UTC midnight. */
export function parseDate(value: unknown): string | undefined {
  if (value instanceof Date) return dateOnlyFromDate(value);
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return dateOnlyFromDate(new Date(ms));
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!slash) return undefined;
  return utcDate(expandYear(slash[3]), Number(slash[2]), Number(slash[1]));
}

/*
 * Tharidu's gate. `Confirmed, details not published` is validated.
 * Needs on-site check, No evidence, and a blank cell are not.
 */
const KNOWN_VERIFICATION = new Set([
  "confirmed",
  "corrected",
  "confirmed, details not published",
  "confirmed details not published",
]);

export function isKnownVerification(value: unknown): boolean {
  return KNOWN_VERIFICATION.has(norm(value));
}

export function parseMinutes(value: unknown): number | undefined {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  if (n == null || n < 0) return undefined;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 1e-6) return undefined;
  return rounded;
}

export function mapConf(value: unknown): number | undefined {
  const score = parseMinutes(value);
  if (score == null || score < 1 || score > 5) return undefined;
  return score / 5;
}

/*
 * Integer pence for `Parking Charge (£)`. Separate from `parseCoord`.
 * The sheet sync reads the displayed cell, so the charge may be `£0.87`.
 * A leading £, spaces around it, and thousands commas in groups of three
 * are accepted. More than two decimal places are rejected, on a string or
 * a raw number. A leading + is rejected. Negatives and other text are omitted.
 *
 * ExcelJS returns a JS number. Two decimal places are not always an integer
 * after * 100: `0.29 * 100` is `28.999999999999996`, while `0.87 * 100` is 87.
 * A gap of at most 1e-6 from a whole pence is that float error. `1.234` is
 * 0.4 away and is rejected.
 */
const PENCE_EPSILON = 1e-6;
const POUNDS_TEXT =
  /^\s*£?\s*(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?|\.\d{1,2})\s*$/;

function penceFromAmount(amount: number): number | undefined {
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const scaled = amount * 100;
  const pence = Math.round(scaled);
  if (Math.abs(scaled - pence) > PENCE_EPSILON) return undefined;
  return pence;
}

export function poundsToPence(value: unknown): number | undefined {
  if (typeof value === "number") return penceFromAmount(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!POUNDS_TEXT.test(trimmed)) return undefined;
  const body = (trimmed.startsWith("£") ? trimmed.slice(1).trim() : trimmed).replace(/,/g, "");
  return penceFromAmount(Number(body));
}

export function isAutopay(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s === "✅" || s === "✓" || s === "yes" || s === "true" || s === "checked";
}

const OPERATOR_OMIT = new Set(["not published", "not applicable", "unknown", "n/a", "none"]);

export function mapOperator(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || OPERATOR_OMIT.has(raw.toLowerCase())) return undefined;
  return raw;
}

export function firstUrl(value: unknown): string | undefined {
  const s = text(value);
  if (!s) return undefined;
  const match = /https?:\/\/[^\s;]+/i.exec(s);
  if (!match) return undefined;
  return match[0].replace(/[),.;]+$/g, "");
}

export function mapHours(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s || undefined;
}

export function formatAddr(street: unknown, postcode: unknown): string | undefined {
  const line = text(street);
  const code = text(postcode);
  if (!line && !code) return undefined;
  if (line && code && line.toUpperCase().includes(code.toUpperCase())) return line;
  if (line && code) return `${line}, ${code}`;
  return line || code;
}

function detailUnits(detail: string): {hour: boolean; day: boolean; visit: boolean; night: boolean} {
  return {
    hour: /\b(?:per hour|an hour|\/hour|hourly)\b/.test(detail),
    day: /\b(?:per 24 hours|per day|a day|daily)\b/.test(detail),
    visit: /\b(?:per visit|per stay)\b/.test(detail),
    night: /\b(?:per night|a night|overnight)\b/.test(detail),
  };
}

/*
 * `hour` | `visit` | `day` only when the tariff names one unit.
 * A night rate is not a day. Mixed units are omitted.
 */
export function mapFeeUnit(type: unknown, detail: unknown): FeeUnit | undefined {
  const tariff = norm(type);
  const prose = norm(detail);
  const units = detailUnits(prose);
  const mentioned = [units.hour, units.day, units.visit, units.night].filter(Boolean).length;

  if (tariff === "hourly rate" || tariff === "free period, then hourly") {
    if (units.day || units.visit || units.night) return undefined;
    return "hour";
  }
  if (tariff === "flat rate per 24 hours") {
    if (units.hour || units.visit || units.night) return undefined;
    return "day";
  }
  if (tariff === "flat rate per night") return undefined;
  if (mentioned !== 1 || units.night) return undefined;
  if (units.hour) return "hour";
  if (units.day) return "day";
  if (units.visit) return "visit";
  return undefined;
}

function providerSlug(raw: string): string | undefined {
  const s = raw.toLowerCase().replace(/[\s-]+/g, "");
  if (s.includes("paybyphone")) return "paybyphone";
  if (s.includes("ringgo")) return "ringgo";
  if (s.includes("justpark")) return "justpark";
  if (s.includes("ecpparkbuddy") || s.includes("eurocarparks")) return "eurocarparks";
  if (s.includes("parkbuddy")) return "parkbuddy";
  if (s.includes("apcoa")) return "apcoa";
  if (s === "ncp" || s.includes("nationalcarparks")) return "ncp";
  if (s.includes("qpark")) return "qpark";
  if (s.includes("evology")) return "evology";
  return undefined;
}

export interface LocationCode {
  locationCode: string;
  locationProvider: string;
  ambiguous: boolean;
}

/*
 * First provider+code in the rules text.
 * `PayByPhone location 37208` -> `{locationCode: "37208", locationProvider: "paybyphone"}`.
 * A second different code is reported and the first code is kept.
 */
const PROVIDER_SOURCE = [
  "pay\\s*-?\\s*by\\s*-?\\s*phone",
  "paybyphone",
  "ring\\s*-?\\s*go",
  "just\\s*-?\\s*park",
  "euro\\s*car\\s*parks",
  "ecp\\s*parkbuddy",
  "parkbuddy",
  "apcoa(?:\\s+connect)?",
  "national\\s+car\\s+parks",
  "q\\s*-?\\s*park",
  "ncp",
  "evology",
].join("|");

export function parseLocationCode(value: unknown): LocationCode | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const hits: Array<{at: number; code: string; provider: string}> = [];
  const tight = new RegExp(
    `\\b(${PROVIDER_SOURCE})\\b\\s*(?:\\(\\s*)?(?:(?:location(?:\\s+id)?|loc\\.?|zone|codes?|number|no\\.?)\\s+)?(\\d{4,8})\\b`,
    "gi",
  );
  for (const match of value.matchAll(tight)) {
    const provider = providerSlug(match[1] ?? "");
    const code = match[2] ?? "";
    if (!provider || !code || match.index == null) continue;
    hits.push({at: match.index, code, provider});
  }
  const keyed = new RegExp(
    "\\b(location(?:\\s+id)?|loc\\.?|zone|codes?|number|no\\.?)\\s+(\\d{4,8}(?:\\s*,\\s*\\d{4,8})*)",
    "gi",
  );
  for (const match of value.matchAll(keyed)) {
    const keyword = (match[1] ?? "").toLowerCase();
    const parts = (match[2] ?? "").split(/\s*,\s*/);
    const codes = keyword === "codes" ? parts : parts.slice(0, 1);
    const window = value.slice(Math.max(0, (match.index ?? 0) - 80), match.index ?? 0);
    const providerRe = new RegExp(`\\b(${PROVIDER_SOURCE})\\b`, "gi");
    let provider: string | undefined;
    for (const found of window.matchAll(providerRe)) provider = providerSlug(found[1] ?? "");
    if (!provider) continue;
    codes.forEach((code, offset) => {
      if (!/^\d{4,8}$/.test(code)) return;
      hits.push({at: (match.index ?? 0) + offset, code, provider});
    });
  }
  hits.sort((a, b) => a.at - b.at || a.code.localeCompare(b.code));
  const unique: Array<{code: string; provider: string}> = [];
  for (const hit of hits) {
    if (unique.some((item) => item.code === hit.code && item.provider === hit.provider)) continue;
    unique.push({code: hit.code, provider: hit.provider});
  }
  const first = unique[0];
  if (!first) return undefined;
  const ambiguous = unique.some((hit) => hit.code !== first.code || hit.provider !== first.provider);
  return {locationCode: first.code, locationProvider: first.provider, ambiguous};
}

export function closureReason(value: unknown): "closed" | "temporarily_closed" | null {
  const s = norm(value);
  if (s === "closed") return "closed";
  if (s === "temporarily closed") return "temporarily_closed";
  return null;
}

export function coordinateSkip(latValue: unknown, lngValue: unknown): boolean {
  return coordinatePoint(latValue, lngValue) == null;
}

/* `No` is not parkable. Conditional and Yes stay. Unknown is left for the app. */
export function isNotParkable(value: unknown): boolean {
  return norm(value) === "no";
}

export function skipReason(values: Record<string, unknown>): string | null {
  const closed = closureReason(values["Location Status"]);
  if (closed) return closed;
  if (!rowCoordinates(values)) return "bad_coordinates";
  if (isNotParkable(values["Can Park? (Yes/No/Conditional)"])) return "not_parkable";
  if (!text(values["Location Name"])) return "missing_name";
  if (!isKnownVerification(values["Verification Result"])) return "unvalidated";
  if (!sheetPlaceId(values["Place ID"])) return "missing_pp_id";
  return null;
}

function assign<K extends keyof PrivatePlace>(place: PrivatePlace, key: K, value: PrivatePlace[K] | undefined): void {
  if (value !== undefined) place[key] = value;
}

function isPayMode(value: string): value is PayMode {
  return (PAY_MODES as readonly string[]).includes(value);
}

/* Place ID when that cell is set, otherwise the sheet row number, otherwise the place id. */
function payModeRowId(values: Record<string, unknown>, sheetRow: number | undefined, id: string): string {
  const placeId = text(values["Place ID"]);
  if (placeId) return placeId;
  if (sheetRow != null) return String(sheetRow);
  return id;
}

/*
 * The warning names only the row id. The cell text is never interpolated.
 */
function warnUnknownPayMode(rowId: string): void {
  console.warn(`private parking payMode omitted for ${rowId}`);
}

/*
 * Optional Ferro Pay Mode column.
 * Trim whitespace, then match inapp, handoff, or off case-insensitively.
 * The stored value is the lowercase token. Hyphens and underscores are not removed,
 * so in-app and in_app are unknown.
 * A blank cell omits the field. Any other value omits it and warns.
 */
export function mapPayMode(value: unknown, rowId: string): PayMode | undefined {
  if (typeof value !== "string") {
    if (value == null) return undefined;
    warnUnknownPayMode(rowId);
    return undefined;
  }
  const raw = value.trim();
  if (!raw) return undefined;
  const folded = raw.toLowerCase();
  if (isPayMode(folded)) return folded;
  warnUnknownPayMode(rowId);
  return undefined;
}

/* Map one kept sheet row onto a place. Does not set `r` or `tl`. Sets `payMode` from Ferro Pay Mode. */
export function mapPlace(values: Record<string, unknown>, sheetRow?: number): PrivatePlace {
  const point = rowCoordinates(values);
  if (!point) throw new Error("mapPlace called without coordinates");
  const {lat, lng} = point;
  const id = sheetPlaceId(values["Place ID"]);
  if (!id) throw new Error("mapPlace called without a PP id");
  const name = text(values["Location Name"]);
  const place: PrivatePlace = {
    id,
    n: name,
    p: [lat, lng],
    s: mapCanPark(values["Can Park? (Yes/No/Conditional)"]),
  };
  if (isKnownVerification(values["Verification Result"])) {
    place.q = "known";
    assign(place, "verifiedAt", parseDate(values["Verified Date"]));
  }
  assign(place, "conf", mapConf(values["Confidence (1-5)"]));
  assign(place, "aud", mapAud(values["Who Can Park"]));
  if (isApproxPrecision(values["Geo Precision"])) place.approx = true;
  assign(place, "free", parseMinutes(values["Free Stay Countdown (mins)"]));
  assign(place, "max", parseMinutes(values["Max Stay (mins)"]));
  if (norm(values["Price Status"]) === "published") {
    assign(place, "fee", poundsToPence(values["Parking Charge (£)"]));
  }
  assign(place, "feeUnit", mapFeeUnit(values["Tariff Type"], values["Tariff Detail"]));
  if (isAutopay(values["Ferro Autopay"])) place.auto = true;
  assign(place, "payMode", mapPayMode(values["Ferro Pay Mode"], payModeRowId(values, sheetRow, place.id)));
  assign(place, "operator", mapOperator(values.Operator));
  assign(place, "src", firstUrl(values["Source URLs (primary first)"]));
  assign(place, "srcType", mapSrcType(values["Evidence Type"]));
  assign(place, "capturedAt", parseDate(values["Date Captured"]));
  assign(place, "hours", mapHours(values["Hours (OpenStreetMap opening_hours format)"]));
  assign(place, "addr", formatAddr(values["Street Address"], values.Postcode));
  const location = parseLocationCode(values["Rules Summary"]);
  if (location) {
    place.locationCode = location.locationCode;
    place.locationProvider = location.locationProvider;
  }
  if (place.srcType !== undefined && !isSrcType(place.srcType)) {
    throw new Error("srcType escaped the allowed list");
  }
  return place;
}
