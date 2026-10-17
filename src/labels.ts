import type { Group, Kind } from './contracts';

export const GROUP_LABEL: Record<Group, string> = { ui: '界面渲染', gpu: 'GPU', app: '主进程与服务', host: '后台服务', tools: '工具进程' };
/**
 * What each kind of process does and when it gets busy, in the words of someone using DSH rather than building Electron.
 * `note` fits under a row name; `about` is the paragraph in the details view.
 */
export const KIND: Record<Kind, { label: string; note: string; about: string }> = {
  main: { label: '主进程', note: '窗口与应用生命周期', about: '管理窗口、菜单和其他进程的启停。通常占用很低；持续偏高时，多半是其他进程在频繁与它通信。' },
  renderer: { label: '界面渲染', note: '绘制对话、设置等页面', about: '绘制对话、设置和插件页面，也运行这些页面里的脚本。长对话、频繁滚动或复杂页面会让它的 CPU 和内存升高。' },
  gpu: { label: 'GPU 进程', note: '图形加速与画面合成', about: '负责界面绘制的硬件加速和画面合成。动画、视频、高分辨率或多块屏幕会让它更忙。' },
  network: { label: '网络服务', note: '模型请求与联网', about: '处理模型请求和其他联网。模型流式输出、下载文件时会短暂上升。' },
  storage: { label: '存储服务', note: '本地缓存与存储', about: '管理页面使用的本地存储与缓存。' },
  audio: { label: '音频服务', note: '播放与录音', about: '负责声音播放和录音，例如语音输入。' },
  utility: { label: '辅助服务', note: 'Chromium 内部服务', about: 'Chromium 按需启动的内部服务，通常短暂运行。' },
  crashpad: { label: '崩溃报告', note: '异常退出时收集报告', about: '平时几乎不工作，只在 DSH 异常退出时收集崩溃报告。' },
  other: { label: '辅助进程', note: 'DSH 桌面的其他进程', about: 'DSH 桌面启动的其他进程。' },
  host: { label: '后台服务', note: '运行 Agent、插件与会话', about: '运行 Agent、插件和会话。Agent 工作、插件计算时会升高；它启动的程序单独列在「工具进程」中。' },
  tool: { label: '工具进程', note: '由 DSH 后台启动', about: '由 DSH 后台启动的程序，例如终端、Agent 执行的命令、MCP 服务或开发服务器。它启动的子进程合并在一起计算。' },
};
