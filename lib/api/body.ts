import 'server-only';

/**
 * Reads a request body as raw bytes but stops at `limit`: for public routes that run before any
 * authentication, so they never buffer whatever they are sent. Undefined when the body is too big
 * (by Content-Length or by what actually arrives).
 */
export async function readLimitedBody(request: Request, limit: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
