import {assertEquals} from 'jsr:@std/assert@1';
import {evaluateRole} from '../../../plugins/omnishell/interpreter/jessie.js';
const handler = async (name:string) => evaluateRole(await Deno.readTextFile(new URL(`../shell/handlers/odds-progress-${name}.js`,import.meta.url)), 'handler');
Deno.test('chart inspection maps responsive plot coordinates onto recorded snapshots',async()=>{
  const point=await handler('point');
  const state={items:[{snapshot_last:9,snapshot_index:9}]};
  assertEquals(point(state,{from:'odds-graph-group-team',pointerX:81}),0);
  assertEquals(point(state,{from:'odds-graph-group-team',pointerX:530}),5);
  assertEquals(point(state,{from:'position-graph-group-team',pointerX:81}),9);
});
Deno.test('chart controls retain other selections, validate range and accept known zone IDs',async()=>{
  const zone=await handler('zone');const slider=await handler('snapshot');
  const row={id:'group:team',zone_id:'same-name-id-1',snapshot_index:3,snapshot_last:9,series_json:JSON.stringify({zones:[{id:'same-name-id-1'},{id:'same-name-id-2'}]})};
  const state={items:[row]};
  assertEquals(zone(state,{value:'same-name-id-1'}),'same-name-id-1');
  assertEquals(zone(state,{value:'same-name-id-2'}),'same-name-id-2');
  assertEquals(zone(state,{value:'unknown'}),row.zone_id);
  assertEquals(zone(state,{value:'*'}),'*');
  assertEquals(slider(state,{from:'odds-date-group-team',value:'20'}),3);
  assertEquals(slider(state,{from:'odds-date-group-team'}),3);
  assertEquals(slider(state,{from:'odds-date-group-team',value:'4'}),4);
  // A final-position range input shares the region's input event; typing a
  // position there once moved the recorded date.
  assertEquals(slider(state,{from:'group:team-from',value:'4'}),3);
});
