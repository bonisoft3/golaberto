import { assertEquals } from "jsr:@std/assert@1";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url));

for (const [path, mode] of [["/shell/screens/principal.html", "cors"], ["/en", "navigate"]]) {
  Deno.test(`cached ${path} keeps revalidation alive until the new response is stored`, async () => {
    let respond: Promise<Response> | undefined;
    const lifetime: Promise<unknown>[] = [];
    const stored: string[] = [];
    let finish: (response: Response) => void = () => {};
    const network = new Promise<Response>((resolve) => finish = resolve);
    const handlers: Record<string, (event: unknown) => void> = {};
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: "https://localhost:8443" },
        clients: { matchAll: () => Promise.resolve([]) },
        addEventListener: (name: string, handler: (event: unknown) => void) => handlers[name] = handler,
      },
      caches: {
        open: () => Promise.resolve({
          match: () => Promise.resolve(new Response("old")),
          put: async (_request: unknown, response: Response) => stored.push(await response.text()),
        }),
      },
      fetch: () => network,
    });
    handlers.fetch({
      request: { method: "GET", url: `https://localhost:8443${path}`, mode },
      respondWith: (promise: Promise<Response>) => respond = promise,
      waitUntil: (promise: Promise<unknown>) => lifetime.push(promise),
    });
    assertEquals(await (await respond)?.text(), "old", "the cached response does not wait for the network");
    assertEquals(lifetime.length, 1, "the worker must retain background revalidation after respondWith resolves");
    finish(new Response("new"));
    await Promise.all(lifetime);
    assertEquals(stored, ["new"]);
  });
}
