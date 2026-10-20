# store-apps-server

Remote backend for commercebuild custom apps. Today it serves one app: the
**Customer Return - Vercel** demo — every piece of returns logic, data and
email lives here, while the screens are an ordinary commercebuild extension.

```
extension page ──> commercebuild storefront proxy ──> this service ──> commercebuild platform API
 useBackend("returns")   signs a 60 s token for the       verifies the token,     read the order AS the
                         signed-in user, forwards the      owns the returns data   shopper, with the token
                         user's platform token                                     the storefront forwarded
```

## How a request is trusted

- `authorization: Bearer <token>` — signed by the storefront's OIDC issuer.
  Verified against `${CB_ISSUER}/api/oidc/jwks`: issuer, audience
  (`SERVICE_ORIGIN`), expiry. Claims used: `cb_store_id` (every query is
  scoped by it), `cb_user_id`, `cb_user_role` (`admin` → admin routes),
  `cb_user_customer_code` (shoppers see their customer's returns),
  `cb_storefront_url` (email links), `cb_platform_url`.
- `x-cb-platform-token` — the user's own platform access token, used only
  within the request (to read the order being returned, and email
  addresses) and never stored or logged.
- `Idempotency-Key` — required on every write except `PUT settings`; a
  repeat returns the first answer.

## Data

Postgres, schema in `migrations/`. No customer names or email addresses are
stored; addresses are read from the platform when an email is sent. Line
snapshots (item, quantity, unit price) are taken from the order the platform
returns, never from the browser.

## API

See the app's `README.md` (the contract) — `src/app/api/[...path]/route.ts`
lists the same routes.

## Run locally

```bash
docker run -d --name returns-postgres-local -e POSTGRES_USER=returns \
  -e POSTGRES_PASSWORD=returns -e POSTGRES_DB=returns -p 54329:5432 postgres:17-alpine
cp .env.example .env.local     # adjust CB_ISSUER to the local storefront issuer
npm install
DATABASE_URL=postgres://returns:returns@localhost:54329/returns npm run migrate
npm run dev                    # http://localhost:4000/api
```

Tests use a separate database (`returns_test` on the same server, or
`TEST_DATABASE_URL`): `npm test`.

## Deploy (Vercel + Supabase)

1. Supabase project → Database → connection string, **transaction pooler**
   (port 6543) → `DATABASE_URL`. Run `npm run migrate` against it once.
2. Vercel project from this repo; env: `DATABASE_URL`, `CB_ISSUER`,
   `SERVICE_ORIGIN` (the deployment's public origin), `APP_ID`,
   `ADMIN_NOTIFY_EMAIL`, `RESEND_API_KEY`, `EMAIL_FROM`.
3. Put `${SERVICE_ORIGIN}/api` in the app's `config.json` as the `returns`
   connection's `baseUrl`.

Without `RESEND_API_KEY` emails are logged, not sent. Without a verified
domain, Resend delivers only to the account owner's address.
