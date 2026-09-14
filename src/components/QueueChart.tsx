import { fmtMinutes, type QueuePoint } from "../sim/engine";

interface QueueChartProps {
  series: QueuePoint[];
  open: number;
  horizonEnd: number;
  maxQueue: number;
}

/** 排队长度随时间变化的阶梯图（SVG，无第三方依赖） */
export default function QueueChart({ series, open, horizonEnd, maxQueue }: QueueChartProps) {
  const W = 880;
  const H = 210;
  const padL = 36;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const span = Math.max(horizonEnd - open, 1);
  const x = (t: number) => padL + ((t - open) / span) * (W - padL - padR);
  const yMax = Math.max(maxQueue, 1);
  const y = (q: number) => H - padB - (q / yMax) * (H - padT - padB);

  let line = "";
  series.forEach((p, i) => {
    const px = x(p.t);
    const py = y(p.q);
    line += i === 0 ? `M ${px} ${py}` : ` H ${px} V ${py}`;
  });
  line += ` H ${x(horizonEnd)}`;
  const area = `${line} V ${y(0)} L ${x(open)} ${y(0)} Z`;

  const tickStep = span > 12 * 60 ? 120 : 60;
  const xTicks: number[] = [];
  for (let t = Math.ceil(open / tickStep) * tickStep; t <= horizonEnd + 1e-6; t += tickStep) {
    xTicks.push(t);
  }
  const yTicks: number[] = [];
  const yStep = yMax <= 6 ? 1 : Math.ceil(yMax / 5);
  for (let q = 0; q <= yMax; q += yStep) yTicks.push(q);
  if (yTicks[yTicks.length - 1] !== yMax) yTicks.push(yMax);

  return (
    <svg className="queue-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="排队长度曲线">
      {yTicks.map((q) => (
        <g key={q}>
          <line className="qc-grid" x1={padL} x2={W - padR} y1={y(q)} y2={y(q)} />
          <text className="qc-ylabel" x={padL - 6} y={y(q) + 4} textAnchor="end">
            {q}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={t} className="qc-xlabel" x={x(t)} y={H - 8} textAnchor="middle">
          {fmtMinutes(t)}
        </text>
      ))}
      <path className="qc-area" d={area} />
      <path className="qc-line" d={line} />
    </svg>
  );
}
