/** An answer the API gives on purpose, with a JSON body. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export const notFound = () => new HttpError(404, "not_found", "Not found.");
export const forbidden = () => new HttpError(403, "forbidden", "Not allowed.");
export const badRequest = (message: string) =>
  new HttpError(400, "bad_request", message);
export const unprocessable = (message: string) =>
  new HttpError(422, "unprocessable", message);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: error.code, message: error.message, ...error.extra },
      error.status,
    );
  }
  console.error("[returns] unhandled", error);
  return json({ error: "internal", message: "Something went wrong." }, 500);
}

export async function readJson(request: Request): Promise<any> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The body is not valid JSON.");
  }
}
