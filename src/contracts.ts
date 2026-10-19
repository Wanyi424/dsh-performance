export const API_PATH = '/api/dsh-performance';
export const PANEL = 'dsh-performance';
/** Trend history and responsiveness records are kept this long, in memory only. */
export const HISTORY_MS = 3_600_000;
/** The sidebar row samples every 3 s; with the page open, every 2 s; after a failure, every 15 s. */
export const CADENCE = { idle: 3_000, page: 2_000, failed: 15_000 };

/**
 * How the collector reached a process in the DSH tree: the desktop main process, the rest of the desktop (Electron children),
 * the Host (the same executable in Node mode), or a program the Host started (terminals, agent commands, MCP servers…).
 */
export type Role = 'main' | 'app' | 'host' | 'tool';
export interface RawProcess {
  pid: number; parent: number; role: Role; name: string; threads: number;
  /** Electron's `--type` and `--utility-sub-type` flags, for desktop processes. */
  type: string | null; subtype: string | null;
  /** Command line and executable path of a tool process; the command line is cut at 1024 characters. */
  command: string | null; image?: string | null;
  /** Creation time, epoch ms. Together with the PID it identifies one process across samples. */
  created: number; cpuMs: number;
  /** Private working set in bytes; null when Windows does not report it. */
  memory: number | null;
}
/** Cumulative machine CPU times (idle is included in kernel time) and physical memory. */
export interface RawSystem { idleMs: number; kernelMs: number; userMs: number; memoryTotal: number; memoryAvailable: number }
export interface RawSample { time: number; monotonic: number; cores: number; system: RawSystem | null; processes: RawProcess[]; collector: RawProcess | null; unavailable: number; collectionMs: number }

/** Chart order, bottom to top: the stable desktop parts first, the most volatile (programs DSH started) last. */
export const GROUPS = ['ui', 'gpu', 'app', 'host', 'tools'] as const;
export type Group = typeof GROUPS[number];
export type Kind = 'main' | 'renderer' | 'gpu' | 'network' | 'storage' | 'audio' | 'utility' | 'crashpad' | 'other' | 'host' | 'tool';
export interface ProcessMetric {
  pid: number; parent: number; created: number; name: string; kind: Kind; group: Group; threads: number;
  /** Utility service name, Electron type or tool command line. */
  detail: string | null;
  /** For a tool process: the executable it runs, and the installed plugin whose folder holds it, if any. */
  path?: string | null; plugin?: string | null;
  /** Share of the whole machine's CPU over the last interval; null without a valid baseline. */
  cpu: number | null; memory: number | null;
}
export interface Sample {
  time: number;
  /** Length of the CPU measurement interval; null when the sample has no valid CPU baseline. */
  intervalMs: number | null;
  cores: number;
  /** When the desktop main process started. */
  started: number;
  cpu: number | null; memory: number | null;
  /** The whole machine over the same interval: busy CPU share, and physical memory in use (total minus available). */
  system: { cpu: number | null; memoryUsed: number; memoryTotal: number } | null;
  processes: ProcessMetric[];
  /** The monitor's own helper, kept out of the totals. */
  collector: { pid: number; cpu: number | null; memory: number | null } | null;
  /** Processes in the tree that Windows did not let the collector read. */
  unavailable: number;
  /** The Host's own split of its main thread and memory by plugin; null where the Host runs no profiler (tests, tools). */
  attribution: Attribution | null;
}
/**
 * One history point: per-group sums in GROUPS order, the machine totals at that moment, and the Host's main thread by owner
 * (null when the reading had no matching profiler window).
 */
export interface Point { time: number; intervalMs: number | null; cpu: number[] | null; memory: number[] | null; systemCpu: number | null; systemMemory: number | null; owners: Record<string, number> | null }

/** An installed plugin: a profile bundle that is not one of DSH's own. */
export interface PluginInfo { id: string; label: string; version: string }

/**
 * The Host profiles itself from the moment it starts, so its main thread and memory can be split by plugin: a stack sample
 * every 10 ms and an allocation sample per 128 KB. A window closes with each reading, or every 10 s while none come (the
 * window hidden), so a profile never grows unbounded. Reading memory collects garbage first: it is read a minute after the
 * profiler starts and then every 5 minutes, only while readings come in.
 */
export const PROFILER = { sampleMs: 10, heapBytes: 128 * 1024, windowMs: 10_000, memoryEveryMs: 300_000, firstMemoryMs: 60_000 };
/** Owners of the Host's main thread besides the plugins (`plugin:<id>`): DSH itself, garbage collection, everything else. */
export const REST = ['core', 'gc', 'other'] as const;
/** Running since the Host started, paused by the user until resumed or DSH restarts, or impossible in this environment. */
export type ProfilerState = 'running' | 'paused' | 'unavailable';
export interface Attribution {
  /** Each owner's share of the whole machine's CPU over this reading's interval, like `cpu`; null without a matching window. */
  cpu: Record<string, number> | null;
  /** The latest memory reading: bytes each owner allocated since the profiler started and still holds (sampled estimates). */
  memory: { at: number; owners: Record<string, number>; pauseMs: number } | null;
  state: ProfilerState;
  /** When the profiler last started: memory counts allocations from then on. */
  since: number | null;
  /** How long the Host paused when the profiler last started; null until it has. */
  startPauseMs: number | null;
  /** Why the Host cannot split itself in this environment; null when it can. */
  error: string | null;
}
/** A function (`name`, file and line in `where`) or, for DSH and the rest, a package (`where` empty), with its time or bytes. */
export interface Hot { name: string; where: string; value: number }
/** Where one owner's main-thread time went over a range, and where its memory sits at the latest reading. */
export interface OwnerDetail { cpu: Hot[]; memory: Hot[]; memoryAt: number | null }
