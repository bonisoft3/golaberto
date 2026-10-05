import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { runInNewContext } from "node:vm";

const original = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url));
const source = original.replace("const LIVE_UPDATES = false;", "const LIVE_UPDATES = true;");
function request(path: string, network: () => Promise<Response>, cached: Response | null = new Response('old'), script=source, cacheFails=false) {
  let response!: Promise<Response>;
  const lifetime: Promise<unknown>[] = [];
  const stored: string[] = [];
  const messages: unknown[] = [];
  const handlers: Record<string, (event: unknown) => void> = {};
  runInNewContext(script, {
    URL,
    self: {
      location: {origin:'https://localhost:8443'},
      clients: {matchAll:async () => [{postMessage:(message:unknown) => messages.push(message)}]},
      addEventListener:(name:string, handler:(event:unknown) => void) => handlers[name] = handler,
    },
    caches: {open:async () => ({match:async () => cached,put:async (_req:unknown,res:Response) => {if(cacheFails) throw new Error("quota");stored.push(await res.text());}})},
    fetch:network,
  });
  handlers.fetch({request:{method:'GET',url:`https://localhost:8443${path}`,mode:path.startsWith('/en') ? 'navigate' : 'cors'},respondWith:(value:Promise<Response>) => response=value,waitUntil:(value:Promise<unknown>) => lifetime.push(value)});
  return {response,lifetime,stored,messages};
}
for (const path of ['/shell/screens/team.html','/shell/shell.json','/omnishell/interpreter/shell.js','/en/team']) {
  Deno.test(`${path} serves fresh online assets on the first request`,async () => {
    const result=request(path,async () => new Response('new'));
    assertEquals(await (await result.response).text(),'new');
    await Promise.all(result.lifetime);
    assertEquals(result.stored,['new']);
    assertEquals(result.messages.length,path.startsWith('/en') ? 0 : 1);
  });
  Deno.test(`${path} retains cached offline boot`,async () => {
    const result=request(path,async () => {throw new TypeError('offline');});
    assertEquals(await (await result.response).text(),'old');
    assertEquals(result.stored,[]);
    assertEquals(result.messages,[]);
  });
}
Deno.test('unchanged files do not repeatedly refresh clients',async () => {
  const result=request('/shell/shell.json',async () => new Response('old'));
  await result.response;
  assertEquals(result.messages,[]);
});
Deno.test('a server outage falls back, but removed assets report their real status',async () => {
  assertEquals(await (await request('/shell/shell.json',async () => new Response('',{status:503})).response).text(),'old');
  assertEquals((await request('/shell/shell.json',async () => new Response('',{status:404})).response).status,404);
});
Deno.test('private and no-store responses are never cached',async () => {
  for (const directive of ['private','no-store']) {
    const result=request('/shell/shell.json',async () => new Response('new',{headers:{'Cache-Control':directive}}));
    assertEquals(await (await result.response).text(),'new');
    assertEquals(result.stored,[]);
    assertEquals(result.messages,[]);
  }
});
Deno.test('offline uncached assets fail rather than serving unrelated content',async () => {
  const result=request('/shell/new.js',async () => {throw new TypeError('offline');},null);
  await assertRejects(() => result.response,TypeError,'offline');
  await Promise.all(result.lifetime);
});

Deno.test('other apps retain the original cache-first default',async () => {
  let finish!:(response:Response) => void;
  const network=new Promise<Response>(resolve => finish=resolve);
  const result=request('/shell/screens/team.html',() => network,new Response('old'),original);
  assertEquals(await (await result.response).text(),'old');
  finish(new Response('new'));
  await Promise.all(result.lifetime);
  assertEquals(result.stored,['new']);
});
Deno.test('auth, mutations and sync streams remain outside the worker cache',() => {
  for (const path of ['/crud/team','/auth/guest','/electric/team','/events/stream']) {
    const result=request(path,async () => new Response('must not fetch'));
    assertEquals(result.response,undefined);
    assertEquals(result.lifetime,[]);
  }
});

Deno.test('cache exhaustion cannot turn a fresh response into a stale one',async () => {
  const result=request('/shell/shell.json',async () => new Response('new'),new Response('old'),source,true);
  assertEquals(await (await result.response).text(),'new');
  assertEquals(result.messages,[]);
});
