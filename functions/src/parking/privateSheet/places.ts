import {createHash} from "node:crypto";
import {canonicalOperator, PP_SHEET_SOURCE} from "../contract.js";
import {
  isAutopay,
  mapPayMode,
  norm,
  rowCoordinates,
  parseLocationCode,
  parseMinutes,
  placeId,
  poundsToPence,
  sheetPlaceId,
  text,
} from "./mapping.js";
import {rowsFromMatrix} from "./rows.js";
import {type SourceRow} from "./types.js";

/* The phone's stay picker. An hourly sheet rate is expanded onto these bands. */
export const STAY_BANDS = [15, 30, 60, 120, 180, 240, 480, 1440] as const;

export interface TariffBand {
  maxMinutes: number;
  pence: number;
}

export interface PayablePlace {
  id: string;
  source: typeof PP_SHEET_SOURCE;
  name: string;
  payMode: "inapp" | "handoff";
  operator?: string;
  locationCode?: string;
  parkingPence?: number;
  parkingTariffs?: TariffBand[];
}

interface TariffLine {
  placeId: string;
  vehicle: string;
  fuel: string;
  minutesTo: number | null;
  pence: number;
  unit: "hour" | "stay" | "day";
}

export interface ExistingParkingPlace {
  id: string;
  contentHash?: string;
  source?: string;
  parking?: boolean;
}

export interface PlannedPlaceWrite {
  id: string;
  action: "upsert" | "delete";
  data?: PayablePlace & {contentHash: string};
}

const LEGACY_ID = /^[a-f0-9]{64}$/;
const EXAMPLE_ID = /^(debug-|example)/i;

export function parkingPlaceHash(place: PayablePlace): string {
  const body = {
    source: place.source,
    name: place.name,
    payMode: place.payMode,
    operator: place.operator ?? null,
    locationCode: place.locationCode ?? null,
    parkingPence: place.parkingPence ?? null,
    parkingTariffs: place.parkingTariffs ?? null,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/* Operator column when it is a pay operator, otherwise the code parsed from Rules Summary. */
export function payOperator(operatorCell: unknown, rules: unknown): string | null {
  const direct = canonicalOperator(operatorCell);
  if (direct) return direct;
  const parsed = parseLocationCode(rules);
  if (!parsed) return null;
  return canonicalOperator(parsed.locationProvider);
}

function tariffUnit(value: unknown): TariffLine["unit"] | null {
  const s = norm(value);
  if (s === "per hour") return "hour";
  if (s === "per stay") return "stay";
  if (s === "per 24 hours" || s === "per day") return "day";
  return null;
}

function genericFuel(fuel: string): boolean {
  const s = norm(fuel);
  return s === "" || s === "any" || s.includes("any other");
}

/* One vehicle band. A generic car row wins over petrol versus electric splits. */
export function chooseTariffLines(lines: TariffLine[]): TariffLine[] {
  if (lines.length === 0) return [];
  const cars = lines.filter((line) => {
    const vehicle = norm(line.vehicle);
    return vehicle === "" || vehicle === "car";
  });
  const pool = cars.length > 0 ? cars : lines;
  const generic = pool.filter((line) => genericFuel(line.fuel));
  const chosen = generic.length > 0 ? generic : pool.filter((line) => norm(line.fuel) === norm(pool[0].fuel));
  return chosen;
}

function hourlyBands(hourlyPence: number): TariffBand[] {
  const bands: TariffBand[] = [];
  for (const maxMinutes of STAY_BANDS) {
    const pence = Math.round(hourlyPence * maxMinutes / 60);
    if (pence >= 1) bands.push({maxMinutes, pence});
  }
  return bands;
}

function uniqueBands(rows: TariffBand[]): TariffBand[] {
  const byMinutes = new Map<number, number>();
  for (const row of rows) {
    const prev = byMinutes.get(row.maxMinutes);
    if (prev == null || row.pence > prev) byMinutes.set(row.maxMinutes, row.pence);
  }
  return [...byMinutes.entries()]
    .map(([maxMinutes, pence]) => ({maxMinutes, pence}))
    .sort((a, b) => a.maxMinutes - b.maxMinutes);
}

/* Hourly rows become the phone's duration bands. A flat stay is used only when there is no hourly rate. */
export function tariffsFromLines(lines: TariffLine[]): TariffBand[] | undefined {
  const chosen = chooseTariffLines(lines);
  const hourly = chosen.filter((line) => line.unit === "hour");
  if (hourly.length > 0) {
    const rate = Math.max(...hourly.map((line) => line.pence));
    const bands = hourlyBands(rate);
    return bands.length > 0 ? bands : undefined;
  }
  const flats = chosen.filter((line) => line.unit === "stay" || line.unit === "day");
  const banded = flats.filter((line) => line.minutesTo != null && line.minutesTo >= 1);
  if (banded.length > 0) {
    const bands = uniqueBands(banded.map((line) => ({
      maxMinutes: line.minutesTo ?? 0,
      pence: line.pence,
    })));
    return bands.length > 0 ? bands : undefined;
  }
  return undefined;
}

export function indexTariffs(matrix: unknown[][]): Map<string, TariffLine[]> {
  const index = new Map<string, TariffLine[]>();
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const id = sheetPlaceId(row.values["Place ID"]);
    const unit = tariffUnit(row.values.Unit);
    const pence = poundsToPence(row.values["Price (£)"]);
    if (!id || !unit || pence == null || pence < 1) continue;
    const minutesTo = parseMinutes(row.values["Minutes to"]);
    const line: TariffLine = {
      placeId: id,
      vehicle: text(row.values["Vehicle class"]),
      fuel: text(row.values["Fuel or band"]),
      minutesTo: minutesTo ?? null,
      pence,
      unit,
    };
    const list = index.get(id) ?? [];
    list.push(line);
    index.set(id, list);
  }
  return index;
}

function flatFromLines(lines: TariffLine[]): number | undefined {
  const chosen = chooseTariffLines(lines).filter((line) => line.unit === "stay" || line.unit === "day");
  if (chosen.length === 0) return undefined;
  if (chosen.some((line) => line.minutesTo != null)) return undefined;
  return chosen[0].pence;
}

/*
 * A Ferro Autopay mark is the payable gate. A blank Ferro Pay Mode becomes
 * inapp so the charge path can run. An explicit off is not stored.
 */
export function payablePlace(values: Record<string, unknown>, tariffs: Map<string, TariffLine[]>): PayablePlace | null {
  if (!isAutopay(values["Ferro Autopay"])) return null;
  const id = sheetPlaceId(values["Place ID"]);
  const name = text(values["Location Name"]).slice(0, 80);
  if (!id || !name) return null;
  const mode = mapPayMode(values["Ferro Pay Mode"], id);
  if (mode === "off") return null;
  const payMode = mode === "handoff" ? "handoff" : "inapp";
  const place: PayablePlace = {id, source: PP_SHEET_SOURCE, name, payMode};
  const operator = payOperator(values.Operator, values["Rules Summary"]);
  if (operator) place.operator = operator;
  const location = parseLocationCode(values["Rules Summary"]);
  if (location) place.locationCode = location.locationCode;
  if (norm(values["Price Status"]) === "published") {
    const pence = poundsToPence(values["Parking Charge (£)"]);
    if (pence != null && pence >= 1) place.parkingPence = pence;
  }
  const lines = tariffs.get(id) ?? [];
  const bands = tariffsFromLines(lines);
  if (bands) place.parkingTariffs = bands;
  if (place.parkingPence == null) {
    const flat = flatFromLines(lines);
    if (flat != null && flat >= 1 && !bands) place.parkingPence = flat;
  }
  return place;
}

export function payablePlaces(
  rows: Array<{values: Record<string, unknown>}>,
  tariffMatrix: unknown[][],
): PayablePlace[] {
  const tariffs = indexTariffs(tariffMatrix);
  const places: PayablePlace[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const place = payablePlace(row.values, tariffs);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  return places;
}

/* Old sha256 ids for every row that still has a name and a coordinate, validated or not. */
export function legacyPlaceIds(rows: SourceRow[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.blank) continue;
    const point = rowCoordinates(row.values);
    const name = text(row.values["Location Name"]);
    if (!point || !name) continue;
    const id = placeId(name, row.values.Postcode, point.lat, point.lng);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function deletePlace(prev: ExistingParkingPlace, desired: Set<string>, legacy: Set<string>): boolean {
  if (desired.has(prev.id)) return false;
  if (prev.source === PP_SHEET_SOURCE) return true;
  if (legacy.has(prev.id)) return true;
  if (LEGACY_ID.test(prev.id) && prev.parking === true) return true;
  if (EXAMPLE_ID.test(prev.id)) return true;
  return false;
}

export function planPlaceWrites(input: {
  desired: PayablePlace[];
  existing: ExistingParkingPlace[];
  legacyIds: string[];
}): {writes: PlannedPlaceWrite[]; unchanged: number; deleted: number} {
  const desiredIds = new Set(input.desired.map((place) => place.id));
  const legacy = new Set(input.legacyIds);
  const existingById = new Map(input.existing.map((place) => [place.id, place]));
  const writes: PlannedPlaceWrite[] = [];
  let unchanged = 0;
  for (const place of input.desired) {
    const contentHash = parkingPlaceHash(place);
    const prev = existingById.get(place.id);
    if (prev?.contentHash === contentHash && prev.source === PP_SHEET_SOURCE) {
      unchanged += 1;
      continue;
    }
    writes.push({id: place.id, action: "upsert", data: {...place, contentHash}});
  }
  let deleted = 0;
  for (const prev of input.existing) {
    if (!deletePlace(prev, desiredIds, legacy)) continue;
    deleted += 1;
    writes.push({id: prev.id, action: "delete"});
  }
  return {writes, unchanged, deleted};
}
