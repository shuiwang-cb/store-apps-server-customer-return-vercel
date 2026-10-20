/**
 * The returns domain: every rule about who may see or change a return lives
 * here. Shoppers see their customer's returns (or, without a linked
 * customer, their own); admins see the whole store. Every query is scoped to
 * the caller's store.
 */
import type { Caller } from "../auth";
import { requireAdmin } from "../auth";
import { db, type Tx } from "../db";
import { sendEmail } from "../email";
import { env } from "../env";
import {
  badRequest,
  forbidden,
  HttpError,
  notFound,
  unprocessable,
} from "../http";
import {
  readOrder,
  readOwnEmail,
  readUserEmailAsAdmin,
  type PlatformOrder,
  type PlatformOrderLine,
} from "../platform";
import {
  ALL_STATUSES,
  actionNeedsMessage,
  HISTORY_INFO_PROVIDED,
  isReturnAction,
  STATUS_APPROVED,
  STATUS_CREDITED,
  STATUS_INFO_REQUESTED,
  STATUS_REJECTED,
  STATUS_REQUESTED,
  STATUS_UNDER_REVIEW,
  transitionOf,
} from "./lifecycle";
import {
  DEFAULT_MAX_PHOTOS_PER_LINE,
  DEFAULT_RETURN_WINDOW_DAYS,
  readSettings,
} from "./settings";

const FIRST_NUMBER = 1001;
const MAX_ADMIN_PAGE = 100;
const SEARCH_LIMIT = 50;
const MAX_PHOTO_CHARS = 1_000_000;
const PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

interface StatusEntry {
  label: string;
  at: string;
  by?: string;
  message?: string;
}

export interface ReturnItem {
  sequence: number;
  itemCode: string;
  displayItemCode: string;
  itemDesc: string;
  uom: string;
  unitPrice: number;
  purchasedQty: number;
  returnQty: number;
  reason: string;
  photoCount: number;
}

interface ReturnRow {
  id: string;
  store_id: string;
  request_id: string;
  order_number: string;
  order_date: string;
  currency_code: string;
  customer_code: string;
  user_id: number;
  locale: string;
  status: string;
  status_history: StatusEntry[];
  rma: string | null;
  comment: string;
  items: ReturnItem[];
  item_count: number;
  estimated_credit: string;
  created_at: Date;
  updated_at: Date;
}

function toApi(row: ReturnRow) {
  return {
    requestId: row.request_id,
    orderNumber: row.order_number,
    orderDate: row.order_date,
    currencyCode: row.currency_code,
    customerCode: row.customer_code,
    userId: row.user_id,
    status: row.status,
    statusHistory: row.status_history,
    rma: row.rma,
    comment: row.comment,
    itemCount: row.item_count,
    estimatedCredit: Number(row.estimated_credit),
    items: row.items,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

function isOwner(caller: Caller, row: ReturnRow): boolean {
  return caller.customerCode
    ? row.customer_code === caller.customerCode
    : row.user_id === caller.userId;
}

async function findRow(
  sql: ReturnType<typeof db> | Tx,
  storeId: string,
  requestId: string,
  forUpdate = false,
): Promise<ReturnRow | null> {
  const rows = forUpdate
    ? await sql<ReturnRow[]>`
        select * from returns
        where store_id = ${storeId} and request_id = ${requestId.toUpperCase()}
        for update`
    : await sql<ReturnRow[]>`
        select * from returns
        where store_id = ${storeId} and request_id = ${requestId.toUpperCase()}`;
  return rows[0] ?? null;
}

/** The row when the caller may see it; 404 otherwise (never 403 — no probing). */
async function visibleRow(caller: Caller, requestId: string): Promise<ReturnRow> {
  const row = await findRow(db(), caller.storeId, requestId);
  if (!row || (caller.role !== "admin" && !isOwner(caller, row))) {
    throw notFound();
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Shopper                                                             */
/* ------------------------------------------------------------------ */

export async function listMine(caller: Caller) {
  const rows = caller.customerCode
    ? await db()<ReturnRow[]>`
        select * from returns
        where store_id = ${caller.storeId} and customer_code = ${caller.customerCode}
        order by created_at desc limit 500`
    : await db()<ReturnRow[]>`
        select * from returns
        where store_id = ${caller.storeId} and user_id = ${caller.userId}
        order by created_at desc limit 500`;
  return { items: rows.map(toApi) };
}

export async function getReturn(caller: Caller, requestId: string) {
  return toApi(await visibleRow(caller, requestId));
}

function priceOf(line: PlatformOrderLine): number {
  return Number(line.unitPriceDisplay ?? line.unitPrice ?? line.price ?? 0) || 0;
}

function orderDateOf(order: PlatformOrder): string {
  return (
    order.orderDate ||
    order.startedOn ||
    order.updatedOn ||
    order.lastModifiedDate ||
    ""
  );
}

function withinWindow(orderDate: string, windowDays: number): boolean {
  if (windowDays < 0) return true;
  const placed = Date.parse(orderDate);
  // An order without a usable date cannot be shown to be outside the window.
  if (Number.isNaN(placed)) return true;
  return Date.now() - placed <= windowDays * 24 * 60 * 60 * 1000;
}

interface NewLine {
  sequence: number;
  returnQty: number;
  reason: string;
}

function parseNewReturn(body: any): {
  orderNumber: string;
  comment: string;
  locale: string;
  lines: NewLine[];
} {
  const orderNumber =
    typeof body?.orderNumber === "string" ? body.orderNumber.trim() : "";
  if (!orderNumber || orderNumber.length > 64) {
    throw badRequest("orderNumber is required.");
  }
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";
  if (comment.length > 2000) throw badRequest("The comment is too long.");
  const locale =
    typeof body?.locale === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.locale)
      ? body.locale
      : "";
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    throw unprocessable("Select at least one item to return.");
  }
  if (body.items.length > 500) throw badRequest("Too many items.");
  const seen = new Set<number>();
  const lines = body.items.map((item: any): NewLine => {
    const sequence = Number(item?.sequence);
    const returnQty = Number(item?.returnQty);
    const reason = typeof item?.reason === "string" ? item.reason.trim() : "";
    if (!Number.isInteger(sequence) || sequence < 1 || seen.has(sequence)) {
      throw badRequest("Each item needs a distinct line sequence.");
    }
    seen.add(sequence);
    if (!(returnQty > 0)) {
      throw unprocessable("Each item needs a quantity above zero.");
    }
    if (!reason || reason.length > 200) {
      throw unprocessable("Choose a reason for every item you are returning.");
    }
    return { sequence, returnQty, reason };
  });
  return { orderNumber, comment, locale, lines };
}

async function nextNumber(tx: Tx, storeId: string, name: string): Promise<number> {
  const [row] = await tx<{ value: number }[]>`
    insert into counters (store_id, name, next) values (${storeId}, ${name}, ${FIRST_NUMBER + 1})
    on conflict (store_id, name) do update set next = counters.next + 1
    returning next - 1 as value`;
  return row!.value;
}

/**
 * A new return. The order is read from the platform AS THE SHOPPER — the
 * platform only shows a shopper their own customer's orders, which is the
 * ownership check — and every line and quantity is checked against it and
 * against what earlier returns of the same order already claim.
 */
export async function createReturn(caller: Caller, body: unknown) {
  if (caller.role === "admin" && !caller.customerCode) {
    throw forbidden();
  }
  const input = parseNewReturn(body);
  const order = await readOrder(caller, input.orderNumber);
  if (!order) throw notFound();
  const settings = await readSettings(caller.storeId);
  const orderDate = orderDateOf(order);
  if (
    !withinWindow(
      orderDate,
      settings.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS,
    )
  ) {
    throw unprocessable("The return window for this order has closed.");
  }
  const orderLines = order.orderLines ?? [];
  const reasons = settings.returnReasons;

  const items: ReturnItem[] = input.lines.map((line) => {
    // Lines are addressed by their 1-based position in the order, as the app
    // does: the platform's own `sequence` repeats on some orders.
    const source = orderLines[line.sequence - 1];
    if (!source || !source.itemCode) {
      throw unprocessable(`Line ${line.sequence} is not on this order.`);
    }
    if (reasons && !reasons.includes(line.reason)) {
      throw unprocessable(`"${line.reason}" is not a return reason here.`);
    }
    return {
      sequence: line.sequence,
      itemCode: source.itemCode,
      displayItemCode: source.displayItemCode || source.itemCode,
      itemDesc: source.itemDesc ?? "",
      uom: source.uom ?? "",
      unitPrice: priceOf(source),
      purchasedQty: Number(source.qty ?? 0),
      returnQty: line.returnQty,
      reason: line.reason,
      photoCount: 0,
    };
  });

  const nowIso = new Date().toISOString();
  const row = await db().begin(async (tx) => {
    // One creator per order at a time, so two concurrent requests cannot
    // both claim the same remaining quantity.
    await tx`select pg_advisory_xact_lock(hashtext(${`${caller.storeId}|${order.orderNumber}`}))`;
    const earlier = await tx<{ items: ReturnItem[] }[]>`
      select items from returns
      where store_id = ${caller.storeId} and order_number = ${order.orderNumber}
        and status <> ${STATUS_REJECTED}`;
    const claimed = new Map<number, number>();
    for (const entry of earlier) {
      for (const item of entry.items) {
        claimed.set(item.sequence, (claimed.get(item.sequence) ?? 0) + item.returnQty);
      }
    }
    for (const item of items) {
      const left = item.purchasedQty - (claimed.get(item.sequence) ?? 0);
      if (item.returnQty > left) {
        throw unprocessable(
          `Only ${Math.max(left, 0)} of ${item.displayItemCode} can still be returned.`,
        );
      }
    }
    const number = await nextNumber(tx, caller.storeId, "request");
    const estimatedCredit = items.reduce(
      (total, item) => total + item.returnQty * item.unitPrice,
      0,
    );
    const [created] = await tx<ReturnRow[]>`
      insert into returns (
        store_id, request_number, request_id, order_number, order_date,
        currency_code, customer_code, user_id, locale, status, status_history,
        comment, items, item_count, estimated_credit
      ) values (
        ${caller.storeId}, ${number}, ${`RET-${number}`}, ${order.orderNumber},
        ${orderDate}, ${order.currencyCode ?? ""},
        ${order.customerCode || caller.customerCode}, ${caller.userId},
        ${input.locale}, ${STATUS_REQUESTED},
        ${tx.json([{ label: STATUS_REQUESTED, at: nowIso }] as never)},
        ${input.comment}, ${tx.json(items as never)}, ${items.length},
        ${estimatedCredit}
      ) returning *`;
    return created!;
  });

  await notifyAdmin(
    caller,
    row,
    `New return ${row.request_id} for order ${row.order_number}`,
    `A return was requested for order ${row.order_number} (${row.item_count} item(s)).`,
  );
  return { requestId: row.request_id };
}

export async function listPhotos(caller: Caller, requestId: string) {
  const row = await visibleRow(caller, requestId);
  const photos = await db()<
    {
      id: string;
      line_sequence: number;
      item_code: string;
      data_url: string;
      source: string;
      created_at: Date;
    }[]
  >`
    select id, line_sequence, item_code, data_url, source, created_at
    from return_photos where return_id = ${row.id} order by created_at`;
  return {
    items: photos.map((photo) => ({
      id: photo.id,
      lineSequence: photo.line_sequence,
      itemCode: photo.item_code,
      dataUrl: photo.data_url,
      source: photo.source,
      createdAtIso: photo.created_at.toISOString(),
    })),
  };
}

export async function addPhoto(caller: Caller, requestId: string, body: any) {
  const row = await visibleRow(caller, requestId);
  if (!isOwner(caller, row)) throw forbidden();
  if (
    ![STATUS_REQUESTED, STATUS_UNDER_REVIEW, STATUS_INFO_REQUESTED].includes(
      row.status,
    )
  ) {
    throw new HttpError(409, "stale", "Photos can no longer be added.", {
      current: row.status,
    });
  }
  const lineSequence = Number(body?.lineSequence);
  const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
  const source =
    body?.source === "customer-response" ? "customer-response" : "request";
  const item = row.items.find((entry) => entry.sequence === lineSequence);
  if (!item) throw badRequest("That line is not part of this return.");
  if (dataUrl.length > MAX_PHOTO_CHARS || !PHOTO_DATA_URL.test(dataUrl)) {
    throw badRequest("Photos must be JPEG, PNG or WebP under 700 KB.");
  }
  const settings = await readSettings(caller.storeId);
  const maxPerLine = settings.maxPhotosPerLine ?? DEFAULT_MAX_PHOTOS_PER_LINE;
  const mimeType = /^data:([^;]+);/.exec(dataUrl)?.[1] ?? "";

  const id = await db().begin(async (tx) => {
    const locked = (await findRow(tx, caller.storeId, requestId, true))!;
    const [{ count }] = await tx<{ count: number }[]>`
      select count(*)::int as count from return_photos
      where return_id = ${row.id} and line_sequence = ${lineSequence}
        and source = ${source}`;
    if (count >= maxPerLine) {
      throw unprocessable(`Up to ${maxPerLine} photos per item.`);
    }
    const [photo] = await tx<{ id: string }[]>`
      insert into return_photos (return_id, line_sequence, item_code, data_url, mime_type, source)
      values (${row.id}, ${lineSequence}, ${item.itemCode}, ${dataUrl}, ${mimeType}, ${source})
      returning id`;
    if (source === "request") {
      const items = locked.items.map((entry) =>
        entry.sequence === lineSequence
          ? { ...entry, photoCount: (entry.photoCount ?? 0) + 1 }
          : entry,
      );
      await tx`update returns set items = ${tx.json(items as never)}, updated_at = now()
               where id = ${row.id}`;
    }
    return photo!.id;
  });
  return { id };
}

/** The customer answers an Info Requested: back to Under Review. */
export async function respondToInfoRequest(
  caller: Caller,
  requestId: string,
  body: any,
) {
  const row = await visibleRow(caller, requestId);
  if (!isOwner(caller, row)) throw forbidden();
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message.length > 2000) throw badRequest("The reply is too long.");
  const entry: StatusEntry = {
    label: HISTORY_INFO_PROVIDED,
    at: new Date().toISOString(),
    ...(message ? { message } : {}),
  };
  const updated = await db()<ReturnRow[]>`
    update returns
    set status = ${STATUS_UNDER_REVIEW},
        status_history = status_history || ${db().json([entry] as never)},
        updated_at = now()
    where id = ${row.id} and status = ${STATUS_INFO_REQUESTED}
    returning *`;
  if (updated.length === 0) {
    throw new HttpError(409, "stale", "This return is no longer waiting for information.", {
      current: row.status,
    });
  }
  await notifyAdmin(
    caller,
    updated[0]!,
    `Customer replied on return ${row.request_id}`,
    message
      ? `The customer replied: ${message}`
      : "The customer added information to the return.",
  );
  return {};
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

function encodeCursor(row: ReturnRow): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function adminList(caller: Caller, params: URLSearchParams) {
  requireAdmin(caller);
  const pageSize = Math.min(
    Math.max(Number(params.get("pageSize")) || 20, 1),
    MAX_ADMIN_PAGE,
  );
  const status = params.get("status") ?? "";
  if (status && !(ALL_STATUSES as readonly string[]).includes(status)) {
    throw badRequest("Unknown status.");
  }
  const cursor = params.get("cursor");
  const after = cursor ? decodeCursor(cursor) : null;
  if (cursor && !after) throw badRequest("Invalid cursor.");
  const sql = db();
  const rows = await sql<ReturnRow[]>`
    select * from returns
    where store_id = ${caller.storeId}
      ${status ? sql`and status = ${status}` : sql``}
      ${after ? sql`and (created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
    order by created_at desc, id desc
    limit ${pageSize + 1}`;
  const page = rows.slice(0, pageSize);
  return {
    items: page.map(toApi),
    cursor: rows.length > pageSize ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function adminCounts(caller: Caller) {
  requireAdmin(caller);
  const rows = await db()<{ status: string; count: number }[]>`
    select status, count(*)::int as count from returns
    where store_id = ${caller.storeId} group by status`;
  const counts: Record<string, number> = { "": 0 };
  for (const status of ALL_STATUSES) counts[status] = 0;
  for (const row of rows) {
    counts[row.status] = row.count;
    counts[""] = (counts[""] ?? 0) + row.count;
  }
  return counts;
}

export async function adminSearch(caller: Caller, params: URLSearchParams) {
  requireAdmin(caller);
  const term = (params.get("q") ?? "").trim();
  if (!term) return { items: [] };
  const upper = term.toUpperCase();
  const rows = await db()<ReturnRow[]>`
    select * from returns
    where store_id = ${caller.storeId}
      and (request_id = ${upper}
           or order_number in (${term}, ${upper})
           or customer_code in (${term}, ${upper}))
    order by created_at desc limit ${SEARCH_LIMIT}`;
  return { items: rows.map(toApi) };
}

function byLabel(body: any): string {
  return typeof body?.by === "string" ? body.by.trim().slice(0, 120) : "";
}

export async function applyAction(caller: Caller, requestId: string, body: any) {
  requireAdmin(caller);
  const action = body?.action;
  if (!isReturnAction(action)) throw badRequest("Unknown action.");
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (actionNeedsMessage(action) && !message) {
    throw unprocessable("Add a message for the customer.");
  }
  if (message.length > 2000) throw badRequest("The message is too long.");
  const { from, to } = transitionOf(action);

  const updated = await db().begin(async (tx) => {
    const row = await findRow(tx, caller.storeId, requestId, true);
    if (!row) throw notFound();
    if (!from.includes(row.status)) {
      throw new HttpError(409, "stale", "The return has moved on.", {
        current: row.status,
      });
    }
    const rma =
      action === "approve"
        ? `RMA-${await nextNumber(tx, caller.storeId, "rma")}`
        : row.rma;
    const entry: StatusEntry = {
      label: to,
      at: new Date().toISOString(),
      ...(byLabel(body) ? { by: byLabel(body) } : {}),
      ...(message ? { message } : {}),
    };
    const [next] = await tx<ReturnRow[]>`
      update returns
      set status = ${to}, rma = ${rma},
          status_history = status_history || ${tx.json([entry] as never)},
          updated_at = now()
      where id = ${row.id}
      returning *`;
    return next!;
  });

  await notifyShopper(caller, updated, message);
  return { rma: action === "approve" ? updated.rma : null };
}

/** Requested → Under Review when an admin first opens it; no-op otherwise. */
export async function markUnderReview(caller: Caller, requestId: string, body: any) {
  requireAdmin(caller);
  const entry: StatusEntry = {
    label: STATUS_UNDER_REVIEW,
    at: new Date().toISOString(),
    ...(byLabel(body) ? { by: byLabel(body) } : {}),
  };
  const updated = await db()<ReturnRow[]>`
    update returns
    set status = ${STATUS_UNDER_REVIEW},
        status_history = status_history || ${db().json([entry] as never)},
        updated_at = now()
    where store_id = ${caller.storeId} and request_id = ${requestId.toUpperCase()}
      and status = ${STATUS_REQUESTED}
    returning *`;
  if (updated[0]) await notifyShopper(caller, updated[0], "");
  return {};
}

export async function deleteReturn(caller: Caller, requestId: string) {
  requireAdmin(caller);
  const deleted = await db()`
    delete from returns
    where store_id = ${caller.storeId} and request_id = ${requestId.toUpperCase()}
    returning id`;
  if (deleted.length === 0) throw notFound();
  return {};
}

export async function listNotes(caller: Caller, requestId: string) {
  requireAdmin(caller);
  const row = await visibleRow(caller, requestId);
  const notes = await db()<
    { id: string; text: string; author_name: string; created_at: Date }[]
  >`
    select id, text, author_name, created_at from return_notes
    where return_id = ${row.id} order by created_at`;
  return {
    items: notes.map((note) => ({
      id: note.id,
      text: note.text,
      authorName: note.author_name,
      authorEmail: "",
      createdAtIso: note.created_at.toISOString(),
    })),
  };
}

export async function addNote(caller: Caller, requestId: string, body: any) {
  requireAdmin(caller);
  const row = await visibleRow(caller, requestId);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 4000) throw badRequest("Write a note first.");
  const authorName =
    typeof body?.authorName === "string" ? body.authorName.trim().slice(0, 120) : "";
  const [note] = await db()<{ id: string }[]>`
    insert into return_notes (return_id, text, author_name, author_user_id)
    values (${row.id}, ${text}, ${authorName}, ${caller.userId})
    returning id`;
  return { id: note!.id };
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function storefrontLink(caller: Caller, row: ReturnRow): string {
  if (!caller.storefrontUrl) return "";
  const locale = row.locale || "en-US";
  return `${caller.storefrontUrl}/${locale}/extension/${env.appId()}/page/ReturnsPage?id=${encodeURIComponent(row.request_id)}`;
}

function adminLink(caller: Caller, row: ReturnRow): string {
  if (!caller.storefrontUrl) return "";
  const origin = new URL(caller.storefrontUrl).origin;
  const locale = row.locale || "en-US";
  return `${origin}/v5-admin/${locale}/extension/${env.appId()}/page/Returns?id=${encodeURIComponent(row.request_id)}`;
}

async function notifyAdmin(
  caller: Caller,
  row: ReturnRow,
  subject: string,
  text: string,
): Promise<void> {
  const outcome = await sendEmail({
    to: env.adminNotifyEmail(),
    subject,
    text: `${text}\n\nOpen it in Store Admin (sign in first): ${adminLink(caller, row)}`,
  });
  console.info(`[returns] admin email for ${row.request_id}: ${outcome}`);
}

const SHOPPER_SUBJECTS: Record<string, string> = {
  [STATUS_UNDER_REVIEW]: "We are reviewing your return",
  [STATUS_INFO_REQUESTED]: "We need more information about your return",
  [STATUS_APPROVED]: "Your return is approved",
  [STATUS_REJECTED]: "Your return was not approved",
  [STATUS_CREDITED]: "Your return has been credited",
};

/**
 * Tells the shopper about a change the admin made. The address is read live
 * from the platform as the admin — never stored here; when the admin's
 * privileges don't cover it, the email is skipped and that is logged.
 */
async function notifyShopper(
  caller: Caller,
  row: ReturnRow,
  message: string,
): Promise<void> {
  const to =
    caller.userId === row.user_id
      ? await readOwnEmail(caller)
      : await readUserEmailAsAdmin(caller, row.user_id);
  const subject = `${SHOPPER_SUBJECTS[row.status] ?? `Your return is now "${row.status}"`} (${row.request_id})`;
  const body = [
    `Return ${row.request_id} for order ${row.order_number} is now: ${row.status}.`,
    row.rma ? `RMA number: ${row.rma}` : "",
    message ? `Message from the store: ${message}` : "",
    row.status === STATUS_INFO_REQUESTED
      ? `Reply here (sign in first): ${storefrontLink(caller, row)}`
      : `Details (sign in first): ${storefrontLink(caller, row)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const outcome = await sendEmail({ to, subject, text: body });
  console.info(`[returns] shopper email for ${row.request_id}: ${outcome}`);
}
