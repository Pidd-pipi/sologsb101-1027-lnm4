/**
 * Dexie 层冒烟验证（fake-indexeddb）：
 * 1. v1 旧库（罐装无 og/fg）打开后自动迁移到 v2，按发酵读数 / 配方目标回填
 * 2. 旧备份导入：缺字段按当前结构回填；超过单批容量分批写入；中途失败整批回滚可重试
 * 3. 对账改写事务 + 退回对账前数值
 */
import 'fake-indexeddb/auto';

// fake-indexeddb 提供结构化克隆；Dexie 在 Node 下需要这些全局
if (typeof globalThis.structuredClone === 'undefined') {
  // Node 20 自带 structuredClone，保险起见留空分支
}

import {
  db,
  DB_NAME,
  DB_SCHEMA_VERSION,
  IMPORT_CHUNK_SIZE,
  importSnapshot,
  exportSnapshot,
  applyReconcilePatches,
  restorePackagingGravity,
  resetDatabase,
  chunkArray,
  type DatabaseSnapshot
} from '../src/app/core/utils/db';
import { buildReconcilePlan, planToPatches } from '../src/app/core/utils/reconcile';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error('✘', msg);
  } else {
    console.log('✔', msg);
  }
}

function v1Snapshot(): DatabaseSnapshot {
  return {
    name: DB_NAME,
    schemaVersion: 1,
    exportedAt: '2024-04-30T00:00:00.000Z',
    recipes: [
      { id: 'r1', name: 'IPA', style: 'IPA', targetOg: 1.06, targetFg: 0.012, targetIbu: 60, targetEbc: 14, batchSizeL: 20 },
      { id: 'r3', name: '世涛', style: '世涛', targetOg: 1.068, targetFg: 0.018, targetIbu: 40, targetEbc: 58, batchSizeL: 18 }
    ],
    malts: [],
    hops: [],
    mashSteps: [],
    boilAdds: [],
    ferments: [
      { id: 'f1', batchNo: 'B1', recipeId: 'r1', date: '2024-04-01', gravity: 1.062, tempC: 20, diacetylPpm: 0.5, state: '主发酵' },
      { id: 'f2', batchNo: 'B1', recipeId: 'r1', date: '2024-04-09', gravity: 1.01, tempC: 20, diacetylPpm: 0.05, state: '已结束' },
      { id: 'f3', batchNo: 'B2', recipeId: 'r1', date: '2024-04-02', gravity: 1.05, tempC: 20, diacetylPpm: 0.4, state: '主发酵' }
    ],
    // 旧备份的罐装行没有 og / fg 字段（用 as 绕过类型，模拟历史 JSON）
    packagings: [
      { id: 'p1', batchNo: 'B1', recipeId: 'r1', packDate: '2024-04-12', container: '瓶装', quantity: 40, carbonationVol: 2.5, abv: 6.7 },
      { id: 'p2', batchNo: 'B2', recipeId: 'r1', packDate: '2024-04-13', container: '桶装', quantity: 1, carbonationVol: 2.8, abv: 5.0 },
      { id: 'p3', batchNo: 'B3', recipeId: 'r3', packDate: '2024-05-01', container: '罐装', quantity: 48, carbonationVol: 2.2, abv: 6.6 }
    ] as unknown as DatabaseSnapshot['packagings']
  };
}

async function main(): Promise<void> {
  assert(DB_SCHEMA_VERSION === 2, '当前结构版本 v2');
  assert(IMPORT_CHUNK_SIZE === 500, '单批容量 500 行');
  assert(chunkArray([]).length === 0, '空数组不产生批次');
  assert(chunkArray(Array.from({ length: 1201 })).length === 3, '1201 行切成 3 批（500/500/201）');

  /* ---------- 1. 旧备份导入 = v1→v2 回填路径（importSnapshot 内部回填） ---------- */
  await importSnapshot(v1Snapshot());
  assert(db.verno === 2, `导入后库版本为 2（实际 ${db.verno}）`);
  const p1 = await db.packagings.get('p1');
  const p2 = await db.packagings.get('p2');
  const p3 = await db.packagings.get('p3');
  assert(p1!.og === 1.062 && p1!.fg === 1.01, `p1 按发酵读数回填 og/fg：${p1!.og}/${p1!.fg}`);
  // B2 只有一条读数：og 用读数，fg 退回配方目标 1.012
  assert(p2!.og === 1.05 && p2!.fg === 0.012, `p2 读数不足，fg 退回配方目标：${p2!.og}/${p2!.fg}`);
  // B3 完全无读数且属于 r3：og/fg 都退回 r3 目标
  assert(p3!.og === 1.068 && p3!.fg === 0.018, `p3 无读数，og/fg 退回配方目标：${p3!.og}/${p3!.fg}`);

  /* ---------- 2. 真实 v1→v2 升级迁移：先建 v1 旧结构库再用新代码打开 ---------- */
  db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除被阻塞'));
  });

  // 用原生 IndexedDB 手搓一个 version(1) 库，罐装行不带 og/fg
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const idb = open.result;
      idb.createObjectStore('recipes', { keyPath: 'id' });
      idb.createObjectStore('malts', { keyPath: 'id' });
      idb.createObjectStore('hops', { keyPath: 'id' });
      idb.createObjectStore('mashSteps', { keyPath: 'id' });
      idb.createObjectStore('boilAdds', { keyPath: 'id' });
      idb.createObjectStore('ferments', { keyPath: 'id' });
      const pkStore = idb.createObjectStore('packagings', { keyPath: 'id' });
      const tx = open.transaction!;
      tx.objectStore('recipes').put({ id: 'r1', name: 'IPA', style: 'IPA', targetOg: 1.06, targetFg: 0.012, targetIbu: 60, targetEbc: 14, batchSizeL: 20 });
      tx.objectStore('ferments').put({ id: 'f1', batchNo: 'B1', recipeId: 'r1', date: '2024-04-01', gravity: 1.062, tempC: 20, diacetylPpm: 0.5, state: '主发酵' });
      tx.objectStore('ferments').put({ id: 'f2', batchNo: 'B1', recipeId: 'r1', date: '2024-04-09', gravity: 1.01, tempC: 20, diacetylPpm: 0.05, state: '已结束' });
      pkStore.put({ id: 'p1', batchNo: 'B1', recipeId: 'r1', packDate: '2024-04-12', container: '瓶装', quantity: 40, carbonationVol: 2.5, abv: 6.7 });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });

  await db.open();
  assert(db.verno === 2, `旧 v1 库自动升级到 v2（实际 ${db.verno}）`);
  const migrated = await db.packagings.get('p1');
  assert(migrated!.og === 1.062 && migrated!.fg === 1.01, '迁移事务按发酵读数回填旧罐装行 og/fg');

  /* ---------- 3. 对账改写事务 + 回滚 ---------- */
  const [ferments, packagings] = await Promise.all([db.ferments.toArray(), db.packagings.toArray()]);
  const plan = buildReconcilePlan(packagings, ferments, 't');
  const patches = planToPatches(plan);
  assert(patches.length === 1 && patches[0].batchNo === 'B1', `对账出 1 批待改写（实际 ${patches.length}）`);

  const backups = await applyReconcilePatches(patches);
  assert(backups.length === 1, '改写返回 1 条对账前留底');
  const applied = await db.packagings.get('p1');
  assert(applied!.og === 1.062 && applied!.fg === 1.01, `改写后 og/fg 以发酵读数为准：${applied!.og}/${applied!.fg}`);
  const expectedAbv = Number(((1.062 - 1.01) * 131.25).toFixed(2));
  assert(applied!.abv === expectedAbv, `改写后 abv=${applied!.abv}（期望 ${expectedAbv}）`);
  assert(applied!.quantity === 40 && applied!.container === '瓶装', '改写只动 og/fg/abv，其它列不变');

  // 重复改写：留底仍是最初值，再执行一次也安全（幂等）
  const backups2 = await applyReconcilePatches(patches);
  assert(backups2[0].og === applied!.og, '已是目标值时再执行，留底取当前值且不报错');

  const restored = await restorePackagingGravity(backups);
  assert(restored === 1, '回滚 1 批');
  const rolled = await db.packagings.get('p1');
  assert(
    rolled!.og === 1.062 && rolled!.fg === 1.01 && rolled!.abv === 6.7,
    `回滚后恢复对账前数值（迁移回填的 og/fg 1.062/1.01 保留，abv 退回旧值 6.7；实际 ${rolled!.og}/${rolled!.fg}/${rolled!.abv}）`
  );

  /* ---------- 4. 大批量分批写入 + 失败整体回滚可重试 ---------- */
  const big = v1Snapshot();
  big.ferments = Array.from({ length: IMPORT_CHUNK_SIZE * 2 + 3 }, (_, i) => ({
    id: `f${i}`,
    batchNo: 'BIG',
    recipeId: 'r1',
    date: '2024-04-01',
    gravity: 1.05,
    tempC: 20,
    diacetylPpm: 0.3,
    state: '主发酵'
  }));
  await importSnapshot(big);
  assert((await db.ferments.count()) === IMPORT_CHUNK_SIZE * 2 + 3, `大批量读数分批写入 ${IMPORT_CHUNK_SIZE * 2 + 3} 条`);

  // 导入失败（结构性错误：主键缺失会让 bulkPut 抛错）→ 旧数据应保留，可重试
  const before = await countAllTables();
  const broken = v1Snapshot();
  broken.ferments = [{ ...big.ferments[0], id: undefined as unknown as string }];
  let threw = false;
  try {
    await importSnapshot(broken);
  } catch {
    threw = true;
  }
  assert(threw, '坏备份导入抛错');
  const after = await countAllTables();
  assert(JSON.stringify(before) === JSON.stringify(after), '失败后整批回滚，库内仍是导入前数据，可重试');

  // 修正后重试成功
  const retry = v1Snapshot();
  await importSnapshot(retry);
  assert((await db.packagings.count()) === 3, '修正备份后重试导入成功');

  // 导出再导入往返：og/fg 不丢
  const exported = await exportSnapshot();
  assert(typeof (exported.packagings[0] as { og?: number }).og === 'number', '导出的罐装行带 og/fg 当前结构');
  await importSnapshot(exported);
  assert((await db.packagings.get('p1'))!.og === 1.062, '往返导入后 og 保持');

  db.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
  process.exit(failures === 0 ? 0 : 1);
}

async function countAllTables(): Promise<Record<string, number>> {
  const [recipes, malts, hops, mashSteps, boilAdds, ferments, packagings] = await Promise.all([
    db.recipes.count(),
    db.malts.count(),
    db.hops.count(),
    db.mashSteps.count(),
    db.boilAdds.count(),
    db.ferments.count(),
    db.packagings.count()
  ]);
  return { recipes, malts, hops, mashSteps, boilAdds, ferments, packagings };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
