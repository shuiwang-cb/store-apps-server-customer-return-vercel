/**
 * Who is calling. Every request arrives through the commercebuild storefront,
 * which signs a 60-second token for the signed-in user; it is verified here
 * against the storefront issuer's JWKS (issuer, audience = this service's
 * origin, expiry). Nothing else about the caller is trusted.
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import { env } from "./env";
import { HttpError } from "./http";

export interface Caller {
  storeId: string;
  userId: number;
  role: "admin" | "user";
  /** "" when the user has no linked customer. */
  customerCode: string;
  /** The store's origin + basePath, for links back into it. */
  storefrontUrl: string;
  /** Present when the storefront forwarded the user's platform token. */
  platform?: { url: string; token: string };
}

let keys: JWTVerifyGetKey | null = null;
let keysUrl = "";

function jwks(): JWTVerifyGetKey {
  const url = env.jwksUrl();
  if (!keys || keysUrl !== url) {
    keys = createRemoteJWKSet(new URL(url));
    keysUrl = url;
  }
  return keys;
}

/** Test seam: verify against these keys instead of the issuer's JWKS. */
export function setKeysForTests(getKey: JWTVerifyGetKey | null): void {
  keys = getKey;
  keysUrl = getKey ? env.jwksUrl() : "";
}

const unauthorized = () =>
  new HttpError(401, "unauthorized", "Sign in to continue.");

export async function authenticate(request: Request): Promise<Caller> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw unauthorized();
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, jwks(), {
      issuer: env.issuer(),
      audience: env.serviceOrigin(),
      algorithms: ["RS256"],
    }));
  } catch {
    throw unauthorized();
  }
  const storeId = String(claims.cb_store_id ?? "");
  const userId = Number(claims.cb_user_id);
  if (!storeId || !Number.isInteger(userId) || userId <= 0) {
    throw unauthorized();
  }
  const platformToken = request.headers.get("x-cb-platform-token") ?? "";
  const platformUrl = String(claims.cb_platform_url ?? "")
    ? env.platformUrlOverride() || String(claims.cb_platform_url)
    : "";
  return {
    storeId,
    userId,
    role: claims.cb_user_role === "admin" ? "admin" : "user",
    customerCode: String(claims.cb_user_customer_code ?? ""),
    storefrontUrl: String(claims.cb_storefront_url ?? ""),
    ...(platformToken && platformUrl
      ? { platform: { url: platformUrl.replace(/\/+$/, ""), token: platformToken } }
      : {}),
  };
}

export function requireAdmin(caller: Caller): void {
  if (caller.role !== "admin") {
    throw new HttpError(403, "forbidden", "Admins only.");
  }
}
