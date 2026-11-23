/*
 * Checks a credential file before it is used, without printing any of it.
 *
 * Accepted:
 *   external_account  the keyless file google-github-actions/auth writes for
 *                     Workload Identity Federation. The service account it
 *                     impersonates must live in the expected project.
 *   service_account   a JSON key, kept as a fallback for local runs. Key
 *                     creation is blocked by org policy, so CI never uses it.
 */

export type CredentialCheck =
  | {ok: true; type: "external_account" | "service_account"; serviceAccount: string}
  | {ok: false; reason: string};

const IMPERSONATION = /\/serviceAccounts\/([^/:]+):generateAccessToken$/;

export function impersonatedAccount(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = IMPERSONATION.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

export function checkCredential(json: unknown, project: string, expectedAccount?: string): CredentialCheck {
  if (typeof json !== "object" || json === null) return {ok: false, reason: "not a JSON object"};
  const cred = json as Record<string, unknown>;
  const suffix = `@${project}.iam.gserviceaccount.com`;
  const want = expectedAccount?.trim().toLowerCase() || "";

  let account: string | null;
  let type: "external_account" | "service_account";
  if (cred.type === "external_account") {
    type = "external_account";
    if (typeof cred.audience !== "string" || !cred.audience.includes("/workloadIdentityPools/")) {
      return {ok: false, reason: "external_account is not a workload identity pool credential"};
    }
    account = impersonatedAccount(cred.service_account_impersonation_url);
    if (!account) return {ok: false, reason: "external_account does not impersonate a service account"};
  } else if (cred.type === "service_account") {
    type = "service_account";
    if (cred.project_id !== project) return {ok: false, reason: `key belongs to another project; expected ${project}`};
    account = typeof cred.client_email === "string" ? cred.client_email : null;
    if (!account || typeof cred.private_key !== "string") return {ok: false, reason: "key is missing fields"};
  } else {
    return {ok: false, reason: "unsupported credential type"};
  }

  account = account.toLowerCase();
  if (!account.endsWith(suffix)) return {ok: false, reason: `service account is not in ${project}`};
  if (want && account !== want) return {ok: false, reason: "service account is not the expected one"};
  return {ok: true, type, serviceAccount: account};
}
