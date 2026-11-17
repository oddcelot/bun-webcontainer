// The smaller modules: constants, domain, inspector, trace_events, cluster, dgram, repl, wasi.
import constants from "node:constants";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import domain from "node:domain";
import { EventEmitter } from "node:events";
import inspector from "node:inspector";
import inspectorPromises from "node:inspector/promises";
import trace from "node:trace_events";
import cluster from "node:cluster";
import dgram from "node:dgram";
import repl from "node:repl";
import wasi from "node:wasi";
import type { Case } from "./cases.ts";

export async function misc(t: Case, log: (line: string) => void) {
  // The values are the platform's (the playground's is Linux): compare the keys and the ones every platform shares.
  t("constants are the groups", () => {
    const groups = { ...os.constants.dlopen, ...os.constants.errno, ...os.constants.priority, ...os.constants.signals, ...fs.constants, ...crypto.constants };
    return [Object.keys(groups).sort().join() === Object.keys(constants).sort().join(), Object.keys(constants).every((k) => (constants as Record<string, unknown>)[k] === (groups as Record<string, unknown>)[k])].join();
  });
  t("constants shared values", () => {
    const c = constants as Record<string, number>;
    return ["O_RDONLY", "O_WRONLY", "O_RDWR", "S_IFMT", "S_IFREG", "S_IFDIR", "F_OK", "R_OK", "ENOENT", "EEXIST", "EACCES", "SIGINT", "SIGKILL", "SIGTERM", "RTLD_LAZY", "PRIORITY_HIGHEST", "RSA_PKCS1_PADDING", "COPYFILE_EXCL"].map((k) => `${k}=${c[k]}`).join(" ");
  });
  t("os.constants groups", () => Object.keys(os.constants).sort().join() + " " + Object.keys(os.constants.errno).length + " " + ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGUSR2", "SIGWINCH"].every((s) => s in os.constants.signals));

  t("domain exports", () => Object.keys(domain).sort().join());
  t("domain run", () => {
    const d = domain.create();
    let got = "";
    d.on("error", (e: Error & { domain?: unknown; domainThrown?: boolean }) => (got = `${e.message} ${e.domain === d} ${e.domainThrown}`));
    const r = d.run(() => {
      throw new Error("in domain");
    });
    return [got, r, domain.active].join("|");
  });
  t("domain active", () => {
    const d = domain.create();
    let inside: unknown;
    d.run(() => (inside = domain.active === d && (process as { domain?: unknown }).domain === d));
    return [inside, domain.active, (domain as unknown as { _stack: unknown[] })._stack.length].join();
  });
  t("domain bind intercept", () => {
    const d = domain.create();
    const seen: string[] = [];
    d.on("error", (e: Error) => seen.push(e.message));
    d.bind(() => {
      throw new Error("bound");
    })();
    d.intercept((v: number) => seen.push(`ok ${v}`))(null, 5);
    d.intercept(() => {})(new Error("intercepted"));
    return seen.join();
  });
  t("domain add", () => {
    const d = domain.create();
    const e = new EventEmitter();
    let got = "";
    d.on("error", (err: Error & { domainEmitter?: unknown }) => (got = `${err.message} ${err.domainEmitter === e}`));
    d.add(e);
    e.emit("error", new Error("from emitter"));
    return got;
  });
  t("domain methods", () => ["add", "remove", "bind", "intercept", "run", "dispose", "enter", "exit"].map((k) => typeof (domain.create() as unknown as Record<string, unknown>)[k]).join() + " " + (domain.create() instanceof EventEmitter));

  t("inspector exports", () => Object.keys(inspector).join() + " | " + Object.keys(inspectorPromises).join());
  t("inspector url", () => String(inspector.url()));
  t("inspector waitForDebugger", () => inspector.waitForDebugger());
  t("inspector not connected", () => new inspector.Session().post("Runtime.enable"));
  t("inspector connect twice", () => {
    const s = new inspector.Session();
    s.connect();
    s.connect();
  });
  {
    const s = new inspector.Session();
    s.connect();
    const post = (m: string) => new Promise((r) => s.post(m, (e, res) => r(e ? `${e.message} ${(e as Error & { code?: string }).code}` : JSON.stringify(res))));
    log(`inspector post: ${[await post("Runtime.enable"), await post("Nope.x"), await post("Profiler.start"), await post("Profiler.enable")].join(" | ")}`);
    t("inspector post sync", () => s.post("Runtime.disable"));
    t("inspector post sync error", () => s.post("Nope.y"));
    s.disconnect();
    const p = new inspectorPromises.Session();
    p.connect();
    log(`inspector/promises post: ${JSON.stringify(await p.post("Runtime.enable"))} ${await p.post("Nope.z").catch((e: Error) => e.message)}`);
  }

  t("trace_events", () => {
    const before = trace.getEnabledCategories();
    const a = trace.createTracing({ categories: ["a", "b"] });
    a.enable();
    const b = trace.createTracing({ categories: ["b", "c"] });
    b.enable();
    const both = trace.getEnabledCategories();
    a.disable();
    const after = trace.getEnabledCategories();
    b.disable();
    return [before, both, after, a.enabled, a.categories, trace.getEnabledCategories()].join("|");
  });
  t("trace_events no categories", () => trace.createTracing({ categories: [] }));

  t("cluster", () => [cluster.isPrimary, cluster.isMaster, cluster.isWorker, cluster.schedulingPolicy, cluster.SCHED_RR, cluster.SCHED_NONE, typeof cluster.on, cluster instanceof EventEmitter, Object.keys(cluster.workers ?? {}).length, typeof cluster.fork].join());
  t("dgram", () => {
    const s = dgram.createSocket("udp4");
    const r = [typeof s.bind, typeof s.send, s instanceof EventEmitter, s instanceof dgram.Socket].join();
    s.close();
    return r;
  });
  t("repl", () => [typeof repl.start, typeof repl.REPL_MODE_STRICT, String(repl.REPL_MODE_STRICT), typeof repl.REPLServer].join());
  t("wasi", () => typeof wasi.WASI);
}
