import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {autopayPlaceAllowed, canonicalOperator} from "../src/parking/contract.js";
import {buildImport} from "../src/parking/privateSheet/build.js";
import {
  isKnownVerification,
  parseLocationCode,
  placeId,
  sheetPlaceId,
} from "../src/parking/privateSheet/mapping.js";
import {
  legacyPlaceIds,
  payablePlaces,
  planPlaceWrites,
  tariffsFromLines,
  type TariffBand,
} from "../src/parking/privateSheet/places.js";
import {rowsFromMatrix} from "../src/parking/privateSheet/rows.js";
import {
  LONDON_CLEAN_TAB,
  TARIFFS_TAB,
  syncPrivateParkingOnce,
} from "../src/parking/privateSheet/syncPlan.js";

const NOW = new Date("2026-11-01T00:00:00.000Z");

function row(values: Record<string, unknown>): Record<string, unknown> {
  return {
    "Location Name": "Yard",
    "Postcode": "W1 1AA",
    "Latitude": 51.5,
    "Longitude": -0.12,
    "Location Status": "Open",
    "Can Park? (Yes/No/Conditional)": "Yes",
    "Verification Result": "Confirmed",
    "Place ID": "PP-000100",
    ...values,
  };
}

describe("pp sheet autopay", () => {
  it("accepts the three validated results and drops the rest", () => {
    assert.equal(isKnownVerification("Confirmed"), true);
    assert.equal(isKnownVerification(" Corrected "), true);
    assert.equal(isKnownVerification("Confirmed, details not published"), true);
    assert.equal(isKnownVerification("Confirmed details not published"), true);
    for (const value of ["Needs on-site check", "No evidence", "", "   ", null]) {
      assert.equal(isKnownVerification(value), false, String(value));
    }
  });

  it("maps columns by header name when Ferro Pay Mode is the last column", () => {
    const names = ["Location Name", "Latitude", "Longitude", "Ferro Pay Mode", "Place ID", "Verification Result"];
    const moved = ["Ferro Pay Mode", "Place ID", "Verification Result", "Location Name", "Longitude", "Latitude"];
    const values = {
      "Location Name": "Yard",
      "Latitude": "51.5",
      "Longitude": "-0.12",
      "Ferro Pay Mode": "inapp",
      "Place ID": "PP-000222",
      "Verification Result": "Confirmed",
    };
    const matrix = (header: string[]) => [header, header.map((name) => values[name as keyof typeof values])];
    const first = buildImport(rowsFromMatrix(matrix(names)), NOW).imported[0].place;
    const second = buildImport(rowsFromMatrix(matrix(moved)), NOW).imported[0].place;
    assert.equal(first.id, "PP-000222");
    assert.equal(second.id, first.id);
    assert.equal(second.payMode, "inapp");
    assert.deepEqual(second.p, first.p);
  });

  it("publishes only validated PP ids and keys the place by that id", () => {
    const headers = Object.keys(row({}));
    const lines = [
      row({}),
      row({"Place ID": "PP-000101", "Verification Result": "Confirmed, details not published", "Location Name": "Published"}),
      row({"Place ID": "PP-000102", "Verification Result": "Corrected", "Location Name": "Fixed"}),
      row({"Place ID": "PP-000103", "Verification Result": "Needs on-site check", "Location Name": "Visit"}),
      row({"Place ID": "PP-000104", "Verification Result": "No evidence", "Location Name": "None"}),
      row({"Place ID": "PP-000105", "Verification Result": "", "Location Name": "Blank"}),
      row({"Place ID": "not-a-pp-id", "Location Name": "Google"}),
    ];
    const matrix = [headers, ...lines.map((values) => headers.map((name) => values[name]))];
    const build = buildImport(rowsFromMatrix(matrix), NOW);
    assert.deepEqual(build.imported.map((item) => item.place.id), ["PP-000100", "PP-000101", "PP-000102"]);
    assert.equal(build.skipped.unvalidated, 3);
    assert.equal(build.skipped.missing_pp_id, 1);
    assert.equal(sheetPlaceId("pp-000100"), "PP-000100");
    assert.equal(sheetPlaceId("ChIJexample"), null);
  });

  it("canonicalises NCP, APCOA, and Q-Park and reads their location codes", () => {
    assert.equal(canonicalOperator("NCP"), "NCP");
    assert.equal(canonicalOperator("APCOA Parking"), "APCOA");
    assert.equal(canonicalOperator("APCOA Parking UK"), "APCOA");
    assert.equal(canonicalOperator("Q-Park"), "Q-Park");
    assert.equal(canonicalOperator("Q Park"), "Q-Park");
    assert.equal(canonicalOperator("Ealing Council"), null);
    const qpark = parseLocationCode("Q-Park location 120045");
    assert.equal(qpark?.locationProvider, "qpark");
    assert.equal(qpark?.locationCode, "120045");
    const ncp = parseLocationCode("NCP 48219");
    assert.equal(ncp?.locationProvider, "ncp");
    assert.equal(ncp?.locationCode, "48219");
  });

  it("upserts Ferro Autopay rows into places and deletes legacy hash ids", () => {
    const values = row({
      "Ferro Autopay": "✅",
      "Operator": "Q-Park",
      "Rules Summary": "Q-Park location 120045",
      "Price Status": "Published",
      "Parking Charge (£)": "4.50",
    });
    const tariffs = [[
      "Place ID", "Vehicle class", "Fuel or band", "Minutes to", "Price (£)", "Unit",
    ], [
      "PP-000100", "Car", "Any other vehicle", "", "2.00", "per hour",
    ]];
    const desired = payablePlaces([{values}], tariffs);
    assert.equal(desired.length, 1);
    assert.equal(desired[0].id, "PP-000100");
    assert.equal(desired[0].source, "pp-sheet");
    assert.equal(desired[0].payMode, "inapp");
    assert.equal(desired[0].operator, "Q-Park");
    assert.equal(desired[0].locationCode, "120045");
    assert.equal(desired[0].parkingPence, 450);
    assert.equal(desired[0].parkingTariffs?.[0].maxMinutes, 15);
    assert.equal(desired[0].parkingTariffs?.[0].pence, 50);
    assert.equal(desired[0].parkingTariffs?.find((band) => band.maxMinutes === 60)?.pence, 200);

    const legacy = placeId("Yard", "W1 1AA", 51.5, -0.12);
    const plan = planPlaceWrites({
      desired,
      legacyIds: [legacy],
      existing: [
        {id: legacy, parking: true},
        {id: "debug-inapp-pay", parking: true},
        {id: "PP-000099", source: "pp-sheet", parking: true},
        {id: "venue-1"},
      ],
    });
    assert.equal(plan.writes.find((write) => write.id === "PP-000100")?.action, "upsert");
    assert.equal(plan.writes.find((write) => write.id === legacy)?.action, "delete");
    assert.equal(plan.writes.find((write) => write.id === "debug-inapp-pay")?.action, "delete");
    assert.equal(plan.writes.find((write) => write.id === "PP-000099")?.action, "delete");
    assert.equal(plan.writes.some((write) => write.id === "venue-1"), false);
    assert.equal(plan.deleted, 3);
  });

  it("does not write a place when Ferro Autopay is blank or pay mode is off", () => {
    const blank = payablePlaces([
      {values: row({"Ferro Pay Mode": "inapp"})},
      {values: row({"Place ID": "PP-000101", "Ferro Autopay": "yes", "Ferro Pay Mode": "off"})},
      {values: row({"Place ID": "PP-000102", "Ferro Autopay": "yes", "Ferro Pay Mode": "handoff", "Operator": "NCP"})},
    ], []);
    assert.deepEqual(blank.map((place) => [place.id, place.payMode, place.operator]), [
      ["PP-000102", "handoff", "NCP"],
    ]);
  });

  it("turns a flat per-stay tariff into bands when minutes are set", () => {
    const bands: TariffBand[] | undefined = tariffsFromLines([
      {placeId: "PP-000100", vehicle: "Car", fuel: "", minutesTo: 60, pence: 200, unit: "stay"},
      {placeId: "PP-000100", vehicle: "Car", fuel: "", minutesTo: 120, pence: 350, unit: "stay"},
    ]);
    assert.deepEqual(bands, [
      {maxMinutes: 60, pence: 200},
      {maxMinutes: 120, pence: 350},
    ]);
  });

  it("refuses Birmingham and any other location tab without reading", async () => {
    let calls = 0;
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "1VHtzY1001e0aRSXE6s_-IJU9YioJtjSNZ5WCOt1IO-o",
      tab: "UK PILOT - Birmingham",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => {
        calls += 1;
        return [];
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, "aborted");
    assert.equal(result.abortReason, "tab-not-london");
    assert.equal(result.placeWrites.length, 0);
    assert.equal(LONDON_CLEAN_TAB, "ALL LONDON (clean)");
    assert.equal(TARIFFS_TAB, "TARIFFS");
  });

  it("drops a place that loses validation and deletes its places doc", async () => {
    const headers = [
      "Location Name", "Postcode", "Latitude", "Longitude", "Location Status", "Evidence Type",
      "Verification Result", "Place ID", "Ferro Autopay",
    ];
    const kept = ["Other", "W1 1AB", "51.51", "-0.13", "Open", "", "Confirmed", "PP-000101", ""];
    const lost = ["Yard", "W1 1AA", "51.5", "-0.12", "Open", "", "No evidence", "PP-000100", "✅"];
    const legacy = legacyPlaceIds(rowsFromMatrix([headers, lost]));
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet",
      tab: LONDON_CLEAN_TAB,
      lastGoodRowCount: 1,
      existing: [],
      existingPlaces: [
        {id: "PP-000100", source: "pp-sheet", parking: true, contentHash: "old"},
        {id: legacy[0], parking: true},
      ],
      loadSheet: async () => [headers, lost, kept],
    });
    assert.equal(result.status, "ok");
    assert.equal(result.imported, 1);
    assert.equal(result.writes[0].data.places[0].id, "PP-000101");
    assert.equal(result.placeWrites.find((write) => write.id === "PP-000100")?.action, "delete");
    assert.equal(result.placeWrites.find((write) => write.id === legacy[0])?.action, "delete");
    assert.equal(result.placesDeleted, 2);
  });

  it("refuses Autopay charges that are not a sheet PP id", () => {
    assert.equal(autopayPlaceAllowed("PP-000100", "pp-sheet"), true);
    assert.equal(autopayPlaceAllowed("debug-inapp-pay", "pp-sheet"), false);
    assert.equal(autopayPlaceAllowed("PP-000100", "example"), false);
    assert.equal(autopayPlaceAllowed("PP-000100", undefined), false);
    assert.equal(autopayPlaceAllowed(placeId("Yard", "W1 1AA", 51.5, -0.12), "pp-sheet"), false);
  });
});
