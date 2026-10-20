/**
 * The returns API — one route, a small table of paths. Every request must
 * carry a commercebuild token (see lib/auth.ts); writes must carry an
 * Idempotency-Key. Paths and their callers are documented in README.md.
 */
import { authenticate, requireAdmin, type Caller } from "@/lib/auth";
import { badRequest, errorResponse, json, notFound, readJson } from "@/lib/http";
import { withIdempotency } from "@/lib/idempotency";
import {
  addNote,
  addPhoto,
  adminCounts,
  adminList,
  adminSearch,
  applyAction,
  createReturn,
  deleteReturn,
  getReturn,
  listMine,
  listNotes,
  listPhotos,
  markUnderReview,
  respondToInfoRequest,
} from "@/lib/returns/service";
import {
  readSettings,
  saveSettings,
  validateSettingsPatch,
} from "@/lib/returns/settings";

type Handler = (ctx: {
  caller: Caller;
  params: string[];
  query: URLSearchParams;
  body: () => Promise<any>;
}) => Promise<unknown>;

/** [method, pattern, handler]; ":" segments capture, in order. */
const ROUTES: [string, string, Handler][] = [
  ["GET", "returns/mine", ({ caller }) => listMine(caller)],
  ["GET", "returns/counts", ({ caller }) => adminCounts(caller)],
  ["GET", "returns/search", ({ caller, query }) => adminSearch(caller, query)],
  ["GET", "returns", ({ caller, query }) => adminList(caller, query)],
  ["POST", "returns", async ({ caller, body }) => createReturn(caller, await body())],
  ["GET", "returns/:id", ({ caller, params }) => getReturn(caller, params[0]!)],
  ["DELETE", "returns/:id", ({ caller, params }) => deleteReturn(caller, params[0]!)],
  ["GET", "returns/:id/photos", ({ caller, params }) => listPhotos(caller, params[0]!)],
  [
    "POST",
    "returns/:id/photos",
    async ({ caller, params, body }) => addPhoto(caller, params[0]!, await body()),
  ],
  [
    "POST",
    "returns/:id/info-response",
    async ({ caller, params, body }) =>
      respondToInfoRequest(caller, params[0]!, await body()),
  ],
  [
    "POST",
    "returns/:id/actions",
    async ({ caller, params, body }) => applyAction(caller, params[0]!, await body()),
  ],
  [
    "POST",
    "returns/:id/review",
    async ({ caller, params, body }) => markUnderReview(caller, params[0]!, await body()),
  ],
  ["GET", "returns/:id/notes", ({ caller, params }) => listNotes(caller, params[0]!)],
  [
    "POST",
    "returns/:id/notes",
    async ({ caller, params, body }) => addNote(caller, params[0]!, await body()),
  ],
  ["GET", "settings", ({ caller }) => readSettings(caller.storeId)],
  [
    "PUT",
    "settings",
    async ({ caller, body }) => {
      requireAdmin(caller);
      await saveSettings(caller.storeId, validateSettingsPatch(await body()));
      return {};
    },
  ],
];

function match(
  method: string,
  segments: string[],
): { handler: Handler; params: string[] } | null {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    const params: string[] = [];
    const ok = parts.every((part, index) => {
      if (part.startsWith(":")) {
        params.push(segments[index]!);
        return true;
      }
      return part === segments[index];
    });
    if (ok) return { handler, params };
  }
  return null;
}

async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    const { path } = await params;
    const route = match(request.method, path ?? []);
    if (!route) throw notFound();
    const caller = await authenticate(request);
    const url = new URL(request.url);
    const run = async () => ({
      status: 200,
      body: await route.handler({
        caller,
        params: route.params,
        query: url.searchParams,
        body: () => readJson(request),
      }),
    });
    if (request.method === "GET") {
      const { body } = await run();
      return json(body);
    }
    const key = request.headers.get("idempotency-key");
    if (!key && request.method !== "PUT") throw badRequest("Idempotency-Key is required.");
    const result = key
      ? // Keys are per user, so one user's key never replays another's answer.
        await withIdempotency(caller.storeId, `${caller.userId}:${key}`, run)
      : await run();
    return json(result.body, result.status);
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
