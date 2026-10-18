import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call } from './api';
import { CADENCE, PROFILER, type Group, type PluginInfo } from './contracts';
import type { Controller } from './controller';
import { Details } from './details';
import { ms, span } from './format';
import { Alert, Info, Refresh } from './icons';
import { ownerName } from './labels';
import { Now } from './now';
import { OwnerDetails } from './owner';
import { PluginSection } from './plugin-section';
import { Processes } from './processes';
import { Timeline } from './timeline';
import { Dialog, Segmented, useStored } from './ui';
import css from './styles.css';

const RANGES = [{ value: '5m', label: '5 分钟', ms: 300_000 }, { value: '15m', label: '15 分钟', ms: 900_000 }, { value: '1h', label: '1 小时', ms: 3_600_000 }] as const;
type Range = typeof RANGES[number]['value'];

export function Page({ controller: c }: { controller: Controller }) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot);
  useEffect(() => c.attach(true), [c]);
  const root = useRef<HTMLDivElement>(null);
  const [range, setRange] = useStored<Range>('range', '15m', RANGES.map(r => r.value));
  const [about, setAbout] = useState(false), [open, setOpen] = useState<string | null>(null), [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => { void call<PluginInfo[]>('plugins').then(setPlugins, () => {}); }, []);
  // Pointing at a component anywhere (the share bar, the legend, a process row) highlights it in every chart. It is a style
  // on the root, not React state, so the charts do not re-render for it.
  const focus = useCallback((group: Group | null) => { const el = root.current; if (!el) return; if (group) el.dataset.focus = group; else delete el.dataset.focus; }, []);
  const show = useCallback((key: string) => { focus(null); setOpen(key); }, [focus]);
  const name = useCallback((id: string) => ownerName(id, plugins), [plugins]);
  const sample = s.sample, end = Date.now(), start = end - RANGES.find(r => r.value === range)!.ms, stale = !!s.error, split = sample?.attribution;

  return <div ref={root} className="dpm-root"><style>{css}</style>
    <header className="dpm-bar">
      <h1>运行监控</h1>
      {!stale && <span className="dpm-status" data-state={sample ? 'live' : 'connecting'}><i key={sample?.time} />{sample ? `实时 · 每 ${CADENCE.page / 1000} 秒更新` : '正在连接…'}</span>}
      <Segmented label="时间范围" value={range} options={RANGES.map(({ value, label }) => ({ value, label }))} onChange={setRange} />
    </header>
    <div className="dpm-scroll"><main className="dpm-content">
      {s.error && <div className="dpm-banner" role="alert"><Alert /><p><strong>{s.error}</strong><span>数据暂停更新，{CADENCE.failed / 1000} 秒后自动重试。</span></p>
        <button type="button" className="dpm-button" onClick={c.retry}><Refresh />重试</button></div>}
      <div className="dpm-stage" data-stale={stale || undefined}>
        <Now sample={sample} onFocus={focus} onOpen={show} />
        <Timeline points={s.points} response={s.response} programs={s.tracked.programs} start={start} end={end} ownerName={name} onFocus={focus} />
      </div>
      <Processes sample={sample} tracked={s.tracked} start={start} end={end} stale={stale} plugins={plugins} onFocus={focus} onOpen={show} />
      <PluginSection plugins={plugins} sample={sample} points={s.points} tracked={s.tracked} start={start} end={end} stale={stale} onFocus={focus} onOpen={show} />
      <footer className="dpm-foot">
        <button type="button" className="dpm-link" onClick={() => setAbout(true)}><Info />统计口径</button>
        {sample && <span>DSH 已运行 {span(sample.time - sample.started)}</span>}
        {sample && sample.memory === null && <span data-tone="warn">当前 Windows 版本不提供专用工作集，内存无法显示</span>}
      </footer>
    </main></div>
    {open && (open.startsWith('owner:')
      ? <OwnerDetails id={open.slice(6)} plugins={plugins} sample={sample} tracked={s.tracked} start={start} end={end} onClose={() => setOpen(null)} />
      : <Details id={open} sample={sample} tracked={s.tracked} start={start} end={end} onClose={() => setOpen(null)} />)}
    {about && <Dialog title="统计口径" onClose={() => setAbout(false)}>
      <dl className="dpm-about">
        <dt>统计范围</dt>
        <dd>DSH 桌面的主进程、界面渲染、GPU、网络等服务和后台服务，以及后台启动的全部程序：终端、Agent 执行的命令、MCP 服务等。父进程已经退出的程序无法确认来源，不计入。</dd>
        <dt>CPU</dt>
        <dd>占整台电脑算力的比例{sample ? `，${sample.cores} 个逻辑处理器全部满载为 100%` : ''}，与任务管理器一致。平均值按时间加权。「整机」是同一时段内所有程序合计的 CPU 使用率。</dd>
        <dt>内存</dt>
        <dd>专用工作集，即进程独占的物理内存，与任务管理器「详细信息」页的「内存(专用工作集)」一致。「整机」是已使用的物理内存（总量减去可用）。</dd>
        <dt>界面响应</dt>
        <dd>卡顿：DSH 窗口有一帧被拖延超过 50 毫秒，期间画面停住、无法响应输入。交互延迟：从点击或按键到界面画出反馈的时间，超过 200 毫秒会明显感到迟钝。只在窗口可见时记录；打开本页期间，本页自身的绘制也会计入。</dd>
        <dt>插件占用</dt>
        <dd>插件都运行在 DSH 后台进程里，系统无法分开计量，因此后台在自己进程里采样：窗口可见时每 {PROFILER.sampleMs} 毫秒记录一次主线程的调用栈，每个样本归到调用栈上离它最近的插件代码，没有插件代码就算作 DSH 内核。插件触发、但由 DSH 稍后异步完成的工作没有插件的调用栈，会算进 DSH 内核；文件和网络读写不在主线程，不计入；界面部分不在统计范围内。内存从 DSH 启动起每分配约 {PROFILER.heapBytes / 1024} KB 抽样记录一次，每 {PROFILER.memoryEveryMs / 60_000} 分钟读取一次各插件分配、目前仍占用的部分；本插件加载之前分配的不计入。插件自带的程序按所在目录归属，实时统计。</dd>
        <dt>程序启停</dt>
        <dd>根据每次读数推断：启动时间取进程自身的创建时间，退出时间是最后一次看到它运行的时刻。窗口不可见期间不采样，期间启动又退出的程序不会出现。</dd>
        <dt>数据保留</dt>
        <dd>最近 1 小时，只保存在内存中，不写入磁盘、不上传，关闭 DSH 后清空。进程趋势按 15 秒汇总。窗口不可见时暂停采集，图上留出空档。</dd>
        <dt>采集开销</dt>
        <dd>由一个独立的小程序按需读取进程信息，闲置 15 秒后自动退出；它的占用显示在「插件」分区「运行监控」一行的自带进程中，不计入 DSH 合计。插件归属的采样在后台进程里进行：启动采样要扫描一遍后台的内存{split?.startPauseMs != null ? `，本次启动时后台停顿 ${ms(split.startPauseMs)}` : ''}，所以窗口隐藏后仍保持 {PROFILER.lingerMs / 60_000} 分钟再停止；读取内存前要做一次完整的垃圾回收{split?.memory ? `，最近一次后台停顿 ${ms(split.memory.pauseMs)}` : ''}。停顿只发生在后台，界面不受影响。</dd>
      </dl>
    </Dialog>}
  </div>;
}
