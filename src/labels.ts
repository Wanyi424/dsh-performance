import type { Group, Kind, PluginInfo, REST } from './contracts';

/** This plugin's own package name: its row says so, and its helper is the collector. */
export const SELF = 'dsh-performance';
/** The five parts of DSH, named for someone using it rather than building it. */
export const GROUP_LABEL: Record<Group, string> = { ui: '界面', gpu: 'GPU', app: '主进程与服务', host: '后台', tools: '启动的程序' };
/** What each part does and when it gets busy: a line under its name, and the paragraph in its details. */
export const GROUP_ABOUT: Record<Group, { note: string; about: string }> = {
  ui: { note: '绘制对话、设置和插件页面', about: 'DSH 窗口里看到的内容都由它绘制，插件的页面也在这里运行。长对话、频繁滚动或复杂页面会让它的 CPU 和内存升高。' },
  gpu: { note: '图形加速与画面合成', about: '借助显卡加速界面绘制并合成画面。动画、视频、高分辨率或多块屏幕会让它更忙。' },
  app: { note: '窗口管理、联网与存储', about: 'DSH 桌面的主进程和它的辅助服务：管理窗口、处理模型请求等联网、管理本地缓存。平时占用很低；持续偏高时，多半是其他部分在频繁与它通信。' },
  host: { note: '运行 Agent、会话和插件', about: '运行 Agent、会话和全部插件的后台进程，Agent 工作或插件计算时会升高。插件没有自己的进程，所以这里按插件拆分的是后台的计算时间和插件分配的内存。' },
  tools: { note: '终端、Agent 命令、MCP 服务等', about: '由 DSH 后台启动的程序，例如终端、Agent 执行的命令、MCP 服务或开发服务器。一个程序启动的子进程合并计算，并计入 DSH 合计。' },
};
/** Each kind of process in the same words; `about` is the paragraph in its details. */
export const KIND: Record<Kind, { label: string; note: string; about: string }> = {
  main: { label: '主进程', note: '管理窗口和其他进程', about: '管理窗口、菜单和其他进程的启停。通常占用很低；持续偏高时，多半是其他进程在频繁与它通信。' },
  renderer: { label: '界面渲染', note: '绘制对话、设置和插件页面', about: GROUP_ABOUT.ui.about },
  gpu: { label: 'GPU 进程', note: '图形加速与画面合成', about: GROUP_ABOUT.gpu.about },
  network: { label: '网络服务', note: '模型请求与联网', about: '处理模型请求和其他联网。模型流式输出、下载文件时会短暂上升。' },
  storage: { label: '存储服务', note: '本地缓存与存储', about: '管理页面使用的本地存储与缓存。' },
  audio: { label: '音频服务', note: '播放与录音', about: '负责声音播放和录音，例如语音输入。' },
  utility: { label: '辅助服务', note: 'Chromium 按需启动的服务', about: 'Chromium 按需启动的内部服务，通常短暂运行。' },
  crashpad: { label: '崩溃报告', note: '异常退出时收集报告', about: '平时几乎不工作，只在 DSH 异常退出时收集崩溃报告。' },
  other: { label: '其他进程', note: 'DSH 桌面的其他进程', about: 'DSH 桌面启动的其他进程。' },
  host: { label: '后台', note: GROUP_ABOUT.host.note, about: GROUP_ABOUT.host.about },
  tool: { label: '程序', note: '由 DSH 后台启动', about: GROUP_ABOUT.tools.about },
};
/**
 * The parts of the Host's CPU that are not a plugin: its other owners, and the rest it cannot split (`rest`). The list shows the
 * last three as one line, `misc`; the Host's details show them apart.
 */
export const OWNER_LABEL: Record<typeof REST[number] | 'rest' | 'misc', { label: string; note: string; about: string }> = {
  core: { label: 'DSH 自身', note: 'Agent 循环、会话、模型请求', about: 'DSH 自己的代码，例如 Agent 循环、会话和模型请求的处理，按代码包细分。插件发起、由 DSH 稍后完成的工作（例如等待模型回复）也算在这里。' },
  gc: { label: '内存回收', note: '释放不再使用的内存', about: 'JavaScript 引擎回收不再使用的内存（垃圾回收）所花的时间。本插件读取插件内存前做的那次回收也计在这里。' },
  other: { label: '其他代码', note: 'Node.js 内部与原生代码', about: '既不在插件目录、也不在 DSH 安装目录中的代码，以及 Node.js 内部和系统调用等原生代码。' },
  rest: { label: '其余工作', note: '文件、网络读写等', about: '后台不在主线程上的工作，例如文件和网络读写、代码编译与内存回收的辅助线程，以及暂停插件统计期间的全部占用。它们无法按插件拆分。' },
  misc: { label: '其他', note: '内存回收、文件读写等', about: '后台里既不属于某个插件、也不是 DSH 自身代码的部分：内存回收、Node.js 内部和系统调用，以及文件、网络读写等其他线程的工作。' },
};
export const PLUGIN_ABOUT = '插件在后台运行的代码，以及它直接调用的 DSH 代码。插件发起、由 DSH 稍后完成的工作（例如等待模型回复）算作「DSH 自身」；文件和网络读写不在主线程，算作「其余工作」。插件的页面运行在「界面」里，不在这里统计。';
/** What an owner is called on the page: a plugin by its own name, the rest by theirs. */
export function ownerName(id: string, plugins: readonly PluginInfo[]) {
  if (id.startsWith('plugin:')) { const pid = id.slice(7); return plugins.find(p => p.id === pid)?.label ?? pid; }
  return OWNER_LABEL[id as keyof typeof OWNER_LABEL]?.label ?? id;
}
