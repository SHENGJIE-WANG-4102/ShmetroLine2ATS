/** Two operating days with repeatable weather/return pressure.
 * npx tsx scripts/stress-day2.ts <fault 0-3> <seed> <wind 1-4> <return minutes>
 * [--return-depot key|index] [--return-dir UP|DN] [--day-type weekday|weekend]
 * [--date YYYY-MM-DD] [--out directory] [--cache directory]
 * Output is diagnostic JSON plus a compact result/first wait chain. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Sim } from "../src/sim/engine";
import type { Command, SimConfig } from "../src/sim/model";
import { nextOperatingConfig, standsAt } from "../src/sim/operatingDay";
import { stationsAhead } from "../src/sim/ats";
import { ahead, travelDirection } from "../src/sim/topology";
import { overnightPlaces, hotStandbyPlaces } from "../src/sim/timetable";
import { capture, restore, type Checkpoint } from "../src/sim/state";
import {
  exportDiagnostics,
  stringifyDiagnostics,
} from "../src/sim/diagnostics";

export const DAY_END = 27.75 * 3600;
export const clockLabel = (t: number) => {
  const n = Math.round(t * 10);
  return `${String(Math.floor(n / 36000)).padStart(2, "0")}:${String(Math.floor((n % 36000) / 600)).padStart(2, "0")}:${((n % 600) / 10).toFixed(1).padStart(4, "0")}`;
};
export function options(args: string[]) {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++)
    if (args[i].startsWith("--")) map.set(args[i].slice(2), args[++i] ?? "");
  return map;
}
export function modelHash() {
  const hash = createHash("sha256");
  for (const dir of ["src/sim", "src/data"])
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .sort()) {
      hash.update(`${dir}/${f}\n`);
      hash.update(readFileSync(join(dir, f)));
    }
  return hash.digest("hex").slice(0, 16);
}
export function fleetNumbers(sim: Sim) {
  return [
    ...sim.yards.flatMap((y) => y.tracks.flat()),
    ...sim.stabledPool,
    ...sim.trainList.flatMap((t) => [
      t.vehicle,
      ...(t.coupledVehicle ? [t.coupledVehicle] : []),
    ]),
    ...[...sim.vehicles].filter(([, r]) => r.work).map(([no]) => no),
  ].sort();
}
export function waitChains(sim: Sim, ids?: number[]) {
  const starts = ids?.length
    ? ids
    : sim.trainList
        .filter((t) => t.v < 0.05 && t.phase !== "stabled" && t.tasks.length)
        .map((t) => t.id);
  return starts.map((id) => {
    const seen = new Set<number>(),
      chain: unknown[] = [];
    let tr = sim.trains.get(id);
    while (tr && !seen.has(tr.id)) {
      seen.add(tr.id);
      chain.push({
        id: tr.id,
        vehicle: tr.vehicle,
        service: `${tr.svc}-${tr.tripNo}`,
        section: sim.topo.sections[sim.topo.links[tr.link].section].name,
        v: tr.v,
        ma: tr.maDist,
        stop: tr.stopDist,
        halt: tr.halt,
        ars: tr.arsWait,
        task: tr.tasks.slice(0, 3),
        signal: tr.nextSignal < 0 ? null : sim.topo.signals[tr.nextSignal].name,
      });
      const next =
        tr.halt.train >= 0 ? tr.halt.train : (tr.arsWait?.train ?? -1);
      tr = sim.trains.get(next);
    }
    return chain;
  });
}
export function numericProblem(sim: Sim): string | null {
  for (const t of sim.trainList) {
    // lastTraceCh is explicitly NaN until the first trace sample: an
    // unmeasured cache marker, not a train/authority numerical value.
    if (
      Object.entries(t).some(
        ([key, value]) =>
          key !== "lastTraceCh" &&
          typeof value === "number" &&
          Number.isNaN(value),
      )
    )
      return `NAN train ${t.id}`;
    for (const key of ["off", "v", "a", "len", "load", "delay"] as const)
      if (!Number.isFinite(t[key]))
        return `NONFINITE train ${t.id}.${key}=${t[key]}`;
    for (const key of ["maDist", "stopDist", "vPermit", "vTarget"] as const)
      if (Number.isNaN(t[key])) return `NAN train ${t.id}.${key}`;
    if (t.load < 0 || t.v < 0 || t.len <= 0) return `NEGATIVE train ${t.id}`;
    if (t.body.some((b) => !Number.isFinite(b.from) || !Number.isFinite(b.to)))
      return `NONFINITE body ${t.id}`;
  }
  for (const [d, y] of sim.yards.entries())
    if (sim.depotStock[d] !== y.tracks.flat().length) return `YARD_COUNT ${d}`;
  if (
    sim.depotStock.some((n) => !Number.isFinite(n) || n < 0) ||
    sim.sw.some((s) => !Number.isFinite(s.lockCount) || s.lockCount < 0)
  )
    return "NEGATIVE_OR_NONFINITE_COUNT";
  for (const key of [
    "passengersServed",
    "passengersCleared",
    "passengersStranded",
    "depTotal",
    "depOnTime",
    "tripsDone",
  ] as const)
    if (!Number.isFinite(sim[key]) || sim[key] < 0)
      return `INVALID_COUNT ${key}`;
  for (const object of [sim.env, ...sim.sw, ...sim.plat])
    if (
      Object.values(object).some(
        (value) => typeof value === "number" && Number.isNaN(value),
      )
    )
      return "NAN equipment/environment";
  if (sim.plat.some((p) => !Number.isFinite(p.waiting) || p.waiting < 0))
    return "PLATFORM_COUNT";
  const cars = fleetNumbers(sim);
  if (new Set(cars).size !== cars.length) return "DUPLICATE_VEHICLE";
  return null;
}
export function overnightProblem(sim: Sim): string | null {
  const places = [
    ...new Set([
      ...overnightPlaces(sim.topo).flatMap((p) => [p.berth, p.arrivalBerth]),
      ...hotStandbyPlaces(sim.topo).map((p) => p.berth),
      ...sim.topo.stations.flatMap((s) => s.storageBerths),
    ]),
  ];
  const bad = sim.trainList.filter(
    (t) =>
      t.v >= 0.05 || t.tasks.length || !places.some((p) => standsAt(sim, t, p)),
  );
  return bad.length
    ? `UNFINISHED_OVERNIGHT ${bad.map((t) => `${t.id}/${t.vehicle}/${t.svc}-${t.tripNo}`).join(",")}`
    : null;
}
export function rolloverContinuous(sim: Sim) {
  const before = fleetNumbers(sim),
    active = sim.trainList
      .filter((t) => t.tasks.length && t.phase !== "stabled")
      .map((t) => ({
        id: t.id,
        vehicle: t.vehicle,
        link: t.link,
        off: t.off,
        dir: t.dir,
      }));
  const next = new Sim(nextOperatingConfig(sim), sim);
  if (JSON.stringify(fleetNumbers(next)) !== JSON.stringify(before))
    throw Error("ROLLOVER_FLEET: vehicle numbers lost, duplicated or added");
  for (const t of active) {
    const n = next.trains.get(t.id);
    if (
      !n ||
      n.vehicle !== t.vehicle ||
      n.link !== t.link ||
      n.dir !== t.dir ||
      Math.abs(n.off - t.off) > 0.001
    )
      throw Error(`ROLLOVER_TRAIN ${t.id}`);
  }
  const problem = numericProblem(next);
  if (problem) throw Error(problem);
  return {
    sim: next,
    carried: active.map((t) => ({
      id: t.id,
      vehicle: t.vehicle,
      block: next.trains.get(t.id)!.block,
    })),
  };
}
export function saveFailure(
  sim: Sim,
  out: string,
  tag: string,
  day: number,
  type: string,
  error?: unknown,
) {
  mkdirSync(out, { recursive: true });
  const v = sim.integrity.violations[0],
    diagnostic = join(out, `${tag}-day${day}.json`);
  const numericTrain = /\b(?:train|body) (\d+)/.exec(type);
  const trains = v?.trains ?? (numericTrain ? [Number(numericTrain[1])] : []);
  const bundle = { ...exportDiagnostics(sim), stressFailure: { day, type } };
  writeFileSync(diagnostic, stringifyDiagnostics(bundle));
  const result = {
    tag,
    status: "fail",
    day,
    t: sim.t,
    clock: clockLabel(sim.t),
    type,
    detail: v?.detail ?? String(error ?? type),
    trains,
    chains: waitChains(sim, trains),
    diagnostic,
    exception: error instanceof Error ? error.stack : undefined,
    model: modelHash(),
  };
  console.log(JSON.stringify(result));
  return result;
}
export interface StressOptions {
  level: number;
  seed: number;
  wind: number;
  every: number;
  dayType: SimConfig["dayType"];
  date: string;
  out: string;
  cache?: string;
  returnDepot?: string;
  returnDir: "DN" | "UP";
}
export function runStress(o: StressOptions) {
  const tag = `d2w-${o.level}-${o.seed}-${o.wind}-${o.every}-${o.dayType}`,
    started = Date.now(),
    hash = modelHash();
  mkdirSync(o.out, { recursive: true });
  let sim = new Sim({
    dayType: o.dayType,
    date: o.date,
    dateLabel: "跨日压测",
    startTime: 14400,
    seed: o.seed,
    autoDispatch: true,
    autoRadio: true,
  });
  let day = 1,
    lastSecond = -1;
  const commands: {
    day: number;
    t: number;
    cmd: Command;
    ok: boolean;
    msg: string;
  }[] = [];
  const command = (cmd: Command) => {
    const r = sim.command(cmd);
    commands.push({ day, t: sim.t, cmd, ...r });
    return r;
  };
  const check = () => {
    const v = sim.integrity.violations[0];
    if (v) throw Error(v.kind);
    const second = Math.floor(sim.t);
    if (second !== lastSecond) {
      lastSecond = second;
      const p = numericProblem(sim);
      if (p) throw Error(p);
    }
  };
  const finish = (result: { status: string; [key: string]: unknown }) => {
    writeFileSync(
      join(o.out, `${tag}-result.json`),
      JSON.stringify(
        {
          ...result,
          options: o,
          seconds: (Date.now() - started) / 1000,
          commands,
          model: hash,
        },
        null,
        2,
      ),
    );
    return result;
  };
  try {
    const key = `${hash}-${o.dayType}-${o.date}-${o.level}-${o.seed}`,
      file = o.cache ? join(o.cache, `${key}.bin`) : undefined;
    if (file && existsSync(file))
      restore(sim, deserialize(readFileSync(file)) as Checkpoint);
    else {
      if (o.level) command({ c: "randomFaults", level: o.level });
      while (sim.t < DAY_END) {
        sim.step();
        check();
      }
      if (file) {
        mkdirSync(o.cache!, { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, serialize(capture(sim)));
        renameSync(temporary, file);
      }
    }
    const transition = rolloverContinuous(sim);
    sim = transition.sim;
    day = 2;
    const depot =
      o.returnDepot === undefined
        ? sim.topo.depots.find(
            (d) =>
              d.transferPaths.some((p) => p.flow === "in") &&
              d.transferPaths.some((p) => p.flow === "out"),
          )
        : sim.topo.depots.find(
            (d) => d.key === o.returnDepot || String(d.id) === o.returnDepot,
          );
    if (o.every && !depot) throw Error("No matching return depot");
    const weather = [
      [7 * 3600, 5 * 3600],
      [15 * 3600, 4 * 3600],
    ];
    let w = 0,
      due = 6.5 * 3600;
    while (sim.t < 24 * 3600) {
      sim.step();
      check();
      if (w < weather.length && sim.t >= weather[w][0]) {
        command({
          c: "env",
          wind: o.wind,
          rain: true,
          duration: weather[w][1],
        });
        w++;
      }
      if (o.every && sim.t >= due && sim.t < 21 * 3600) {
        const tr = sim.trainList.find((t) => {
          if (
            !t.inService ||
            t.withdrawn ||
            t.failed ||
            t.phase !== "run" ||
            travelDirection(sim.topo, t) !== o.returnDir
          )
            return false;
          const stations = stationsAhead(sim, t);
          return (
            stations[0] === depot!.station &&
            stations[1] !== undefined &&
            ahead(o.returnDir, stations[0], stations[1])
          );
        });
        if (tr) {
          command({
            c: "withdraw",
            train: tr.id,
            reason: "跨日压测指定方向回段",
          });
          due += o.every * 60;
        }
      }
      check();
    }
    if (modelHash() !== hash) throw Error("Source changed during run");
    const result = {
      tag,
      status: "pass",
      day: 2,
      t: sim.t,
      violations: 0,
      cars: fleetNumbers(sim).length,
      tripsDone: sim.tripsDone,
    };
    console.log(JSON.stringify(result));
    return finish(result);
  } catch (error) {
    return finish(
      saveFailure(
        sim,
        o.out,
        tag,
        day,
        sim.integrity.violations[0]?.kind ??
          String(error instanceof Error ? error.message : error),
        error,
      ),
    );
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2),
    opts = options(args),
    level = Number(args[0]),
    seed = Number(args[1]),
    wind = Number(args[2]),
    every = Number(args[3] ?? 0),
    dayType = opts.get("day-type") ?? "weekday",
    returnDir = opts.get("return-dir") ?? "UP";
  if (
    ![0, 1, 2, 3].includes(level) ||
    !Number.isInteger(seed) ||
    ![1, 2, 3, 4].includes(wind) ||
    !Number.isFinite(every) ||
    every < 0 ||
    !["weekday", "weekend"].includes(dayType) ||
    !["DN", "UP"].includes(returnDir)
  )
    throw Error(
      "Usage: stress-day2 <fault 0-3> <seed> <wind 1-4> <return minutes> [--return-depot key|index --return-dir UP|DN --day-type weekday|weekend --out dir --cache dir]",
    );
  const out = opts.get("out") ?? "work/stress-day2";
  const result = runStress({
    level,
    seed,
    wind,
    every,
    dayType: dayType as SimConfig["dayType"],
    date:
      opts.get("date") ?? (dayType === "weekend" ? "2026-10-24" : "2026-10-19"),
    out,
    cache: opts.get("cache") ?? join(out, "cache"),
    returnDepot: opts.get("return-depot"),
    returnDir: returnDir as "DN" | "UP",
  });
  process.exitCode = (result as { status: string }).status === "pass" ? 0 : 1;
}
