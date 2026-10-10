import { errors, jwtVerify } from "npm:jose@6.0.11";
import { MAX_BODY } from "./normalize.ts";

export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export async function boundedBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw new RequestError(413, "Image too large");
  }
  if (!request.body) throw new RequestError(400, "Image required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, 15_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (expired) throw new RequestError(408, "Upload timed out");
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new RequestError(413, "Image too large");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function requireActor(
  request: Request,
  secret: Uint8Array,
): Promise<string> {
  const bearer = request.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ")) {
    throw new RequestError(401, "Authentication required");
  }
  try {
    const { payload } = await jwtVerify(bearer.slice(7), secret, {
      algorithms: ["HS256"],
      requiredClaims: ["sub", "exp"],
    });
    if (
      payload.guest !== false || payload.role !== "app_user" ||
      typeof payload.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        payload.sub,
      )
    ) throw new RequestError(403, "Account required");
    return payload.sub;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      throw new RequestError(401, "Invalid session");
    }
    throw error;
  }
}
