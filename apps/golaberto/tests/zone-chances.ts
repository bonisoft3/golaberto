import { assertEquals } from "jsr:@std/assert@1";
import { plan, finish } from "../computations/chances.js";

Deno.test("chances use explicit noncontiguous zones and preserve source colors and order", () => {
  const group = {id:"g",live:false,sort:"pt,name",win:3,draw:1,loss:0,bonus_points:0,bonus_points_threshold:0};
  const members = [1,2,3].map(position=>({group_id:"g",team_id:`t${position}`,name:`T${position}`,position,points:0,played:0,add_sub:0,bias:0}));
  const zones = [
    {id:"z1",group_id:"g",first:1,last:3,position:0,color:"#8a2be2",positions_json:"[1,3]"},
    {id:"z2",group_id:"g",first:1,last:1,position:1,color:"#aabbcc",positions_json:"[1]"},
  ];
  const input={groups:[group],members,games:[],zones};
  const request=(plan({...input,groups:[{...group,live:true}]},1) as any[])[0].input.request;
  assertEquals(request.zones,[{position:[1,3]},{position:[1]}]);
  const output=finish(input,[]) as any;
  assertEquals(output.zone_chance.map((row:any)=>[row.team_id,row.percent,row.color,row.position]),[
    ["t1",100,"#8a2be2",0],["t1",100,"#aabbcc",1],
    ["t2",0,"#8a2be2",0],["t2",0,"#aabbcc",1],
    ["t3",100,"#8a2be2",0],["t3",0,"#aabbcc",1],
  ]);
});
