/** 罐装批次 feature 的 NgRx actions */
import { createActionGroup, emptyProps, props } from '@ngrx/store';
import type { FilterModel } from '../../models/filter.model';
import type { Packaging } from '../../models/packaging.model';
import type { PackagingRow, PackagingGravityBackup } from '../../utils/db';
import type { PackagingGravityPatch, ReconcilePlan } from '../../utils/reconcile';

export const PackagingActions = createActionGroup({
  source: 'Packaging',
  events: {
    'Load Packagings': emptyProps(),
    'Load Packagings Success': props<{ packagings: PackagingRow[] }>(),
    'Set Filter': props<{ filter: FilterModel }>(),
    'Reset Filter': emptyProps(),
    'Create Packaging': props<{ payload: Omit<Packaging, 'id'> }>(),
    'Update Packaging': props<{ id: string; patch: Partial<Packaging> }>(),
    'Delete Packaging': props<{ id: string }>(),

    /** 月底对账：按批次号核对发酵读数与罐装记录（只生成计划，不落库） */
    'Run Reconcile': emptyProps(),
    'Run Reconcile Success': props<{ plan: ReconcilePlan }>(),
    'Run Reconcile Failure': props<{ error: string }>(),
    /** 按对账计划分批改写罐装 OG / FG / ABV（事务，失败可重试） */
    'Apply Reconcile': props<{ patches: PackagingGravityPatch[] }>(),
    'Apply Reconcile Success': props<{ backups: PackagingGravityBackup[]; updated: number }>(),
    'Apply Reconcile Failure': props<{ error: string }>(),
    /** 退回对账前的数值（凭改写留底回滚） */
    'Rollback Reconcile': props<{ backups: PackagingGravityBackup[] }>(),
    'Rollback Reconcile Success': props<{ restored: number }>(),
    'Rollback Reconcile Failure': props<{ error: string }>(),
    /** 清掉对账结果面板 */
    'Clear Reconcile': emptyProps()
  }
});
