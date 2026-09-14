import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  InputNumber,
  Popconfirm,
  Select,
  Table,
  TimePicker,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  buildSlots,
  fmtMinutes,
  normalizeConfig,
  simulate,
  validateConfig,
  MAX_PUMPS,
  type CarRecord,
  type RawConfig,
  type SimConfig,
  type SimMetrics,
  type SimResult,
} from "./sim/engine";
import Gantt from "./components/Gantt";
import QueueChart from "./components/QueueChart";

/* ---------- 时间工具 ---------- */

function hm(text: string): Dayjs {
  const [h, m] = text.split(":").map(Number);
  return dayjs().startOf("day").hour(h).minute(m);
}

function toMin(d: Dayjs | null): number | null {
  return d ? d.hour() * 60 + d.minute() : null;
}

function minToDayjs(min: number): Dayjs {
  return dayjs()
    .startOf("day")
    .hour(Math.floor(min / 60))
    .minute(min % 60);
}

/* ---------- 类型与常量 ---------- */

interface FailureRow {
  pump: number;
  start: Dayjs | null;
  end: Dayjs | null;
}

interface RunState {
  key: string;
  config: SimConfig;
  result: SimResult;
}

interface Scenario {
  id: string;
  name: string;
  savedAt: string;
  config: SimConfig;
  metrics: SimMetrics;
  fingerprint: string;
}

const STORAGE_KEY = "gas-queue-sandbox-scenarios";

const DEFAULT_ARRIVALS = [6, 10, 18, 30, 42, 36, 22, 18, 24, 38, 46, 34, 20, 10];

function defaultFailures(): FailureRow[] {
  return [{ pump: 1, start: hm("12:00"), end: hm("12:40") }];
}

function loadScenarios(): Scenario[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Scenario[];
    return Array.isArray(list) ? list.slice(0, 3) : [];
  } catch {
    return [];
  }
}

function nextName(list: Scenario[]): string {
  for (const ch of ["A", "B", "C"]) {
    if (!list.some((s) => s.name === `方案 ${ch}`)) return `方案 ${ch}`;
  }
  return `方案 ${list.length + 1}`;
}

/* ---------- 对比表定义 ---------- */

const COMPARE_ROWS: {
  label: string;
  get: (m: SimMetrics) => number;
  fmt: (v: number) => string;
  best: "min" | "max" | null;
}[] = [
  { label: "平均等待", get: (m) => m.avgWait, fmt: (v) => `${v.toFixed(1)} 分`, best: "min" },
  { label: "最长等待", get: (m) => m.maxWait, fmt: (v) => `${v.toFixed(1)} 分`, best: "min" },
  { label: "最长队伍", get: (m) => m.maxQueue, fmt: (v) => `${v} 辆`, best: "min" },
  { label: "泵岛利用率", get: (m) => m.utilization, fmt: (v) => `${(v * 100).toFixed(1)}%`, best: "max" },
  { label: "完成车数", get: (m) => m.completed, fmt: (v) => `${v} 辆`, best: "max" },
  { label: "营业外加班", get: (m) => m.overtime, fmt: (v) => `${v.toFixed(0)} 分`, best: "min" },
];

/* ---------- 主组件 ---------- */

export default function App() {
  const [open, setOpen] = useState<Dayjs | null>(hm("07:00"));
  const [close, setClose] = useState<Dayjs | null>(hm("21:00"));
  const [pumps, setPumps] = useState<number | null>(4);
  const [arrivals, setArrivals] = useState<(number | null)[]>(DEFAULT_ARRIVALS);
  const [serviceMin, setServiceMin] = useState<number | null>(3);
  const [serviceMax, setServiceMax] = useState<number | null>(8);
  const [seed, setSeed] = useState<number | null>(42);
  const [failures, setFailures] = useState<FailureRow[]>(defaultFailures);
  const [run, setRun] = useState<RunState | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>(loadScenarios);

  const openMin = toMin(open);
  const closeMin = toMin(close);

  const slots = useMemo(
    () =>
      openMin !== null && closeMin !== null && closeMin > openMin
        ? buildSlots(openMin, closeMin)
        : [],
    [openMin, closeMin],
  );

  function resizeArrivals(n: number) {
    setArrivals((prev) => {
      if (prev.length === n) return prev;
      if (prev.length > n) return prev.slice(0, n);
      return [...prev, ...Array<number | null>(n - prev.length).fill(0)];
    });
  }

  // 营业时段变化时保持到车量数组与时段数一致
  useEffect(() => {
    if (slots.length !== arrivals.length) resizeArrivals(slots.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.length]);

  const raw: RawConfig = useMemo(
    () => ({
      open: openMin,
      close: closeMin,
      pumps,
      arrivals: slots.map((_, i) => arrivals[i] ?? null),
      serviceMin,
      serviceMax,
      seed,
      failures: failures.map((f) => ({ pump: f.pump, start: toMin(f.start), end: toMin(f.end) })),
    }),
    [openMin, closeMin, pumps, slots, arrivals, serviceMin, serviceMax, seed, failures],
  );

  const errors = useMemo(() => validateConfig(raw), [raw]);
  const config = useMemo(() => normalizeConfig(raw), [raw]);
  const currentKey = config ? JSON.stringify(config) : `invalid:${JSON.stringify(raw)}`;
  const stale = run !== null && run.key !== currentKey;

  function handleRun() {
    if (!config) return;
    setRun({ key: JSON.stringify(config), config, result: simulate(config) });
  }

  function handleReset() {
    setOpen(hm("07:00"));
    setClose(hm("21:00"));
    setPumps(4);
    setArrivals(DEFAULT_ARRIVALS);
    setServiceMin(3);
    setServiceMax(8);
    setSeed(42);
    setFailures(defaultFailures());
  }

  /* ---------- 方案保存 / 对比 ---------- */

  function persist(next: Scenario[]) {
    setScenarios(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function saveScenario() {
    if (!run || stale || scenarios.length >= 3) return;
    persist([
      ...scenarios,
      {
        id: `s-${Date.now()}-${scenarios.length}`,
        name: nextName(scenarios),
        savedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        config: run.config,
        metrics: run.result.metrics,
        fingerprint: run.result.fingerprint,
      },
    ]);
  }

  function loadScenario(s: Scenario) {
    setOpen(minToDayjs(s.config.open));
    setClose(minToDayjs(s.config.close));
    setPumps(s.config.pumps);
    setArrivals([...s.config.arrivals]);
    setServiceMin(s.config.serviceMin);
    setServiceMax(s.config.serviceMax);
    setSeed(s.config.seed);
    setFailures(
      s.config.failures.map((f) => ({
        pump: f.pump,
        start: minToDayjs(f.start),
        end: minToDayjs(f.end),
      })),
    );
  }

  /* ---------- 渲染 ---------- */

  const pumpOptions = Array.from({ length: Math.max(pumps ?? 0, 0) }, (_, i) => ({
    value: i,
    label: `${i + 1} 号泵`,
  }));

  const carColumns = [
    { title: "车辆", key: "id", render: (_: unknown, r: CarRecord) => `#${r.id}` },
    { title: "到达时刻", key: "arrival", render: (_: unknown, r: CarRecord) => fmtMinutes(r.arrival) },
    { title: "开始服务", key: "start", render: (_: unknown, r: CarRecord) => fmtMinutes(r.start) },
    { title: "泵岛", key: "pump", render: (_: unknown, r: CarRecord) => `${r.pump + 1} 号` },
    { title: "等待(分)", key: "wait", render: (_: unknown, r: CarRecord) => r.wait.toFixed(1) },
    { title: "服务(分)", key: "duration", render: (_: unknown, r: CarRecord) => r.duration.toFixed(1) },
    { title: "完成时刻", key: "end", render: (_: unknown, r: CarRecord) => fmtMinutes(r.end) },
  ];

  const m = run?.result.metrics;

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">油站值班主管 · 高峰排队沙盘</p>
            <h1>高峰排队沙盘</h1>
            <p className="subtitle">
              设定营业时段、泵岛数量、分时到车量、服务时长范围、随机种子与故障时段，
              按时间顺序逐车模拟分配泵岛，观察排队、等待、泵岛占用与时间轴。
              相同配置与种子重复运行结果完全一致；任何配置变更都会立即使旧结果失效。
            </p>
          </div>
        </header>

        <div className="layout">
          {/* ---------- 配置面板 ---------- */}
          <aside className="panel config-panel">
            <h2>沙盘配置</h2>

            <div className="field">
              <span className="field-label">营业时段</span>
              <div className="time-range">
                <TimePicker
                  value={open}
                  onChange={(d) => setOpen(d)}
                  format="HH:mm"
                  minuteStep={5}
                  allowClear={false}
                  placeholder="开始"
                />
                <span className="tilde">–</span>
                <TimePicker
                  value={close}
                  onChange={(d) => setClose(d)}
                  format="HH:mm"
                  minuteStep={5}
                  allowClear={false}
                  placeholder="结束"
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <span className="field-label">泵岛数量（座）</span>
                <InputNumber value={pumps} onChange={(v) => setPumps(v)} placeholder={`1–${MAX_PUMPS}`} />
              </div>
              <div className="field">
                <span className="field-label">随机种子</span>
                <InputNumber value={seed} onChange={(v) => setSeed(v)} placeholder="非负整数" />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <span className="field-label">服务时长下限（分）</span>
                <InputNumber value={serviceMin} onChange={(v) => setServiceMin(v)} step={0.5} placeholder="如 3" />
              </div>
              <div className="field">
                <span className="field-label">服务时长上限（分）</span>
                <InputNumber value={serviceMax} onChange={(v) => setServiceMax(v)} step={0.5} placeholder="如 8" />
              </div>
            </div>

            <div className="field">
              <span className="field-label">分时到车量（辆 / 时段，共 {slots.length} 段）</span>
              {slots.length === 0 ? (
                <p className="hint">请先设置有效的营业时段（结束需晚于开始）。</p>
              ) : (
                <div className="slots-grid">
                  {slots.map((s, i) => (
                    <label className="slot-field" key={`${s.start}-${s.end}`}>
                      <span>
                        {fmtMinutes(s.start)}–{fmtMinutes(s.end)}
                      </span>
                      <InputNumber
                        value={arrivals[i] ?? null}
                        onChange={(v) =>
                          setArrivals((prev) => prev.map((old, j) => (j === i ? v : old)))
                        }
                        placeholder="辆"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <span className="field-label">单泵故障时段（故障期间该泵完全停用）</span>
              {failures.length === 0 && <p className="hint">暂无故障时段。</p>}
              {failures.map((f, i) => (
                <div className="failure-row" key={i}>
                  <Select
                    value={f.pump}
                    onChange={(v) =>
                      setFailures((prev) => prev.map((old, j) => (j === i ? { ...old, pump: v } : old)))
                    }
                    options={pumpOptions}
                    style={{ width: 96 }}
                  />
                  <TimePicker
                    value={f.start}
                    onChange={(d) =>
                      setFailures((prev) => prev.map((old, j) => (j === i ? { ...old, start: d } : old)))
                    }
                    format="HH:mm"
                    minuteStep={5}
                    allowClear={false}
                  />
                  <span className="tilde">–</span>
                  <TimePicker
                    value={f.end}
                    onChange={(d) =>
                      setFailures((prev) => prev.map((old, j) => (j === i ? { ...old, end: d } : old)))
                    }
                    format="HH:mm"
                    minuteStep={5}
                    allowClear={false}
                  />
                  <Button
                    size="small"
                    danger
                    onClick={() => setFailures((prev) => prev.filter((_, j) => j !== i))}
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button
                type="dashed"
                size="small"
                disabled={pumpOptions.length === 0}
                onClick={() =>
                  setFailures((prev) => [
                    ...prev,
                    { pump: 0, start: open ?? hm("12:00"), end: open ?? hm("12:30") },
                  ])
                }
              >
                + 添加故障时段
              </Button>
            </div>

            {errors.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="当前配置不能运行"
                description={
                  <ul className="error-list">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <div className="run-row">
              <Button type="primary" size="large" disabled={errors.length > 0} onClick={handleRun}>
                运行沙盘
              </Button>
              <Button onClick={handleReset}>重置示例</Button>
              {run && !stale && (
                <span title={scenarios.length >= 3 ? "最多保存 3 个方案，请先删除" : undefined}>
                  <Button onClick={saveScenario} disabled={scenarios.length >= 3}>
                    保存为方案（{scenarios.length}/3）
                  </Button>
                </span>
              )}
            </div>
          </aside>

          {/* ---------- 结果区 ---------- */}
          <section className="results">
            {!run && (
              <div className="panel empty-panel">
                <Empty description="配置完成后点击「运行沙盘」，这里将显示逐车分配结果" />
              </div>
            )}

            {run && stale && (
              <Alert
                type="warning"
                showIcon
                message="配置已变更，以下运行结果已失效"
                description="旧结果不再对应当前配置，请重新点击「运行沙盘」生成新结果。"
              />
            )}

            {run && m && (
              <div className={stale ? "stale" : undefined}>
                <div className="metrics">
                  <article className="metric">
                    <span>平均等待</span>
                    <strong>{m.avgWait.toFixed(1)}</strong>
                    <em>分钟</em>
                  </article>
                  <article className="metric">
                    <span>最长队伍</span>
                    <strong>{m.maxQueue}</strong>
                    <em>辆</em>
                  </article>
                  <article className="metric">
                    <span>泵岛利用率</span>
                    <strong>{(m.utilization * 100).toFixed(1)}%</strong>
                    <em>忙时 / 全程</em>
                  </article>
                  <article className="metric">
                    <span>完成车数</span>
                    <strong>{m.completed}</strong>
                    <em>共到 {m.total} 辆</em>
                  </article>
                </div>

                <p className="meta-line">
                  最长等待 {m.maxWait.toFixed(1)} 分 · 营业外加班 {m.overtime.toFixed(0)} 分 · 结果指纹{" "}
                  <code>#{run.result.fingerprint}</code>
                  <span className="hint-inline">（相同配置与种子重复运行，指纹不变）</span>
                </p>

                <div className="panel">
                  <h3>泵岛占用时间轴</h3>
                  <Gantt
                    cars={run.result.cars}
                    failures={run.config.failures}
                    pumps={run.config.pumps}
                    open={run.config.open}
                    horizonEnd={m.horizonEnd}
                  />
                </div>

                <div className="panel">
                  <h3>排队长度变化</h3>
                  <QueueChart
                    series={run.result.queueSeries}
                    open={run.config.open}
                    horizonEnd={m.horizonEnd}
                    maxQueue={m.maxQueue}
                  />
                </div>

                <div className="panel">
                  <h3>逐车分配明细</h3>
                  <Table<CarRecord>
                    rowKey="id"
                    size="small"
                    columns={carColumns}
                    dataSource={run.result.cars}
                    pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (t) => `共 ${t} 车` }}
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ---------- 方案对比 ---------- */}
        <section className="panel scenario-section">
          <div className="section-head">
            <h2>方案对比</h2>
            <span className="hint">已保存 {scenarios.length}/3（保存在本机浏览器）</span>
          </div>
          {scenarios.length === 0 && (
            <p className="hint">运行沙盘后点击「保存为方案」，最多保存 3 个，在此并排比较。</p>
          )}
          <div className="scenario-cards">
            {scenarios.map((s) => (
              <div className="scenario-card" key={s.id}>
                <input
                  className="scenario-name"
                  value={s.name}
                  onChange={(e) =>
                    persist(scenarios.map((old) => (old.id === s.id ? { ...old, name: e.target.value } : old)))
                  }
                />
                <p className="scenario-meta">
                  {fmtMinutes(s.config.open)}–{fmtMinutes(s.config.close)} · {s.config.pumps} 泵 · 种子{" "}
                  {s.config.seed} · 故障 {s.config.failures.length} 段
                </p>
                <p className="scenario-meta">指纹 #{s.fingerprint} · {s.savedAt}</p>
                <div className="scenario-actions">
                  <Button size="small" onClick={() => loadScenario(s)}>
                    载入配置
                  </Button>
                  <Popconfirm
                    title={`删除「${s.name}」？`}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => persist(scenarios.filter((old) => old.id !== s.id))}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>

          {scenarios.length >= 2 && (
            <table className="compare">
              <thead>
                <tr>
                  <th>指标</th>
                  {scenarios.map((s) => (
                    <th key={s.id}>{s.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => {
                  const values = scenarios.map((s) => row.get(s.metrics));
                  const bestValue =
                    row.best === "min"
                      ? Math.min(...values)
                      : row.best === "max"
                        ? Math.max(...values)
                        : null;
                  return (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      {scenarios.map((s, i) => (
                        <td
                          key={s.id}
                          className={bestValue !== null && values[i] === bestValue ? "best" : undefined}
                        >
                          {row.fmt(values[i])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {scenarios.length === 1 && <p className="hint">再保存 1 个方案即可并排比较。</p>}
        </section>
      </div>
    </main>
  );
}
