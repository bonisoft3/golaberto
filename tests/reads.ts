import type { Page, Response } from "npm:playwright@1.61.1";

// A server-rendered document carries the guest /crud reads its render made
// (omnishell's pronto-reads), and a fresh guest's shell answers them from it
// instead of the door: what a guest's page read is in both places.

/** The reads `document` carries, each body under its path and query. */
export async function carried(document: Response): Promise<Map<string, string>> {
	const script = /<script type="application\/json" id="pronto-reads">([\s\S]*?)<\/script>/
		.exec(await document.text());
	return new Map(script === null ? [] : Object.entries(JSON.parse(script[1])));
}

/** Each /crud address `page` reads from now on, from the door or, for a
 * guest, from a document it is served. */
export function crudReads(page: Page): { settled(): Promise<URL[]> } {
	const urls: URL[] = [];
	const documents: Promise<void>[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/crud/")) urls.push(url);
	});
	page.on("response", (response) => {
		if (response.request().resourceType() !== "document" || !response.ok()) return;
		documents.push(carried(response).then((reads) => {
			for (const key of reads.keys()) urls.push(new URL(key, response.url()));
		}));
	});
	return {
		async settled() {
			await Promise.all(documents);
			return urls;
		},
	};
}
