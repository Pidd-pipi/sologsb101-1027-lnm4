/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbbrewhouse-db，结构版本号 version(2)（v1→v2 见类内 upgrade 迁移）
 * - 配方 / 麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵读数 / 罐装批次 七张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 整库导入支持旧结构回填、分批写入、失败整体回滚；月底对账改写 / 回滚见文件末尾
 */
import Dexie, { type Table } from 'dexie';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import { packagingGravityFromFerments } from '../models/packaging.model';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import type { PackagingGravityPatch } from './reconcile';

/** 数据库名 */
export const DB_NAME = 'gbbrewhouse-db';

/**
 * 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移）
 * v2：罐装批次结构并入糖化实绩，新增 og / fg 两个字段（旧行按发酵读数回填）
 */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 2;

/** 分批写入的每批行数：超过单批容量就拆成多个 bulkPut，避免一次性写入触发 IndexedDB 配额/事务压力 */
export const IMPORT_CHUNK_SIZE = 500;

/** 把数组按每片 size 条切块 */
export function chunkArray<T>(rows: T[], size: number = IMPORT_CHUNK_SIZE): T[][] {
  if (rows.length <= size) return rows.length === 0 ? [] : [rows];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type RecipeRow = Recipe & Revisioned;
export type MaltRow = Malt & Revisioned;
export type HopRow = Hop & Revisioned;
export type MashStepRow = MashStep & Revisioned;
export type BoilAddRow = BoilAdd & Revisioned;
export type FermentRow = Ferment & Revisioned;
export type PackagingRow = Packaging & Revisioned;

class GbBrewhouseDatabase extends Dexie {
  recipes!: Table<RecipeRow, string>;
  malts!: Table<MaltRow, string>;
  hops!: Table<HopRow, string>;
  mashSteps!: Table<MashStepRow, string>;
  boilAdds!: Table<BoilAddRow, string>;
  ferments!: Table<FermentRow, string>;
  packagings!: Table<PackagingRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初始七表结构（保留声明以便从旧库逐级升级；新建库会直接跳到最新版本，不执行其 upgrade）
    this.version(1).stores({
      recipes: 'id, name, style, targetOg, updatedAt',
      malts: 'id, recipeId, name, ebc, type, updatedAt',
      hops: 'id, recipeId, name, alphaPct, form, updatedAt',
      mashSteps: 'id, recipeId, seq, state, updatedAt',
      boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
      ferments: 'id, recipeId, batchNo, date, state, updatedAt',
      packagings: 'id, recipeId, batchNo, packDate, container, updatedAt'
    });

    // v2：罐装批次并入糖化实绩字段 og / fg（不新增索引）。
    // 旧结构的罐装行没有 og / fg，按批次号取发酵首尾读数回填；
    // 该批次没有发酵读数时退回配方目标 OG / FG，再缺则置 0，保证字段类型统一。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        recipes: 'id, name, style, targetOg, updatedAt',
        malts: 'id, recipeId, name, ebc, type, updatedAt',
        hops: 'id, recipeId, name, alphaPct, form, updatedAt',
        mashSteps: 'id, recipeId, seq, state, updatedAt',
        boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
        ferments: 'id, recipeId, batchNo, date, state, updatedAt',
        packagings: 'id, recipeId, batchNo, packDate, container, updatedAt'
      })
      .upgrade(async (tx) => {
        // 历史行可能连 v1 的 revision / 时间戳都没有，先补齐
        const tableNames = ['recipes', 'malts', 'hops', 'mashSteps', 'boilAdds', 'ferments'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = 1;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }

        const [fermentRows, recipeRows, packagingRows] = await Promise.all([
          tx.table('ferments').toArray() as Promise<FermentRow[]>,
          tx.table('recipes').toArray() as Promise<RecipeRow[]>,
          tx.table('packagings').toArray() as Promise<PackagingRow[]>
        ]);
        const fermentByBatch = new Map<string, FermentRow[]>();
        for (const row of fermentRows) {
          const list = fermentByBatch.get(row.batchNo);
          if (list) list.push(row);
          else fermentByBatch.set(row.batchNo, [row]);
        }
        const recipeById = new Map(recipeRows.map((row) => [row.id, row]));

        for (const packaging of packagingRows) {
          // 行修订 / 时间戳同样补齐
          if (typeof packaging.revision !== 'number') packaging.revision = 1;
          if (typeof packaging.createdAt !== 'number') packaging.createdAt = Date.now();
          if (typeof packaging.updatedAt !== 'number') packaging.updatedAt = packaging.createdAt;

          if (typeof packaging.og === 'number' && typeof packaging.fg === 'number') continue;
          const batchFerments = fermentByBatch.get(packaging.batchNo) ?? [];
          const derived = packagingGravityFromFerments(batchFerments);
          const recipe = recipeById.get(packaging.recipeId);
          const patch: Record<string, unknown> = {
            revision: ROW_REVISION,
            updatedAt: Date.now()
          };
          if (derived?.complete) {
            patch['og'] = derived.og;
            patch['fg'] = derived.fg;
          } else {
            // 旧备份常见情形：读数还没补齐。先按当前结构回填目标值占位，月底对账再改写
            patch['og'] = typeof derived?.og === 'number' ? derived.og : recipe?.targetOg ?? 0;
            patch['fg'] = recipe?.targetFg ?? 0;
          }
          await tx.table('packagings').update(packaging.id, patch);
        }
      });
  }
}

export const db = new GbBrewhouseDatabase();

/** 初始化 Promise 缓存：并发调用共享同一次「打开 + 按需播种」，避免重复灌入演示数据 */
let initPromise: Promise<void> | null = null;

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播；并发调用复用同一 Promise） */
export function initDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await db.open();
      if ((await db.recipes.count()) === 0) {
        await seedDatabase();
      }
    })().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/* ------------------------------ 配方 ------------------------------ */

export async function listRecipes(): Promise<RecipeRow[]> {
  const rows = await db.recipes.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 删除配方：级联删除麦芽、酒花、糖化步、煮沸投加、发酵读数与罐装批次 */
export async function removeRecipe(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings],
    async () => {
      await db.malts.where('recipeId').equals(id).delete();
      await db.hops.where('recipeId').equals(id).delete();
      await db.mashSteps.where('recipeId').equals(id).delete();
      await db.boilAdds.where('recipeId').equals(id).delete();
      await db.ferments.where('recipeId').equals(id).delete();
      await db.packagings.where('recipeId').equals(id).delete();
      await db.recipes.delete(id);
    }
  );
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  recipes: Recipe[];
  malts: Malt[];
  hops: Hop[];
  mashSteps: MashStep[];
  boilAdds: BoilAdd[];
  ferments: Ferment[];
  packagings: Packaging[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [recipes, malts, hops, mashSteps, boilAdds, ferments, packagings] = await Promise.all([
    db.recipes.toArray(),
    db.malts.toArray(),
    db.hops.toArray(),
    db.mashSteps.toArray(),
    db.boilAdds.toArray(),
    db.ferments.toArray(),
    db.packagings.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    recipes: recipes.map(stripRow),
    malts: malts.map(stripRow),
    hops: hops.map(stripRow),
    mashSteps: mashSteps.map(stripRow),
    boilAdds: boilAdds.map(stripRow),
    ferments: ferments.map(stripRow),
    packagings: packagings.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/**
 * 旧备份里的罐装行可能没有 og / fg 字段：先按当前结构回填（以发酵读数为准，
 * 读数缺失时退回配方目标值），再落库。返回补齐后的新数组，不改入参。
 */
function backfillPackagingStructure(snapshot: DatabaseSnapshot): Packaging[] {
  const fermentByBatch = new Map<string, Ferment[]>();
  for (const row of snapshot.ferments) {
    const list = fermentByBatch.get(row.batchNo);
    if (list) list.push(row);
    else fermentByBatch.set(row.batchNo, [row]);
  }
  const recipeById = new Map(snapshot.recipes.map((row) => [row.id, row]));
  return snapshot.packagings.map((row) => {
    if (typeof row.og === 'number' && typeof row.fg === 'number') return row;
    const derived = packagingGravityFromFerments(fermentByBatch.get(row.batchNo) ?? []);
    const recipe = recipeById.get(row.recipeId);
    return {
      ...row,
      og: derived?.og ?? recipe?.targetOg ?? 0,
      fg: derived?.complete ? derived.fg : recipe?.targetFg ?? 0
    };
  });
}

/** 分批写入：超过单批容量时拆成多个 bulkPut，调用方需已处在事务中 */
async function bulkPutChunked<T>(table: { bulkPut: (rows: T[]) => Promise<unknown> }, rows: T[]): Promise<void> {
  for (const chunk of chunkArray(rows)) {
    await table.bulkPut(chunk);
  }
}

/**
 * 整库导入：清空 + 覆盖写入全部放在同一个 Dexie 事务里，
 * 任何一张表写入失败都会整体回滚（旧数据保留），用户修正备份后可重试。
 * 旧备份缺 og / fg 字段时先按当前结构回填；行数超过单批容量时自动分批写入。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const packagings = backfillPackagingStructure(snapshot);
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear()
      ]);
      await bulkPutChunked(db.recipes, snapshot.recipes.map(stamp));
      await bulkPutChunked(db.malts, snapshot.malts.map(stamp));
      await bulkPutChunked(db.hops, snapshot.hops.map(stamp));
      await bulkPutChunked(db.mashSteps, snapshot.mashSteps.map(stamp));
      await bulkPutChunked(db.boilAdds, snapshot.boilAdds.map(stamp));
      await bulkPutChunked(db.ferments, snapshot.ferments.map(stamp));
      await bulkPutChunked(db.packagings, packagings.map(stamp));
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear()
      ]);
    }
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
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

/* --------------------------- 月底对账：改写 / 回滚 --------------------------- */

/** 对账前某条罐装批次的 OG / FG / ABV 留底（回滚凭据） */
export interface PackagingGravityBackup {
  id: string;
  batchNo: string;
  og: number;
  fg: number;
  abv: number;
}

/**
 * 按对账计划改写罐装批次的 OG / FG / ABV：
 * - 全部补丁在同一个 Dexie 事务内分批 bulkPut，任一补丁失败整体回滚，库内仍是对账前数值，可直接重试；
 * - 同时返回受影响行改写前的留底，供「退回对账前的数值」使用。
 * 以补丁 id 重新整行读出后再覆盖三个字段，避免补丁与库内当前行结构不一致时误伤其它列。
 */
export async function applyReconcilePatches(
  patches: PackagingGravityPatch[]
): Promise<PackagingGravityBackup[]> {
  if (patches.length === 0) return [];
  const backups: PackagingGravityBackup[] = [];
  await db.transaction('rw', [db.packagings], async () => {
    for (const chunk of chunkArray(patches)) {
      const rows: PackagingRow[] = [];
      for (const patch of chunk) {
        const current = await db.packagings.get(patch.id);
        if (!current) {
          // 行已被删除（如整库重导）：跳过并保留留底缺失，调用方可据备份核对
          continue;
        }
        backups.push({
          id: current.id,
          batchNo: current.batchNo,
          og: current.og,
          fg: current.fg,
          abv: current.abv
        });
        rows.push({ ...current, og: patch.og, fg: patch.fg, abv: patch.abv, updatedAt: Date.now() });
      }
      if (rows.length > 0) await db.packagings.bulkPut(rows);
    }
  });
  return backups;
}

/**
 * 退回对账前的数值：把改写留底重新分批写回。
 * 同样包在单个事务里，失败整体不动、可重试；留底里已不存在的行跳过（不复活已删除批次）。
 */
export async function restorePackagingGravity(backups: PackagingGravityBackup[]): Promise<number> {
  if (backups.length === 0) return 0;
  let restored = 0;
  await db.transaction('rw', [db.packagings], async () => {
    for (const chunk of chunkArray(backups)) {
      const rows: PackagingRow[] = [];
      for (const backup of chunk) {
        const current = await db.packagings.get(backup.id);
        if (!current) continue;
        rows.push({
          ...current,
          og: backup.og,
          fg: backup.fg,
          abv: backup.abv,
          updatedAt: Date.now()
        });
        restored += 1;
      }
      if (rows.length > 0) await db.packagings.bulkPut(rows);
    }
  });
  return restored;
}
