/**
 * End-to-end tests of the API route against a real Postgres (TEST_DATABASE_URL,
 * default: the local returns_test database) with real token signing and a
 * stubbed platform API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://returns:returns@localhost:54329/returns_test";
const ISSUER = "https://store.example.com/v5-store";
const SERVICE = "https://returns.example.com";
const PLATFORM = "https://platform.example.com";

process.env.DATABASE_URL = DATABASE_URL;
process.env.CB_ISSUER = ISSUER;
process.env.SERVICE_ORIGIN = SERVICE;
process.env.APP_ID = "app-1";
process.env.ADMIN_NOTIFY_EMAIL = "admin@example.com";
delete process.env.RESEND_API_KEY;

const { setKeysForTests } = await import("@/lib/auth");
const route = await import("@/app/api/[...path]/route");

let privateKey: CryptoKey;
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

interface Who {
  store?: string;
  user?: number;
  role?: "admin" | "user";
  customer?: string;
  aud?: string;
  expired?: boolean;
}

async function token(who: Who = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    cb_store_id: who.store ?? "S1",
    cb_user_id: String(who.user ?? 7),
    cb_user_role: who.role ?? "user",
    cb_user_customer_code: who.customer ?? "C1",
    cb_storefront_url: "https://store.example.com/v5-store",
    cb_platform_url: PLATFORM,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(who.aud ?? SERVICE)
    .setIssuedAt(who.expired ? now - 600 : now)
    .setExpirationTime(who.expired ? now - 300 : now + 60)
    .sign(privateKey);
}

let keySeq = 0;
async function call(
  method: string,
  path: string,
  options: { who?: Who; body?: unknown; key?: string | null; noAuth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "x-cb-platform-token": "plat-token" };
  if (!options.noAuth) headers.authorization = `Bearer ${await token(options.who)}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && options.key !== null) {
    headers["idempotency-key"] = options.key ?? `k-${++keySeq}`;
  }
  const [pathname, search = ""] = path.split("?");
  const request = new Request(`${SERVICE}/api/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const handler = (route as Record<string, any>)[method];
  const res: Response = await handler(request, {
    params: Promise.resolve({ path: pathname!.split("/") }),
  });
  void search;
  return { status: res.status, body: await res.json() };
}

const ORDER = {
  orderNumber: "SO-100",
  orderDate: new Date().toISOString(),
  currencyCode: "USD",
  customerCode: "C1",
  orderLines: [
    { itemCode: "A", itemDesc: "Widget", qty: 5, uom: "EA", unitPriceDisplay: 10 },
    { itemCode: "B", itemDesc: "Gadget", qty: 2, uom: "EA", unitPrice: 4 },
  ],
};

let platformOrders: Record<string, unknown>;
const platformCalls: { url: string; auth: string | null; store: string | null }[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  setKeysForTests(async () => pair.publicKey);
  await sql.unsafe(`drop schema public cascade; create schema public;`);
  await sql.unsafe(readFileSync(join(import.meta.dirname, "../migrations/0001_init.sql"), "utf8"));
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    platformCalls.push({
      url,
      auth: headers.get("authorization"),
      store: headers.get("x-xm-store"),
    });
    const orderMatch = /\/api\/v\/1\/order\/orders\/(.+)$/.exec(url);
    if (orderMatch) {
      const order = platformOrders[decodeURIComponent(orderMatch[1]!)];
      return order
        ? new Response(JSON.stringify({ success: true, data: order }))
        : new Response("{}", { status: 404 });
    }
    if (url.endsWith("/api/v/1/users/self")) {
      return new Response(JSON.stringify({ user: { email: "me@example.com" } }));
    }
    if (/\/api\/v\/1\/admin\/users\/\d+$/.test(url)) {
      return new Response(JSON.stringify({ email: "shopper@example.com" }));
    }
    return new Response("{}", { status: 404 });
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

beforeEach(async () => {
  await sql`truncate returns, return_photos, return_notes, counters, store_settings, idempotency_keys cascade`;
  platformOrders = { "SO-100": ORDER };
  platformCalls.length = 0;
});

afterAll(async () => {
  await sql.end();
  vi.unstubAllGlobals();
});

const ADMIN: Who = { role: "admin", user: 1, customer: "" };

async function createDefault(who: Who = {}) {
  return call("POST", "returns", {
    who,
    body: {
      orderNumber: "SO-100",
      comment: "broken",
      locale: "en-US",
      items: [{ sequence: 1, returnQty: 2, reason: "Damaged in transit" }],
    },
  });
}

describe("authentication", () => {
  it("refuses a request without a token, with another audience, or expired", async () => {
    expect((await call("GET", "returns/mine", { noAuth: true })).status).toBe(401);
    expect((await call("GET", "returns/mine", { who: { aud: "https://other.example.com" } })).status).toBe(401);
    expect((await call("GET", "returns/mine", { who: { expired: true } })).status).toBe(401);
  });

  it("answers 404 for an unknown path", async () => {
    expect((await call("GET", "nope")).status).toBe(404);
  });
});

describe("creating a return", () => {
  it("reads the order as the shopper, snapshots the lines from it and issues a request number", async () => {
    const res = await createDefault();
    expect(res).toEqual({ status: 200, body: { requestId: "RET-1001" } });
    expect(platformCalls[0]).toEqual({
      url: `${PLATFORM}/api/v/1/order/orders/SO-100`,
      auth: "Bearer plat-token",
      store: "S1",
    });
    const detail = await call("GET", "returns/RET-1001");
    expect(detail.body).toMatchObject({
      requestId: "RET-1001",
      orderNumber: "SO-100",
      customerCode: "C1",
      userId: 7,
      status: "Requested",
      itemCount: 1,
      estimatedCredit: 20,
      items: [
        { sequence: 1, itemCode: "A", unitPrice: 10, purchasedQty: 5, returnQty: 2 },
      ],
    });
    // No customer names or email addresses are stored anywhere.
    const [row] = await sql`select * from returns`;
    expect(JSON.stringify(row)).not.toMatch(/@example\.com/);
  });

  it("refuses an order the platform does not show the shopper", async () => {
    platformOrders = {};
    expect((await createDefault()).status).toBe(404);
  });

  it("refuses a line that is not on the order and a quantity above what is left", async () => {
    const bad = await call("POST", "returns", {
      body: { orderNumber: "SO-100", items: [{ sequence: 9, returnQty: 1, reason: "Other" }] },
    });
    expect(bad.status).toBe(422);
    expect((await createDefault()).status).toBe(200); // 2 of 5
    const more = await call("POST", "returns", {
      body: { orderNumber: "SO-100", items: [{ sequence: 1, returnQty: 4, reason: "Other" }] },
    });
    expect(more.status).toBe(422);
    expect(more.body.message).toContain("Only 3");
  });

  it("refuses an order outside the store's return window", async () => {
    await call("PUT", "settings", { who: ADMIN, body: { returnWindowDays: 30 }, key: null });
    platformOrders = {
      "SO-100": { ...ORDER, orderDate: new Date(Date.now() - 40 * 86400000).toISOString() },
    };
    expect((await createDefault()).status).toBe(422);
  });

  it("a repeated Idempotency-Key returns the first answer and creates nothing new", async () => {
    const body = {
      orderNumber: "SO-100",
      items: [{ sequence: 1, returnQty: 1, reason: "Other" }],
    };
    const first = await call("POST", "returns", { body, key: "same" });
    const again = await call("POST", "returns", { body, key: "same" });
    expect(again).toEqual(first);
    const [{ count }] = await sql`select count(*)::int as count from returns`;
    expect(count).toBe(1);
  });

  it("requires an Idempotency-Key on writes", async () => {
    const res = await call("POST", "returns", {
      body: { orderNumber: "SO-100", items: [] },
      key: null,
    });
    expect(res.status).toBe(400);
  });
});

describe("who sees what", () => {
  it("another customer, and another store, cannot read the return", async () => {
    await createDefault();
    expect((await call("GET", "returns/RET-1001", { who: { customer: "C2", user: 8 } })).status).toBe(404);
    expect((await call("GET", "returns/RET-1001", { who: { store: "S2" } })).status).toBe(404);
    expect((await call("GET", "returns/RET-1001", { who: { store: "S2", role: "admin" } })).status).toBe(404);
    expect((await call("GET", "returns/mine", { who: { customer: "C2", user: 8 } })).body.items).toEqual([]);
    expect((await call("GET", "returns/mine")).body.items).toHaveLength(1);
  });

  it("admin routes refuse shoppers", async () => {
    await createDefault();
    expect((await call("GET", "returns")).status).toBe(403);
    expect((await call("GET", "returns/counts")).status).toBe(403);
    expect(
      (await call("POST", "returns/RET-1001/actions", { body: { action: "approve" } })).status,
    ).toBe(403);
    expect((await call("PUT", "settings", { body: { returnWindowDays: 1 }, key: null })).status).toBe(403);
  });
});

describe("the admin lifecycle", () => {
  it("review, request info, customer reply, approve with RMA, receive, inspect, credit", async () => {
    await createDefault();
    await call("POST", "returns/RET-1001/review", { who: ADMIN, body: { by: "Ann" } });
    expect((await call("POST", "returns/RET-1001/actions", { who: ADMIN, body: { action: "requestInfo" } })).status).toBe(422);
    await call("POST", "returns/RET-1001/actions", {
      who: ADMIN,
      body: { action: "requestInfo", by: "Ann", message: "Photo of the box?" },
    });
    // The shopper replies; it goes back to Under Review.
    const reply = await call("POST", "returns/RET-1001/info-response", { body: { message: "Attached" } });
    expect(reply.status).toBe(200);
    expect((await call("POST", "returns/RET-1001/info-response", { body: {} })).status).toBe(409);

    const approve = await call("POST", "returns/RET-1001/actions", { who: ADMIN, body: { action: "approve", by: "Ann" } });
    expect(approve.body).toEqual({ rma: "RMA-1001" });
    const stale = await call("POST", "returns/RET-1001/actions", { who: ADMIN, body: { action: "approve" } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale", current: "Approved · RMA Issued" });
    for (const action of ["received", "inspected", "credit"]) {
      expect((await call("POST", "returns/RET-1001/actions", { who: ADMIN, body: { action } })).status).toBe(200);
    }
    const detail = (await call("GET", "returns/RET-1001")).body;
    expect(detail.status).toBe("Credited");
    expect(detail.rma).toBe("RMA-1001");
    expect(detail.statusHistory.map((e: any) => e.label)).toEqual([
      "Requested",
      "Under Review",
      "Info Requested",
      "Info Provided",
      "Approved · RMA Issued",
      "Received",
      "Inspected",
      "Credited",
    ]);
    // The shopper's address was read live, as the admin, for the emails.
    expect(platformCalls.some((c) => c.url.endsWith("/api/v/1/admin/users/7"))).toBe(true);
  });

  it("lists with counts, status filter, cursor paging and search", async () => {
    for (let i = 0; i < 3; i++) {
      await call("POST", "returns", {
        body: { orderNumber: "SO-100", items: [{ sequence: 2, returnQty: i === 2 ? 0.5 : 0.5, reason: "Other" }] },
      });
    }
    const counts = (await call("GET", "returns/counts", { who: ADMIN })).body;
    expect(counts[""]).toBe(3);
    expect(counts.Requested).toBe(3);
    const page1 = (await call("GET", "returns?pageSize=2", { who: ADMIN })).body;
    expect(page1.items.map((r: any) => r.requestId)).toEqual(["RET-1003", "RET-1002"]);
    const page2 = (await call("GET", `returns?pageSize=2&cursor=${page1.cursor}`, { who: ADMIN })).body;
    expect(page2.items.map((r: any) => r.requestId)).toEqual(["RET-1001"]);
    expect(page2.cursor).toBeNull();
    const found = (await call("GET", "returns/search?q=ret-1002", { who: ADMIN })).body;
    expect(found.items.map((r: any) => r.requestId)).toEqual(["RET-1002"]);
    const filtered = (await call("GET", "returns?status=Credited", { who: ADMIN })).body;
    expect(filtered.items).toEqual([]);
  });

  it("notes and permanent delete", async () => {
    await createDefault();
    await call("POST", "returns/RET-1001/notes", { who: ADMIN, body: { text: "Called them", authorName: "Ann" } });
    const notes = (await call("GET", "returns/RET-1001/notes", { who: ADMIN })).body.items;
    expect(notes).toMatchObject([{ text: "Called them", authorName: "Ann" }]);
    expect((await call("DELETE", "returns/RET-1001", { who: ADMIN })).status).toBe(200);
    expect((await call("GET", "returns/RET-1001", { who: ADMIN })).status).toBe(404);
  });
});

describe("photos", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("the owner attaches photos per line; the count rides the line; admins can read them", async () => {
    await createDefault();
    expect(
      (await call("POST", "returns/RET-1001/photos", { body: { lineSequence: 1, dataUrl: "data:text/html;base64,PGI+" } })).status,
    ).toBe(400);
    expect(
      (await call("POST", "returns/RET-1001/photos", { body: { lineSequence: 2, dataUrl: PNG } })).status,
    ).toBe(400);
    expect(
      (await call("POST", "returns/RET-1001/photos", { body: { lineSequence: 1, dataUrl: PNG } })).status,
    ).toBe(200);
    const detail = (await call("GET", "returns/RET-1001")).body;
    expect(detail.items[0].photoCount).toBe(1);
    const photos = (await call("GET", "returns/RET-1001/photos", { who: ADMIN })).body.items;
    expect(photos).toMatchObject([{ lineSequence: 1, itemCode: "A", dataUrl: PNG, source: "request" }]);
    // Another customer cannot add to it.
    expect(
      (await call("POST", "returns/RET-1001/photos", { who: { customer: "C2", user: 8 }, body: { lineSequence: 1, dataUrl: PNG } })).status,
    ).toBe(404);
  });
});

describe("settings", () => {
  it("any signed-in user reads them; admins change them, validated", async () => {
    expect((await call("GET", "settings")).body).toEqual({});
    expect((await call("PUT", "settings", { who: ADMIN, body: { maxPhotosPerLine: -1 }, key: null })).status).toBe(400);
    await call("PUT", "settings", { who: ADMIN, body: { returnReasons: ["Broken"] }, key: null });
    expect((await call("GET", "settings")).body).toEqual({ returnReasons: ["Broken"] });
  });
});
