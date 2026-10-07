/** 罐装批次 feature reducer */
import { createReducer, on } from '@ngrx/store';
import type { FilterModel } from '../../models/filter.model';
import type { PackagingGravityBackup, PackagingRow } from '../../utils/db';
import type { ReconcilePlan } from '../../utils/reconcile';
import { PackagingActions } from './packaging.actions';

export interface PackagingState {
  packagings: PackagingRow[];
  filter: FilterModel;
  /** 最近一次对账计划（备查清单） */
  reconcilePlan: ReconcilePlan | null;
  /** 对账是否正在跑（生成计划 / 改写 / 回滚共用一个忙碌标记） */
  reconcileBusy: boolean;
  /** 最近一次对账动作的错误信息，空串表示无错误 */
  reconcileError: string;
  /** 改写成功后的对账前留底，用于「退回对账前的数值」 */
  reconcileBackups: PackagingGravityBackup[];
  /** 最近一次成功改写的批次数 */
  lastAppliedCount: number;
  /** 最近一次成功改写的时间戳（同样批数重复改写时也能触发提示 / 重新对账） */
  lastAppliedAt: number;
  /** 最近一次成功回滚的批次数 */
  lastRestoredCount: number;
  /** 最近一次成功回滚的时间戳 */
  lastRestoredAt: number;
  /** 最近一次对账失败的时间戳（同样的错误信息重复出现时也能弹提示） */
  reconcileErrorAt: number;
}

export const initialPackagingState: PackagingState = {
  packagings: [],
  filter: { keyword: '', containers: [] },
  reconcilePlan: null,
  reconcileBusy: false,
  reconcileError: '',
  reconcileBackups: [],
  lastAppliedCount: 0,
  lastAppliedAt: 0,
  lastRestoredCount: 0,
  lastRestoredAt: 0,
  reconcileErrorAt: 0
};

export const packagingReducer = createReducer(
  initialPackagingState,
  on(PackagingActions.loadPackagingsSuccess, (state, { packagings }) => ({ ...state, packagings })),
  on(PackagingActions.setFilter, (state, { filter }) => ({ ...state, filter })),
  on(PackagingActions.resetFilter, (state) => ({ ...state, filter: { keyword: '', containers: [] } })),

  on(PackagingActions.runReconcile, (state) => ({ ...state, reconcileBusy: true, reconcileError: '' })),
  on(PackagingActions.runReconcileSuccess, (state, { plan }) => ({
    ...state,
    reconcilePlan: plan,
    reconcileBusy: false,
    reconcileError: ''
  })),
  on(PackagingActions.runReconcileFailure, (state, { error }) => ({
    ...state,
    reconcileBusy: false,
    reconcileError: error,
    reconcileErrorAt: Date.now()
  })),

  on(PackagingActions.applyReconcile, (state) => ({ ...state, reconcileBusy: true, reconcileError: '' })),
  on(PackagingActions.applyReconcileSuccess, (state, { backups, updated }) => ({
    ...state,
    reconcileBusy: false,
    reconcileError: '',
    // 多次对账改写时留底始终保留「最初对账前」的数值，便于一次退回
    reconcileBackups: state.reconcileBackups.length > 0 ? state.reconcileBackups : backups,
    lastAppliedCount: updated,
    lastAppliedAt: Date.now()
  })),
  on(PackagingActions.applyReconcileFailure, (state, { error }) => ({
    ...state,
    reconcileBusy: false,
    reconcileError: error,
    reconcileErrorAt: Date.now()
  })),

  on(PackagingActions.rollbackReconcile, (state) => ({ ...state, reconcileBusy: true, reconcileError: '' })),
  on(PackagingActions.rollbackReconcileSuccess, (state, { restored }) => ({
    ...state,
    reconcileBusy: false,
    reconcileError: '',
    reconcileBackups: [],
    lastRestoredCount: restored,
    lastRestoredAt: Date.now()
  })),
  on(PackagingActions.rollbackReconcileFailure, (state, { error }) => ({
    ...state,
    reconcileBusy: false,
    reconcileError: error,
    reconcileErrorAt: Date.now()
  })),

  on(PackagingActions.clearReconcile, (state) => ({
    ...state,
    reconcilePlan: null,
    reconcileBusy: false,
    reconcileError: '',
    // 整库重导 / 重置后留底已失效，必须一并清掉，避免把旧库的对账前值写回新库
    reconcileBackups: [],
    lastAppliedCount: 0,
    lastAppliedAt: 0,
    lastRestoredCount: 0,
    lastRestoredAt: 0,
    reconcileErrorAt: 0
  }))
);
