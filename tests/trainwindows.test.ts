import {describe,it,expect} from 'vitest';
import {placeTrainLabel,placeTrainWindows,trainWindowWidth,leaderCrosses,leaderHits,trainGroupText,lateText,type Rect,type Leader} from '../src/ui/labels';
describe('train window placement',()=>{
 it.each([-1,1] as const)('keeps twelve queued trains and their overflow group inside the same bounded band (side %s)',side=>{
  const band={x:20,y:side===1?420:270,w:1000,h:88};
  const inputs=Array.from({length:12},(_,id)=>({id,head:{x:500+id*2,y:400},side,width:230,delay:id*60}));
  const result=placeTrainWindows(inputs,band,[{x:0,y:530,w:1100,h:50}]);
  expect(result.flatMap(p=>p.ids).sort((a,b)=>a-b)).toEqual(inputs.map(t=>t.id));
  expect(result.some(p=>p.text&&p.ids.length>1)).toBe(true);
  expect(result.some(p=>!p.text&&p.ids.length===1)).toBe(true);
  for(const [i,p] of result.entries()) {
   expect(p.r.x).toBeGreaterThanOrEqual(band.x);expect(p.r.x+p.r.w).toBeLessThanOrEqual(band.x+band.w);
   expect(p.r.y).toBeGreaterThanOrEqual(band.y);expect(p.r.y+p.r.h).toBeLessThanOrEqual(band.y+band.h);
   for(const o of result.slice(0,i)) expect(p.r.x>=o.r.x+o.r.w||p.r.x+p.r.w<=o.r.x||p.r.y>=o.r.y+o.r.h||p.r.y+p.r.h<=o.r.y).toBe(true);
   if(p.text) expect(p.text).toContain(`${Math.max(...p.ids.map(id=>id))}分`);
  }
 });
 it('folds only normal trains, and an on-time group carries no lateness',()=>{
  const band={x:20,y:420,w:700,h:44};
  // a peak queue running 10–110 s behind: on time by the legend (≤2 min)
  const inputs=Array.from({length:10},(_,id)=>({id,head:{x:300+id*30,y:400},side:1 as const,width:110,delay:10+id*10,keep:id===7||id===9}));
  const result=placeTrainWindows(inputs,band,[]);
  const group=result.find(p=>p.text)!;
  expect(group).toBeDefined();
  expect(group.text).toBe(`+${group.ids.length} 列`);
  expect(group.ids).not.toContain(7);
  expect(group.ids).not.toContain(9);
  expect(trainGroupText(3,121)).toBe('+3 列 · 最晚 2分');
  expect(lateText(120)).toBe('');
  expect(lateText(179)).toBe("+2'");
 });
 it('folds each crowded spot on its own next to its trains; a crowded spot goes compact first, the rest stays full',()=>{
  const band={x:0,y:420,w:2000,h:44};
  const queue=(x0:number,id0:number)=>Array.from({length:5},(_,i)=>({id:id0+i,head:{x:x0+i*20,y:400},side:1 as const,width:120,compactWidth:70,delay:0}));
  const inputs=[...queue(300,0),...queue(1500,10)];
  const groups=placeTrainWindows(inputs,band,[]).filter(p=>p.text);
  expect(groups.length).toBe(2);
  for(const g of groups) {
   const xs=g.ids.map(id=>inputs.find(t=>t.id===id)!.head.x);
   expect(Math.max(...xs)-Math.min(...xs)).toBeLessThan(200);
   expect(Math.abs(g.r.x+g.r.w/2-xs.reduce((a,b)=>a+b)/xs.length)).toBeLessThan(250);
  }
  // trains that collide only at full width all fit once their spot is compact;
  // a lone train far away keeps its full window
  const spread=[...Array.from({length:8},(_,id)=>({id,head:{x:100+id*100,y:400},side:1 as const,width:120,compactWidth:70,delay:0,keep:id===3})),
   {id:20,head:{x:1700,y:400},side:1 as const,width:120,compactWidth:70,delay:0}];
  const withoutCompact=placeTrainWindows(spread.map(({compactWidth,...t})=>t),band,[]),result=placeTrainWindows(spread,band,[]);
  expect(withoutCompact.some(p=>p.text)).toBe(true);
  expect(result.some(p=>p.text)).toBe(false);
  expect(result.find(p=>p.ids[0]===3)!.compact).toBeFalsy();
  expect(result.find(p=>p.ids[0]===20)!.compact).toBeFalsy();
  expect(result.some(p=>p.compact)).toBe(true);
 });
 it('a queue on one spot of mostly late trains keeps some windows beside its group',()=>{
  const band={x:20,y:420,w:1000,h:88};
  const inputs=Array.from({length:12},(_,id)=>({id,head:{x:500+id*2,y:400},side:1 as const,width:230,compactWidth:140,delay:id*60,keep:id*60>120}));
  const result=placeTrainWindows(inputs,band,[]);
  expect(result.flatMap(p=>p.ids).sort((a,b)=>a-b)).toEqual(inputs.map(t=>t.id));
  expect(result.filter(p=>!p.text).length).toBeGreaterThan(0);
 });
 it('a fold of one train names its trip, never "+1 列"',()=>{
  // two trains side by side in a narrow band: one window and one more box fit
  const band={x:0,y:420,w:330,h:44};
  const inputs=[0,1].map(id=>({id,head:{x:160+id*4,y:400},side:1 as const,width:150,compactWidth:120,delay:id?200:0,trip:`401${id}`}));
  const result=placeTrainWindows(inputs,band,[]);
  expect(result.flatMap(p=>p.ids).sort()).toEqual([0,1]);
  for(const p of result.filter(p=>p.text&&p.ids.length===1)) expect(p.text).toBe(`401${p.ids[0]}${p.ids[0]?"+3'":''}`);
  expect(result.some(p=>p.text==='+1 列')).toBe(false);
 });
 it('stacks crowded windows locally with clear leaders and measured text',()=>{
  const placed:{r:Rect;leader:Leader}[]=[];
  const inputs=[[600,174,48],[650,210,0],[710,192,48],[770,174,0],[830,192,0]];
  for(const [i,[x,text,chips]] of inputs.entries()) {
   const width=trainWindowWidth(text,chips);
   const p=placeTrainLabel({x,y:400},1,width,placed,[],12,inputs.slice(i+1).map(([x])=>({x,y:400})));
   expect(p).not.toBeNull();
   expect(Math.abs(p!.r.x+width/2-x)).toBeLessThanOrEqual(width);
   expect(width-28).toBeGreaterThanOrEqual(text+chips);
   for(const o of placed) {
    expect(leaderCrosses(p!.leader,o.leader)).toBe(false);
    expect(leaderHits(p!.leader,o.r)).toBe(false);
    expect(leaderHits(o.leader,p!.r)).toBe(false);
   }
   placed.push(p!);
  }
 });
 it('places the first window directly above or below the head and lets tracks yield',()=>{
  for(const side of [-1,1] as const) {
   const p=placeTrainLabel({x:200,y:300},side,180,[],[{x:0,y:0,w:1000,h:1000}])!;
   expect(p.r.x+p.r.w/2).toBe(200);
   expect(p.leader.x1).toBe(p.leader.x2);
   expect(Math.abs(p.leader.y2-p.leader.y1)).toBe(14);
  }
 });
});
