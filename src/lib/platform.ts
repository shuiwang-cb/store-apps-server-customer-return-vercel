/**
 * Calls to the commercebuild platform API, always as the signed-in user —
 * with the platform token the storefront forwarded for this request. Nothing
 * here is stored, cached or logged.
 */
import type { Caller } from "./auth";
import { HttpError } from "./http";

const API_PREFIX = "/api/v/1";

async function platformGet(
  caller: Caller,
  path: string,
): Promise<Response | null> {
  if (!caller.platform) return null;
  return fetch(`${caller.platform.url}${API_PREFIX}${path}`, {
    headers: {
      authorization: `Bearer ${caller.platform.token}`,
      "x-xm-store": caller.storeId,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
}

export interface PlatformOrderLine {
  sequence?: number;
  lineType?: string;
  itemCode?: string;
  displayItemCode?: string;
  itemDesc?: string;
  qty?: number;
  uom?: string;
  unitPriceDisplay?: number;
  unitPrice?: number;
  price?: number;
}

export interface PlatformOrder {
  orderNumber: string;
  orderDate?: string;
  startedOn?: string;
  updatedOn?: string;
  lastModifiedDate?: string;
  currencyCode?: string;
  customerCode?: string;
  orderLines?: PlatformOrderLine[];
}

/**
 * The order as the caller sees it, or null when the platform does not show it
 * to them (it scopes shopper reads to their own customer).
 */
export async function readOrder(
  caller: Caller,
  orderNumber: string,
): Promise<PlatformOrder | null> {
  const res = await platformGet(
    caller,
    `/order/orders/${encodeURIComponent(orderNumber)}`,
  );
  if (!res) {
    throw new HttpError(
      503,
      "platform_unavailable",
      "The order cannot be checked right now.",
    );
  }
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) {
    throw new HttpError(
      502,
      "platform_error",
      `The order could not be read (${res.status}).`,
    );
  }
  const body = (await res.json()) as { success?: boolean; data?: PlatformOrder };
  return body?.data ?? null;
}

/** The caller's own email address, or "" when unavailable. */
export async function readOwnEmail(caller: Caller): Promise<string> {
  try {
    const res = await platformGet(caller, "/users/self");
    if (!res?.ok) return "";
    const body = (await res.json()) as { user?: { email?: string } };
    return body.user?.email ?? "";
  } catch {
    return "";
  }
}

/**
 * Another user's email address, read as the calling admin. "" when the
 * admin's privileges don't cover it or the read fails.
 */
export async function readUserEmailAsAdmin(
  caller: Caller,
  userId: number,
): Promise<string> {
  try {
    const res = await platformGet(caller, `/admin/users/${userId}`);
    if (!res?.ok) return "";
    const body = (await res.json()) as { email?: string };
    return body.email ?? "";
  } catch {
    return "";
  }
}
