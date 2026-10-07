/**
 * ReconcileService：月末批次对账的读写编排。
 * 计划由 core/utils/reconcile.ts 的纯函数生成，这里负责：
 * 对账前抓快照 → 超容量时分批写入 → 中途失败自动回滚（可重试）→ 支持手动退回对账前的数值。
 */
import { Injectable } from '@angular/core';
import { db, IMPORT_CHUNK_SIZE, type PackagingRow } from '../utils/db';
import { planReconciliation, type ReconcilePlan } from '../utils/reconcile';

export interface ReconcileReport {
  plan: ReconcilePlan;
  /** 实际改写的批次数 */
  changed: number;
  /** 分批批次数（>1 表示触发了分批写入） */
  batches: number;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

@Injectable({ providedIn: 'root' })
export class ReconcileService {
  /** 最近一次对账前的罐装行快照，用于「退回对账前的数值」 */
  private preReconcileSnapshot: PackagingRow[] | null = null;

  /** 是否有可退回的对账前快照 */
  get canRollback(): boolean {
    return this.preReconcileSnapshot !== null;
  }

  /**
   * 按批次号对账：以发酵读数为准改写罐装批次的 OG / FG / ABV。
   * 写入超过容量（IMPORT_CHUNK_SIZE）时分批提交；任一批中途失败，
   * 自动用对账前快照回滚后抛错，调用方修正环境后可原样重试。
   */
  async reconcile(): Promise<ReconcileReport> {
    const [packagings, ferments] = await Promise.all([db.packagings.toArray(), db.ferments.toArray()]);
    const plan = planReconciliation(packagings, ferments);
    if (plan.changes.length === 0) {
      return { plan, changed: 0, batches: 0 };
    }

    const snapshot = packagings.map((row) => ({ ...row }));
    let batches = 0;
    try {
      for (const group of chunks(plan.changes, IMPORT_CHUNK_SIZE)) {
        await db.transaction('rw', [db.packagings], async () => {
          const now = Date.now();
          for (const change of group) {
            await db.packagings.update(change.id, { ...change.after, updatedAt: now });
          }
        });
        batches += 1;
      }
    } catch (error) {
      await this.restoreSnapshot(snapshot);
      const reason = error instanceof Error ? error.message : '未知错误';
      throw new Error(`对账写入中途失败，已退回对账前的数值（${reason}），可重试`);
    }

    this.preReconcileSnapshot = snapshot;
    return { plan, changed: plan.changes.length, batches };
  }

  /** 退回对账前的数值：把最近一次对账前的罐装行整体写回 */
  async rollback(): Promise<number> {
    const snapshot = this.preReconcileSnapshot;
    if (!snapshot) return 0;
    await this.restoreSnapshot(snapshot);
    this.preReconcileSnapshot = null;
    return snapshot.length;
  }

  private async restoreSnapshot(snapshot: PackagingRow[]): Promise<void> {
    await db.transaction('rw', [db.packagings], async () => {
      await db.packagings.clear();
      await db.packagings.bulkPut(snapshot);
    });
  }
}
