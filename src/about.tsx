import React from 'react';
import { CADENCE, HISTORY_MS, PROFILER, type Sample } from './contracts';
import { Head } from './details';
import { bytes, clockShort, cpu, duration, span } from './format';
import { SLOW_INTERACTION_MS } from './insights';
import { RULES } from './verdict';

const MB = 1024 ** 2, pct = (share: number) => `${Math.round(share * 100)}%`;

/** How the numbers are made, in the order a reader asks: what is counted, what each figure means, when the page speaks up, and the cost. */
export function About({ sample }: { sample?: Sample }) {
  const a = sample?.attribution, collector = sample?.collector;
  // Read from the rules themselves, so what the page says and why never drift apart.
  const rules: [string, string, 'warn' | 'info'][] = [
    ['DSH 占用很高', `近 ${RULES.high.ms / 60_000} 分钟平均占整机 CPU ≥ ${RULES.high.cpu}%`, 'warn'],
    ['界面出现卡顿', `近 ${RULES.stutter.ms / 60_000} 分钟卡顿 ≥ ${RULES.stutter.count} 次，或有一次 ≥ ${RULES.stutter.longestMs / 1000} 秒`, 'warn'],
    ['DSH 内存持续上涨', `近 ${RULES.growth.ms / 60_000} 分钟增加 ≥ ${RULES.growth.bytes / MB} MB；至少观察 ${RULES.growth.minMs / 60_000} 分钟才判断，不含 DSH 启动的程序`, 'warn'],
    ['电脑内存紧张', `整机内存已用 ≥ ${pct(RULES.tight.used)}，且 DSH 占其中 ≥ ${pct(RULES.tight.share)}`, 'warn'],
    ['DSH 正在忙', `近 ${RULES.busy.ms / 1000} 秒平均占整机 CPU ≥ ${RULES.busy.cpu}%，通常是 Agent 在工作`, 'info'],
    ['电脑很忙，但主要不是 DSH', `近 ${RULES.machine.ms / 1000} 秒整机 CPU ≥ ${RULES.machine.cpu}%，DSH 不到其中 ${pct(RULES.machine.share)}`, 'info'],
  ];
  return <>
    <Head title="这些数字怎么来的" meta="统计范围、算法、提示规则和本插件自己的开销" />
    <div className="dpm-prose">
      <section><h3>统计了什么</h3>
        <p>DSH 桌面的全部进程：界面、GPU、主进程与网络、存储等服务、后台，以及后台启动的程序（终端、Agent 执行的命令、MCP 服务等）。父进程已经退出的程序无法确认来源，不计入。本插件的采集器不计入 DSH 合计，单独列在「DSH 性能监控」插件下。</p></section>
      <section><h3>CPU 和内存</h3>
        <p>CPU 是占整台电脑算力的比例{sample ? `，${sample.cores} 个逻辑处理器全部满载为 100%` : ''}，和任务管理器一致。「谁在占用」里的 CPU 是所选时间内按时间加权的平均值，所以排序不会随每次读数跳动；程序按它运行的那段时间平均。</p>
        <p>内存是进程独占的物理内存，即任务管理器「详细信息」页的「内存(专用工作集)」。整机内存是已经使用的物理内存，即总量减去可用。</p></section>
      <section><h3>什么时候会提示</h3>
        <table className="dpm-rules"><thead><tr><th scope="col">提示</th><th scope="col">条件</th><th scope="col">级别</th></tr></thead>
          <tbody>{rules.map(([title, rule, level]) => <tr key={title}><th scope="row">{title}</th><td>{rule}</td>
            <td><span className="dpm-level" data-level={level}>{level === 'warn' ? '需要留意' : '告知'}</span></td></tr>)}</tbody></table>
        <p>几项同时成立时，先说需要留意的。侧栏入口只在「需要留意」时亮起圆点。</p></section>
      <section><h3>插件是怎么统计的</h3>
        <p>插件没有自己的进程，都运行在后台进程里，系统无法分开计量。所以后台从 DSH 启动起持续自我抽样：每 {PROFILER.sampleMs} 毫秒记录一次主线程正在执行的代码，归到调用栈上离它最近的插件；没有插件代码就算作「DSH 自身」。插件发起、由 DSH 稍后完成的工作也算作 DSH 自身；文件和网络读写不在主线程，算作「其余工作」。插件的页面运行在「界面」里，不在统计范围内。</p>
        <p>插件的内存是抽样估算：每分配约 {PROFILER.heapBytes / 1024} KB 记录一次分配位置，窗口可见时每 {PROFILER.memoryEveryMs / 60_000} 分钟读取一次各插件分配、仍在占用的部分{a?.since ? `，自 ${clockShort(a.since)} 起统计` : ''}。比本插件更早加载的插件，启动时分配的内存不在其中。</p></section>
      <section><h3>界面响应</h3>
        <p>卡顿：DSH 窗口有一帧被拖住超过 50 毫秒，期间画面停住、点了没反应。操作响应：从点击或按键到画面给出反馈的时间，超过 {SLOW_INTERACTION_MS} 毫秒会明显感到迟钝。两者都由浏览器事件推送，只在窗口可见时记录；打开本页期间，本页自身的绘制也计入。</p></section>
      <section><h3>本插件自己的开销</h3>
        <p>采集器是一个只读的小程序：侧栏每 {CADENCE.idle / 1000} 秒、打开本页时每 {CADENCE.page / 1000} 秒读取一次进程信息，窗口隐藏后暂停，闲置 15 秒自动退出{collector ? `；此刻占用 CPU ${cpu(collector.cpu)}、内存 ${bytes(collector.memory)}` : ''}。</p>
        <p>插件统计的持续抽样开销低于系统能计量的精度。开始统计时后台会停顿一次{a?.startPauseMs != null ? `（这次是 ${duration(a.startPauseMs)}）` : ''}；每次读取插件内存前要做一次完整的内存回收{a?.memory ? `（最近一次停顿 ${duration(a.memory.pauseMs)}）` : ''}。停顿只发生在后台，界面不受影响。不需要时，可以在「后台」的详情里暂停插件统计。</p></section>
      <section><h3>数据保存在哪里</h3>
        <p>只保存在内存里，保留最近 {span(HISTORY_MS)}，不写入磁盘、不上传，关闭 DSH 后清空。窗口不可见时暂停采集，图上留出空档。复制诊断报告时只列程序名，不含命令行和文件路径。</p></section>
    </div>
  </>;
}
