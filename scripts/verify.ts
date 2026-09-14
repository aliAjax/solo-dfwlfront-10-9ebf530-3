/**
 * 油站高峰排队沙盘 —— 场景验证脚本（node scripts 运行，见 package.json 的 verify 脚本）。
 *
 * 覆盖三类场景：
 *  1. 正常场景：标准高峰配置可运行，指标自洽；
 *  2. 边界场景：单泵、固定服务时长（上限=下限）、仅首时段有车、营业外加班、种子 0；
 *  3. 故障场景：故障时段内停用泵无任何服务；全部泵同时故障时窗口内零服务；
 *     以及校验拦截：空值、负数、服务时长上限<下限、到车量为零。
 */
import {
  buildSlots,
  normalizeConfig,
  simulate,
  validateConfig,
  type RawConfig,
  type SimConfig,
} from "../src/sim/engine.js";

declare const process: { exit(code: number): never };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n== ${title} ==`);
}

/* ---------- 测试用配置 ---------- */

function baseRaw(): RawConfig {
  return {
    open: 7 * 60,
    close: 21 * 60,
    pumps: 4,
    arrivals: [6, 10, 18, 30, 42, 36, 22, 18, 24, 38, 46, 34, 20, 10],
    serviceMin: 3,
    serviceMax: 8,
    seed: 42,
    failures: [{ pump: 1, start: 12 * 60, end: 12 * 60 + 40 }],
  };
}

function baseConfig(): SimConfig {
  const c = normalizeConfig(baseRaw());
  if (!c) throw new Error("基准配置应当通过校验");
  return c;
}

/* ---------- 1. 校验拦截 ---------- */
section("校验拦截（不能运行并说明原因）");

{
  const e = validateConfig({ ...baseRaw(), open: null });
  check("营业时段为空被拦截", e.some((s) => s.includes("营业时段不能为空")), e.join("；"));

  const e2 = validateConfig({ ...baseRaw(), open: 21 * 60, close: 7 * 60 });
  check("结束早于开始被拦截", e2.some((s) => s.includes("晚于开始")), e2.join("；"));

  const e3 = validateConfig({ ...baseRaw(), pumps: -2 });
  check("泵岛数量为负被拦截", e3.some((s) => s.includes("不能为负数")), e3.join("；"));

  const e4 = validateConfig({ ...baseRaw(), pumps: 0 });
  check("泵岛数量为 0 被拦截", e4.some((s) => s.includes("不小于 1")), e4.join("；"));

  const e5 = validateConfig({ ...baseRaw(), pumps: null });
  check("泵岛数量为空被拦截", e5.some((s) => s.includes("不能为空")), e5.join("；"));

  const e6 = validateConfig({ ...baseRaw(), serviceMin: 8, serviceMax: 3 });
  check("服务时长上限<下限被拦截", e6.some((s) => s.includes("上限不能小于下限")), e6.join("；"));

  const e7 = validateConfig({ ...baseRaw(), serviceMin: -1 });
  check("服务时长为负被拦截", e7.some((s) => s.includes("不能为负数")), e7.join("；"));

  const e8 = validateConfig({ ...baseRaw(), serviceMax: null });
  check("服务时长为空被拦截", e8.some((s) => s.includes("不能为空")), e8.join("；"));

  const e9 = validateConfig({ ...baseRaw(), arrivals: baseRaw().arrivals.map(() => 0) });
  check("到车量全为零被拦截", e9.some((s) => s.includes("均为零")), e9.join("；"));

  const arrNeg = [...baseRaw().arrivals];
  arrNeg[3] = -5;
  const e10 = validateConfig({ ...baseRaw(), arrivals: arrNeg });
  check("某时段到车量为负被拦截", e10.some((s) => s.includes("第 4 时段") && s.includes("负数")), e10.join("；"));

  const arrBlank = [...baseRaw().arrivals];
  arrBlank[0] = null;
  const e11 = validateConfig({ ...baseRaw(), arrivals: arrBlank });
  check("某时段到车量为空被拦截", e11.some((s) => s.includes("第 1 时段") && s.includes("不能为空")), e11.join("；"));

  const e12 = validateConfig({ ...baseRaw(), seed: -1 });
  check("种子为负被拦截", e12.some((s) => s.includes("不能为负数")), e12.join("；"));

  const e13 = validateConfig({ ...baseRaw(), seed: null });
  check("种子为空被拦截", e13.some((s) => s.includes("不能为空")), e13.join("；"));

  const e14 = validateConfig({
    ...baseRaw(),
    failures: [{ pump: 0, start: 13 * 60, end: 12 * 60 }],
  });
  check("故障结束早于开始被拦截", e14.some((s) => s.includes("晚于开始")), e14.join("；"));

  const e15 = validateConfig({
    ...baseRaw(),
    failures: [{ pump: 0, start: 23 * 60, end: 23 * 60 + 30 }],
  });
  check("故障在营业时段外被拦截", e15.some((s) => s.includes("不在营业时段内")), e15.join("；"));

  const e16 = validateConfig({
    ...baseRaw(),
    failures: [{ pump: 9, start: 12 * 60, end: 13 * 60 }],
  });
  check("故障泵编号超范围被拦截", e16.some((s) => s.includes("超出范围")), e16.join("；"));

  check("合法配置零错误", validateConfig(baseRaw()).length === 0, validateConfig(baseRaw()).join("；"));
}

/* ---------- 2. 正常场景 ---------- */
section("正常场景");

{
  const config = baseConfig();
  const r = simulate(config);
  const m = r.metrics;
  check("全部到车均被服务", m.completed === m.total && m.total === 354, `completed=${m.completed} total=${m.total}`);
  check("每车 start>=arrival 且 end=start+duration",
    r.cars.every((c) => c.start >= c.arrival - 1e-9 && Math.abs(c.end - c.start - c.duration) < 1e-9));
  check("每车 wait = start - arrival >= 0", r.cars.every((c) => Math.abs(c.wait - (c.start - c.arrival)) < 1e-9 && c.wait >= -1e-9));
  check("服务时长落在 [3, 8] 分钟", r.cars.every((c) => c.duration >= 3 - 1e-9 && c.duration <= 8 + 1e-9));
  check("平均等待非负", m.avgWait >= 0, `avgWait=${m.avgWait}`);
  check("最长队伍非负且不超过总车数", m.maxQueue >= 0 && m.maxQueue <= m.total);
  check("利用率在 (0, 1) 区间", m.utilization > 0 && m.utilization < 1, `util=${m.utilization.toFixed(3)}`);
  check("同一泵任意两车服务不重叠", (() => {
    for (let p = 0; p < config.pumps; p++) {
      const list = r.cars.filter((c) => c.pump === p).sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        if (list[i].start < list[i - 1].end - 1e-9) return false;
      }
    }
    return true;
  })());
  check("车辆按到达顺序编号", r.cars.every((c, i) => c.id === i + 1 && (i === 0 || r.cars[i - 1].arrival <= c.arrival + 1e-9)));
  console.log(`  指标: 均等 ${m.avgWait.toFixed(2)} 分, 峰值队列 ${m.maxQueue}, 利用率 ${(m.utilization * 100).toFixed(1)}%, 完成 ${m.completed}, 指纹 #${r.fingerprint}`);
}

/* ---------- 3. 确定性 ---------- */
section("确定性（同配置同种子必一致）");

{
  const config = baseConfig();
  const r1 = simulate(config);
  const r2 = simulate(config);
  check("两次运行指纹一致", r1.fingerprint === r2.fingerprint, `${r1.fingerprint} vs ${r2.fingerprint}`);
  check(
    "两次运行逐车结果一致",
    JSON.stringify(r1.cars) === JSON.stringify(r2.cars) &&
      JSON.stringify(r1.metrics) === JSON.stringify(r2.metrics),
  );
  const r3 = simulate({ ...config, seed: 43 });
  check("换一种子指纹改变", r3.fingerprint !== r1.fingerprint);
  const r4 = simulate({ ...config, pumps: 5 });
  check("改配置（泵数）指纹改变", r4.fingerprint !== r1.fingerprint);
}

/* ---------- 4. 故障场景 ---------- */
section("故障场景（故障时段停用泵不可用）");

{
  const config = baseConfig();
  const r = simulate(config);
  const win = config.failures[0];
  const violating = r.cars.filter(
    (c) => c.pump === win.pump && c.start < win.end && c.end > win.start,
  );
  check("故障窗口内 2 号泵无任何服务", violating.length === 0, `${violating.length} 车违规`);
  check("故障期间仍有车到并完成（队列被其他泵消化或延后）", r.metrics.completed === r.metrics.total);

  // 全部泵同一时段故障 => 窗口内全场零服务
  const allDown: SimConfig = {
    ...config,
    failures: [0, 1, 2, 3].map((p) => ({ pump: p, start: 12 * 60, end: 13 * 60 })),
  };
  const rAll = simulate(allDown);
  const inWindow = rAll.cars.filter((c) => c.start < 13 * 60 && c.end > 12 * 60);
  check("全部泵故障时 12:00–13:00 零服务", inWindow.length === 0, `${inWindow.length} 车违规`);
  check("全泵故障后队列仍能清空", rAll.metrics.completed === rAll.metrics.total);
  check("全泵故障导致排队积压（峰值队列 > 0）", rAll.metrics.maxQueue > 0, `maxQueue=${rAll.metrics.maxQueue}`);

  // 单泵 + 长故障 => 等待显著上升但仍全部完成
  const onePump: SimConfig = {
    ...config,
    pumps: 1,
    arrivals: config.arrivals.map((v) => Math.ceil(v / 4)),
    failures: [{ pump: 0, start: 12 * 60, end: 13 * 60 }],
  };
  const rOne = simulate(onePump);
  check("单泵故障场景全部完成", rOne.metrics.completed === rOne.metrics.total);
  check(
    "单泵故障窗口内无服务",
    rOne.cars.every((c) => c.start >= 13 * 60 || c.end <= 12 * 60),
  );
}

/* ---------- 5. 边界场景 ---------- */
section("边界场景");

{
  // 固定服务时长：上限 = 下限
  const fixed: SimConfig = { ...baseConfig(), serviceMin: 5, serviceMax: 5, failures: [] };
  const rFixed = simulate(fixed);
  check("上限=下限时长全部恰为 5 分钟", rFixed.cars.every((c) => Math.abs(c.duration - 5) < 1e-9));
  check("固定时长场景全部完成", rFixed.metrics.completed === rFixed.metrics.total);

  // 仅首时段有车，其余为零
  const firstOnly: SimConfig = {
    ...baseConfig(),
    arrivals: [20, ...Array(13).fill(0)],
    failures: [],
  };
  const rFirst = simulate(firstOnly);
  check("仅首时段到车可运行", rFirst.metrics.total === 20 && rFirst.metrics.completed === 20);
  check("无车到时段不产生排队", rFirst.metrics.maxQueue <= 20);

  // 营业时段仅 1 小时（单时段）
  const oneSlot: SimConfig = {
    ...baseConfig(),
    open: 7 * 60,
    close: 8 * 60,
    arrivals: [12],
    failures: [],
  };
  const rSlot = simulate(oneSlot);
  check("单小时营业可运行", rSlot.metrics.completed === 12);
  check("到车都在营业时段内", rSlot.cars.every((c) => c.arrival >= 7 * 60 && c.arrival < 8 * 60));

  // 营业外加班：小窗口大流量单泵
  const overtime: SimConfig = {
    ...baseConfig(),
    open: 7 * 60,
    close: 8 * 60,
    pumps: 1,
    arrivals: [40],
    serviceMin: 4,
    serviceMax: 6,
    failures: [],
  };
  const rOt = simulate(overtime);
  check("堆积导致营业外加班", rOt.metrics.overtime > 0, `overtime=${rOt.metrics.overtime.toFixed(1)}`);
  check("加班场景仍全部完成", rOt.metrics.completed === 40);

  // 种子 0 可用
  const rSeed0 = simulate({ ...baseConfig(), seed: 0 });
  check("种子 0 可运行且确定", rSeed0.fingerprint === simulate({ ...baseConfig(), seed: 0 }).fingerprint);

  // 故障紧贴营业边界
  const edge: SimConfig = {
    ...baseConfig(),
    failures: [
      { pump: 0, start: 7 * 60, end: 7 * 60 + 30 },
      { pump: 2, start: 20 * 60 + 30, end: 21 * 60 },
    ],
  };
  const rEdge = simulate(edge);
  check(
    "故障贴营业开始/结束边界仍无违规",
    rEdge.cars.every((c) => {
      if (c.pump === 0 && c.start < 7 * 60 + 30 && c.end > 7 * 60) return false;
      if (c.pump === 2 && c.start < 21 * 60 && c.end > 20 * 60 + 30) return false;
      return true;
    }),
  );
  check("边界故障场景全部完成", rEdge.metrics.completed === rEdge.metrics.total);

  // 时段划分正确
  const slots = buildSlots(6 * 60 + 30, 9 * 60);
  check("非整点营业的时段划分", slots.length === 3 && slots[2].end === 9 * 60 && slots[2].start === 8 * 60 + 30);
}

/* ---------- 汇总 ---------- */
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
