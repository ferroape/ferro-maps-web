# Dev hotspot mirror

Ferro Dev builds use `ferro-maps-dev`, whose Firestore had no hotspot data, so the map showed no SURGE pins. This job copies the live active pins into dev, one way and read-only on live.

| | |
|---|---|
| Source | `ferro-maps-staging-v2` → `hotspots_test` where `expire_at > now` (the same set the driver map listens to) |
| Target | `ferro-maps-dev` → `hotspots_test`, plus one bookkeeping doc `_devMirror/hotspots_test` (clients cannot read it; the rules' final deny covers it) |
| Runner | `.github/workflows/dev-hotspot-mirror.yml`, `ubuntu-latest`, every 15 minutes, `main` only |
| Auth | Keyless. GitHub OIDC → Workload Identity Federation pool in `ferro-maps-dev` → impersonates one service account per project. No JSON keys (key creation is blocked by org policy). |
| Code | `scripts/mirror-dev-hotspots` |

## What it does each run

1. Reads the live active pins. If that read fails, or returns more than 5,000 pins, it stops. Dev is not touched.
2. Reads one dev doc, the manifest: per pin, a hash of what was last copied and its `expire_at`.
3. Writes only pins that are new or changed, as a full `set` (no merge), so dev matches live field for field. Sheet-sync clocks (`fetched_at`, `updatedFromSheetAt`, `updatedAt`, `forecastUpdatedAt`) do not count as a change on their own.
4. Deletes dev pins that left the live set (expired or removed).
5. Saves the manifest with only what committed. A failed batch is retried next run. The job is idempotent.

Guards:

- **Live is read-only.** The live account has only `roles/datastore.viewer`, and the code only runs a query on it.
- **Right account, right project.** Before use, each credential file is checked: a WIF file must impersonate an account in the expected project (and, when `LIVE_MIRROR_SA` / `DEV_MIRROR_SA` are set, exactly that account). The same account for both sides is refused. Nothing from the file is printed.
- **Shrink guard.** If the live set drops below 20% of what dev holds (and dev holds more than 20), only pins that have already expired are deleted.
- **Dev quota.** Spark allows 20k writes and 20k deletes a day. The job stops at 500 ops a run and 6,000 a day (Pacific quota day), so testers keep the rest.
- **Public logs.** The repo is public. Only counts are printed: no document contents, no ids, no credential contents. The auth credential files are written by `google-github-actions/auth`, never uploaded, removed in an `always()` step, and `gha-creds-*.json` is in `.gitignore`.

Not copied: `contributions` (driver-submitted pins with driver uids), `pmf_testing` (an internal Settings test feed), `pins` / `pinTiles` (pins v1 is off), planner and forecast collections. The dev map treats an empty `contributions` as normal.

## Setup (one time, Google Cloud console)

Service accounts (already created, one role each):

- `dev-hotspot-mirror-reader@ferro-maps-staging-v2.iam.gserviceaccount.com`: `roles/datastore.viewer` on `ferro-maps-staging-v2`
- `dev-hotspot-mirror-writer@ferro-maps-dev.iam.gserviceaccount.com`: `roles/datastore.user` on `ferro-maps-dev`

### 1. APIs in `ferro-maps-dev` (the pool's project)

APIs & Services → Library, enable each if it is not already on:

- IAM Service Account Credentials API (`iamcredentials.googleapis.com`)
- Security Token Service API (`sts.googleapis.com`)
- Identity and Access Management (IAM) API (`iam.googleapis.com`)

Nothing needs enabling in `ferro-maps-staging-v2` for auth. Firestore is already on in both.

### 2. Pool and provider in `ferro-maps-dev`

IAM & Admin → Workload Identity Federation → Create pool.

- Name `GitHub Actions`, Pool ID **`github-actions`**, enabled.
- Add a provider: **OpenID Connect (OIDC)**.
  - Provider name `ferro-maps-web`, Provider ID **`ferro-maps-web`**
  - Issuer (URL): `https://token.actions.githubusercontent.com`
  - JWK file: leave empty
  - Audiences: **Default audience**
- Configure provider attributes, mapping:

  | Google | OIDC |
  |---|---|
  | `google.subject` | `assertion.sub` |
  | `attribute.repository` | `assertion.repository` |
  | `attribute.repository_id` | `assertion.repository_id` |
  | `attribute.repository_owner_id` | `assertion.repository_owner_id` |
  | `attribute.ref` | `assertion.ref` |
  | `attribute.workflow_ref` | `assertion.job_workflow_ref` |

- Attribute condition (only `main` of this repo; the ids stop a renamed or re-created repo from matching):

  ```
  assertion.repository == 'ferroape/ferro-maps-web' && assertion.repository_id == '1468849395' && assertion.repository_owner_id == '300433873' && assertion.ref == 'refs/heads/main'
  ```

- Save. The provider's resource name is
  `projects/DEV_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/ferro-maps-web`.
  `DEV_PROJECT_NUMBER` is on the `ferro-maps-dev` dashboard (Project info → Project number) or Firebase console → Project settings → Project number. It is the number, not `ferro-maps-dev`.

### 3. Let the pool impersonate each account

Member (principal), the same for both:

```
principalSet://iam.googleapis.com/projects/DEV_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/ferroape/ferro-maps-web
```

- Project `ferro-maps-dev` → IAM & Admin → Service accounts → `dev-hotspot-mirror-writer` → Principals with access → Grant access → that member → role **Workload Identity User** (`roles/iam.workloadIdentityUser`).
- Project `ferro-maps-staging-v2` → Service accounts → `dev-hotspot-mirror-reader` → same member, same role. Cross-project is supported: the account need not be in the pool's project. This binding is on the service account only. It grants no project role and touches no data.

Do not grant any role at project level to the `principalSet`.

### 4. Repo variables (not secrets)

github.com/ferroape/ferro-maps-web → Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|---|---|
| `GCP_WIF_PROVIDER` | `projects/DEV_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/ferro-maps-web` |
| `LIVE_MIRROR_SA` | `dev-hotspot-mirror-reader@ferro-maps-staging-v2.iam.gserviceaccount.com` |
| `DEV_MIRROR_SA` | `dev-hotspot-mirror-writer@ferro-maps-dev.iam.gserviceaccount.com` |
| `DEV_HOTSPOT_MIRROR_ENABLED` | `true` (the switch) |

The old `LIVE_FIRESTORE_READER_KEY` / `DEV_FIRESTORE_MIRROR_KEY` secrets are no longer used.

### 5. First run

Actions → Dev hotspot mirror → Run workflow on `main` with **dry run** ticked. The log shows `live`, `upserts`, `deletes` counts. Then run it again unticked. The schedule takes over from there.

Local runs (optional): set `LIVE_CREDENTIALS_FILE` and `DEV_CREDENTIALS_FILE` to credential files. A JSON key file still passes the same project check, but key creation is blocked by org policy, so CI never uses one.

## Cost

- Actions: free (public repo, ubuntu runner). About 96 runs a day of under a minute.
- Live Firestore reads: one read per active pin per run, so 96 × active pins a day. 500 active pins ≈ 1.4M reads a month ≈ $0.55. Hard cap 5,000 pins ≈ $5.50 a month worst case.
- Dev: within the Spark free tier (6,000 ops a day cap, 96 manifest reads a day).

## Turning it off

Set `DEV_HOTSPOT_MIRROR_ENABLED` to anything else, or disable the workflow. To revoke live access, remove the Workload Identity User binding from `dev-hotspot-mirror-reader` in `ferro-maps-staging-v2` (or disable the provider in `ferro-maps-dev`).
