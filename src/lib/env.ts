/** Configuration, read on use so tests can set it per case. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  /** The storefront OIDC issuer, without a trailing slash. */
  issuer: () => required("CB_ISSUER").replace(/\/+$/, ""),
  /** This service's origin — the audience every token must name. */
  /**
   * Where to fetch the issuer's keys. Defaults to `${issuer}/api/oidc/jwks`;
   * set it only when the issuer's public URL is not reachable from here
   * (local development against a storefront on localhost).
   */
  jwksUrl: () =>
    process.env.CB_JWKS_URL?.trim() ||
    `${required("CB_ISSUER").replace(/\/+$/, "")}/api/oidc/jwks`,
  /**
   * Call the platform here instead of the token's cb_platform_url. Set it
   * only when that URL is not reachable from here (a deployed service
   * talking to a platform that only resolves on a developer's machine).
   */
  platformUrlOverride: () => process.env.CB_PLATFORM_URL?.trim() ?? "",
  serviceOrigin: () => new URL(required("SERVICE_ORIGIN")).origin,
  appId: () => required("APP_ID"),
  adminNotifyEmail: () => process.env.ADMIN_NOTIFY_EMAIL?.trim() ?? "",
  resendApiKey: () => process.env.RESEND_API_KEY?.trim() ?? "",
  emailFrom: () =>
    process.env.EMAIL_FROM?.trim() || "Returns <onboarding@resend.dev>",
};
