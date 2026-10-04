/** Pages `_headers` doesn't apply to Functions responses, so API responses carry these themselves. */
export const apiHeaders = { "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" };

export const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(apiHeaders)) merged.set(name, value);
  return Response.json(body, { status, headers: merged });
};

export const errorResponse = (status: number, code: string, message: string, extra: object = {}, headers: HeadersInit = {}): Response =>
  json({ error: { code, message }, ...extra }, status, headers);
