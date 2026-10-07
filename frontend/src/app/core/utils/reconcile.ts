/**
 * 月末批次对账：罐装批次与发酵读数按批次号配对，以发酵读数为准回写罐装的 OG / FG / ABV。
 * 纯函数实现，不触碰 IndexedDB；由 ReconcileService 编排读写与回滚。
 * 同时负责把旧备份里的旧结构行按当前结构回填（缺字段补默认值 / 由读数派生）。
 */
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import { abvFromGravity } from './brew';
import type { DatabaseSnapshot } from './db';

/** 单个罐装批次的对账改动（before 用于退回对账前的数值） */
export interface ReconcileChange {
  id: string;
  batchNo: string;
  before: { og: number; fg: number; abv: number };
  after: { og: number; fg: number; abv: number };
}

/** 对不上的批次：留在备查清单，不改写 */
export interface ReconcileUnmatched {
  /** 罐装时抄了批次号，但发酵侧没有任何读数 */
  missingReadings: Packaging[];
  /** 发酵侧只有一条读数，不足以定 OG / FG */
  insufficientReadings: Packaging[];
  /** 发酵侧有读数、罐装侧没登记的批次号 */
  unpackagedBatchNos: string[];
}

export interface ReconcilePlan {
  changes: ReconcileChange[];
  unmatched: ReconcileUnmatched;
}

function sortedReadings(ferments: Ferment[], batchNo: string): Ferment[] {
  return ferments
    .filter((row) => row.batchNo === batchNo)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 由同批次号的发酵读数推导实绩：最早一条为 OG，最晚一条为 FG */
export function actualsFromReadings(readings: Ferment[]): { og: number; fg: number; abv: number } | null {
  if (readings.length < 2) return null;
  const og = readings[0].gravity;
  const fg = readings[readings.length - 1].gravity;
  return { og, fg, abv: abvFromGravity(og, fg) };
}

/**
 * 生成对账计划：以发酵读数为准，逐批次算出罐装 OG / FG / ABV 的目标值；
 * 与现值一致的批次不重复改写，对不上的批次单独列出备查。
 */
export function planReconciliation(packagings: Packaging[], ferments: Ferment[]): ReconcilePlan {
  const changes: ReconcileChange[] = [];
  const unmatched: ReconcileUnmatched = { missingReadings: [], insufficientReadings: [], unpackagedBatchNos: [] };
  const packagedBatchNos = new Set(packagings.map((row) => row.batchNo));

  for (const pack of packagings) {
    const readings = sortedReadings(ferments, pack.batchNo);
    if (readings.length === 0) {
      unmatched.missingReadings.push(pack);
      continue;
    }
    const actuals = actualsFromReadings(readings);
    if (!actuals) {
      unmatched.insufficientReadings.push(pack);
      continue;
    }
    if (pack.og === actuals.og && pack.fg === actuals.fg && pack.abv === actuals.abv) continue;
    changes.push({
      id: pack.id,
      batchNo: pack.batchNo,
      before: { og: pack.og, fg: pack.fg, abv: pack.abv },
      after: actuals
    });
  }

  const fermentBatchNos = [...new Set(ferments.map((row) => row.batchNo))].sort((a, b) => a.localeCompare(b));
  unmatched.unpackagedBatchNos = fermentBatchNos.filter((batchNo) => !packagedBatchNos.has(batchNo));

  return { changes, unmatched };
}

/* --------------------------- 旧备份结构回填 --------------------------- */

/** 把一条旧版罐装行按当前结构回填：缺 og / fg / abv 时优先用同批次发酵读数派生，否则补 0 */
export function backfillPackagingRow(row: Partial<Packaging> & { id: string }, ferments: Ferment[]): Packaging {
  const readings = row.batchNo ? sortedReadings(ferments, row.batchNo) : [];
  const actuals = actualsFromReadings(readings);
  const og = typeof row.og === 'number' ? row.og : (actuals?.og ?? 0);
  const fg = typeof row.fg === 'number' ? row.fg : (actuals?.fg ?? 0);
  return {
    id: row.id,
    batchNo: row.batchNo ?? '',
    recipeId: row.recipeId ?? '',
    packDate: row.packDate ?? new Date().toISOString().slice(0, 10),
    container: row.container ?? '瓶装',
    quantity: typeof row.quantity === 'number' ? row.quantity : 0,
    carbonationVol: typeof row.carbonationVol === 'number' ? row.carbonationVol : 2.4,
    og,
    fg,
    abv: typeof row.abv === 'number' ? row.abv : abvFromGravity(og, fg)
  };
}

/**
 * 旧备份整库回填：老档案（schemaVersion < 当前）里的罐装行没有 og / fg，
 * 先按当前结构补齐再交给分批导入；缺失的表一律按空表兜底，行级时间戳由入库时统一盖戳。
 */
export function backfillSnapshot(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  const ferments = Array.isArray(snapshot.ferments) ? snapshot.ferments : [];
  const packagings = Array.isArray(snapshot.packagings) ? snapshot.packagings : [];
  return {
    ...snapshot,
    recipes: Array.isArray(snapshot.recipes) ? snapshot.recipes : [],
    malts: Array.isArray(snapshot.malts) ? snapshot.malts : [],
    hops: Array.isArray(snapshot.hops) ? snapshot.hops : [],
    mashSteps: Array.isArray(snapshot.mashSteps) ? snapshot.mashSteps : [],
    boilAdds: Array.isArray(snapshot.boilAdds) ? snapshot.boilAdds : [],
    ferments,
    packagings: packagings.map((row) => backfillPackagingRow(row as Partial<Packaging> & { id: string }, ferments))
  };
}
