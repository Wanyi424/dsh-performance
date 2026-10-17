export const API_PATH = '/api/dsh-performance';
export const PANEL = 'dsh-performance';
/** Trend history and long tasks are kept this long, in memory only. */
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

/** Chart order, bottom to top: the stable desktop parts first, the most volatile (tool programs) last. */
export const GROUPS = ['ui', 'gpu', 'app', 'host', 'tools'] as const;
export type Group = typeof GROUPS[number];
export type Kind = 'main' | 'renderer' | 'gpu' | 'network' | 'storage' | 'audio' | 'utility' | 'crashpad' | 'other' | 'host' | 'tool';
export interface ProcessMetric {
  pid: number; parent: number; created: number; name: string; kind: Kind; group: Group; threads: number;
  /** Utility service name, Electron type or tool command line. */
  detail: string | null;
  /** For a tool process whose executable ships inside an installed plugin: that plugin's package name. */
  plugin?: string | null;
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
}
/** One history point: per-group sums in GROUPS order, and the machine totals at that moment. */
export interface Point { time: number; intervalMs: number | null; cpu: number[] | null; memory: number[] | null; systemCpu: number | null; systemMemory: number | null }

/** An installed plugin: a profile bundle that is not one of DSH's own. */
export interface PluginInfo { id: string; label: string; version: string }

/** Analysis lengths offered on the page; the Host refuses others. */
export const ANALYSIS_SECONDS = [10, 30, 60] as const;
/** Where the Host spent a stretch of its main thread, and the memory allocated meanwhile that was still alive at the end. */
export interface Analysis {
  durationMs: number; busyMs: number;
  /** Estimated bytes allocated during the analysis and still alive after the closing garbage collection; null when not measured. */
  memory: number | null;
  owners: Owner[];
}
export interface Hot { name: string; where: string; value: number }
/** A plugin, DSH itself, garbage collection or everything else; `modules` breaks DSH down by package. */
export interface Owner {
  id: string; kind: 'plugin' | 'core' | 'gc' | 'other'; label: string;
  cpuMs: number; memory: number | null;
  functions: Hot[]; allocations: Hot[]; modules?: { name: string; cpuMs: number; memory: number }[];
}
export type AnalysisState =
  | { state: 'idle'; last?: { startedAt: number; seconds: number; result: Analysis } }
  | { state: 'running'; startedAt: number; seconds: number; last?: { startedAt: number; seconds: number; result: Analysis } }
  | { state: 'done'; startedAt: number; seconds: number; result: Analysis }
  | { state: 'failed'; startedAt: number; seconds: number; error: string };
