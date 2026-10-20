import {describe,it,expect} from 'vitest';
import {placeTrainLabel,placeTrainWindows,trainWindowWidth,leaderCrosses,leaderHits,type Rect,type Leader} from '../src/ui/labels';
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
