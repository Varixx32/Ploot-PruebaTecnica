import { DatabaseError } from "pg";
import { ZodError } from "zod";

/** Typed API error: `code` is stable and meant for clients/UI, `message` for humans. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return Response.json(
      { error: { code: "validation_failed", message: "Invalid request", details: err.issues } },
      { status: 422 },
    );
  }
  if (err instanceof DatabaseError) {
    switch (err.code) {
      case "23503": // FK: e.g. an Embajador that doesn't exist in (or doesn't belong to) the tenant
        return errorResponse(new ApiError(422, "unknown_reference", "Referenced entity not found"));
      case "23514": // CHECK constraint: an invalid state transition got to the DB
        return errorResponse(new ApiError(422, "invalid_state", "Invalid post state", { constraint: err.constraint }));
      case "42501": // RLS WITH CHECK / missing privilege
        return errorResponse(new ApiError(403, "forbidden", "Not allowed"));
      case "57014": // statement_timeout
        return errorResponse(new ApiError(503, "timeout", "The database took too long, retry"));
    }
  }
  console.error(JSON.stringify({ level: "error", msg: "unhandled API error", err: String(err) }));
  return Response.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

/** Wraps a Route Handler so every failure becomes a typed JSON error. */
export function route<P = Record<string, never>>(fn: Handler<P>): Handler<P> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Body must be valid JSON");
  }
}
