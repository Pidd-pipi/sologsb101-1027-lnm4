/**
 * 月底对账：按批次号把糖化（发酵读数）与罐装两套记录并成一份实绩。
 * - 同一批次号两边各记一次，以发酵读数为准，改写罐装批次的 OG / FG / ABV；
 * - 对不上的批次（缺读数、读数不足、OG/FG/ABV 与读数不一致）单独列出来备查；
 * - 对账计划是纯数据（plan），不落库、可预览；执行分批写入，整批改动放进 Dexie 事务，
 *   中途失败可凭 before 快照重试或整批回滚到对账前的数值。
 */
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import { abvFromGravity } from './brew';
import { packagingGravityFromFerments, roundGravity } from '../models/packaging.model';

/** 对不上的原因 */
export type ReconcileIssueKind =
  | '罐装无发酵读数' // 发酵表里查不到该批次号
  | '发酵读数不足' // 只有 1 条读数，无法确定 FG
  | 'OG不一致'
  | 'FG不一致'
  | 'ABV不一致';

/** 单条对账差异（备查用） */
export interface ReconcileIssue {
  kind: ReconcileIssueKind;
  /** 差异说明（人话） */
  detail: string;
  /** 罐装侧现值（缺字段时为 null） */
  packagingValue: number | null;
  /** 发酵读数口径值（读数缺失时为 null） */
  fermentValue: number | null;
}

/** 一条罐装批次的对账结果 */
export interface ReconcileItem {
  packaging: Packaging;
  /** 该批次号在发酵表中的全部读数 */
  ferments: Ferment[];
  /** 对账后应写入的 OG / FG / ABV；读数不足时为 null（不改写） */
  expected: { og: number; fg: number; abv: number } | null;
  /** 与罐装现值是否一致（一致则无需改写，但缺读数 / 读数不足仍然列出备查） */
  matched: boolean;
  /** 是否需要改写（以发酵读数为准） */
  needsUpdate: boolean;
  issues: ReconcileIssue[];
}

/** 整批对账结果 */
export interface ReconcilePlan {
  /** 生成时间 ISO */
  reconciledAt: string;
  items: ReconcileItem[];
  /** 需要改写的罐装批次 */
  updates: ReconcileItem[];
  /** 对不上、需单独备查的批次（含缺读数 / 读数不足 / 数值不一致） */
  mismatches: ReconcileItem[];
  summary: {
    total: number;
    matched: number;
    toUpdate: number;
    missingFerment: number;
    incompleteFerment: number;
  };
}

/** ABV 允许的抄写误差（%vol） */
export const ABV_TOLERANCE = 0.05;
/** 比重允许的抄写误差（4 位小数口径下只认真值） */
export const GRAVITY_TOLERANCE = 0.0005;

/** 单批对账（纯函数） */
export function reconcilePackaging(packaging: Packaging, ferments: Ferment[]): ReconcileItem {
  const issues: ReconcileIssue[] = [];
  const derived = packagingGravityFromFerments(ferments);

  if (!derived) {
    issues.push({
      kind: '罐装无发酵读数',
      detail: '发酵表中查不到该批次号的读数，无法以发酵读数为准改写',
      packagingValue: packaging.og,
      fermentValue: null
    });
    return {
      packaging,
      ferments,
      expected: null,
      matched: false,
      needsUpdate: false,
      issues
    };
  }

  if (!derived.complete) {
    issues.push({
      kind: '发酵读数不足',
      detail: `该批次仅有 ${ferments.length} 条发酵读数，无法确定 FG，暂不改写`,
      packagingValue: packaging.fg,
      fermentValue: derived.og
    });
  }

  const expectedOg = derived.og;
  const expectedFg = derived.complete ? derived.fg : null;
  const expectedAbv = derived.complete ? abvFromGravity(expectedOg, expectedFg as number) : null;

  const ogBad = Math.abs((packaging.og || 0) - expectedOg) > GRAVITY_TOLERANCE;
  if (ogBad) {
    issues.push({
      kind: 'OG不一致',
      detail: `罐装抄写 OG ${packaging.og || '（空）'} 与发酵首读 ${expectedOg} 不一致`,
      packagingValue: packaging.og || null,
      fermentValue: expectedOg
    });
  }

  let fgBad = false;
  if (expectedFg !== null) {
    fgBad = Math.abs((packaging.fg || 0) - expectedFg) > GRAVITY_TOLERANCE;
    if (fgBad) {
      issues.push({
        kind: 'FG不一致',
        detail: `罐装抄写 FG ${packaging.fg || '（空）'} 与发酵末读 ${expectedFg} 不一致`,
        packagingValue: packaging.fg || null,
        fermentValue: expectedFg
      });
    }
  }

  let abvBad = false;
  if (expectedAbv !== null) {
    abvBad = Math.abs((packaging.abv || 0) - expectedAbv) > ABV_TOLERANCE;
    if (abvBad) {
      issues.push({
        kind: 'ABV不一致',
        detail: `罐装登记 ABV ${packaging.abv || '（空）'}%vol 与读数回算 ${expectedAbv}%vol 不一致`,
        packagingValue: packaging.abv || null,
        fermentValue: expectedAbv
      });
    }
  }

  const expected =
    expectedFg !== null && expectedAbv !== null
      ? { og: expectedOg, fg: expectedFg, abv: expectedAbv }
      : null;
  // 读数齐全才允许改写；读数不足时只备查、不动账
  const needsUpdate = expected !== null && (ogBad || fgBad || abvBad);

  return {
    packaging,
    ferments,
    expected,
    matched: issues.length === 0,
    needsUpdate,
    issues
  };
}

/**
 * 全量对账：按批次号分组发酵读数，逐条核对罐装批次。
 * @param nowIso 可选的时间注入（测试用）
 */
export function buildReconcilePlan(
  packagings: Packaging[],
  ferments: Ferment[],
  nowIso: string = new Date().toISOString()
): ReconcilePlan {
  const fermentByBatch = new Map<string, Ferment[]>();
  for (const row of ferments) {
    const list = fermentByBatch.get(row.batchNo);
    if (list) {
      list.push(row);
    } else {
      fermentByBatch.set(row.batchNo, [row]);
    }
  }

  // 同一批次号若在罐装表出现多次，各自一条对账结果，互不覆盖
  const items = [...packagings]
    .sort((a, b) => a.batchNo.localeCompare(b.batchNo, 'zh-Hans-CN'))
    .map((row) => reconcilePackaging(row, fermentByBatch.get(row.batchNo) ?? []));

  const updates = items.filter((item) => item.needsUpdate);
  const mismatches = items.filter((item) => item.issues.length > 0);

  return {
    reconciledAt: nowIso,
    items,
    updates,
    mismatches,
    summary: {
      total: items.length,
      matched: items.filter((item) => item.matched).length,
      toUpdate: updates.length,
      missingFerment: items.filter((item) => item.issues.some((i) => i.kind === '罐装无发酵读数')).length,
      incompleteFerment: items.filter((item) => item.issues.some((i) => i.kind === '发酵读数不足')).length
    }
  };
}

/** 一条待执行的改写（携带对账前的值，供回滚） */
export interface PackagingGravityPatch {
  id: string;
  batchNo: string;
  og: number;
  fg: number;
  abv: number;
}

/** 从计划中取出待写入的补丁 */
export function planToPatches(plan: ReconcilePlan): PackagingGravityPatch[] {
  return plan.updates
    .filter((item): item is ReconcileItem & { expected: { og: number; fg: number; abv: number } } =>
      item.expected !== null
    )
    .map((item) => ({
      id: item.packaging.id,
      batchNo: item.packaging.batchNo,
      og: roundGravity(item.expected.og),
      fg: roundGravity(item.expected.fg),
      abv: item.expected.abv
    }));
}
