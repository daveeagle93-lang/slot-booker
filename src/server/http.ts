export const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, { status, headers });

export const errorResponse = (status: number, code: string, message: string, extra: object = {}): Response =>
  json({ error: { code, message }, ...extra }, status);
