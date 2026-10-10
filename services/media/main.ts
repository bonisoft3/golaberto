import postgres from "npm:postgres@3.4.9";
import { createNativeGateway, nativeRepository } from "./native-gateway.ts";
import { adaptBlobRequest } from "./blob-route.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const jwtSecret = Deno.env.get("PGRST_JWT_SECRET");
if (!databaseUrl || !jwtSecret) throw new Error("DATABASE_URL and PGRST_JWT_SECRET are required");
const schema = postgres(databaseUrl, { max: 1 });
try {
  await schema`SELECT 1 FROM golaberto_upload.object LIMIT 0`;
  await schema`SELECT 1 FROM user_pending_upload LIMIT 0`;
} finally { await schema.end(); }
const repository = nativeRepository(databaseUrl);
const gateway = createNativeGateway(repository, jwtSecret);
Deno.serve({ port: 3900 }, async (request) => {
  if (new URL(request.url).pathname === "/health" && request.method === "GET") return new Response("ok");
  return await gateway(adaptBlobRequest(request));
});
