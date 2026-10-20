import {describe,it,expect} from 'vitest';
import {Geometry} from '../src/ui/geometry';
import type {Topology} from '../src/sim/topology';
import {buildTopology} from '../src/sim/topology';
import {lineWindow,stationWindow} from '../src/ui/geometry';
import {LINE_INFO} from '../src/data/line2';

const length=(segments:ReturnType<Geometry['trainBody']>)=>segments.reduce((n,s)=>n+Math.hypot(s.x2-s.x1,s.y2-s.y1),0);
function geometry() {
  const g=Object.create(Geometry.prototype) as Geometry;
  Object.defineProperty(g,'topo',{value:{
    nodes:[{kind:'end',links:[0]},{kind:'switch',sw:0,toe:0,normal:1,reverse:3,links:[0,1,3]},{kind:'joint',links:[1,2]},{kind:'end',links:[2]},{kind:'end',links:[3]}],
    links:[{a:0,b:1,len:1000,chainA:0,chainB:1000,section:0},{a:1,b:2,len:20,chainA:1000,chainB:1020,section:1},
      {a:2,b:3,len:500,chainA:1020,chainB:1520,section:2},{a:1,b:4,len:50,section:3}],berths:[],platforms:[],
  } as unknown as Topology});
  g.pos=[{row:0,x:0,y:0},{row:0,x:100,y:0},{row:0,x:120,y:20},{row:0,x:180,y:20},{row:0,x:80,y:-30}];
  return g;
}
describe('fixed train symbols with independent occupancy',()=>{
  it('gives every full-train berth room and every platform the same width',()=>{
    const topo=buildTopology();
    for(const detail of [false,true]) for(const window of detail?topo.stations.map(s=>stationWindow(topo,s.index)):[lineWindow(topo)]) {
      const g=new Geometry(topo,{chainFrom:window[0],chainTo:window[1],rows:detail?1:3,width:3200,marginL:50,marginR:50,rowH:560,top:50,upY:200,midY:245,dnY:290,depotDy:{q:30,z:60,j1:90,j2:120,gate:150},detail});
      for(const berth of topo.berths.filter(b=>b.kind!=='depot')) {
        const segs=g.linkSegs(berth.link);
        if(!segs.length)continue;
        const drawn=segs.reduce((n,s)=>n+Math.hypot(s.x2-s.x1,s.y2-s.y1),0);
        expect(drawn,berth.name).toBeGreaterThanOrEqual(g.platformTrainLength());
      }
      for(const _ of topo.platforms) expect(g.platformWidth()).toBe(72);
      for(const berth of topo.berths.filter(b=>b.kind==='platform')) {
        if(!g.pos[topo.links[berth.link].a]||!g.pos[topo.links[berth.link].b])continue;
        const link=topo.links[berth.link];
        const from=(link.len-LINE_INFO.platformLength)/2,to=(link.len+LINE_INFO.platformLength)/2;
        const points=[0,from,link.len/2,to,link.len].map(off=>g.linkPoint(link.id,off)!);
        const sign=Math.sign(g.pos[link.b]!.x-g.pos[link.a]!.x);
        for(let i=1;i<points.length;i++) expect((points[i].x-points[i-1].x)*sign).toBeGreaterThanOrEqual(0);
        expect(points[0]).toEqual(g.pos[link.a]);
        expect(points.at(-1)).toEqual(g.pos[link.b]);
        const tr={link:berth.link,off:berth.offset,dir:berth.dir,body:[berth.link,berth.offset-(berth.dir===1?LINE_INFO.trainLength:0),berth.offset+(berth.dir===-1?LINE_INFO.trainLength:0)],v:0};
        const segs=g.trainBody(tr);
        expect((segs[0].x1+segs.at(-1)!.x2)/2,berth.name).toBeCloseTo(g.stationX(berth.station).x,5);
        expect(length(segs),berth.name).toBeCloseTo(g.platformTrainLength(),5);
        const head=g.trainHeadPoint(tr)!;
        expect(head.x,berth.name).toBeCloseTo(segs[0].x1,5);
        const movingTrain={...tr,v:1};
        const moving=g.trainBody(movingTrain);
        expect(moving).toEqual(segs);
        expect(tr.off).toBe(berth.offset);
        // Manual stops retain real under/overrun; standing never snaps the
        // body to a different drawing coordinate than the moving approach.
        for(const delta of [-5,5]) {
          const manual={...tr,off:berth.offset+delta,body:[tr.link,tr.body[1]+delta,tr.body[2]+delta]};
          const stopped=g.trainBody(manual);
          const movingManual={...manual,v:1};
          expect(stopped).toEqual(g.trainBody(movingManual));
          expect(stopped[0].x1).not.toBeCloseTo(segs[0].x1,5);
          expect(manual.off).toBe(berth.offset+delta);
        }
      }
    }
  });
  it('keeps one symbol length in differently compressed intervals, in both directions',()=>{
    const g=geometry();
    for(const meters of [1000,2000,10000]) for(const dir of [1,-1] as const) {
      g.topo.links[0].len=meters;
      const off=(dir===1?.8:.2)*meters;
      const tr={link:0,off,dir,body:[0,off-(dir===1?186:0),off+(dir===-1?186:0)]};
      const segments=g.trainBody(tr);
      expect(length(segments)).toBeCloseTo(g.platformTrainLength());
      expect(segments[0].x1).toBeCloseTo(g.trainHeadPoint(tr)!.x);
      expect(tr.off).toBe(off);
    }
  });
  it('keeps its length while following a bent switch and the actual body path',()=>{
    const g=geometry();
    const tr={link:2,off:5,dir:1 as const,body:[2,0,5,1,0,20,0,900,1000]};
    const segments=g.trainBody(tr,()=>'R');
    expect(length(segments)).toBeCloseTo(g.platformTrainLength());
    expect(segments).toHaveLength(3);
    for(let i=1;i<segments.length;i++) {
      expect(segments[i].x1).toBeCloseTo(segments[i-1].x2);
      expect(segments[i].y1).toBeCloseTo(segments[i-1].y2);
    }
    expect(segments.every(s=>s.y1>=0&&s.y2>=0)).toBe(true);
    expect(tr.body).toEqual([2,0,5,1,0,20,0,900,1000]);
  });
  it('does not change the symbol or head when a train comes to a stop',()=>{
    const g=geometry();
    const tr={link:0,off:800,dir:1 as const,body:[0,614,800],v:0};
    const segments=g.trainBody(tr);
    expect(segments[0].x1).toBeCloseTo(g.trainHeadPoint(tr)!.x);
    expect(length(segments)).toBeCloseTo(g.platformTrainLength());
    const moving={...tr,v:1};
    expect(g.trainBody(moving)).toEqual(segments);
    expect(tr.off).toBe(800);
  });
  it('preserves physical occupancy even when the symbolic tail extends onto a switch leg',()=>{
    const g=geometry();
    const tr={link:0,off:950,dir:-1 as const,body:[0,950,1000]};
    const original=tr.body.slice();
    for(const position of ['N','R'] as const) {
      const segments=g.trainBody(tr,()=>position);
      expect(length(segments)).toBeCloseTo(g.platformTrainLength());
      expect(segments.some(s=>s.section!==0)).toBe(true);
      expect(tr.body).toEqual(original);
      expect(tr.body.filter((_,i)=>i%3===0)).toEqual([0]);
    }
  });
  it('orients each body link by connectivity rather than copying the head direction',()=>{
    const g=geometry();
    Object.assign(g.topo.links[1],{a:2,b:1});
    const segments=g.trainBody({link:2,off:5,dir:1,body:[2,0,5,1,0,20,0,900,1000]});
    expect(length(segments)).toBeCloseTo(g.platformTrainLength());
    for(let i=1;i<segments.length;i++) {
      expect(segments[i].x1).toBeCloseTo(segments[i-1].x2);
      expect(segments[i].y1).toBeCloseTo(segments[i-1].y2);
    }
  });
  it('uses the same symbol length on real depot transfer links and platforms',()=>{
    const topo=buildTopology(),window=lineWindow(topo);
    const g=new Geometry(topo,{chainFrom:window[0],chainTo:window[1],rows:3,width:3200,marginL:50,marginR:50,rowH:560,top:50,upY:200,midY:245,dnY:290,depotDy:{q:30,z:60,j1:90,j2:120,gate:150},detail:false});
    let checked=0;
    for(const depot of topo.depots) for(const path of depot.transferPaths) for(const link of path.links) {
      const l=topo.links[link];
      if(l.len<186||!g.linkSegs(link).length)continue;
      for(const dir of [1,-1] as const) {
        const tr={link,off:dir===1?l.len:0,dir,body:[link,dir===1?l.len-186:0,dir===1?l.len:186]};
        expect(length(g.trainBody(tr))).toBeCloseTo(g.platformTrainLength());
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
  it('follows the real Guanglan middle-to-UP crossover with its grey occupied tail',()=>{
    const topo=buildTopology(),st=topo.stations.find(s=>s.id==='GLL')!;
    const middle=topo.berths[st.turnbackBerths.find(b=>topo.berths[b].kind==='platform')!].link,ml=topo.links[middle];
    const route=topo.routes.find(r=>{
      const first=topo.links[r.steps[0]?.link];
      return first&&first.id!==middle&&[ml.a,ml.b].some(n=>n===first.a||n===first.b)&&r.steps.some(s=>topo.links[s.link].track==='UP');
    })!;
    const enter=route.steps[0].dir===1?topo.links[route.steps[0].link].a:topo.links[route.steps[0].link].b;
    const steps=[{link:middle,dir:(ml.b===enter?1:-1) as 1|-1},...route.steps.slice(0,route.steps.findIndex(s=>topo.links[s.link].track==='UP')+1)];
    const last=steps.at(-1)!,link=topo.links[last.link],advance=Math.min(20,link.len/2),off=last.dir===1?advance:link.len-advance;
    const body:number[]=[];let remaining=LINE_INFO.trainLength;
    for(let i=steps.length-1;i>=0&&remaining>0;i--) {
      const s=steps[i],l=topo.links[s.link],head=i===steps.length-1?off:s.dir===1?l.len:0,take=Math.min(remaining,s.dir===1?head:l.len-head);
      body.push(s.link,s.dir===1?head-take:head,s.dir===1?head:head+take);remaining-=take;
    }
    expect(remaining).toBe(0);
    for(const detail of [false,true]) {
      const window=detail?stationWindow(topo,st.index):lineWindow(topo);
      const g=new Geometry(topo,{chainFrom:window[0],chainTo:window[1],rows:detail?1:3,width:3200,marginL:50,marginR:50,rowH:560,top:50,upY:200,midY:245,dnY:290,depotDy:{q:30,z:60,j1:90,j2:120,gate:150},detail});
      const tr={link:link.id,off,dir:last.dir,body},occupied=g.trainOccupiedPath(tr),covered=new Set(body.filter((_,i)=>i%3===0));
      expect(occupied.some(s=>s.link===middle)).toBe(true);
      expect(occupied.every(s=>covered.has(s.link))).toBe(true);
      for(let i=1;i<occupied.length;i++) {
        expect(occupied[i].x1).toBeCloseTo(occupied[i-1].x2);
        expect(occupied[i].y1).toBeCloseTo(occupied[i-1].y2);
      }
      const sections=new Set([...covered].map(l=>topo.links[l].section));
      const symbol=g.trainBody(tr,sw=>route.switches.find(s=>s.sw===sw)?.pos??'N');
      expect(symbol.every(s=>sections.has(s.section))).toBe(true);
      expect(length(symbol)).toBeCloseTo(g.platformTrainLength());
    }
  });
  it('shows a positive monotonically increasing real gap in the grey occupancy for either direction',()=>{
    const g=geometry();
    for(const dir of [1,-1] as const) {
      let previous=0;
      for(const gap of [.3,1,5,20,50,100,200,400]) {
        const head=dir===1?800:100,tail=head-dir*186,rear=tail-dir*gap;
        const front=g.trainOccupiedPath({dir,body:[0,Math.min(head,tail),Math.max(head,tail)]});
        const behind=g.trainOccupiedPath({dir,body:[0,Math.min(rear,rear-dir*186),Math.max(rear,rear-dir*186)]});
        const drawn=(front.at(-1)!.x2-behind[0].x1)*dir;
        expect(drawn).toBeGreaterThan(previous);
        expect(drawn).toBeCloseTo(gap/10);
        previous=drawn;
      }
    }
  });
});
