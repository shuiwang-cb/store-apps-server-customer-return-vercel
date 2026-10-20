/**
 * Idempotency-Key handling for writes. The first request with a key claims
 * the row and runs; it stores its answer when done. A repeat gets the stored
 * answer (or 409 while the first is still running), so a retried request —
 * including one retried across a redeploy — never applies twice.
 */
import { db } from "./db";
import { HttpError } from "./http";

export async function withIdempotency(
  storeId: string,
  key: string | null,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  if (!key) {
    throw new HttpError(400, "bad_request", "Idempotency-Key is required.");
  }
  if (key.length > 200) {
    throw new HttpError(400, "bad_request", "Idempotency-Key is too long.");
  }
  const claimed = await db()`
    insert into idempotency_keys (store_id, key) values (${storeId}, ${key})
    on conflict do nothing returning key`;
  if (claimed.length === 0) {
    const [row] = await db()<{ status: number | null; response: unknown }[]>`
      select status, response from idempotency_keys
      where store_id = ${storeId} and key = ${key}`;
    if (!row || row.status === null) {
      throw new HttpError(409, "in_progress", "This request is still running.");
    }
    return { status: row.status, body: row.response };
  }
  try {
    const result = await run();
    await db()`
      update idempotency_keys
      set status = ${result.status}, response = ${db().json((result.body ?? {}) as never)}
      where store_id = ${storeId} and key = ${key}`;
    return result;
  } catch (error) {
    // A failed attempt releases the key so the caller can retry it.
    await db()`delete from idempotency_keys where store_id = ${storeId} and key = ${key}`;
    throw error;
  }
}
