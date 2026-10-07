/** 纯 Node 冒烟验证：不触碰 IndexedDB，只校验对账纯逻辑（build / patch / 备查分类） */
import { buildReconcilePlan, planToPatches } from '../src/app/core/utils/reconcile';
import type { Packaging } from '../src/app/core/models/packaging.model';
import type { Ferment } from '../src/app/core/models/ferment.model';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error('✘', msg);
  } else {
    console.log('✔', msg);
  }
}

const ferments: Ferment[] = [
  { id: 'f1', batchNo: 'B1', recipeId: 'r1', date: '2024-04-01', gravity: 1.062, tempC: 20, diacetylPpm: 0.5, state: '主发酵' },
  { id: 'f2', batchNo: 'B1', recipeId: 'r1', date: '2024-04-05', gravity: 1.02, tempC: 20, diacetylPpm: 0.2, state: '双乙酰还原' },
  { id: 'f3', batchNo: 'B1', recipeId: 'r1', date: '2024-04-09', gravity: 1.01, tempC: 20, diacetylPpm: 0.05, state: '已结束' },
  { id: 'f4', batchNo: 'B2', recipeId: 'r2', date: '2024-04-02', gravity: 1.05, tempC: 19, diacetylPpm: 0.4, state: '主发酵' },
  { id: 'f5', batchNo: 'B4', recipeId: 'r4', date: '2024-04-03', gravity: 1.048, tempC: 19, diacetylPpm: 0.4, state: '主发酵' },
  { id: 'f6', batchNo: 'B4', recipeId: 'r4', date: '2024-04-08', gravity: 1.012, tempC: 19, diacetylPpm: 0.06, state: '已结束' }
];

const mkPack = (p: Partial<Packaging> & { id: string; batchNo: string }): Packaging => ({
  recipeId: 'r',
  packDate: '2024-04-10',
  container: '瓶装',
  quantity: 1,
  carbonationVol: 2.4,
  og: 0,
  fg: 0,
  abv: 0,
  ...p
});

const packagings: Packaging[] = [
  mkPack({ id: 'p1', batchNo: 'B1', recipeId: 'r1', og: 1.06, fg: 1.012, abv: 6.7 }), // 三项全不一致 → 改写
  mkPack({ id: 'p2', batchNo: 'B2', recipeId: 'r2', og: 1.05, fg: 1.011, abv: 0 }), // 读数不足 → 仅备查
  mkPack({ id: 'p3', batchNo: 'B3', recipeId: 'r3', og: 1.07, fg: 0.018, abv: 7 }),  // 无发酵读数 → 仅备查
  mkPack({ id: 'p4', batchNo: 'B4', recipeId: 'r4', og: 1.048, fg: 1.012, abv: 4.73 }) // 一致 → 不改
];

const plan = buildReconcilePlan(packagings, ferments, '2024-04-30T00:00:00.000Z');

assert(plan.summary.total === 4, '共 4 批罐装');
assert(plan.summary.toUpdate === 1, '仅 1 批需要改写（B1）');
assert(plan.summary.matched === 1, '1 批两边一致（B4）');
assert(plan.summary.missingFerment === 1, '1 批罐装无发酵读数（B3）');
assert(plan.summary.incompleteFerment === 1, '1 批发酵读数不足（B2）');
assert(plan.mismatches.length === 3, '备查清单 3 批（B1/B2/B3）');
assert(plan.updates[0].packaging.id === 'p1', '待改写的是 p1');

const patches = planToPatches(plan);
assert(patches.length === 1, '补丁只有 1 条');
assert(patches[0].og === 1.062 && patches[0].fg === 1.01, `补丁 OG/FG 正确：${patches[0].og}/${patches[0].fg}`);
const expectedAbv = Number(((1.062 - 1.01) * 131.25).toFixed(2));
assert(patches[0].abv === expectedAbv, `补丁 ABV=${patches[0].abv} 等于 ${expectedAbv}`);
assert(patches[0].batchNo === 'B1', '补丁带批次号备查');

const b1 = plan.items.find((i) => i.packaging.batchNo === 'B1')!;
assert(
  b1.issues.map((i) => i.kind).join(',') === 'OG不一致,FG不一致,ABV不一致',
  'B1 列出 OG/FG/ABV 三项不一致'
);
const b3 = plan.items.find((i) => i.packaging.batchNo === 'B3')!;
assert(b3.needsUpdate === false && b3.expected === null, 'B3 无读数不改写、无期望值');
const b2 = plan.items.find((i) => i.packaging.batchNo === 'B2')!;
assert(b2.needsUpdate === false && b2.expected === null, 'B2 读数不足不改写');

// 重复批次号：罐装两行同批次号各自一条结果
const dup = buildReconcilePlan(
  [mkPack({ id: 'a', batchNo: 'B1' }), mkPack({ id: 'b', batchNo: 'B1' })],
  ferments,
  't'
);
assert(dup.items.length === 2, '同批次号两条罐装行各自对账，互不覆盖');

// 空库场景
const empty = buildReconcilePlan([], [], 't');
assert(empty.summary.total === 0 && empty.mismatches.length === 0 && planToPatches(empty).length === 0, '空数据不报错');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
