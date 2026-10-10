import postgres from "npm:postgres@3.4.9";
import { boundedBody, RequestError, requireActor } from "./request.ts";
import { ImageVariants, MediaInputError, normalize } from "./normalize.ts";

export interface UploadRepository {
	stage(actor: string, key: string, image: ImageVariants): Promise<void>;
	read(
		key: string,
		variant: "medium" | "thumb",
	): Promise<{ bytes: Uint8Array; etag: string } | null>;
}
export function nativeRepository(
	url: string,
): UploadRepository & { close(): Promise<void> } {
	const sql = postgres(url, { max: 4 });
	return {
		async stage(actor, key, image) {
			try {
				await sql.begin(async (tx) => {
					await tx`SET LOCAL ROLE service`;
					await tx`SELECT golaberto_upload.stage(${actor}::uuid,${key},${image.etag},${image.medium},${image.thumb})`;
				});
			} catch (error) {
				if (error instanceof postgres.PostgresError) {
					if (error.code === "42501") {
						throw new RequestError(403, "Upload permission denied");
					}
					if (error.code === "23505") {
						throw new RequestError(409, "Upload key is immutable");
					}
					if (error.code === "54000") {
						throw new RequestError(429, "Pending upload limit reached");
					}
				}
				throw error;
			}
		},
		async read(key, variant) {
			const rows = await sql.begin(async (tx) => {
				await tx`SET LOCAL ROLE service`;
				return await tx`SELECT ${
					tx(variant)
				} AS bytes,etag FROM golaberto_upload.object WHERE key=${key} AND attached_kind IS NOT NULL`;
			});
			return rows[0] ? { bytes: rows[0].bytes, etag: rows[0].etag } : null;
		},
		close: () => sql.end(),
	};
}
export function createNativeGateway(
	repository: UploadRepository,
	jwtSecret: string,
) {
	const secret = new TextEncoder().encode(jwtSecret);
	if (secret.length < 32) {
		throw new Error("JWT_SECRET must be at least 32 bytes");
	}
	const keyPattern =
		"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[A-Za-z0-9]{1,12})";
	const blobRoute = new RegExp(`^/blobs/mecha-objects/${keyPattern}$`);
	const imageRoute = new RegExp(
		`^/media/objects/${keyPattern}/(medium|thumb)\\.png$`,
	);
	let active = 0, receiving = 0;
	return async (request: Request): Promise<Response> => {
		try {
			const path = new URL(request.url).pathname;
			const blob = blobRoute.exec(path), image = imageRoute.exec(path);
			if (!blob && !image) throw new RequestError(404, "Not found");
			const key = (blob ?? image)![1];
			if (request.method === "GET" || request.method === "HEAD") {
				const result = await repository.read(
					key,
					(image?.[2] ?? "medium") as "medium" | "thumb",
				);
				if (!result) throw new RequestError(404, "Image missing");
				const headers = {
					"content-type": "image/png",
					"x-content-type-options": "nosniff",
					// A key never names other bytes, so an hour of reuse is safe; a
					// detached image stops being served within it.
					"cache-control": "public, max-age=3600",
					etag: `"${result.etag}"`,
				};
				if (request.headers.get("if-none-match") === headers.etag) {
					return new Response(null, { status: 304, headers });
				}
				return new Response(
					request.method === "HEAD" ? null : new Uint8Array(result.bytes),
					{
						headers,
					},
				);
			}
			if (!blob || request.method !== "PUT") {
				throw new RequestError(405, "Method not allowed");
			}
			// Bodies and processing are bounded apart: a slow body read inside the
			// processor's two slots would let two trickling clients refuse
			// everyone else, and unbounded reads would buffer without limit.
			// Refused before the bytes when processing is already full; checked
			// again after them, since a slot may have been taken meanwhile. The
			// receiving slot is taken before the token is verified, so admission
			// follows arrival rather than which verification finishes first.
			if (active >= 2) throw new RequestError(429, "Image processor busy");
			if (receiving >= 8) throw new RequestError(429, "Upload service busy");
			receiving++;
			let actor: Awaited<ReturnType<typeof requireActor>>;
			let body: Uint8Array;
			try {
				actor = await requireActor(request, secret);
				body = await boundedBody(request);
			} finally {
				receiving--;
			}
			if (active >= 2) throw new RequestError(429, "Image processor busy");
			active++;
			try {
				const normalized = await normalize(
					body,
					request.headers.get("content-type") ?? "",
				);
				await repository.stage(actor, key, normalized);
				return new Response(null, {
					status: 204,
					headers: {
						"cache-control": "no-store",
						etag: `"${normalized.etag}"`,
					},
				});
			} finally {
				active--;
			}
		} catch (error) {
			if (error instanceof MediaInputError) {
				return new Response(error.message, {
					status: 422,
					headers: { "cache-control": "no-store" },
				});
			}
			if (error instanceof RequestError) {
				return new Response(error.message, {
					status: error.status,
					headers: { "cache-control": "no-store" },
				});
			}
			throw error;
		}
	};
}
