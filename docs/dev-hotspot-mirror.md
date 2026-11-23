# Dev hotspot mirror

Ferro Dev builds use `ferro-maps-dev`, whose Firestore had no hotspot data, so the map showed no SURGE pins. This job copies the live active pins into dev, one way and read-only on live.

| | |
|---|---|
| Source | `ferro-maps-staging-v2` → `hotspots_test` where `expire_at > now` (the same set the driver map listens to) |
| Target | `ferro-maps-dev` → `hotspots_test`, plus one bookkeeping doc `_devMirror/hotspots_test` (clients cannot read it; the rules' final deny covers it) |
| Runner | `.github/workflows/dev-hotspot-mirror.yml`, `ubuntu-latest`, every 15 minutes |
| Code | `scripts/mirror-dev-hotspots` |

## What it does each run

1. Reads the live active pins. If that read fails, or returns more than 5,000 pins, it stops. Dev is not touched.
2. Reads one dev doc, the manifest: per pin, a hash of what was last copied and its `expire_at`.
3. Writes only pins that are new or changed, as a full `set` (no merge), so dev matches live field for field. Sheet-sync clocks (`fetched_at`, `updatedFromSheetAt`, `updatedAt`, `forecastUpdatedAt`) do not count as a change on their own.
4. Deletes dev pins that left the live set (expired or removed).
5. Saves the manifest with only what committed. A failed batch is retried next run. The job is idempotent.

Guards:

- **Live is read-only.** The live key is a `roles/datastore.viewer` account, and the code only runs a query on it. The script refuses a key whose `project_id` is not the expected project, and refuses live = dev.
- **Shrink guard.** If the live set drops below 20% of what dev holds (and dev holds more than 20), only pins that have already expired are deleted.
- **Dev quota.** Spark allows 20k writes and 20k deletes a day. The job stops at 500 ops a run and 6,000 a day (Pacific quota day), so testers keep the rest.
- **Public logs.** The repo is public. Only counts are printed: no document contents, no ids, no key material.

Not copied: `contributions` (driver-submitted pins with driver uids), `pmf_testing` (an internal Settings test feed), `pins` / `pinTiles` (pins v1 is off), planner and forecast collections. The dev map treats an empty `contributions` as normal.

## Setup (one time)

### 1. Live read-only account (`ferro-maps-staging-v2`)

Google Cloud console → project **ferro-maps-staging-v2** → IAM & Admin → Service accounts → Create service account.

- Name: `dev-hotspot-mirror-reader`
- Grant role: **Cloud Datastore Viewer** (`roles/datastore.viewer`). No other role.
- Done → open the account → Keys → Add key → Create new key → JSON.

### 2. Dev writer account (`ferro-maps-dev`)

Same steps in project **ferro-maps-dev**:

- Name: `dev-hotspot-mirror-writer`
- Grant role: **Cloud Datastore User** (`roles/datastore.user`).
- Keys → Add key → JSON.

### 3. Secrets

Repo → Settings → Secrets and variables → Actions:

- Secret `LIVE_FIRESTORE_READER_KEY`: the whole JSON of the live viewer key.
- Secret `DEV_FIRESTORE_MIRROR_KEY`: the whole JSON of the dev writer key.
- Variable `DEV_HOTSPOT_MIRROR_ENABLED` = `true` (the switch; the schedule is skipped without it).

Keep any local copy of the key files in `/workspace/ferro-secrets/` with `chmod 600`, or delete them after pasting.

### 4. First run

Actions → Dev hotspot mirror → Run workflow with **dry run** ticked. The log shows `live`, `upserts`, `deletes` counts. Then run it again unticked. The schedule takes over from there.

## Cost

- Actions: free (public repo, ubuntu runner). About 96 runs a day of under a minute.
- Live Firestore reads: one read per active pin per run, so 96 × active pins a day. 500 active pins ≈ 1.4M reads a month ≈ $0.55. Hard cap 5,000 pins ≈ $5.50 a month worst case.
- Dev: within the Spark free tier (6,000 ops a day cap, 96 manifest reads a day).

## Turning it off

Set `DEV_HOTSPOT_MIRROR_ENABLED` to anything else, or disable the workflow. To revoke live access, delete the `dev-hotspot-mirror-reader` key or account in `ferro-maps-staging-v2`.
