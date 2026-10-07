/** /packaging 罐装批次登记与结构版本导出：本地库版本查看与 JSON 导入导出 */
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { FilterBarComponent } from '../../shared/components/filter-bar/filter-bar.component';
import { StatBadgeComponent } from '../../shared/components/stat-badge/stat-badge.component';
import { EmptyPanelComponent } from '../../shared/components/empty-panel/empty-panel.component';
import { CONTAINER_TYPES, createEmptyPackaging, type Packaging } from '../../core/models/packaging.model';
import {
  filtersToQueryParams,
  queryParamsToFilters,
  type FilterModel,
  type FilterSelectConfig
} from '../../core/models/filter.model';
import { PackagingActions } from '../../core/state/packaging/packaging.actions';
import { selectAllPackagings, selectFilteredPackagings, selectPackagingFilter } from '../../core/state/packaging/packaging.selectors';
import { selectAllFerments } from '../../core/state/ferment/ferment.selectors';
import { selectAllRecipes, selectSelectedRecipeId } from '../../core/state/recipe/recipe.selectors';
import { RecipeActions } from '../../core/state/recipe/recipe.actions';
import { FermentActions } from '../../core/state/ferment/ferment.actions';
import {
  countAll,
  DB_NAME,
  DB_SCHEMA_VERSION,
  exportSnapshot,
  importSnapshotChunked,
  initDatabase,
  resetDatabase,
  type DatabaseSnapshot,
  type PackagingRow
} from '../../core/utils/db';
import {
  buildRecipeArchive,
  downloadJson,
  parseArchive,
  serializeArchive,
  type RecipeArchive
} from '../../core/utils/export';
import { backfillSnapshot } from '../../core/utils/reconcile';
import { ReconcileService, type ReconcileReport } from '../../core/services/reconcile.service';
import { abvFromGravity } from '../../core/utils/brew';

@Component({
  selector: 'app-packaging-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    FilterBarComponent,
    StatBadgeComponent,
    EmptyPanelComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page__head">
        <div>
          <h2 class="page__title">罐装批次登记与结构版本导出</h2>
          <p class="page__subtitle">
            本地库 {{ dbName }}（结构版本 v{{ schemaVersion }}）· 罐装批次由发酵读数自动带出 OG / FG 与 ABV。
          </p>
        </div>
        <button mat-flat-button color="primary" type="button" (click)="openCreate()" [disabled]="recipes().length === 0">
          <mat-icon>add</mat-icon>
          新增罐装批次
        </button>
      </div>

      <div class="badge-row">
        <app-stat-badge label="罐装批次" [value]="filtered().length" suffix="个" tone="primary" icon="inventory_2" />
        <app-stat-badge label="总数量" [value]="totalQuantity()" tone="warning" icon="numbers" />
        <app-stat-badge label="平均酒精度" [value]="avgAbv()" suffix="%vol" tone="danger" icon="local_bar" />
        <app-stat-badge label="平均二氧化碳" [value]="avgCarbonation()" suffix="vol" tone="info" icon="bubble_chart" />
        <app-stat-badge label="覆盖配方" [value]="recipeCoverage()" suffix="个" tone="success" icon="menu_book" />
      </div>

      <app-filter-bar
        [filters]="filter()"
        [selects]="selects"
        keywordPlaceholder="搜索批次号 / 容器类型…"
        (filtersChange)="onFilterChange($event)"
        (reset)="onResetFilter()"
      ></app-filter-bar>

      @if (filtered().length === 0) {
        <app-empty-panel
          title="暂无罐装批次"
          description="登记罐装日期、容器与数量，系统会按发酵读数带出 OG / FG 与 ABV。"
          createText="新增罐装批次"
          (create)="openCreate()"
        ></app-empty-panel>
      } @else {
        <mat-card appearance="outlined">
          <mat-card-content>
            <table class="data-table">
              <thead>
                <tr>
                  <th>批次号</th>
                  <th>配方</th>
                  <th>罐装日期</th>
                  <th>容器</th>
                  <th>数量</th>
                  <th>CO₂ 体积</th>
                  <th>ABV</th>
                  <th>OG / FG 实绩</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                @for (row of filtered(); track row.id) {
                  <tr>
                    <td>{{ row.batchNo }}</td>
                    <td>{{ recipeName(row.recipeId) }}</td>
                    <td>{{ row.packDate }}</td>
                    <td>{{ row.container }}</td>
                    <td>{{ row.quantity }}</td>
                    <td>{{ row.carbonationVol }}</td>
                    <td>{{ row.abv }} %vol</td>
                    <td>{{ row.og }} / {{ row.fg }}</td>
                    <td>
                      <button mat-button type="button" (click)="edit(row)">编辑</button>
                      <button mat-button color="warn" type="button" (click)="remove(row)">删除</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </mat-card-content>
        </mat-card>
      }

      @if (formVisible) {
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ editingId ? '编辑罐装批次' : '新增罐装批次' }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="form-grid">
              <mat-form-field appearance="outline">
                <mat-label>所属配方</mat-label>
                <mat-select [(ngModel)]="form.recipeId">
                  @for (recipe of recipes(); track recipe.id) {
                    <mat-option [value]="recipe.id">{{ recipe.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>批次号</mat-label>
                <input matInput [(ngModel)]="form.batchNo" placeholder="如：B-2401" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>罐装日期</mat-label>
                <input matInput type="date" [(ngModel)]="form.packDate" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>容器</mat-label>
                <mat-select [(ngModel)]="form.container">
                  @for (container of containers; track container) {
                    <mat-option [value]="container">{{ container }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>数量</mat-label>
                <input matInput type="number" [(ngModel)]="form.quantity" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>二氧化碳体积</mat-label>
                <input matInput type="number" step="0.1" [(ngModel)]="form.carbonationVol" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>实绩 OG（对账回写）</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.og" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>实绩 FG（对账回写）</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.fg" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>最终酒精度 %vol（由读数带出）</mat-label>
                <input matInput type="number" step="0.1" [(ngModel)]="form.abv" />
              </mat-form-field>
            </div>
            <p class="muted">提示：选择批次号后会自动按该批次发酵读数回算 OG / FG / ABV（当前建议值 {{ suggestedAbv() }} %vol）。</p>
          </mat-card-content>
          <mat-card-actions align="end">
            <button mat-button type="button" (click)="formVisible = false">取消</button>
            <button mat-button type="button" (click)="fillAbv()">按读数回算 OG / FG / ABV</button>
            <button mat-flat-button color="primary" type="button" (click)="submit()">保存</button>
          </mat-card-actions>
        </mat-card>
      }

      <div class="grid-cards">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>月末批次对账</mat-card-title></mat-card-header>
          <mat-card-content>
            <p class="muted">
              按批次号把罐装记录与发酵读数配对，以发酵读数为准改写罐装批次的 OG / FG / ABV；
              对不上的批次不改写，单独列出备查。写入超容量自动分批，失败可重试并退回对账前的数值。
            </p>
            <div class="archive-actions">
              <button mat-flat-button color="primary" type="button" (click)="runReconcile()" [disabled]="reconciling">
                {{ reconciling ? '对账中…' : '按批次号对账' }}
              </button>
              <button mat-stroked-button color="warn" type="button" (click)="rollbackReconcile()" [disabled]="!canRollback">
                退回对账前的数值
              </button>
            </div>
            @if (report) {
              <div class="badge-row">
                <app-stat-badge label="已改写批次" [value]="report.changed" suffix="个" tone="primary" icon="sync_alt" />
                <app-stat-badge label="写入批次" [value]="report.batches" suffix="批" tone="info" icon="view_list" />
                <app-stat-badge
                  label="对不上备查"
                  [value]="unmatchedTotal()"
                  suffix="个"
                  tone="danger"
                  icon="report"
                />
              </div>
              @if (report.plan.changes.length > 0) {
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>批次号</th>
                      <th>对账前 OG / FG / ABV</th>
                      <th>对账后 OG / FG / ABV</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (change of report.plan.changes; track change.id) {
                      <tr>
                        <td>{{ change.batchNo }}</td>
                        <td>{{ change.before.og }} / {{ change.before.fg }} / {{ change.before.abv }} %vol</td>
                        <td>{{ change.after.og }} / {{ change.after.fg }} / {{ change.after.abv }} %vol</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
              @if (unmatchedTotal() > 0) {
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>备查批次号</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (pack of report.plan.unmatched.missingReadings; track pack.id) {
                      <tr>
                        <td>{{ pack.batchNo }}</td>
                        <td>罐装已登记，发酵侧没有任何读数</td>
                      </tr>
                    }
                    @for (pack of report.plan.unmatched.insufficientReadings; track pack.id) {
                      <tr>
                        <td>{{ pack.batchNo }}</td>
                        <td>发酵读数不足两条，无法定 OG / FG</td>
                      </tr>
                    }
                    @for (batchNo of report.plan.unmatched.unpackagedBatchNos; track batchNo) {
                      <tr>
                        <td>{{ batchNo }}</td>
                        <td>发酵有读数，罐装侧未登记</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            }
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>配方实绩档案导出</mat-card-title></mat-card-header>
          <mat-card-content>
            <mat-form-field appearance="outline" class="full">
              <mat-label>选择配方</mat-label>
              <mat-select [value]="archiveRecipeId()" (selectionChange)="onArchiveRecipeChange($event.value)">
                @for (recipe of recipes(); track recipe.id) {
                  <mat-option [value]="recipe.id">{{ recipe.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <div class="archive-actions">
              <button mat-stroked-button type="button" (click)="previewArchive()">生成预览</button>
              <button mat-flat-button color="primary" type="button" (click)="exportArchive()">下载档案</button>
            </div>
            <pre class="archive-preview">{{ archivePreview }}</pre>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>本地结构版本与整库备份</mat-card-title></mat-card-header>
          <mat-card-content>
            <table class="data-table">
              <tbody>
                <tr>
                  <th>库名</th>
                  <td>{{ dbName }}</td>
                </tr>
                <tr>
                  <th>结构版本</th>
                  <td>v{{ schemaVersion }}</td>
                </tr>
                <tr>
                  <th>配方 / 麦芽 / 酒花</th>
                  <td>{{ counts['recipes'] || 0 }} / {{ counts['malts'] || 0 }} / {{ counts['hops'] || 0 }}</td>
                </tr>
                <tr>
                  <th>糖化步 / 煮沸投加</th>
                  <td>{{ counts['mashSteps'] || 0 }} / {{ counts['boilAdds'] || 0 }}</td>
                </tr>
                <tr>
                  <th>发酵读数 / 罐装批次</th>
                  <td>{{ counts['ferments'] || 0 }} / {{ counts['packagings'] || 0 }}</td>
                </tr>
              </tbody>
            </table>
            <div class="archive-actions">
              <button mat-stroked-button type="button" (click)="exportLibrary()">导出整库 JSON</button>
              <button mat-stroked-button type="button" (click)="toggleImport()">导入备份</button>
              <button mat-flat-button color="warn" type="button" (click)="resetDemo()">重置演示数据</button>
            </div>
            @if (importVisible) {
              <textarea
                class="import-area"
                rows="6"
                [(ngModel)]="importText"
                placeholder="粘贴导出的 JSON 备份内容后点击确认导入"
              ></textarea>
              <button mat-flat-button color="primary" type="button" (click)="doImport()">
                确认导入（旧数据按当前结构回填，超容量分批写入）
              </button>
            }
          </mat-card-content>
        </mat-card>
      </div>
    </div>
  `,
  styles: [
    `
      .archive-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 12px 0;
      }
      .archive-preview {
        max-height: 240px;
        overflow: auto;
        background: #f7f7f2;
        border-radius: 8px;
        padding: 10px;
        font-size: 11px;
        margin: 0;
      }
      .import-area {
        width: 100%;
        border-radius: 8px;
        border: 1px solid var(--brew-border);
        padding: 8px;
        font-family: monospace;
        font-size: 12px;
        margin-bottom: 8px;
      }
    `
  ]
})
export class PackagingListComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snack = inject(MatSnackBar);
  private readonly reconcileService = inject(ReconcileService);

  readonly dbName = DB_NAME;
  readonly schemaVersion = DB_SCHEMA_VERSION;
  readonly containers = CONTAINER_TYPES;

  readonly filtered = this.store.selectSignal(selectFilteredPackagings);
  readonly allPackagings = this.store.selectSignal(selectAllPackagings);
  readonly filter = this.store.selectSignal(selectPackagingFilter);
  readonly recipes = this.store.selectSignal(selectAllRecipes);
  readonly selectedRecipeId = this.store.selectSignal(selectSelectedRecipeId);
  private readonly ferments = this.store.selectSignal(selectAllFerments);

  readonly selects: FilterSelectConfig[] = [
    { key: 'containers', label: '容器', options: CONTAINER_TYPES.map((item) => ({ label: item, value: item })) }
  ];

  counts: Record<string, number> = {};
  /** 用户在「配方实绩档案导出」里显式选择的配方 */
  private readonly archiveRecipeSelect = signal('');
  /** 归档配方：未显式选择时回退到当前配方 / 配方列表第一项（配方列表异步到达后会自动生效） */
  readonly archiveRecipeId = computed(
    () => this.archiveRecipeSelect() || this.selectedRecipeId() || this.recipes()[0]?.id || ''
  );
  archivePreview = '';
  importVisible = false;
  importText = '';

  formVisible = false;
  editingId: string | null = null;
  form: Omit<Packaging, 'id'> = createEmptyPackaging();

  /** 最近一次对账报告（含对不上的备查清单） */
  report: ReconcileReport | null = null;
  reconciling = false;
  /** 是否有可退回的对账前数值 */
  canRollback = false;

  readonly totalQuantity = computed(() => this.filtered().reduce((sum, item) => sum + item.quantity, 0));
  readonly avgAbv = computed(() => {
    const list = this.filtered();
    return list.length === 0 ? 0 : Number((list.reduce((sum, item) => sum + item.abv, 0) / list.length).toFixed(2));
  });
  readonly avgCarbonation = computed(() => {
    const list = this.filtered();
    return list.length === 0
      ? 0
      : Number((list.reduce((sum, item) => sum + item.carbonationVol, 0) / list.length).toFixed(2));
  });
  readonly recipeCoverage = computed(() => new Set(this.filtered().map((item) => item.recipeId)).size);
  readonly suggestedAbv = computed(() => this.abvForBatch(this.form.batchNo, this.form.recipeId));

  async ngOnInit(): Promise<void> {
    // 首次访问时本地库还在播种演示数据：必须先等 initDatabase() 完成，
    // 否则 countAll() 会读到空库并把「结构版本与整库备份」统计永久显示成 0。
    await initDatabase();
    this.store.dispatch(RecipeActions.reloadAll());
    this.store.dispatch(FermentActions.loadFerments());
    const params: Record<string, string | undefined> = {};
    this.route.snapshot.queryParamMap.keys.forEach((key) => {
      params[key] = this.route.snapshot.queryParamMap.get(key) ?? undefined;
    });
    this.store.dispatch(PackagingActions.setFilter({ filter: queryParamsToFilters(params, ['containers']) }));
    await this.refreshCounts();
  }

  private async refreshCounts(): Promise<void> {
    this.counts = await countAll();
  }

  recipeName(recipeId: string): string {
    return this.recipes().find((item) => item.id === recipeId)?.name ?? '配方已删除';
  }

  private realized(recipeId: string): { og: number; fg: number } {
    const rows = this.ferments()
      .filter((item) => item.recipeId === recipeId)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length === 0) return { og: 0, fg: 0 };
    return { og: rows[0].gravity, fg: rows[rows.length - 1].gravity };
  }

  private readingsForForm() {
    return this.ferments()
      .filter((item) => item.batchNo === this.form.batchNo || (this.form.batchNo.length === 0 && item.recipeId === this.form.recipeId))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private abvForBatch(batchNo: string, recipeId: string): number {
    const rows = this.ferments()
      .filter((item) => item.batchNo === batchNo || (batchNo.length === 0 && item.recipeId === recipeId))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length < 2) {
      const fallback = this.realized(recipeId);
      return abvFromGravity(fallback.og, fallback.fg);
    }
    return abvFromGravity(rows[0].gravity, rows[rows.length - 1].gravity);
  }

  /** 按当前表单批次号的发酵读数回算 OG / FG / ABV 并填入表单 */
  fillAbv(): void {
    const rows = this.readingsForForm();
    if (rows.length >= 2) {
      this.form.og = rows[0].gravity;
      this.form.fg = rows[rows.length - 1].gravity;
    }
    this.form.abv = this.suggestedAbv();
    this.snack.open('已按发酵读数回算 OG / FG / ABV', '关闭', { duration: 1800 });
  }

  openCreate(): void {
    this.editingId = null;
    this.form = createEmptyPackaging();
    this.form.recipeId = this.selectedRecipeId() ?? this.recipes()[0]?.id ?? '';
    this.form.batchNo = this.ferments()[0]?.batchNo ?? '';
    this.form.abv = this.abvForBatch(this.form.batchNo, this.form.recipeId);
    const rows = this.readingsForForm();
    if (rows.length >= 2) {
      this.form.og = rows[0].gravity;
      this.form.fg = rows[rows.length - 1].gravity;
    }
    this.formVisible = true;
  }

  edit(row: PackagingRow): void {
    this.editingId = row.id;
    this.form = {
      batchNo: row.batchNo,
      recipeId: row.recipeId,
      packDate: row.packDate,
      container: row.container,
      quantity: row.quantity,
      carbonationVol: row.carbonationVol,
      og: row.og,
      fg: row.fg,
      abv: row.abv
    };
    this.formVisible = true;
  }

  submit(): void {
    if (!this.form.recipeId || !this.form.batchNo.trim()) {
      this.snack.open('请选择配方并填写批次号', '关闭', { duration: 2200 });
      return;
    }
    if (this.editingId) {
      this.store.dispatch(PackagingActions.updatePackaging({ id: this.editingId, patch: { ...this.form } }));
    } else {
      this.store.dispatch(PackagingActions.createPackaging({ payload: { ...this.form } }));
    }
    this.formVisible = false;
    this.snack.open('罐装批次已登记', '关闭', { duration: 2000 });
    void this.refreshCounts();
  }

  remove(row: PackagingRow): void {
    if (!window.confirm(`删除罐装批次「${row.batchNo}」？`)) return;
    this.store.dispatch(PackagingActions.deletePackaging({ id: row.id }));
    void this.refreshCounts();
  }

  /** 对不上的批次总数（备查清单行数） */
  unmatchedTotal(): number {
    if (!this.report) return 0;
    const { missingReadings, insufficientReadings, unpackagedBatchNos } = this.report.plan.unmatched;
    return missingReadings.length + insufficientReadings.length + unpackagedBatchNos.length;
  }

  /** 月末对账：以发酵读数为准改写罐装批次的 OG / FG / ABV，对不上的批次列入备查 */
  async runReconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      this.report = await this.reconcileService.reconcile();
      this.canRollback = this.reconcileService.canRollback;
      this.store.dispatch(FermentActions.loadFerments());
      await this.refreshCounts();
      const total = this.unmatchedTotal();
      const message =
        this.report.changed === 0
          ? total > 0
            ? `没有需要改写的批次，${total} 个批次对不上已列入备查`
            : '全部罐装批次已与发酵读数一致'
          : `对账完成：改写 ${this.report.changed} 个批次${total > 0 ? `，${total} 个批次对不上已列入备查` : ''}`;
      this.snack.open(message, '关闭', { duration: 3000 });
    } catch (error) {
      this.snack.open(error instanceof Error ? error.message : '对账失败，可重试', '关闭', { duration: 3500 });
    } finally {
      this.reconciling = false;
    }
  }

  /** 退回对账前的数值 */
  async rollbackReconcile(): Promise<void> {
    const restored = await this.reconcileService.rollback();
    this.canRollback = this.reconcileService.canRollback;
    if (restored === 0) {
      this.snack.open('没有可退回的对账记录', '关闭', { duration: 2000 });
      return;
    }
    this.report = null;
    this.store.dispatch(FermentActions.loadFerments());
    await this.refreshCounts();
    this.snack.open('已退回对账前的数值', '关闭', { duration: 2500 });
  }

  onArchiveRecipeChange(recipeId: string): void {
    this.archiveRecipeSelect.set(recipeId);
    this.archivePreview = '';
  }

  async previewArchive(): Promise<void> {
    const recipeId = this.archiveRecipeId();
    if (!recipeId) {
      this.snack.open('请先选择配方', '关闭', { duration: 2000 });
      return;
    }
    const archive = await buildRecipeArchive(recipeId);
    this.archivePreview = serializeArchive(archive);
  }

  async exportArchive(): Promise<void> {
    const recipeId = this.archiveRecipeId();
    if (!recipeId) return;
    const archive: RecipeArchive = await buildRecipeArchive(recipeId);
    downloadJson(`配方实绩-${recipeId}.json`, serializeArchive(archive));
    this.snack.open('配方实绩档案已下载', '关闭', { duration: 2000 });
  }

  async exportLibrary(): Promise<void> {
    const snapshot = await exportSnapshot();
    downloadJson(`gbbrewhouse-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2));
  }

  toggleImport(): void {
    this.importVisible = !this.importVisible;
  }

  async doImport(): Promise<void> {
    try {
      const parsed = parseArchive(this.importText);
      const snapshot = parsed as unknown as DatabaseSnapshot;
      if (!Array.isArray((snapshot as unknown as { recipes?: unknown[] }).recipes)) {
        throw new Error('缺少 recipes 数组字段，不是本应用的备份文件');
      }
      // 旧备份里的旧数据先按当前结构回填（补 og / fg 等缺省字段），再分批写入；
      // 中途失败由 importSnapshotChunked 自动回滚到导入前数据，可修正后重试。
      const backfilled = backfillSnapshot(snapshot);
      const result = await importSnapshotChunked(backfilled);
      await this.refreshCounts();
      this.store.dispatch(RecipeActions.reloadAll());
      this.store.dispatch(FermentActions.loadFerments());
      this.importVisible = false;
      this.importText = '';
      const chunkedTip = result.batches > 1 ? `，超容量已分 ${result.batches} 批写入` : '';
      this.snack.open(`备份已导入（${result.rows} 行${chunkedTip}）`, '关闭', { duration: 3000 });
    } catch (error) {
      this.snack.open(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, '关闭', { duration: 3500 });
    }
  }

  async resetDemo(): Promise<void> {
    if (!window.confirm('将清空本地库并重新灌入演示数据，是否继续？')) return;
    await resetDatabase();
    await this.refreshCounts();
    this.store.dispatch(RecipeActions.reloadAll());
    this.store.dispatch(FermentActions.loadFerments());
    this.snack.open('已重置为演示数据', '关闭', { duration: 2000 });
  }

  onFilterChange(next: FilterModel): void {
    this.store.dispatch(PackagingActions.setFilter({ filter: next }));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filtersToQueryParams(next),
      replaceUrl: true
    });
  }

  onResetFilter(): void {
    this.store.dispatch(PackagingActions.resetFilter());
    void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
  }
}
