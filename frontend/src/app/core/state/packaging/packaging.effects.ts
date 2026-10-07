/**
 * 罐装批次 feature effects：
 * - 月底对账计划生成（按批次号核对发酵读数，纯计算不落库）
 * - 按计划分批改写罐装 OG / FG / ABV（Dexie 事务，失败可重试）
 * - 凭留底退回对账前的数值
 * 罐装批次的增删改仍由 FermentEffects 统一收口（与发酵读数共用一次 reload）。
 */
import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, exhaustMap, forkJoin, from, map, of, switchMap } from 'rxjs';
import { RecipeService } from '../../services/recipe.service';
import {
  applyReconcilePatches,
  restorePackagingGravity
} from '../../utils/db';
import { buildReconcilePlan, planToPatches } from '../../utils/reconcile';
import { FermentActions } from '../ferment/ferment.actions';
import { PackagingActions } from './packaging.actions';

@Injectable()
export class PackagingEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(RecipeService);

  /** 生成对账计划：读数与罐装批次都从本地库现取，计划只存 NgRx，不写库 */
  runReconcile$ = createEffect(() =>
    this.actions$.pipe(
      ofType(PackagingActions.runReconcile),
      switchMap(() =>
        forkJoin({
          ferments: from(this.service.listFerments()),
          packagings: from(this.service.listPackagings())
        }).pipe(
          map(({ ferments, packagings }) =>
            PackagingActions.runReconcileSuccess({ plan: buildReconcilePlan(packagings, ferments) })
          ),
          catchError((error: unknown) =>
            of(
              PackagingActions.runReconcileFailure({
                error: error instanceof Error ? error.message : '对账计划生成失败'
              })
            )
          )
        )
      )
    )
  );

  /** 执行改写：事务内分批写入，成功后广播 reload 刷新表格；失败不改库，可直接重试 */
  applyReconcile$ = createEffect(() =>
    this.actions$.pipe(
      ofType(PackagingActions.applyReconcile),
      exhaustMap(({ patches }) =>
        from(applyReconcilePatches(patches)).pipe(
          switchMap((backups) => [
            PackagingActions.applyReconcileSuccess({ backups, updated: patches.length }),
            FermentActions.loadFerments()
          ]),
          catchError((error: unknown) =>
            of(
              PackagingActions.applyReconcileFailure({
                error: error instanceof Error ? error.message : '改写失败，库内仍是对账前数值，可重试'
              })
            )
          )
        )
      )
    )
  );

  /** 退回对账前的数值：成功后同样广播 reload */
  rollbackReconcile$ = createEffect(() =>
    this.actions$.pipe(
      ofType(PackagingActions.rollbackReconcile),
      exhaustMap(({ backups }) =>
        from(restorePackagingGravity(backups)).pipe(
          switchMap((restored) => [
            PackagingActions.rollbackReconcileSuccess({ restored }),
            FermentActions.loadFerments()
          ]),
          catchError((error: unknown) =>
            of(
              PackagingActions.rollbackReconcileFailure({
                error: error instanceof Error ? error.message : '回滚失败，可重试'
              })
            )
          )
        )
      )
    )
  );
}
