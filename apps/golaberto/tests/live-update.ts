/// <reference lib="dom" />
import {assert,assertEquals} from 'jsr:@std/assert@1';
import {FIXTURE_CARRIERS} from '../../../plugins/omnishell/interpreter/fixture-types.js';
import {chromium} from 'npm:playwright@1.59.1';

Deno.test('app updates replace stale live templates, module lists and held pages without losing drafts',async () => {
  let version=1;
  let offline=false;
  const root=new URL('../../../plugins/omnishell/',import.meta.url);
  const field=(name:string) => ({name,type:'text'});
  const config=() => ({
    app:'live update fixture',revision:Math.min(version,2),liveUpdates:true,carriers:FIXTURE_CARRIERS,tables:[],
    local:{team:'tab',draft:'tab',...(version>=2 ? {probability:'tab'} : {})},
    schema:{team:{fields:[field('id'),field('name')]},draft:{fields:[field('id'),field('body')]},probability:{fields:[field('id'),field('percent')]}},
    seed:{team:[{id:'chelsea',name:'Chelsea'},{id:'arsenal',name:'Arsenal'}],draft:[{id:'note',body:''}],probability:[{id:'chelsea',percent:'25%'}]},
    routes:[{screen:'team',path:'/en/team-championship/:id/:championship',nav:{label:'Team'},keep:2,states:['loading','empty','populated'],files:{html:'shell/screens/team.html',css:'shell/screens/team.css',handlers:[],renderers:version>=2 ? ['shell/renderers/new-odds.js'] : []}}],
  });
  const html=() => `<section class="screen" data-screen="team" data-release="${version}"><div data-live="team" data-filter="id=eq.{param.id}"><template data-item><article><h1 data-text="{name}"></h1><label>Draft<textarea id="draft" data-value="{name}"></textarea></label><a id="switch" data-route="team" data-param-id="arsenal" data-param-championship="{param.championship}">Arsenal</a>${version>=2 ? '<section id="team-odds" style="margin-top:1500px"><h2>Detailed probabilities</h2><div data-live="probability" data-filter="id=eq.{id}"><template data-item><p data-text="{percent}" data-text-format="new-odds"></p></template></div><form data-action="navigate" data-route="team"><input type="hidden" name="championship" value="{param.championship}"><select name="id" data-value="{param.id}"><option value="chelsea">Chelsea</option><option value="arsenal">Arsenal</option></select></form></section><div style="height:1500px"></div>' : ''}</article></template></div></section>`;
  const pageHtml=`<!doctype html><html><head><meta charset="utf-8"><base href="/shell/"></head><body><div id="app"></div><script>sessionStorage.setItem('boots',String(Number(sessionStorage.getItem('boots')||0)+1));</script><script type="module">import {createShell} from '/omnishell/interpreter/shell.js';await createShell({config:'./shell.json',mount:document.getElementById('app')});window.ready=true;if('serviceWorker' in navigator)await navigator.serviceWorker.register('/offline-first-sw.js');</script></body></html>`;
  const server=Deno.serve({port:0,onListen:()=>{}},async req => {
    const path=new URL(req.url).pathname;
    if(offline && path.startsWith('/shell/')) return new Response('outage',{status:503});
    if(path.startsWith('/en/') || path==='/shell/index.html') return new Response(pageHtml,{headers:{'content-type':'text/html'}});
    if(path==='/shell/shell.json') return Response.json(config());
    if(path==='/shell/screens/team.html') return new Response(html(),{headers:{'content-type':'text/html'}});
    if(path.endsWith('.css') || path==='/shell/boot.js') return new Response('',{headers:{'content-type':path.endsWith('.css') ? 'text/css' : 'text/javascript'}});
    if(path==='/shell/renderers/new-odds.js') return new Response('(value) => [{tag:"span",children:[`Probability ${value}`]}]',{headers:{'content-type':'text/javascript; charset=utf-8'}});
    const file=path==='/offline-first-sw.js' ? new URL('offline-first-sw.js',root) : path.startsWith('/omnishell/interpreter/') ? new URL(path.slice('/omnishell/'.length),root) : null;
    if(file) {try{return new Response((await Deno.readTextFile(file)).replace('const LIVE_UPDATES = false;', 'const LIVE_UPDATES = true;'),{headers:{'content-type':'text/javascript; charset=utf-8'}});}catch{}}
    return new Response('not found',{status:404});
  });
  const base=`http://localhost:${(server.addr as Deno.NetAddr).port}`;
  const browser=await chromium.launch();
  const context=await browser.newContext();
  try {
    const page=await context.newPage();
    const screen=() => page.locator('.shell-screen:not([hidden])');
    page.on('pageerror',error => console.error(error.message));
    page.on('console',message => {if(message.type()==='error') console.error(message.text());});
    await page.clock.install();
    await page.goto(`${base}/en/team-championship/chelsea/premier`);
    try {await page.waitForFunction(() => (window as any).ready && navigator.serviceWorker.controller,{},{timeout:10000});}
    catch(error) {console.error((await page.locator('body').innerText()).slice(0,3000));throw error;}
    // Let the initial controller activation finish its own safe refresh.
    await page.waitForTimeout(800);
    await page.waitForFunction(() => (window as any).ready);
    await screen().locator('#draft').fill('Chelsea draft');
    await screen().locator('#switch').click();
    await page.waitForURL('**/arsenal/premier');
    await screen().locator('#draft').fill('Arsenal draft');
    await page.evaluate(async () => {await (window as any).__prontoStore.patch('draft',[{key:'note',changes:{body:'stored draft'}}]);});
    const boots=await page.evaluate(() => Number(sessionStorage.getItem('boots')));
    version=2;
    // The real discovery timer detects the deployment without a navigation
    // or a test-injected asset request.
    await page.clock.fastForward(60000);
    await page.waitForTimeout(900);
    assertEquals(await page.evaluate(() => Number(sessionStorage.getItem('boots'))),boots,'typing defers the automatic refresh');
    await screen().locator('h1').click();
    await page.waitForFunction((old:number) => Number(sessionStorage.getItem('boots'))>old && (window as any).ready,boots);
    await screen().locator('#team-odds').waitFor();
    assertEquals(await screen().locator('#draft').inputValue(),'Arsenal draft');
    assertEquals(await page.evaluate(async () => (await (window as any).__prontoStore.query('draft'))[0].body),'stored draft');
    await page.evaluate(async () => {await (window as any).__prontoStore.patch('team',[{key:'arsenal',changes:{name:'Arsenal updated'}}]);});
    assertEquals(await screen().locator('#draft').inputValue(),'Arsenal draft','a store rebind preserves recovered unsent edits');
    // Keep the fragment, but scroll away from it before another deployment.
    await page.evaluate(() => {history.replaceState(null,'',location.pathname+'#team-odds');window.scrollTo(0,700);});
    const secondBoot=await page.evaluate(() => Number(sessionStorage.getItem('boots')));
    version=3;
    await page.clock.fastForward(60000);
    await page.waitForFunction((old:number) => Number(sessionStorage.getItem('boots'))>old && (window as any).ready,secondBoot);
    await screen().locator('#team-odds').waitFor();
    assertEquals(await screen().locator('#draft').inputValue(),'Arsenal draft','untouched recovered drafts survive consecutive deployments');
    assertEquals(await page.evaluate(() => window.scrollY),700,'recovery keeps the reader position instead of jumping to the fragment');
    assert(page.url().endsWith('#team-odds'));
    // The former held page is rebuilt with new modules, and its DOM-only draft survives.
    await page.goBack();
    await page.waitForURL('**/chelsea/premier');
    await screen().locator('#team-odds p').waitFor();
    assertEquals(await screen().locator('#team-odds p').innerText(),'Probability 25%');
    assertEquals(await screen().locator('#draft').inputValue(),'Chelsea draft');
    await screen().locator('#team-odds select').selectOption('arsenal');
    await page.waitForURL('**/arsenal/premier');
    assert(await screen().locator('#team-odds').isVisible(),'new controls are hydrated and keep the championship');
    offline=true;
    await page.reload();
    await screen().locator('#team-odds').waitFor();
    assertEquals(await screen().locator('h1').innerText(),'Arsenal','cached assets remain available during a server outage');
  } finally {await context.close();await browser.close();await server.shutdown();}
});
