/**
 * Per-store settings of the returns flow. Stored as given (validated); the
 * app merges them over its own defaults, and the service applies the same
 * defaults when it checks a new request.
 */
import { db } from "../db";
import { badRequest } from "../http";

export interface ReturnsSettings {
  returnWindowDays?: number;
  maxPhotosPerLine?: number;
  returnReasons?: string[];
}

export const DEFAULT_RETURN_WINDOW_DAYS = 90;
export const DEFAULT_MAX_PHOTOS_PER_LINE = 3;

export async function readSettings(storeId: string): Promise<ReturnsSettings> {
  const [row] = await db()<{ data: ReturnsSettings }[]>`
    select data from store_settings where store_id = ${storeId}`;
  return row?.data ?? {};
}

export function validateSettingsPatch(input: unknown): ReturnsSettings {
  const source = (input ?? {}) as Record<string, unknown>;
  const patch: ReturnsSettings = {};
  if (source.returnWindowDays !== undefined) {
    if (!Number.isInteger(source.returnWindowDays)) {
      throw badRequest("returnWindowDays must be a whole number.");
    }
    patch.returnWindowDays = source.returnWindowDays as number;
  }
  if (source.maxPhotosPerLine !== undefined) {
    const value = source.maxPhotosPerLine;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 20) {
      throw badRequest("maxPhotosPerLine must be between 0 and 20.");
    }
    patch.maxPhotosPerLine = value as number;
  }
  if (source.returnReasons !== undefined) {
    const reasons = Array.isArray(source.returnReasons)
      ? source.returnReasons
          .filter((r): r is string => typeof r === "string")
          .map((r) => r.trim())
          .filter(Boolean)
      : [];
    if (reasons.length === 0 || reasons.length > 50) {
      throw badRequest("returnReasons must list 1–50 reasons.");
    }
    patch.returnReasons = reasons;
  }
  return patch;
}

export async function saveSettings(
  storeId: string,
  patch: ReturnsSettings,
): Promise<void> {
  await db()`
    insert into store_settings (store_id, data)
    values (${storeId}, ${db().json(patch as never)})
    on conflict (store_id) do update
      set data = store_settings.data || excluded.data, updated_at = now()`;
}
