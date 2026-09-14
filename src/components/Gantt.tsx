import { fmtMinutes, type CarRecord, type FailureWindow } from "../sim/engine";

interface GanttProps {
  cars: CarRecord[];
  failures: FailureWindow[];
  pumps: number;
  open: number;
  horizonEnd: number;
}

/** 泵岛时间轴：每泵一行，蓝色为服务区间，红色斜纹为故障停用 */
export default function Gantt({ cars, failures, pumps, open, horizonEnd }: GanttProps) {
  const span = Math.max(horizonEnd - open, 1);
  const pct = (t: number) => ((t - open) / span) * 100;
  const tickStep = span > 12 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let t = Math.ceil(open / tickStep) * tickStep; t <= horizonEnd + 1e-6; t += tickStep) {
    ticks.push(t);
  }
  const byPump: CarRecord[][] = Array.from({ length: pumps }, () => []);
  for (const c of cars) byPump[c.pump].push(c);

  return (
    <div className="gantt">
      <div className="gantt-axis">
        {ticks.map((t) => (
          <span key={t} className="gantt-tick" style={{ left: `${pct(t)}%` }}>
            {fmtMinutes(t)}
          </span>
        ))}
      </div>
      <div className="gantt-body">
        {ticks.map((t) => (
          <div key={t} className="gantt-gridline" style={{ left: `${pct(t)}%` }} />
        ))}
        {byPump.map((list, p) => (
          <div className="gantt-row" key={p}>
            <span className="gantt-label">{p + 1} 号泵</span>
            <div className="gantt-track">
              {failures
                .filter((f) => f.pump === p)
                .map((f, i) => {
                  const fs = Math.max(f.start, open);
                  const fe = Math.min(f.end, horizonEnd);
                  if (fe <= fs) return null;
                  return (
                    <div
                      key={`f${i}`}
                      className="gantt-failure"
                      style={{ left: `${pct(fs)}%`, width: `${pct(fe) - pct(fs)}%` }}
                      title={`故障停用 ${fmtMinutes(f.start)}–${fmtMinutes(f.end)}`}
                    />
                  );
                })}
              {list.map((c) => (
                <div
                  key={c.id}
                  className="gantt-car"
                  style={{
                    left: `${pct(c.start)}%`,
                    width: `${Math.max(pct(c.end) - pct(c.start), 0.35)}%`,
                  }}
                  title={`#${c.id} 到达 ${fmtMinutes(c.arrival)} · 等待 ${c.wait.toFixed(1)} 分 · 服务 ${fmtMinutes(c.start)}–${fmtMinutes(c.end)}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="gantt-legend">
        <span>
          <i className="legend-car" /> 服务中
        </span>
        <span>
          <i className="legend-failure" /> 故障停用
        </span>
        <span className="legend-note">时间轴终点取营业结束与最后一车完成时间的较晚者</span>
      </div>
    </div>
  );
}
