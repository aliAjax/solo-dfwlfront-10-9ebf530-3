/**
 * 油站高峰排队沙盘 —— 确定性仿真引擎（纯函数，无 DOM / 无 Date.now / 无 Math.random）。
 *
 * 模型约定：
 * - 时间统一用“距当日 00:00 的分钟数”表示，内部为浮点，展示时再取整。
 * - 到车：每个时段（默认 60 分钟）内按种子均匀撒点，全部到车按时间升序编号。
 * - 服务：单队列多服务台（FIFO），车辆到队首时，选择“编号最小且能完整容纳
 *   本车服务时长”的空闲泵；服务区间与故障区间采用半开区间 [start, end)。
 * - 故障：故障时段内该泵完全停用 —— 任何服务区间都不得与故障区间重叠，
 *   即故障开始前“放不下”的车会等故障结束或换其他泵。
 * - 确定性：同一配置 + 同一种子 => 逐车分配结果完全一致（结果指纹相同）。
 */

export interface FailureWindow {
  /** 0 基泵编号 */
  pump: number;
  /** 距 00:00 分钟数 */
  start: number;
  end: number;
}

export interface SimConfig {
  open: number;
  close: number;
  pumps: number;
  /** 每个时段的到车量，长度 = 时段数 */
  arrivals: number[];
  serviceMin: number;
  serviceMax: number;
  seed: number;
  failures: FailureWindow[];
}

/** 表单原始值：数字允许为 null（空）/ NaN */
export interface RawConfig {
  open: number | null;
  close: number | null;
  pumps: number | null;
  arrivals: (number | null)[];
  serviceMin: number | null;
  serviceMax: number | null;
  seed: number | null;
  failures: { pump: number; start: number | null; end: number | null }[];
}

export interface Slot {
  start: number;
  end: number;
}

export interface CarRecord {
  id: number;
  arrival: number;
  duration: number;
  pump: number;
  start: number;
  end: number;
  wait: number;
}

export interface QueuePoint {
  t: number;
  q: number;
}

export interface SimMetrics {
  total: number;
  completed: number;
  avgWait: number;
  maxWait: number;
  maxQueue: number;
  utilization: number;
  busyMinutes: number;
  horizonEnd: number;
  overtime: number;
}

export interface SimResult {
  cars: CarRecord[];
  queueSeries: QueuePoint[];
  metrics: SimMetrics;
  /** 逐车分配结果的确定性指纹，同配置同种子必相同 */
  fingerprint: string;
}

export const SLOT_MINUTES = 60;
export const MAX_PUMPS = 12;
export const MAX_CARS_PER_SLOT = 500;
export const MAX_TOTAL_CARS = 3000;

export function buildSlots(open: number, close: number): Slot[] {
  const slots: Slot[] = [];
  let t = open;
  while (t < close) {
    const end = Math.min(t + SLOT_MINUTES, close);
    slots.push({ start: t, end });
    t = end;
  }
  return slots;
}

/** 经典 mulberry32 种子随机数发生器，输出 [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isBlank(v: number | null): boolean {
  return v === null || Number.isNaN(v);
}

/**
 * 校验配置，返回中文原因列表；空数组表示可以运行。
 * 拦截：空值、负数、服务时长上限 < 下限、到车量总数为零等。
 */
export function validateConfig(raw: RawConfig): string[] {
  const errors: string[] = [];
  const timesValid =
    !isBlank(raw.open) && !isBlank(raw.close) && (raw.close as number) > (raw.open as number);

  if (isBlank(raw.open) || isBlank(raw.close)) {
    errors.push("营业时段不能为空，请填写开始与结束时间");
  } else if ((raw.close as number) <= (raw.open as number)) {
    errors.push("营业结束时间必须晚于开始时间");
  }

  if (isBlank(raw.pumps)) {
    errors.push("泵岛数量不能为空");
  } else if ((raw.pumps as number) < 0) {
    errors.push("泵岛数量不能为负数");
  } else if (!Number.isInteger(raw.pumps) || (raw.pumps as number) < 1) {
    errors.push("泵岛数量必须为不小于 1 的整数");
  } else if ((raw.pumps as number) > MAX_PUMPS) {
    errors.push(`泵岛数量不能超过 ${MAX_PUMPS}（沙盘演示上限）`);
  }

  if (isBlank(raw.serviceMin) || isBlank(raw.serviceMax)) {
    errors.push("单车服务时长下限/上限不能为空");
  } else {
    if ((raw.serviceMin as number) < 0 || (raw.serviceMax as number) < 0) {
      errors.push("单车服务时长不能为负数");
    } else {
      if ((raw.serviceMax as number) < (raw.serviceMin as number)) {
        errors.push("服务时长上限不能小于下限");
      }
      if ((raw.serviceMax as number) <= 0) {
        errors.push("服务时长上限必须大于 0，否则没有服务过程可模拟");
      }
    }
  }

  if (isBlank(raw.seed)) {
    errors.push("随机种子不能为空");
  } else if ((raw.seed as number) < 0) {
    errors.push("随机种子不能为负数");
  } else if (!Number.isInteger(raw.seed)) {
    errors.push("随机种子必须为整数");
  }

  // 分时到车量
  const slotCount = timesValid ? buildSlots(raw.open as number, raw.close as number).length : raw.arrivals.length;
  let totalCars = 0;
  let arrivalFieldError = false;
  for (let i = 0; i < slotCount; i++) {
    const v = raw.arrivals[i];
    const label = `第 ${i + 1} 时段到车量`;
    if (v === null || v === undefined || Number.isNaN(v)) {
      errors.push(`${label}不能为空`);
      arrivalFieldError = true;
    } else if (v < 0) {
      errors.push(`${label}不能为负数`);
      arrivalFieldError = true;
    } else if (!Number.isInteger(v)) {
      errors.push(`${label}必须为整数`);
      arrivalFieldError = true;
    } else if (v > MAX_CARS_PER_SLOT) {
      errors.push(`${label}不能超过 ${MAX_CARS_PER_SLOT}（沙盘演示上限）`);
      arrivalFieldError = true;
    } else {
      totalCars += v;
    }
  }
  if (!arrivalFieldError && totalCars === 0) {
    errors.push("各时段到车量均为零，没有车辆可模拟，不能运行");
  }
  if (!arrivalFieldError && totalCars > MAX_TOTAL_CARS) {
    errors.push(`到车总量 ${totalCars} 超过沙盘上限 ${MAX_TOTAL_CARS}，请降低分时到车量`);
  }

  // 故障时段
  raw.failures.forEach((f, j) => {
    const label = `第 ${j + 1} 条故障时段`;
    if (isBlank(f.start) || isBlank(f.end)) {
      errors.push(`${label}不能为空`);
      return;
    }
    if ((f.end as number) <= (f.start as number)) {
      errors.push(`${label}的结束时间必须晚于开始时间`);
      return;
    }
    if (timesValid) {
      const open = raw.open as number;
      const close = raw.close as number;
      if ((f.end as number) <= open || (f.start as number) >= close) {
        errors.push(`${label}（${fmtMinutes(f.start as number)}–${fmtMinutes(f.end as number)}）不在营业时段内`);
      }
    }
    if (!isBlank(raw.pumps) && Number.isInteger(raw.pumps) && (raw.pumps as number) >= 1) {
      if (f.pump < 0 || f.pump >= (raw.pumps as number)) {
        errors.push(`${label}指定的泵岛编号超出范围`);
      }
    }
  });

  return errors;
}

/** 校验通过时把表单原始值规整为仿真配置；失败返回 null。故障列表排序以保证键值稳定。 */
export function normalizeConfig(raw: RawConfig): SimConfig | null {
  if (validateConfig(raw).length > 0) return null;
  const config: SimConfig = {
    open: raw.open as number,
    close: raw.close as number,
    pumps: raw.pumps as number,
    arrivals: raw.arrivals.map((v) => v as number),
    serviceMin: raw.serviceMin as number,
    serviceMax: raw.serviceMax as number,
    seed: raw.seed as number,
    failures: raw.failures
      .map((f) => ({ pump: f.pump, start: f.start as number, end: f.end as number }))
      .sort((a, b) => a.pump - b.pump || a.start - b.start || a.end - b.end),
  };
  return config;
}

/** 分钟数 -> "HH:MM"（展示用，四舍五入到分钟） */
export function fmtMinutes(t: number): string {
  const m = Math.round(t);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** FNV-1a 哈希，生成结果指纹 */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 运行仿真。纯函数：相同输入必然得到相同输出。
 */
export function simulate(config: SimConfig): SimResult {
  const slots = buildSlots(config.open, config.close);

  // 1) 生成到车时刻（种子流 A）
  const rngArrival = mulberry32((config.seed ^ 0x9e3779b9) >>> 0);
  const arrivalTimes: number[] = [];
  slots.forEach((slot, i) => {
    const n = config.arrivals[i] ?? 0;
    for (let k = 0; k < n; k++) {
      arrivalTimes.push(slot.start + rngArrival() * (slot.end - slot.start));
    }
  });
  arrivalTimes.sort((a, b) => a - b);

  // 2) 生成每车服务时长（种子流 B，与到车流独立）
  const rngService = mulberry32(config.seed >>> 0);
  const cars: CarRecord[] = arrivalTimes.map((t, i) => ({
    id: i + 1,
    arrival: t,
    duration: config.serviceMin + rngService() * (config.serviceMax - config.serviceMin),
    pump: -1,
    start: -1,
    end: -1,
    wait: -1,
  }));

  // 3) 故障按泵分组并排序
  const failuresByPump: FailureWindow[][] = Array.from({ length: config.pumps }, () => []);
  for (const f of config.failures) {
    if (f.pump >= 0 && f.pump < config.pumps) failuresByPump[f.pump].push(f);
  }
  for (const list of failuresByPump) list.sort((a, b) => a.start - b.start);

  /** 泵 pump 在时刻 t 起能否完整容纳时长 d 的服务（不触碰任何故障区间） */
  function fitsAt(pump: number, t: number, d: number): boolean {
    for (const f of failuresByPump[pump]) {
      if (f.start >= t + d) break; // 已排序，后面的窗口不可能再重叠
      if (f.end > t) return false; // [t, t+d) 与 [f.start, f.end) 重叠
    }
    return true;
  }

  const busyUntil: number[] = new Array(config.pumps).fill(-Infinity);
  const queue: CarRecord[] = [];
  const queueSeries: QueuePoint[] = [{ t: config.open, q: 0 }];
  let maxQueue = 0;

  const completions: { time: number; pump: number }[] = [];
  const failureEnds = config.failures
    .map((f) => ({ time: f.end }))
    .sort((a, b) => a.time - b.time);
  let fei = 0;
  let ai = 0;

  function noteQueue(t: number) {
    queueSeries.push({ t, q: queue.length });
    if (queue.length > maxQueue) maxQueue = queue.length;
  }

  /** 队首车辆尽量上泵（严格 FIFO，选编号最小且可容纳的空闲泵） */
  function dispatch(now: number) {
    while (queue.length > 0) {
      const car = queue[0];
      let chosen = -1;
      for (let p = 0; p < config.pumps; p++) {
        if (busyUntil[p] <= now && fitsAt(p, now, car.duration)) {
          chosen = p;
          break;
        }
      }
      if (chosen < 0) break;
      queue.shift();
      car.pump = chosen;
      car.start = now;
      car.end = now + car.duration;
      car.wait = now - car.arrival;
      busyUntil[chosen] = car.end;
      completions.push({ time: car.end, pump: chosen });
      noteQueue(now);
    }
  }

  // 4) 离散事件主循环：到车 / 服务完成 / 故障结束，按时间升序处理
  for (;;) {
    const tArr = ai < cars.length ? cars[ai].arrival : Infinity;
    let tComp = Infinity;
    for (const c of completions) if (c.time < tComp) tComp = c.time;
    const tFail = fei < failureEnds.length ? failureEnds[fei].time : Infinity;
    const now = Math.min(tArr, tComp, tFail);
    if (!Number.isFinite(now)) break;

    for (let i = completions.length - 1; i >= 0; i--) {
      if (completions[i].time <= now) completions.splice(i, 1);
    }
    while (fei < failureEnds.length && failureEnds[fei].time <= now) fei++;
    while (ai < cars.length && cars[ai].arrival <= now) {
      queue.push(cars[ai]);
      ai++;
      noteQueue(now);
    }
    dispatch(now);
  }

  // 5) 指标
  const served = cars.filter((c) => c.pump >= 0);
  const totalWait = served.reduce((acc, c) => acc + c.wait, 0);
  const maxWait = served.reduce((acc, c) => Math.max(acc, c.wait), 0);
  const busyMinutes = served.reduce((acc, c) => acc + c.duration, 0);
  const lastEnd = served.reduce((acc, c) => Math.max(acc, c.end), config.open);
  const horizonEnd = Math.max(config.close, lastEnd);
  const utilization = busyMinutes / (config.pumps * (horizonEnd - config.open));

  const fingerprint = hashText(
    served.map((c) => `${c.id}:${c.pump}@${c.start.toFixed(3)}~${c.end.toFixed(3)}`).join("|"),
  );

  return {
    cars: served,
    queueSeries,
    metrics: {
      total: cars.length,
      completed: served.length,
      avgWait: served.length ? totalWait / served.length : 0,
      maxWait,
      maxQueue,
      utilization,
      busyMinutes,
      horizonEnd,
      overtime: Math.max(0, lastEnd - config.close),
    },
    fingerprint,
  };
}
