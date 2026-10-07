import type { Ferment } from './ferment.model';
import { abvFromGravity } from '../utils/brew';

/** 容器类型 */
export type ContainerType = '桶装' | '瓶装' | '罐装';

/** 罐装批次 */
export interface Packaging {
  id: string;
  /** 批次号 */
  batchNo: string;
  /** 所属配方 */
  recipeId: string;
  /** 罐装日期 */
  packDate: string;
  /** 容器 */
  container: ContainerType;
  /** 数量 */
  quantity: number;
  /** 二氧化碳体积 */
  carbonationVol: number;
  /** 罐装时抄写的初始比重（月底以发酵读数为准对账改写） */
  og: number;
  /** 罐装时抄写的最终比重（月底以发酵读数为准对账改写） */
  fg: number;
  /** 最终酒精度 %vol（由 OG / FG 回算） */
  abv: number;
}

export const CONTAINER_TYPES: ContainerType[] = ['桶装', '瓶装', '罐装'];

export function createEmptyPackaging(): Omit<Packaging, 'id'> {
  return {
    batchNo: '',
    recipeId: '',
    packDate: new Date().toISOString().slice(0, 10),
    container: '瓶装',
    quantity: 24,
    carbonationVol: 2.4,
    og: 1.05,
    fg: 1.012,
    abv: 5.2
  };
}

/** 一批发酵读数按日期排好后的首尾读数（对账与表单回算共用，保证口径一致） */
export interface BatchGravitySummary {
  /** 该批次读数条数 */
  count: number;
  /** 初始比重：最早一条读数 */
  og: number;
  /** 最终比重：最晚一条读数；只有一条读数时与 OG 相同 */
  fg: number;
  /** 是否足以对账（≥ 2 条读数才能确定 FG） */
  complete: boolean;
}

/** 比重数值保留 4 位小数（避免抄写时浮点尾巴） */
export function roundGravity(value: number): number {
  return Number(value.toFixed(4));
}

/** 汇总某个批次号下的发酵读数，得出对账口径的 OG / FG */
export function summarizeBatchFerments(ferments: Ferment[]): BatchGravitySummary | null {
  const sorted = [...ferments].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return null;
  const og = roundGravity(sorted[0].gravity);
  const fg = roundGravity(sorted[sorted.length - 1].gravity);
  return { count: sorted.length, og, fg, complete: sorted.length >= 2 };
}

/** 按发酵读数回算罐装实绩 OG / FG / ABV（读数不足时仅回填 OG，FG 留空含义由调用方处理） */
export function packagingGravityFromFerments(
  ferments: Ferment[]
): { og: number; fg: number; abv: number; complete: boolean } | null {
  const summary = summarizeBatchFerments(ferments);
  if (!summary) return null;
  return {
    og: summary.og,
    fg: summary.complete ? summary.fg : 0,
    abv: summary.complete ? abvFromGravity(summary.og, summary.fg) : 0,
    complete: summary.complete
  };
}
