/** Seeded dispatcher fuzzing over two complete operating days.
 * One: npx tsx scripts/fuzz-day.ts 101 --level 2 --wind 3 --density 3:8 --day-type weekday --template ciie
 * Batch: npx tsx scripts/fuzz-day.ts --cases 60 --jobs 8 --out work/fuzz
 * Replays: npx tsx scripts/fuzz-day.ts --replay path/to/failure-day2.json
 * Coverage probes: --rescue-once true or --late-extra true (use a separate --out).
 * Every operator action goes through sim.command; refused commands are evidence, not exceptions. */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { Sim } from "../src/sim/engine";
import { unattended, OPERATIONS, WEATHER_RULES, supportsSignalSystem } from "../src/data/current";
import type { Command, Train, SimConfig, FaultKind } from "../src/sim/model";
import {
  stationsAhead,
  turnbackOptions,
  exchangePartner,
} from "../src/sim/ats";
import { rescuerFor } from "../src/sim/radio";
import { ahead } from "../src/sim/topology";
import { OVERLAY_PRESETS } from "../src/sim/timetable";
import { parseDiagnostics, replayDiagnostics } from "../src/sim/diagnostics";
import {
  DAY_END,
  options,
  clockLabel,
  modelHash,
  fleetNumbers,
  numericProblem,
  overnightProblem,
  rolloverContinuous,
  saveFailure,
} from "./stress-day2";

export interface FuzzOptions {
  seed: number;
  level: number;
  wind: number;
  density: [number, number];
  dayType: SimConfig["dayType"];
  date: string;
  template: string;
  out: string;
  lateExtra?: boolean;
  rescueOnce?: boolean;
}
interface Action {
  day: number;
  t: number;
  kind: string;
  cmd?: Command;
  ok?: boolean;
  msg?: string;
  cleanup?: boolean;
}
const BASE_KINDS = [
  "weather",
  "rain",
  "adhesion",
  "overlay",
  "addTrain",
  "standby",
  "exchangeDuty",
  "recoverService",
  "withdraw-interval",
  "withdraw-platform",
  "withdraw-turnback",
  "withdraw-depot",
  "manual-CM",
  "manual-RM",
  "manual-AUTO",
  "trainLevel",
  "lineAto",
  "trainDto",
  "trainHold",
  "trainSkip",
  "platformHold",
  "platformSkip",
  "turnback",
  "rescue",
  "setTsr",
  "sectionBlock",
  "switchBlock",
  "zoneLevel",
  "platformEsp",
  "psdBypass",
  "setRoute",
  "cancelRoute",
  "guideRoute",
  "autoPass",
  "ars",
  "randomFaults",
  "repair",
  "fault",
  "ack",
] as const;
const UTO_KINDS = ["uto-sequence", "uto-fault", "uto-reset"] as const;
type Kind = (typeof BASE_KINDS)[number] | (typeof UTO_KINDS)[number];
const LEGACY_FAULTS: FaultKind[] = ["signal", "switch", "axle", "psd", "trainComm", "trainDto", "traction", "door", "brake", "trainFail"];
/** Select actual line capabilities before sampling; keep the legacy world's order and draws. */
export function fuzzCapabilities() {
  const uto = unattended("doorClose");
  const kinds: Kind[] = [...BASE_KINDS];
  const notApplicable: string[] = [];
  const remove = (...excluded: Kind[]) => { for (const kind of excluded) { const i = kinds.indexOf(kind); if (i >= 0) kinds.splice(i, 1); } };
  if (!OVERLAY_PRESETS.length) { remove("overlay"); notApplicable.push("overlay: 本线路没有加开模板，仍抽样 addTrain"); }
  if (!supportsSignalSystem("TBTC")) { remove("trainLevel", "zoneLevel"); notApplicable.push("TBTC trainLevel/zoneLevel: 无后备能力；仍注入通信/区域故障"); }
  if (uto) { remove("lineAto", "trainDto"); kinds.push(...UTO_KINDS); notApplicable.push("lineAto/trainDto: 使用本线 UTO 接管、车载故障和远程复位"); }
  const wind = WEATHER_RULES.wind.map(rule => rule.level);
  if (!wind.length) notApplicable.push("大风等级: 未定义风限制；天气命令仍注入降雨并跨第二天");
  const faults = uto ? [...new Set([...OPERATIONS.randomFaults.kinds.map(rule => rule.kind), ...OPERATIONS.randomFaults.majorKinds])]
    .filter((kind): kind is FaultKind => ["signal", "switch", "axle", "psd", "psdLink", "trainComm", "trainUto", "traction", "door", "brake", "trainFail", "zcFail", "surge", "pecu", "trackPerson"].includes(kind)) : LEGACY_FAULTS;
  return { uto, kinds, wind, faults, notApplicable };
}
interface UtoCoverage {
  stages: string[]; modes: string[]; faults: number; faultAtpm: boolean; takeovers: number; restores: number; famRestored: number; resets: number; rejectedSteps: number;
}
interface DayCoverage { weather: boolean; randomCommands: number; uto?: UtoCoverage }

export function runFuzz(o: FuzzOptions) {
  const capabilities = fuzzCapabilities();
  const coverage: Record<number, DayCoverage> = {};
  const dayCoverage = (day: number) => coverage[day] ??= {weather: false, randomCommands: 0,
    ...(capabilities.uto ? {uto: {stages: [], modes: [], faults: 0, faultAtpm: false, takeovers: 0, restores: 0, famRestored: 0, resets: 0, rejectedSteps: 0}} : {})};
  const observedFaults = new Set<number>(), restoring = new Set<number>();
  let utoServiceStart = Infinity;
  let state = o.seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T | undefined =>
    xs.length ? xs[Math.floor(random() * xs.length)] : undefined;
  const between = (a: number, b: number) => a + random() * (b - a);
  const tag = `fuzz-${o.seed}-${o.level}-${o.wind}-${o.density.join("_")}-${o.dayType}-${o.template}${o.lateExtra ? "-late" : ""}${o.rescueOnce ? "-rescue" : ""}`,
    started = Date.now(),
    hash = modelHash();
  mkdirSync(o.out, { recursive: true });
  console.log(JSON.stringify({event: "fuzz-progress", tag, phase: "constructing-world", day: 1, t: 14400, clock: clockLabel(14400), wallSeconds: 0}));
  let sim = new Sim({
    dayType: o.dayType,
    date: o.date,
    dateLabel: "随机调度压测",
    startTime: 14400,
    seed: o.seed,
    autoDispatch: true,
    autoRadio: true,
  });
  const initialFleet = fleetNumbers(sim);
  let day = 1,
    lastSecond = -1,
    lastWithdraw = -Infinity,
    bag: Kind[] = [];
  const actions: Action[] = [],
    queue: { at: number; cmd: Command; remaining: number }[] = [];
  let progressDay = 0, progressBand = -1, progressAt = started, progressClock = 14400;
  const check = () => {
    const v = sim.integrity.violations[0];
    if (v) throw Error(v.kind);
    const second = Math.floor(sim.t);
    if (second === lastSecond) return;
    lastSecond = second;
    const band = Math.floor(sim.t / (6 * 3600));
    if (progressDay !== day || progressBand !== band) {
      const now = Date.now();
      console.log(JSON.stringify({event: "fuzz-progress", tag, phase: "stepping", day, t: sim.t, clock: clockLabel(sim.t),
        wallSeconds: (now - started) / 1000, stepWallSeconds: (now - progressAt) / 1000,
        advancedSeconds: progressDay === day ? sim.t - progressClock : 0, trains: sim.trainList.length}));
      progressDay = day; progressBand = band; progressAt = now; progressClock = sim.t;
    }
    const dc = dayCoverage(day);
    if (dc.uto) {
      for (const train of sim.trainList) {
        if (train.uto) {
          if (!dc.uto.stages.includes(train.uto.stage)) dc.uto.stages.push(train.uto.stage);
          if (train.uto.stage === "manual" && !dc.uto.modes.includes(train.mode)) dc.uto.modes.push(train.mode);
          if (train.uto.target === "DTO") restoring.add(train.id);
          if (train.uto.stage === "manual" && train.mode === "CM" && train.dtoInhibit === "车载全自动功能故障") dc.uto.faultAtpm = true;
        } else if (train.mode === "DTO" && restoring.delete(train.id)) dc.uto.famRestored++;
      }
      for (const fault of sim.faults) if (fault.kind === "trainUto" && fault.since >= 0 && !observedFaults.has(fault.id)) {
        observedFaults.add(fault.id); dc.uto.faults++;
      }
    }
    const numeric = numericProblem(sim);
    if (numeric) throw Error(numeric);
    if (JSON.stringify(fleetNumbers(sim)) !== JSON.stringify(initialFleet))
      throw Error("FLEET_CONSERVATION");
  };
  const command = (kind: string, cmd: Command, cleanup = false) => {
    const entry: Action = { day, t: sim.t, kind, cmd, cleanup };
    actions.push(entry);
    try {
      const r = sim.command(cmd);
      entry.ok = r.ok;
      entry.msg = r.msg;
      const dc = dayCoverage(day);
      if (r.ok && !cleanup && capabilities.kinds.includes(kind as Kind)) dc.randomCommands++;
      if (dc.uto) {
        if (r.ok && cmd.c === "manual") { if (cmd.mode === "AUTO") dc.uto.restores++; else dc.uto.takeovers++; }
        if (r.ok && cmd.c === "utoReset") dc.uto.resets++;
        if (!r.ok && cmd.c === "utoStep") dc.uto.rejectedSteps++;
      }
      check();
      return r.ok;
    } catch (error) {
      entry.msg = error instanceof Error ? error.stack : String(error);
      throw error;
    }
  };
  const later = (cmd: Command, seconds: number, remaining = 3) =>
    queue.push({ at: sim.t + seconds, cmd, remaining });
  const temporary = (
    kind: string,
    cmd: Command,
    undo: Command,
    seconds = between(30, 120),
  ) => {
    if (command(kind, cmd)) later(undo, seconds);
  };
  const ordinary = (t: Train) =>
    !t.failed &&
    !t.withdrawn &&
    !t.manual &&
    t.rescuing < 0 &&
    t.rescueBy < 0 &&
    t.inService &&
    ["run", "dwell", "reversing"].includes(t.phase);
  const location = (t: Train) => {
    const l = sim.topo.links[t.link];
    if (
      l.track === "DEP" ||
      sim.topo.depots.some((d) =>
        d.transferPaths.some((p) => p.stub === l.id || p.links.includes(l.id)),
      )
    )
      return "depot";
    if (
      t.tasks[0]?.k === "reverse" ||
      t.phase === "reversing" ||
      l.track === "SID" ||
      sim.topo.sections[l.section].kind === "tail"
    )
      return "turnback";
    return l.platform >= 0 ? "platform" : "interval";
  };
  function perform(kind: Kind) {
    const cars = sim.trainList.filter(ordinary),
      tr = pick(cars),
      platform = pick(sim.topo.platforms);
    const skip = () =>
      actions.push({
        day,
        t: sim.t,
        kind,
        msg: "当前无符合前提的目标，未下令",
      });
    if (kind === "weather") {
      command(kind, {
        c: "env",
        wind: capabilities.wind.length ? pick(capabilities.wind)! : 0,
        rain: random() < 0.65,
        duration: between(900, 5400),
      });
      return;
    }
    if (kind === "rain") {
      command(kind, { c: "env", rain: true, duration: between(900, 5400) });
      return;
    }
    if (kind === "adhesion") {
      temporary(
        kind,
        { c: "lowAdhesion", on: true },
        { c: "lowAdhesion", on: false },
        between(900, 3600),
      );
      return;
    }
    if (kind === "randomFaults") {
      command(kind, { c: "randomFaults", level: 1 + Math.floor(random() * 3) });
      return;
    }
    if (kind === "lineAto") {
      temporary(
        kind,
        { c: "lineAto", on: !sim.atoLine },
        { c: "lineAto", on: sim.atoLine },
        between(300, 1800),
      );
      return;
    }
    if (kind === "overlay") {
      const p = pick(OVERLAY_PRESETS);
      if (!p) return void skip();
      const from = sim.t + between(900, 1800),
        to = Math.min(24 * 3600, from + between(1800, 5400));
      if (from >= to) return void skip();
      command(kind, {
        c: "overlay",
        id: p.id,
        from,
        to,
        headway: pick([900, 1200, 1800])!,
      });
      return;
    }
    if (kind === "addTrain") {
      const depot = pick(sim.topo.depots)!,
        dir = pick(["DN", "UP"] as const)!,
        from = depot.portals.exit[dir].station;
      const to = pick(
        sim.topo.stations.filter((s) => ahead(dir, from, s.index)),
      )?.index;
      if (to === undefined || sim.t > 22.5 * 3600) return void skip();
      command(kind, {
        c: "addTrain",
        depot: depot.id,
        dir,
        to,
        time: sim.t + between(900, 1800),
      });
      return;
    }
    if (kind === "ack") {
      command(kind, {
        c: "ack",
        ids: [...sim.alarms.values()].filter((a) => !a.ack).map((a) => a.id),
      });
      return;
    }
    if (kind === "repair") {
      const f = pick(sim.faults.filter((f) => !f.repaired));
      if (!f) return void skip();
      command(kind, { c: "repair", fault: f.id });
      return;
    }
    if (kind === "fault") {
      if (sim.faults.filter((f) => !f.repaired).length >= 6) return void skip();
      const k = pick(capabilities.faults);
      if (!k) return void skip();
      const target =
        k === "signal"
          ? pick(sim.topo.signals)?.id
          : k === "switch"
            ? pick(sim.topo.switches)?.id
            : k === "axle"
              ? pick(sim.topo.sections)?.id
              : k === "psd" || k === "psdLink" || k === "trackPerson"
                ? platform?.id
                : k === "surge" ? platform?.station
                : k === "zcFail" ? pick(sim.topo.zones)?.id
                : tr?.id;
      if (
        target === undefined ||
        (["trainFail", "brake", "traction"].includes(k) &&
          sim.trainList.filter((t) => t.failed).length >= 2)
      )
        return void skip();
      command(kind, {
        c: "fault",
        kind: k,
        target,
        duration: between(120, 900),
        recoverable: random() < 0.8,
      });
      return;
    }
    if (kind === "rescue") {
      const candidates = sim.trainList
        .filter((t) => t.failed && t.rescueBy < 0)
        .map((f) => ({ f, r: rescuerFor(sim, f) }))
        .filter((x) => x.r);
      const pair = pick(candidates);
      if (!pair) return void skip();
      command(kind, { c: "rescue", failed: pair.f.id, rescuer: pair.r!.id });
      return;
    }
    if (kind === "setTsr") {
      const section = pick(
        sim.topo.sections.filter(
          (s) =>
            s.kind === "plain" && !sim.sec[s.id].occ && !sim.sec[s.id].blocked,
        ),
      );
      if (!section) return void skip();
      temporary(
        kind,
        { c: "setTsr", sections: [section.id], kmh: pick([25, 40, 45, 60])! },
        { c: "cancelTsr", sections: [section.id] },
        between(60, 240),
      );
      return;
    }
    if (kind === "sectionBlock") {
      const section = pick(
        sim.topo.sections.filter(
          (s) =>
            s.kind === "plain" &&
            !sim.sec[s.id].blocked &&
            !sim.sec[s.id].occ &&
            sim.sec[s.id].lockRoute < 0 &&
            sim.sec[s.id].poss < 0,
        ),
      );
      if (!section) return void skip();
      temporary(
        kind,
        { c: "sectionBlock", sections: [section.id], on: true },
        { c: "sectionBlock", sections: [section.id], on: false },
      );
      return;
    }
    if (kind === "switchBlock") {
      const sw = pick(
        sim.topo.switches.filter(
          (s) =>
            !sim.sw[s.id].blocked &&
            sim.sw[s.id].lockCount === 0 &&
            s.sections.every((id) => !sim.sec[id].occ),
        ),
      );
      if (!sw) return void skip();
      temporary(
        kind,
        { c: "switchBlock", sw: sw.id, on: true },
        { c: "switchBlock", sw: sw.id, on: false },
      );
      return;
    }
    if (kind === "zoneLevel") {
      const z = pick(sim.topo.zones)!;
      temporary(
        kind,
        { c: "zoneLevel", zones: [z.id], level: "TBTC" },
        { c: "zoneLevel", zones: [z.id], level: "CBTC" },
        between(120, 600),
      );
      return;
    }
    if (
      ["platformHold", "platformSkip", "platformEsp", "psdBypass"].includes(
        kind,
      )
    ) {
      if (!platform) return void skip();
      const c = kind as
        "platformHold" | "platformSkip" | "platformEsp" | "psdBypass";
      temporary(
        kind,
        { c, platform: platform.id, on: true },
        { c, platform: platform.id, on: false },
      );
      return;
    }
    if (
      ["setRoute", "cancelRoute", "guideRoute", "autoPass", "ars"].includes(
        kind,
      )
    ) {
      if (kind === "cancelRoute") {
        const ar = pick(
          [...sim.routes.values()].filter((a) => !a.entered && !a.manual),
        );
        if (!ar) return void skip();
        command(kind, {
          c: "cancelRoute",
          signal: sim.topo.routes[ar.route].start,
        });
        return;
      }
      const signal = pick(sim.topo.signals.filter((s) => s.routes.length))!;
      if (kind === "autoPass" || kind === "ars") {
        temporary(
          kind,
          { c: kind, signal: signal.id, on: false },
          { c: kind, signal: signal.id, on: true },
          between(30, 90),
        );
        return;
      }
      const route = pick(signal.routes)!;
      command(kind, { c: kind as "setRoute" | "guideRoute", route });
      // A manually held route is never left indefinitely across a conflicting move.
      later({ c: "cancelRoute", signal: signal.id }, between(30, 90));
      return;
    }
    if (kind.startsWith("withdraw-")) {
      if (
        sim.t - lastWithdraw < 1800 ||
        cars.length < 12 ||
        cars.length < sim.plan.fleetPeak * 0.65
      )
        return void skip();
      const target = pick(cars.filter((t) => location(t) === kind.slice(9)));
      if (!target) return void skip();
      if (
        command(kind, {
          c: "withdraw",
          train: target.id,
          reason: `随机压测：${location(target)}`,
        })
      )
        lastWithdraw = sim.t;
      return;
    }
    if (kind === "exchangeDuty") {
      const pair = pick(
        cars
          .map((t) => ({ t, other: exchangePartner(sim, t) }))
          .filter((p) => p.other),
      );
      if (pair)
        command(kind, {
          c: "exchangeDuty",
          train: pair.t.id,
          with: pair.other!.id,
        });
      else if (tr && cars.length > 1) {
        const other = pick(cars.filter((t) => t !== tr))!;
        command(kind, { c: "exchangeDuty", train: tr.id, with: other.id });
      } else skip();
      return;
    }
    if (kind === "uto-sequence") {
      const target = pick(cars.filter(t => t.v < .05 && !t.eb && t.comm && sim.zoneState[sim.topo.links[t.link].zone] === "CBTC" && !t.dtoInhibit && !t.uto));
      if (!target) return void skip();
      if (command(kind, {c: "manual", train: target.id, mode: "CM", computer: true})) {
        if (command("uto-guard-probe", {c: "utoStep", train: target.id, action: "key"})) throw Error("UTO_STEP_ORDER_ACCEPTED");
      }
      return;
    }
    if (kind === "uto-fault") {
      const target = pick(cars.filter(t => t.mode === "DTO" && !t.dtoInhibit && !t.uto));
      if (!target) return void skip();
      command(kind, {c: "fault", kind: "trainUto", target: target.id, duration: 0});
      return;
    }
    if (kind === "uto-reset") {
      const target = pick(sim.trainList.filter(t => t.dtoInhibit === "车载全自动功能故障" && t.uto?.stage === "manual" && t.v < .05 && !t.eb));
      if (!target) return void skip();
      command(kind, {c: "utoReset", train: target.id});
      return;
    }
    if (kind === "manual-AUTO") {
      const target = sim.trainList.find((t) => t.manual);
      if (target)
        command(kind, { c: "manual", train: target.id, mode: "AUTO", ...(unattended("doorClose") ? { computer: true } : {}) });
      else skip();
      return;
    }
    if (kind === "manual-CM" || kind === "manual-RM") {
      if (sim.trainList.some((t) => t.manual)) return void skip();
      const target = pick(
        cars.filter(
          (t) => t.v < 0.05 && !t.eb && ["run", "dwell"].includes(t.phase),
        ),
      );
      if (!target) return void skip();
      temporary(
        kind,
        {
          c: "manual",
          train: target.id,
          mode: kind === "manual-CM" ? "CM" : "RM",
          ...(unattended("doorClose") ? { computer: true } : {}),
        },
        { c: "manual", train: target.id, mode: "AUTO", ...(unattended("doorClose") ? { computer: true } : {}) },
        between(10, 30),
      );
      return;
    }
    if (!tr) return void skip();
    if (kind === "trainLevel") {
      temporary(
        kind,
        { c: "trainLevel", train: tr.id, level: "TBTC" },
        { c: "trainLevel", train: tr.id, level: "AUTO" },
        between(120, 600),
      );
      return;
    }
    if (kind === "trainDto") {
      temporary(
        kind,
        { c: "trainDto", train: tr.id, on: false },
        { c: "trainDto", train: tr.id, on: true },
        between(120, 600),
      );
      return;
    }
    if (kind === "trainHold") {
      temporary(
        kind,
        { c: "trainHold", train: tr.id, on: true },
        { c: "trainHold", train: tr.id, on: false },
      );
      return;
    }
    if (kind === "trainSkip") {
      const station = pick(stationsAhead(sim, tr));
      if (station === undefined) return void skip();
      temporary(
        kind,
        { c: "trainSkip", train: tr.id, station, on: true },
        { c: "trainSkip", train: tr.id, station, on: false },
        180,
      );
      return;
    }
    if (kind === "turnback") {
      const station = pick(turnbackOptions(sim, tr));
      if (station === undefined) return void skip();
      command(kind, { c: "turnback", train: tr.id, station });
      return;
    }
    if (kind === "standby" || kind === "recoverService") {
      const target = pick(cars.filter((t) => t.delay > 120)) ?? tr;
      command(kind, { c: kind, train: target.id });
      return;
    }
    skip();
  }
  /** Exercise UTO-specific contracts through real opportunities, without editing world state.
   * Random bag entries continue sampling these procedures independently. */
  let lastUtoProbe = -1;
  function utoCoverageTick() {
    if (!capabilities.uto || Math.floor(sim.t) === lastUtoProbe) return;
    lastUtoProbe = Math.floor(sim.t);
    const dc = dayCoverage(day).uto!;
    if (sim.t < utoServiceStart) return;
    const stopped = sim.trainList.filter(t => ordinary(t) && t.v < .05 && !t.eb && t.comm && sim.zoneState[sim.topo.links[t.link].zone] === "CBTC" && !t.dtoInhibit && !t.uto);
    if (!dc.takeovers && stopped.length) {
      const target = stopped[0];
      if (command("uto-coverage-takeover", {c: "manual", train: target.id, mode: "CM", computer: true}))
        if (command("uto-coverage-guard", {c: "utoStep", train: target.id, action: "key"})) throw Error("UTO_STEP_ORDER_ACCEPTED");
    }
    if (!dc.faults && stopped.length > 1) command("uto-coverage-fault", {c: "fault", kind: "trainUto", target: stopped.at(-1)!.id, duration: 0});
    if (!dc.resets) {
      const target = sim.trainList.find(t => t.dtoInhibit === "车载全自动功能故障" && t.uto?.stage === "manual" && t.v < .05 && !t.eb);
      if (target) command("uto-coverage-reset", {c: "utoReset", train: target.id});
    }
    if (!dc.famRestored) {
      const target = sim.trainList.find(t => t.uto?.stage === "manual" && t.uto.computer && t.v < .05 && !t.eb && t.comm && !t.dtoInhibit && sim.zoneState[sim.topo.links[t.link].zone] === "CBTC");
      if (target) command("uto-coverage-restore", {c: "manual", train: target.id, mode: "AUTO", computer: true});
    }
  }
  function daySchedule() {
    const times: number[] = [];
    for (let hour = 4; hour < 24; hour++) {
      const count = Math.floor(between(o.density[0], o.density[1] + 1));
      for (let k = 0; k < count; k++)
        times.push(hour * 3600 + between(1, 3599));
    }
    return times.sort((a, b) => a - b);
  }
  function nextKind(): Kind {
    if (!bag.length) {
      bag = [...capabilities.kinds];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  }
  const summary = (result: { status: string; [key: string]: unknown }) => {
    const counts: Record<
      string,
      { attempted: number; accepted: number; rejected: number; skipped: number }
    > = {};
    for (const a of actions) {
      const n = (counts[a.kind] ??= {
        attempted: 0,
        accepted: 0,
        rejected: 0,
        skipped: 0,
      });
      if (a.cmd) {
        n.attempted++;
        a.ok ? n.accepted++ : n.rejected++;
      } else n.skipped++;
    }
    const full = {
      ...result,
      coverage,
      notApplicable: capabilities.notApplicable,
      tag,
      options: o,
      model: hash,
      seconds: (Date.now() - started) / 1000,
      counts,
      actions,
    };
    writeFileSync(
      join(o.out, `${tag}-result.json`),
      JSON.stringify(full, null, 2),
    );
    console.log(JSON.stringify({ ...full, actions: undefined }));
    return full;
  };
  try {
    command("initial-faults", { c: "randomFaults", level: o.level });
    let carried: { id: number; vehicle: string; block: number }[] = [];
    for (day = 1; day <= 2; day++) {
      if (o.template !== "none") {
        const p = OVERLAY_PRESETS.find((p) => p.id === o.template)!;
        command("initial-template", {
          c: "overlay",
          id: p.id,
          from: p.from,
          to: p.to,
          headway: p.headway,
        });
      }
      utoServiceStart = Math.min(...sim.plan.trips.filter(t => t.revenue && !t.cancelled).map(t => t.stops[0].dep));
      const schedule = daySchedule(),
        weatherAt = 7 * 3600 + between(0, 1200);
      let cursor = 0,
        weather = false,
        late = false,
        rescue = false;
      while (sim.t < DAY_END) {
        // Commands due at the current fixed-step boundary precede the next step, just as replayDiagnostics does.
        if (!weather && sim.t >= weatherAt) {
          const duration = between(1800, 7200);
          command("profile-weather", {
            c: "env",
            wind: o.wind,
            rain: true,
            duration,
          });
          if (random() < 0.5)
            temporary(
              "profile-adhesion",
              { c: "lowAdhesion", on: true },
              { c: "lowAdhesion", on: false },
              duration,
            );
          weather = true; dayCoverage(day).weather = true;
        }
        if (day === 1 && o.lateExtra && !late && sim.t >= 27.25 * 3600) {
          const depot = sim.topo.depots.find((d) => sim.depotStock[d.id] > 0)!;
          if (!depot) throw Error("NO_LATE_EXTRA_STOCK");
          const origin = sim.topo.stations[depot.portals.exit.DN.station];
          const goals = sim.topo.stations
            .filter((s) => ahead("DN", origin.index, s.index))
            .sort(
              (a, b) =>
                Math.abs(a.chain - origin.chain - 15000) -
                Math.abs(b.chain - origin.chain - 15000),
            );
          for (const goal of goals)
            if (
              command("cross-midnight-extra", {
                c: "addTrain",
                depot: depot.id,
                dir: "DN",
                to: goal.index,
                time: 27.5 * 3600,
              })
            )
              break;
          late = true;
        }
        if (day === 1 && o.rescueOnce && !rescue && sim.t >= 7 * 3600) {
          const pair = sim.trainList
            .filter(ordinary)
            .map((f) => ({ f, r: rescuerFor(sim, f) }))
            .find((p) => p.r);
          if (pair) {
            command("coverage-failure", {
              c: "fault",
              kind: "trainFail",
              target: pair.f.id,
              duration: 900,
              recoverable: false,
            });
            command("coverage-rescue", {
              c: "rescue",
              failed: pair.f.id,
              rescuer: pair.r!.id,
            });
            rescue = true;
          }
        }
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i].at <= sim.t + 1e-6) {
            const task = queue.splice(i, 1)[0];
            const ok = command("cleanup", task.cmd, true);
            if (!ok && task.remaining > 0)
              later(task.cmd, 30, task.remaining - 1);
          }
        while (cursor < schedule.length && schedule[cursor] <= sim.t + 1e-6) {
          perform(nextKind());
          cursor++;
        }
        utoCoverageTick();
        sim.step();
        check();
      }
      if (day === 1) {
        const transition = rolloverContinuous(sim);
        sim = transition.sim;
        carried = transition.carried;
        if (o.lateExtra && !carried.length)
          throw Error("NO_ACTIVE_TRAIN_CARRIED");
        for (const task of queue) task.at -= 86400;
        lastWithdraw -= 86400;
        lastSecond = -1; lastUtoProbe = -1;
      }
    }
    day = 2;
    const pending = carried.filter(
      (t) => t.block >= 0 && !sim.blockDone.has(t.block),
    );
    if (pending.length)
      throw Error(`CARRIED_UNFINISHED ${JSON.stringify(pending)}`);
    const parked = overnightProblem(sim);
    if (parked) throw Error(parked);
    if (capabilities.uto) for (const operatingDay of [1, 2]) {
      const dc = dayCoverage(operatingDay), u = dc.uto!;
      if (!dc.weather || o.density[1] > 0 && !dc.randomCommands || !u.takeovers || !u.faults || !u.faultAtpm || !u.resets || !u.restores || !u.famRestored || !u.rejectedSteps || ["report", "key", "famOff", "brake", "confirm", "manual", "restoreReport", "neutral", "famOn"].some(stage => !u.stages.includes(stage)))
        throw Error(`UTO_COVERAGE_MISSING day=${operatingDay} ${JSON.stringify(dc)}`);
    }
    if (modelHash() !== hash) throw Error("SOURCE_CHANGED");
    return summary({
      status: "pass",
      day: 2,
      t: sim.t,
      clock: clockLabel(sim.t),
      violations: 0,
      cars: fleetNumbers(sim).length,
      carried,
    });
  } catch (error) {
    const type =
      sim.integrity.violations[0]?.kind ??
      (error instanceof Error ? error.message : "RUNTIME_EXCEPTION");
    return summary(saveFailure(sim, o.out, tag, day, type, error));
  }
}

export function verifyReplay(file: string, out = "work/fuzz") {
  const b = parseDiagnostics(readFileSync(file, "utf8")),
    expected = b.state.data.integrity as {
      violations: {
        kind: string;
        t: number;
        trains: number[];
        detail: string;
      }[];
    };
  const sidecar = file.replace(/-day[12]\.json$/, "-result.json"),
    failure = existsSync(sidecar)
      ? JSON.parse(readFileSync(sidecar, "utf8"))
      : (b as typeof b & { stressFailure?: { day: number; type: string } })
          .stressFailure;
  const started = Date.now();
  try {
    const s = replayDiagnostics(b),
      actual = s.integrity.violations[0],
      want = expected.violations[0];
    if (!want && failure?.day === 1 && Math.abs(b.until - DAY_END) < 1) {
      // A constructor failure happens after the last old-day step. Re-enact
      // that boundary as well; replaying only up to its input snapshot cannot throw it.
      let error = "";
      try {
        rolloverContinuous(s);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const result = {
        file,
        status:
          !actual && error === failure.type && Math.abs(s.t - b.until) < 1e-5
            ? "reproduced"
            : "REPLAY_MISMATCH",
        stage: "rollover",
        expected: { t: b.until, type: failure.type },
        actual: { t: s.t, type: error, firstViolation: actual },
        seconds: (Date.now() - started) / 1000,
      };
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `${file.split(/[\\/]/).at(-1)}.replay.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
      return result;
    }
    if (!want && failure) {
      const type =
        numericProblem(s) ??
        (failure.day === 2 && Math.abs(b.until - DAY_END) < 1
          ? overnightProblem(s)
          : null);
      const result = {
        file,
        status:
          !actual && type === failure.type && Math.abs(s.t - b.until) < 1e-5
            ? "reproduced"
            : "REPLAY_MISMATCH",
        expected: { t: b.until, type: failure.type },
        actual: { t: s.t, type },
        seconds: (Date.now() - started) / 1000,
      };
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `${file.split(/[\\/]/).at(-1)}.replay.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
      return result;
    }
    const same =
      !!want &&
      !!actual &&
      want.kind === actual.kind &&
      want.detail === actual.detail &&
      Math.abs(want.t - actual.t) < 1e-5 &&
      JSON.stringify(want.trains) === JSON.stringify(actual.trains);
    const result = {
      file,
      status: same ? "reproduced" : "REPLAY_MISMATCH",
      expected: want,
      actual,
      seconds: (Date.now() - started) / 1000,
    };
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, `${file.split(/[\\/]/).at(-1)}.replay.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      file,
      status: "REPLAY_EXCEPTION",
      error: String(error),
      seconds: (Date.now() - started) / 1000,
    };
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, `${file.split(/[\\/]/).at(-1)}.replay.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    return result;
  }
}
export function fuzzCases(count: number, out: string): FuzzOptions[] {
  return Array.from({ length: count }, (_, i) => {
    const dayType = i % 2 ? "weekend" : "weekday";
    return {
      seed: 101 + i,
      level: 1 + (i % 3),
      wind: WEATHER_RULES.wind.length ? WEATHER_RULES.wind[Math.floor(i / 3) % WEATHER_RULES.wind.length].level : 0,
      density: (
        [
          [3, 4],
          [3, 8],
          [6, 8],
        ] as [number, number][]
      )[Math.floor(i / 4) % 3],
      dayType,
      date: dayType === "weekend" ? "2026-10-24" : "2026-10-19",
      template: ["none", ...OVERLAY_PRESETS.map(p => p.id)][Math.floor(i / 2) % (OVERLAY_PRESETS.length + 1)],
      out,
    };
  });
}
async function batch(count: number, jobs: number, out: string) {
  mkdirSync(out, { recursive: true });
  const cases = fuzzCases(count, out);
  writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 2));
  let cursor = 0,
    finished = 0;
  const statuses: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(jobs, count) }, async () => {
      while (cursor < count) {
        const o = cases[cursor++],
          args = [
            ...process.execArgv,
            fileURLToPath(import.meta.url),
            String(o.seed),
            "--level",
            String(o.level),
            "--wind",
            String(o.wind),
            "--density",
            o.density.join(":"),
            "--day-type",
            o.dayType,
            "--date",
            o.date,
            "--template",
            o.template,
            "--out",
            out,
          ];
        const code = await new Promise<number | null>((resolveRun, reject) => {
          const p = spawn(process.execPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          let log = "";
          p.stdout.on("data", (b) => (log += b));
          p.stderr.on("data", (b) => (log += b));
          p.on("error", reject);
          p.on("exit", (code) => {
            writeFileSync(join(out, `seed-${o.seed}.log`), log);
            resolveRun(code);
          });
        });
        statuses.push({ seed: o.seed, exitCode: code });
        console.log(`fuzz ${++finished}/${count} seed=${o.seed} exit=${code}`);
      }
    }),
  );
  writeFileSync(
    join(out, "batch-status.json"),
    JSON.stringify(statuses, null, 2),
  );
  const results = readdirSync(out)
    .filter((f) => f.endsWith("-result.json"))
    .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
  console.log(
    JSON.stringify({
      cases: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
    }),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2),
    opts = options(args),
    out = opts.get("out") ?? "work/fuzz";
  if (opts.has("replay")) verifyReplay(opts.get("replay")!, out);
  else if (opts.has("cases")) {
    const count = Number(opts.get("cases")),
      jobs = Math.min(
        12,
        Number(opts.get("jobs") ?? Math.min(8, availableParallelism())),
      );
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isInteger(jobs) ||
      jobs < 1
    )
      throw Error("Invalid batch size");
    await batch(count, jobs, out);
  } else {
    const seed = Number(args[0]),
      level = Number(opts.get("level") ?? 2),
      wind = Number(opts.get("wind") ?? (WEATHER_RULES.wind.some(rule => rule.level === 2) ? 2 : 0)),
      density = (opts.get("density") ?? "3:8").split(":").map(Number),
      dayType = opts.get("day-type") ?? "weekday",
      template = opts.get("template") ?? "none";
    if (
      !Number.isInteger(seed) ||
      ![1, 2, 3].includes(level) ||
      ![0, ...WEATHER_RULES.wind.map(rule => rule.level)].includes(wind) ||
      density.length !== 2 ||
      density.some((n) => !Number.isInteger(n) || n < 0) ||
      density[0] > density[1] ||
      !["weekday", "weekend"].includes(dayType) ||
      !["none", ...OVERLAY_PRESETS.map((p) => p.id)].includes(template)
    )
      throw Error("Invalid fuzz options");
    const r = runFuzz({
      seed,
      level,
      wind,
      density: density as [number, number],
      dayType: dayType as SimConfig["dayType"],
      date:
        opts.get("date") ??
        (dayType === "weekend" ? "2026-10-24" : "2026-10-19"),
      template,
      out,
      lateExtra: opts.get("late-extra") === "true",
      rescueOnce: opts.get("rescue-once") === "true",
    });
    process.exitCode = r.status === "pass" ? 0 : 1;
  }
}
