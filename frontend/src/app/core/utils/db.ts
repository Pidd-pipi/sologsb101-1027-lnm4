/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbbrewhouse-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 配方 / 麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵读数 / 罐装批次 七张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrewhouse-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移）：v2 为罐装批次补 og / fg 实绩字段 */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 2;

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

    const stores = {
      recipes: 'id, name, style, targetOg, updatedAt',
      malts: 'id, recipeId, name, ebc, type, updatedAt',
      hops: 'id, recipeId, name, alphaPct, form, updatedAt',
      mashSteps: 'id, recipeId, seq, state, updatedAt',
      boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
      ferments: 'id, recipeId, batchNo, date, state, updatedAt',
      packagings: 'id, recipeId, batchNo, packDate, container, updatedAt'
    };

    this.version(1)
      .stores(stores)
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['recipes', 'malts', 'hops', 'mashSteps', 'boilAdds', 'ferments', 'packagings'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = 1;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });

    this.version(DB_SCHEMA_VERSION)
      .stores(stores)
      .upgrade(async (tx) => {
        // v2 迁移：罐装批次新增 og / fg 实绩字段，历史行先补 0，由月末对账按发酵读数回写
        await tx
          .table('packagings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.og !== 'number') row.og = 0;
            if (typeof row.fg !== 'number') row.fg = 0;
            row.revision = ROW_REVISION;
            row.updatedAt = Date.now();
          });
        // 兜底：早于 v1 迁移逻辑的历史库若缺行修订号与时间戳，一并补齐（幂等）
        const tableNames = ['recipes', 'malts', 'hops', 'mashSteps', 'boilAdds', 'ferments', 'packagings'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
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

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
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
      await db.recipes.bulkPut(snapshot.recipes.map(stamp));
      await db.malts.bulkPut(snapshot.malts.map(stamp));
      await db.hops.bulkPut(snapshot.hops.map(stamp));
      await db.mashSteps.bulkPut(snapshot.mashSteps.map(stamp));
      await db.boilAdds.bulkPut(snapshot.boilAdds.map(stamp));
      await db.ferments.bulkPut(snapshot.ferments.map(stamp));
      await db.packagings.bulkPut(snapshot.packagings.map(stamp));
    }
  );
}

/** 单次事务最多写入的行数，超过就分批写入，避免一次导入超出容量 */
export const IMPORT_CHUNK_SIZE = 500;

export interface ChunkedImportResult {
  /** 实际写入的总行数 */
  rows: number;
  /** 分批批次数（>1 表示触发了分批写入） */
  batches: number;
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

async function clearAllTables(): Promise<void> {
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
}

/** 单张表按 chunkSize 分批写入（每批一个 bulkPut），返回写入行数与批次数 */
async function writeTableInChunks<T extends object>(
  table: Table<T & Revisioned, string>,
  rows: T[],
  chunkSize: number
): Promise<ChunkedImportResult> {
  let written = 0;
  let batches = 0;
  for (const chunk of chunkRows(rows.map(stamp), chunkSize)) {
    await table.bulkPut(chunk);
    written += chunk.length;
    batches += 1;
  }
  return { rows: written, batches };
}

/** 按表分批写入快照（逐表顺序执行，每张表内按 chunkSize 分批） */
async function writeSnapshotInChunks(snapshot: DatabaseSnapshot, chunkSize: number): Promise<ChunkedImportResult> {
  const writers: Array<() => Promise<ChunkedImportResult>> = [
    () => writeTableInChunks(db.recipes, snapshot.recipes, chunkSize),
    () => writeTableInChunks(db.malts, snapshot.malts, chunkSize),
    () => writeTableInChunks(db.hops, snapshot.hops, chunkSize),
    () => writeTableInChunks(db.mashSteps, snapshot.mashSteps, chunkSize),
    () => writeTableInChunks(db.boilAdds, snapshot.boilAdds, chunkSize),
    () => writeTableInChunks(db.ferments, snapshot.ferments, chunkSize),
    () => writeTableInChunks(db.packagings, snapshot.packagings, chunkSize)
  ];
  let rows = 0;
  let batches = 0;
  for (const write of writers) {
    const result = await write();
    rows += result.rows;
    batches += result.batches;
  }
  return { rows, batches };
}

/**
 * 分批导入整库快照：一次导入超过容量（IMPORT_CHUNK_SIZE）时自动分批写入。
 * 任一批中途失败时，用导入前抓取的快照整体回滚，库退回到导入前的数值；
 * 修正备份内容后可安全重试（导入是覆盖式且幂等的）。
 */
export async function importSnapshotChunked(
  snapshot: DatabaseSnapshot,
  chunkSize = IMPORT_CHUNK_SIZE
): Promise<ChunkedImportResult> {
  const backup = await exportSnapshot();
  try {
    await clearAllTables();
    return await writeSnapshotInChunks(snapshot, chunkSize);
  } catch (error) {
    await clearAllTables();
    await writeSnapshotInChunks(backup, chunkSize);
    const reason = error instanceof Error ? error.message : '未知错误';
    throw new Error(`导入中途失败，已回滚到导入前数据（${reason}），修正后可重试`);
  }
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
