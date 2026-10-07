/** 罐装批次 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import { PackagingState } from './packaging.reducer';

export const selectPackagingState = createFeatureSelector<PackagingState>('packaging');

export const selectAllPackagings = createSelector(selectPackagingState, (state) => state.packagings);
export const selectPackagingFilter = createSelector(selectPackagingState, (state) => state.filter);
export const selectReconcilePlan = createSelector(selectPackagingState, (state) => state.reconcilePlan);
export const selectReconcileBusy = createSelector(selectPackagingState, (state) => state.reconcileBusy);
export const selectReconcileError = createSelector(selectPackagingState, (state) => state.reconcileError);
export const selectReconcileBackups = createSelector(selectPackagingState, (state) => state.reconcileBackups);
export const selectLastAppliedCount = createSelector(selectPackagingState, (state) => state.lastAppliedCount);
export const selectLastAppliedAt = createSelector(selectPackagingState, (state) => state.lastAppliedAt);
export const selectLastRestoredCount = createSelector(selectPackagingState, (state) => state.lastRestoredCount);
export const selectLastRestoredAt = createSelector(selectPackagingState, (state) => state.lastRestoredAt);
export const selectReconcileErrorAt = createSelector(selectPackagingState, (state) => state.reconcileErrorAt);

export const selectFilteredPackagings = createSelector(
  selectAllPackagings,
  selectPackagingFilter,
  (packagings, filter) => {
    const keyword = String(filter['keyword'] ?? '').trim().toLowerCase();
    const containers = Array.isArray(filter['containers']) ? (filter['containers'] as string[]) : [];
    return packagings
      .filter((item) => {
        const label = `${item.batchNo} ${item.container}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (containers.length > 0 && !containers.includes(item.container)) return false;
        return true;
      })
      .sort((a, b) => b.packDate.localeCompare(a.packDate));
  }
);

/** 某配方已罐装的总数量 */
export const selectPackagedQuantityByRecipe = (recipeId: string) =>
  createSelector(selectAllPackagings, (packagings) =>
    packagings.filter((item) => item.recipeId === recipeId).reduce((sum, item) => sum + item.quantity, 0)
  );
