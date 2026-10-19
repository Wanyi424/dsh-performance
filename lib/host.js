// src/contracts.ts
var API_PATH = "/api/dsh-performance";
var HISTORY_MS = 36e5;
var PROFILER = { sampleMs: 10, heapBytes: 128 * 1024, memoryEveryMs: 3e5, firstMemoryMs: 6e4, lingerMs: 6e5 };
var REST = ["core", "gc", "other"];

// src/collector.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// src/metrics.ts
import { sep } from "node:path";
var pathKey = (path) => process.platform === "win32" ? path.toLowerCase() : path;
function pluginOf(path, plugins) {
  if (!path) return null;
  const file = pathKey(path);
  return plugins.find((p) => file.startsWith(pathKey(p.dir) + sep))?.id ?? null;
}
var SERVICES = { "network.mojom.NetworkService": "network", "storage.mojom.StorageService": "storage", "audio.mojom.AudioService": "audio" };
function classify(p) {
  if (p.role === "main") return { kind: "main", group: "app" };
  if (p.role === "host") return { kind: "host", group: "host" };
  if (p.role === "tool") return { kind: "tool", group: "tools" };
  if (p.type === "renderer") return { kind: "renderer", group: "ui" };
  if (p.type === "gpu-process") return { kind: "gpu", group: "gpu" };
  if (p.type === "utility") return { kind: p.subtype && SERVICES[p.subtype] || "utility", group: "app" };
  return { kind: p.type === "crashpad-handler" ? "crashpad" : "other", group: "app" };
}
function calculate(current, previous, plugins = []) {
  const elapsed = previous ? current.monotonic - previous.monotonic : 0;
  const valid = !!previous && elapsed >= 500 && elapsed <= 1e4 && current.time - previous.time <= 1e4;
  const before = new Map(previous ? [...previous.processes, ...previous.collector ? [previous.collector] : []].map((p) => [p.pid, p]) : []);
  const cpu = (row) => {
    if (!valid) return null;
    const old = before.get(row.pid);
    const used = old?.created === row.created ? row.cpuMs - old.cpuMs : row.created >= previous.time ? row.cpuMs : null;
    return used === null || used < 0 ? null : Math.min(100, used / elapsed / current.cores * 100);
  };
  const processes = current.processes.map((p) => ({
    pid: p.pid,
    parent: p.parent,
    created: p.created,
    name: p.name,
    threads: p.threads,
    ...classify(p),
    detail: p.role === "tool" ? p.command : p.subtype ?? p.type,
    cpu: cpu(p),
    memory: p.memory,
    ...p.role === "tool" ? { plugin: pluginOf(p.image, plugins) } : {}
  }));
  const memories = processes.flatMap((p) => p.memory === null ? [] : [p.memory]);
  const now = current.system, then = previous?.system, total = now && then ? now.kernelMs + now.userMs - then.kernelMs - then.userMs : 0;
  return {
    time: current.time,
    intervalMs: valid ? elapsed : null,
    cores: current.cores,
    started: current.processes.find((p) => p.role === "main")?.created ?? current.time,
    cpu: valid ? Math.min(100, processes.reduce((sum, p) => sum + (p.cpu ?? 0), 0)) : null,
    memory: memories.length ? memories.reduce((a, b) => a + b, 0) : null,
    system: now && { cpu: valid && total > 0 ? Math.min(100, Math.max(0, (1 - (now.idleMs - then.idleMs) / total) * 100)) : null, memoryUsed: now.memoryTotal - now.memoryAvailable, memoryTotal: now.memoryTotal },
    processes,
    collector: current.collector && { pid: current.collector.pid, cpu: cpu(current.collector), memory: current.collector.memory },
    unavailable: current.unavailable,
    attribution: null
  };
}

// src/collector.ts
var Sampler = class {
  constructor(executable = fileURLToPath(new URL("./collector.exe", import.meta.url)), args = [String(process.pid)], plugins = () => [], profiler) {
    this.executable = executable;
    this.args = args;
    this.plugins = plugins;
    this.profiler = profiler;
  }
  child;
  lines;
  pending;
  flight;
  previous;
  cached;
  cachedAt = 0;
  idle;
  disposed = false;
  stop() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = void 0;
    this.lines?.close();
    this.lines = void 0;
    this.previous = void 0;
    this.cached = void 0;
    this.pending?.reject(new Error("\u91C7\u96C6\u5668\u5DF2\u505C\u6B62\u3002"));
    this.pending = void 0;
    child?.kill();
  }
  start() {
    if (process.platform !== "win32") throw new Error("\u8FD0\u884C\u76D1\u63A7\u4EC5\u652F\u6301 Windows \u672C\u5730\u684C\u9762\u7248\u3002");
    const child = spawn(this.executable, this.args, { windowsHide: true, shell: false, stdio: "pipe" });
    this.child = child;
    const fail = (error) => {
      if (this.child !== child) return;
      this.pending?.reject(error);
      this.pending = void 0;
      this.stop();
    };
    child.on("error", () => fail(new Error("\u65E0\u6CD5\u542F\u52A8\u76D1\u63A7\u91C7\u96C6\u5668\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u5B89\u88C5\u662F\u5426\u5B8C\u6574\u3002")));
    child.on("exit", () => fail(new Error("\u76D1\u63A7\u91C7\u96C6\u5668\u610F\u5916\u9000\u51FA\uFF0C\u8BF7\u91CD\u8BD5\u3002")));
    child.stdin.on("error", () => fail(new Error("\u65E0\u6CD5\u8FDE\u63A5\u76D1\u63A7\u91C7\u96C6\u5668\u3002")));
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (this.child !== child || !this.pending) return;
      const pending = this.pending;
      this.pending = void 0;
      try {
        const result = JSON.parse(line);
        if (result.error) throw new Error(result.error);
        pending.resolve(result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("\u65E0\u6CD5\u8BFB\u53D6\u91C7\u96C6\u7ED3\u679C\u3002"));
      }
    });
  }
  async sample() {
    if (this.disposed) throw new Error("\u76D1\u63A7\u5DF2\u5173\u95ED\u3002");
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), 15e3);
    this.idle.unref();
    if (this.flight) return this.flight;
    if (this.cached && performance.now() - this.cachedAt < 1800) return this.cached;
    this.flight = this.collect().finally(() => {
      this.flight = void 0;
    });
    return this.flight;
  }
  async collect() {
    if (!this.child) this.start();
    let timeout;
    try {
      const raw = await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        timeout = setTimeout(() => {
          reject(new Error("\u91C7\u96C6\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
          this.stop();
        }, 5e3);
        this.child.stdin.write("sample\n");
      });
      this.cached = { ...calculate(raw, this.previous, this.plugins()), attribution: this.profiler?.take(raw.cores) ?? null };
      this.previous = raw;
      this.cachedAt = performance.now();
      return this.cached;
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  dispose() {
    this.disposed = true;
    this.stop();
  }
};

// src/plugins.ts
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var CORE_SCOPE = "@deepseek-ai/";
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function label(dir, fallback) {
  for (const file of ["zh.json", "zh-CN.json", "en.json"]) {
    try {
      const locale = await json(join(dir, "locale", file)), value = locale?.meta?.title ?? locale?.name;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
    }
  }
  return fallback;
}
var PluginCatalog = class {
  constructor(profiles = [process.cwd(), fileURLToPath2(new URL("../../..", import.meta.url))], now = () => Date.now()) {
    this.profiles = profiles;
    this.now = now;
  }
  cached = [];
  readAt = -Infinity;
  reading;
  /** The last list read, refreshed in the background when stale; for callers that cannot wait. */
  current() {
    void this.list();
    return this.cached;
  }
  list() {
    if (this.now() - this.readAt < 6e4) return Promise.resolve(this.cached);
    return this.reading ??= this.read().then((list) => {
      this.cached = list;
      this.readAt = this.now();
      return list;
    }).finally(() => {
      this.reading = void 0;
    });
  }
  async read() {
    for (const profile of this.profiles) {
      let bundles;
      try {
        bundles = (await json(join(profile, "package.json")))?.dsh?.profile?.bundles;
      } catch {
        continue;
      }
      if (!Array.isArray(bundles)) continue;
      const names = bundles.filter((name2) => typeof name2 === "string" && !name2.startsWith(CORE_SCOPE));
      const found = await Promise.all(names.map(async (id) => {
        try {
          const dir = await realpath(join(profile, "node_modules", id)), pkg = await json(join(dir, "package.json"));
          return { id, dir, version: typeof pkg?.version === "string" ? pkg.version : "", label: await label(dir, id) };
        } catch {
          return null;
        }
      }));
      return found.filter((p) => p !== null);
    }
    return [];
  }
};

// src/profiler.ts
import inspector from "node:inspector";
import { Session } from "node:inspector/promises";
import { dirname } from "node:path";

// src/attribution.ts
import { relative, sep as sep2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var ownersOf = (plugins) => [...plugins.map((p) => `plugin:${p.id}`), ...REST];
function top(hot, n = 5) {
  return [...hot].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => {
    const [name2, where = ""] = key.split("\0");
    return { name: name2, where, value };
  });
}
function packageOf(path) {
  const parts = path.split(/[\\/]/), at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  return parts[at + 1].startsWith("@") ? `${parts[at + 1]}/${parts[at + 2] ?? ""}` : parts[at + 1];
}
var pathOf = (url) => {
  try {
    return url.startsWith("file:") ? fileURLToPath3(url.split(/[?#]/)[0]) : url;
  } catch {
    return url;
  }
};
var special = (frame) => frame.url ? null : frame.functionName === "(garbage collector)" ? "gc" : frame.functionName === "(program)" ? "other" : null;
var Attributor = class _Attributor {
  frames = /* @__PURE__ */ new Map();
  plugins = [];
  rootKey;
  constructor(root) {
    this.rootKey = pathKey(root) + sep2;
  }
  use(plugins) {
    if (plugins !== this.plugins) {
      this.plugins = plugins;
      this.frames.clear();
    }
  }
  frameOf(url) {
    let known = this.frames.get(url);
    if (known !== void 0) return known;
    if (!url) known = null;
    else if (url.startsWith("node:")) known = { kind: "core", module: "Node.js" };
    else {
      const path = pathOf(url), plugin = pluginOf(path, this.plugins), module = packageOf(path) ?? path.split(/[\\/]/).at(-1) ?? path;
      if (plugin) known = { kind: "plugin", id: plugin, dir: this.plugins.find((p) => p.id === plugin).dir };
      else known = pathKey(path).startsWith(this.rootKey) ? { kind: "core", module } : { kind: "other", module };
      if (known.kind === "core" && !packageOf(path)) known = { kind: "core", module: "DeepSeek Harness" };
    }
    this.frames.set(url, known);
    return known;
  }
  charge(frame, parent) {
    const f = this.frameOf(frame.url);
    if (f?.kind === "plugin") {
      const where = relative(f.dir, pathOf(frame.url)).split(sep2).join("/");
      return { plugin: { id: f.id, hot: `${frame.functionName || "\uFF08\u533F\u540D\u51FD\u6570\uFF09"}\0${where}:${frame.lineNumber + 1}` }, core: parent.core, other: parent.other };
    }
    if (f?.kind === "core") return { ...parent, core: parent.plugin ? parent.core : f.module };
    if (f?.kind === "other") return { ...parent, other: parent.plugin ? parent.other : f.module };
    return parent;
  }
  static book(tallies, c, kind, value) {
    const id = kind === "gc" ? "gc" : c.plugin && !kind ? `plugin:${c.plugin.id}` : c.core && !kind ? "core" : "other";
    let t = tallies.get(id);
    if (!t) tallies.set(id, t = { value: 0, hot: /* @__PURE__ */ new Map() });
    t.value += value;
    if (id === "gc") return;
    const key = id.startsWith("plugin:") ? c.plugin.hot : kind ? "\u539F\u751F\u4EE3\u7801" : c.core ?? c.other ?? "\u539F\u751F\u4EE3\u7801";
    t.hot.set(key, (t.hot.get(key) ?? 0) + value);
  }
  /** Busy time of one profile window by owner, in ms; `(idle)` is idle and `(root)` carries no time. */
  cpu(profile, plugins) {
    this.use(plugins);
    const nodes = new Map(profile.nodes.map((n) => [n.id, n])), charges = /* @__PURE__ */ new Map(), owners = /* @__PURE__ */ new Map();
    const childIds = new Set(profile.nodes.flatMap((n) => n.children ?? []));
    const stack = profile.nodes.filter((n) => !childIds.has(n.id)).map((n) => [n.id, {}]);
    while (stack.length) {
      const [id, parent] = stack.pop(), node = nodes.get(id), c = this.charge(node.callFrame, parent);
      charges.set(id, c);
      for (const child of node.children ?? []) stack.push([child, c]);
    }
    const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
    let idle = 0, at = profile.startTime;
    const times = deltas.map((d) => at += d);
    samples.forEach((id, i) => {
      const us = (i + 1 < samples.length ? times[i + 1] : profile.endTime) - times[i];
      if (us <= 0) return;
      const frame = nodes.get(id).callFrame;
      if (!frame.url && frame.functionName === "(idle)") {
        idle += us;
        return;
      }
      if (!frame.url && frame.functionName === "(root)") return;
      _Attributor.book(owners, charges.get(id), special(frame), us / 1e3);
    });
    const durationMs = (profile.endTime - profile.startTime) / 1e3;
    return { durationMs, busyMs: Math.max(0, durationMs - idle / 1e3), owners };
  }
  /** The sampled allocations still alive, in bytes by owner, each charged by its allocation stack. */
  heap(head, plugins) {
    this.use(plugins);
    const owners = /* @__PURE__ */ new Map(), walk = [[head, {}]];
    let bytes = 0;
    while (walk.length) {
      const [node, parent] = walk.pop(), c = this.charge(node.callFrame, parent);
      if (node.selfSize) {
        bytes += node.selfSize;
        _Attributor.book(owners, c, special(node.callFrame), node.selfSize);
      }
      for (const child of node.children) walk.push([child, c]);
    }
    return { bytes, owners };
  }
};

// src/profiler.ts
var MAX_WINDOW_MS = 1e4;
var MINUTE = 6e4;
var RELEASE_MS = 3e4;
var HostProfiler = class {
  constructor(plugins, root = dirname(process.execPath), now = () => Date.now()) {
    this.plugins = plugins;
    this.now = now;
    this.attributor = new Attributor(root);
    this.nextRead = now() + PROFILER.firstMemoryMs;
  }
  session;
  starting;
  enabled = false;
  error = null;
  attributor;
  /** Console-profile title of the open window, if the profiler runs. */
  running = null;
  ending = null;
  received;
  count = 0;
  startPauseMs = null;
  memory = null;
  held = /* @__PURE__ */ new Map();
  nextRead;
  reading = false;
  /** Per-minute time by function (plugins) or package (DSH, other) for each owner, an hour deep, for the details view. */
  minutes = [];
  linger;
  release;
  /** Enable the expensive Host attribution only while the details page needs it. */
  async enable() {
    this.enabled = true;
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = void 0;
    });
    await this.starting;
  }
  /** Kept as a small compatibility alias for tests and embedders. */
  async start() {
    return this.enable();
  }
  /** Stop both profilers and release their inspector session immediately. */
  disable() {
    this.enabled = false;
    if (this.starting) {
      void this.starting.then(() => {
        if (!this.enabled) this.stopSession();
      });
      return;
    }
    this.stopSession();
  }
  async open() {
    const session = new Session();
    try {
      session.connect();
      session.on("Profiler.consoleProfileFinished", ({ params }) => {
        if (params.title === this.ending) this.received = params.profile;
      });
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: PROFILER.sampleMs * 1e3 });
      await session.post("HeapProfiler.enable");
      await session.post("HeapProfiler.startSampling", { samplingInterval: PROFILER.heapBytes });
    } catch (error) {
      session.disconnect();
      this.enabled = false;
      this.error = `\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u6309\u63D2\u4EF6\u7EDF\u8BA1\u540E\u53F0\uFF1A${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.session = session;
    this.release = setInterval(() => void session.post("Runtime.discardConsoleEntries").catch(() => {
    }), RELEASE_MS);
    this.release.unref();
    if (!this.enabled) this.stopSession();
  }
  /**
   * Called on each fresh reading: closes the running window and opens the next. Returns what the reading carries: each owner's
   * share of the machine over the window just closed, and the latest memory reading.
   */
  take(cores) {
    const rest = () => ({ memory: this.memory, startPauseMs: this.startPauseMs, error: this.error });
    if (!this.enabled || !this.session) return { cpu: null, ...rest() };
    this.keep();
    const next = `dsh-performance#${++this.count}`;
    if (this.running === null) {
      const started = performance.now();
      inspector.console.profile(next);
      this.startPauseMs = performance.now() - started;
      this.running = next;
      return { cpu: null, ...rest() };
    }
    inspector.console.profile(next);
    const profile = this.close(this.running);
    this.running = next;
    const durationMs = profile ? (profile.endTime - profile.startTime) / 1e3 : 0;
    if (!profile || durationMs <= 0 || durationMs > MAX_WINDOW_MS) return { cpu: null, ...rest() };
    const plugins = this.plugins(), { owners } = this.attributor.cpu(profile, plugins), cpu = {};
    for (const id of ownersOf(plugins)) cpu[id] = (owners.get(id)?.value ?? 0) / durationMs / cores * 100;
    this.bank(owners);
    return { cpu, ...rest() };
  }
  /** Where an owner's time went over [from, to], from the per-minute record, and where its memory sits at the latest reading. */
  detail(id, from, to) {
    const merged = /* @__PURE__ */ new Map();
    for (const m of this.minutes) if (m.minute + MINUTE > from && m.minute <= to) for (const [key, ms] of m.owners.get(id) ?? []) merged.set(key, (merged.get(key) ?? 0) + ms);
    return { cpu: top(merged), memory: top(this.held.get(id)?.hot ?? /* @__PURE__ */ new Map()), memoryAt: this.memory?.at ?? null };
  }
  close(title) {
    this.ending = title;
    this.received = void 0;
    inspector.console.profileEnd(title);
    const profile = this.received;
    this.ending = null;
    this.received = void 0;
    return profile;
  }
  /** Readings are coming in: keep the profiler up a while longer, and read memory when it is due. */
  keep() {
    clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      if (this.running) {
        this.close(this.running);
        this.running = null;
      }
    }, PROFILER.lingerMs);
    this.linger.unref();
    if (!this.reading && this.now() >= this.nextRead) {
      this.reading = true;
      setImmediate(() => void this.readMemory());
    }
  }
  /** After the reading that triggered it has been answered: the garbage collection this costs does not delay that answer. */
  async readMemory() {
    const session = this.session;
    try {
      if (!session) return;
      await session.post("Runtime.discardConsoleEntries");
      const started = performance.now(), { profile } = await session.post("HeapProfiler.getSamplingProfile"), pauseMs = performance.now() - started;
      const plugins = this.plugins(), { owners } = this.attributor.heap(profile.head, plugins), values = {};
      for (const id of ownersOf(plugins)) values[id] = owners.get(id)?.value ?? 0;
      this.memory = { at: this.now(), owners: values, pauseMs };
      this.held = owners;
    } catch {
    } finally {
      this.reading = false;
      this.nextRead = this.now() + PROFILER.memoryEveryMs;
    }
  }
  bank(owners) {
    const at = this.now(), minute = at - at % MINUTE;
    let m = this.minutes.at(-1);
    if (m?.minute !== minute) {
      if (m) for (const [id, hot] of m.owners) m.owners.set(id, new Map([...hot].sort((a, b) => b[1] - a[1]).slice(0, 20)));
      this.minutes.push(m = { minute, owners: /* @__PURE__ */ new Map() });
      while (this.minutes[0].minute <= at - HISTORY_MS) this.minutes.shift();
    }
    for (const [id, t] of owners) {
      if (!t.hot.size) continue;
      let hot = m.owners.get(id);
      if (!hot) m.owners.set(id, hot = /* @__PURE__ */ new Map());
      for (const [key, ms] of t.hot) hot.set(key, (hot.get(key) ?? 0) + ms);
    }
  }
  dispose() {
    this.enabled = false;
    if (this.starting) void this.starting.then(() => this.stopSession());
    else this.stopSession();
  }
  stopSession() {
    clearTimeout(this.linger);
    clearInterval(this.release);
    this.linger = void 0;
    this.release = void 0;
    const session = this.session;
    this.session = void 0;
    if (this.running) {
      this.close(this.running);
      this.running = null;
    }
    this.received = void 0;
    this.memory = null;
    this.held = /* @__PURE__ */ new Map();
    this.minutes = [];
    this.startPauseMs = null;
    this.nextRead = this.now() + PROFILER.firstMemoryMs;
    this.error = null;
    if (!session) return;
    void session.post("HeapProfiler.stopSampling").catch(() => {
    });
    void session.post("Runtime.discardConsoleEntries").catch(() => {
    });
    session.disconnect();
  }
};

// src/host.ts
var name = "performance";
var inject = ["connection"];
var json2 = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function createHandler({ sampler, profiler, catalog }) {
  return async (request) => {
    try {
      const body = await request.json();
      switch (body?.action) {
        case "sample":
          return json2({ data: await sampler.sample() });
        case "profiling": {
          if (typeof body.enabled !== "boolean") throw new Error("\u4E0D\u652F\u6301\u7684\u76D1\u63A7\u64CD\u4F5C\u3002");
          if (body.enabled) await profiler?.enable?.();
          else profiler?.disable?.();
          return json2({ data: { enabled: body.enabled && !!profiler?.enable } });
        }
        case "plugins":
          return json2({ data: (await catalog?.list() ?? []).map(({ id, label: label2, version }) => ({ id, label: label2, version })) });
        case "owner": {
          const { id, from, to } = body;
          if (typeof id !== "string" || id.length > 256 || !Number.isFinite(from) || !Number.isFinite(to)) throw new Error("\u4E0D\u652F\u6301\u7684\u67E5\u8BE2\u3002");
          return json2({ data: profiler?.detail(id, from, to) ?? { cpu: [], memory: [], memoryAt: null } });
        }
        default:
          throw new Error("\u4E0D\u652F\u6301\u7684\u76D1\u63A7\u64CD\u4F5C\u3002");
      }
    } catch (error) {
      return json2({ error: { message: error instanceof Error ? error.message : "\u8BFB\u53D6\u8FD0\u884C\u6307\u6807\u5931\u8D25\u3002" } }, 400);
    }
  };
}
function apply(ctx) {
  const catalog = new PluginCatalog(), profiler = new HostProfiler(() => catalog.current());
  void catalog.list();
  const sampler = new Sampler(void 0, void 0, () => catalog.current(), profiler);
  ctx.connection.fetch.register({ path: API_PATH, methods: ["POST"], requestBody: "buffered", fetch: createHandler({ sampler, profiler, catalog }) });
  ctx.effect(() => () => {
    profiler.dispose();
    sampler.dispose();
  }, "performance: collector and profiler");
}
export {
  apply,
  createHandler,
  inject,
  name
};
