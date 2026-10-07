/** A stored credential omp's `get_logout_accounts` RPC reports for one
 * provider (omp ≥ 18.7.0). Mirrors the upstream `LogoutAccount` shape. */
export interface LogoutAccount {
  credentialId: number;
  provider: string;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
  active: boolean;
}

export type LogoutPlan =
  /** Nothing stored for the provider. */
  | { kind: "none" }
  /** Several accounts stored and the caller named none — the client must choose. */
  | { kind: "choose"; accounts: LogoutAccount[] }
  /** The caller named a credential that is not stored for the provider. */
  | { kind: "not_found"; accounts: LogoutAccount[] }
  /** Remove this credential. */
  | { kind: "logout"; credentialId: number };

/**
 * Decide which credential a logout request removes. A single stored account
 * needs no prompt; several accounts force an explicit choice so one click
 * can never disconnect the wrong account.
 */
export function planLogout(accounts: LogoutAccount[], requestedId?: number): LogoutPlan {
  if (accounts.length === 0) return { kind: "none" };
  if (requestedId === undefined) {
    if (accounts.length > 1) return { kind: "choose", accounts };
    return { kind: "logout", credentialId: accounts[0].credentialId };
  }
  if (!accounts.some((account) => account.credentialId === requestedId)) {
    return { kind: "not_found", accounts };
  }
  return { kind: "logout", credentialId: requestedId };
}
