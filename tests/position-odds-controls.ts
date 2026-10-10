import {assertEquals} from 'jsr:@std/assert@1';
import {evaluateRole} from '../../../plugins/omnishell/interpreter/jessie.js';
const handler = async (name:string) => evaluateRole(await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`,import.meta.url)), 'handler');
const positions = [{position:1,percent:62.5,current:true,reach:''},{position:2,percent:37.5,current:false,reach:''}];
const view = () => ({id:'group:team',group_id:'group',team_id:'team',current_json:JSON.stringify({positions,zones:[]}),position_number:1,position_last:2,table_mode:'history',snapshot_index:3,snapshot_last:9});
Deno.test('current inspection and historical dates use isolated controls',async()=>{
 const control=await handler('position-odds-control');
 const snapshot=await handler('odds-progress-snapshot');
 const point=await handler('odds-progress-point');
 const state={items:[view()]};
 assertEquals(control(state,{from:'position-slider-group-team',value:'2'}),2);
 assertEquals(snapshot(state,{from:'position-slider-group-team',value:'2'}),3);
 assertEquals(point(state,{from:'position-graph-group-team',pointerX:1000}),3);
 assertEquals(control(state,{from:'odds-date-group-team',value:'2'}),1);
 assertEquals(snapshot(state,{from:'odds-date-group-team',value:'2'}),2);
 assertEquals(control(state,{from:'position-slider-group-team',value:'3'}),1);
 assertEquals(control(state,{from:'position-graph-group-team',pointerX:1000}),2);
 assertEquals(control(state,{from:'position-graph-group-team',pointerX:1000},{field:'guard-pointer'}),true);
 assertEquals(control(state,{from:'odds-values-group-team',value:'current'},{field:'table_mode'}),'current');
 assertEquals(control(state,{from:'unrelated',value:'current'},{field:'table_mode'}),'history');
 assertEquals(control(state,{from:'unrelated',pointerX:1000},{field:'guard-pointer'}),false);
});
Deno.test('current source folding retains historical state and reacts to metadata and removals',async()=>{
 const fold=await handler('position-odds-fold');
 const seed=view();
 const zone={id:'z',name:'Zone',color:'#8a2be2',first:1,last:2,positions:''};
 const initial=fold({items:[seed],rows:{view:[],positions,zones:[zone]}}).updates[0];
 assertEquals(initial.op,'put');
 assertEquals(initial.row.position_number,1);
 assertEquals(initial.row.snapshot_index,-1);
 const arriving={series_json:JSON.stringify({snapshots:[{},{},{}],zones:[]})};
 assertEquals(fold({items:[],rows:{view:[{...initial.row,id:seed.id}],positions,zones:[zone],history:[arriving]}}).updates[0].row.snapshot_index,2);
 const history={series_json:JSON.stringify({snapshots:[{},{},{},{},{},{}],zones:[]})};
 const stored={...initial.row,id:seed.id,position_number:2,snapshot_index:3,snapshot_last:5,series_json:history.series_json,table_mode:'history'};
 assertEquals(fold({items:[],rows:{view:[stored],positions,zones:[zone],history:[history]}}),{updates:[]});
 const changed=fold({items:[],rows:{view:[stored],positions,zones:[{...zone,color:'#123456'}],history:[history]}}).updates[0];
 assertEquals(JSON.parse(changed.row.current_json).zones[0].color,'#123456');
 assertEquals(changed.row.position_number,2);
 assertEquals(changed.row.snapshot_index,3);
 assertEquals(changed.row.table_mode,'history');
 const removed=fold({items:[],rows:{view:[stored],positions:[],zones:[]}}).updates[0];
 assertEquals(removed.row.position_number,-1);
 assertEquals(removed.row.position_last,0);
 assertEquals(JSON.parse(removed.row.current_json),{positions:[],zones:[]});
});

Deno.test('one initializer writes both distributions regardless of which source triggers it',async()=>{
 const fold=await handler('position-odds-fold');
 const seed={...view(),snapshot_index:-1};
 const history={...seed,series_json:JSON.stringify({snapshots:[{},{}],zones:[]})};
 const rows={view:[],positions,zones:[],history:[history]};
 const first=fold({items:[seed],rows}).updates[0].row;
 const second=fold({items:[history],rows}).updates[0].row;
 assertEquals(first,second);
 assertEquals(first.series_json,history.series_json);
 assertEquals(JSON.parse(first.current_json).positions,positions);
 assertEquals(first.snapshot_index,1);
 const restored={...first,id:seed.id};
 assertEquals(fold({items:[],rows:{...rows,view:[restored]}}),{updates:[]});
});

Deno.test('a reader on the latest recorded day follows a new capture; an earlier day stays put',async()=>{
 const fold=await handler('position-odds-fold');
 const days=(n:number)=>({series_json:JSON.stringify({snapshots:Array.from({length:n},()=>({})),zones:[]})});
 const latest={...view(),snapshot_index:1,snapshot_last:1,series_json:days(2).series_json};
 // The first fold fixed the latest day's index, so a new day left the chart behind.
 assertEquals(fold({items:[],rows:{view:[latest],positions,zones:[],history:[days(3)]}}).updates[0].row.snapshot_index,2);
 const earlier={...latest,snapshot_index:0};
 assertEquals(fold({items:[],rows:{view:[earlier],positions,zones:[],history:[days(3)]}}).updates[0].row.snapshot_index,0);
});
