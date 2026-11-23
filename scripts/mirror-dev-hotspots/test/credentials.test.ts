import assert from "node:assert/strict";
import {test} from "node:test";
import {checkCredential, impersonatedAccount} from "../src/credentials.ts";

const DEV = "ferro-maps-dev";
const LIVE = "ferro-maps-staging-v2";
const POOL = "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/github-actions/providers/ferro-maps-web";

function wif(account: string): Record<string, unknown> {
  return {
    type: "external_account",
    audience: POOL,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
    credential_source: {url: "https://example.invalid", headers: {Authorization: "Bearer x"}},
  };
}

test("reads the impersonated account from the WIF file", () => {
  assert.equal(
    impersonatedAccount(wif(`dev-hotspot-mirror-writer@${DEV}.iam.gserviceaccount.com`).service_account_impersonation_url),
    `dev-hotspot-mirror-writer@${DEV}.iam.gserviceaccount.com`,
  );
  assert.equal(impersonatedAccount("https://x/serviceAccounts/a@b:signJwt"), null);
});

test("accepts a WIF file whose account is in the expected project", () => {
  const live = `dev-hotspot-mirror-reader@${LIVE}.iam.gserviceaccount.com`;
  const check = checkCredential(wif(live), LIVE, live);
  assert.deepEqual(check, {ok: true, type: "external_account", serviceAccount: live});
});

test("refuses the dev account for live and the live account for dev", () => {
  const dev = `dev-hotspot-mirror-writer@${DEV}.iam.gserviceaccount.com`;
  const live = `dev-hotspot-mirror-reader@${LIVE}.iam.gserviceaccount.com`;
  assert.equal(checkCredential(wif(dev), LIVE).ok, false);
  assert.equal(checkCredential(wif(live), DEV).ok, false);
});

test("refuses an account other than the one named in the variable", () => {
  const other = `someone-else@${DEV}.iam.gserviceaccount.com`;
  const check = checkCredential(wif(other), DEV, `dev-hotspot-mirror-writer@${DEV}.iam.gserviceaccount.com`);
  assert.equal(check.ok, false);
});

test("refuses WIF without impersonation, non-pool audiences and unknown types", () => {
  const noImp = wif(`a@${DEV}.iam.gserviceaccount.com`);
  delete noImp.service_account_impersonation_url;
  assert.equal(checkCredential(noImp, DEV).ok, false);
  assert.equal(checkCredential({...wif(`a@${DEV}.iam.gserviceaccount.com`), audience: "//x/workforcePools/p"}, DEV).ok, false);
  assert.equal(checkCredential({type: "authorized_user"}, DEV).ok, false);
  assert.equal(checkCredential(null, DEV).ok, false);
});

test("a JSON key still works as a local fallback, with its project checked", () => {
  const key = {type: "service_account", project_id: DEV, client_email: `k@${DEV}.iam.gserviceaccount.com`, private_key: "x"};
  assert.equal(checkCredential(key, DEV).ok, true);
  assert.equal(checkCredential({...key, project_id: LIVE}, DEV).ok, false);
});

test("a failed check never echoes credential contents", () => {
  const secret = "SECRET-TOKEN-VALUE";
  const bad = {...wif(`a@${LIVE}.iam.gserviceaccount.com`), credential_source: {headers: {Authorization: secret}}};
  const check = checkCredential(bad, DEV);
  assert.equal(check.ok, false);
  assert.ok(!JSON.stringify(check).includes(secret));
});
