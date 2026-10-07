/** /packaging 罐装批次登记与结构版本导出：本地库版本查看与 JSON 导入导出 */
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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
import {
  selectAllPackagings,
  selectFilteredPackagings,
  selectLastAppliedAt,
  selectLastRestoredAt,
  selectPackagingFilter,
  selectReconcileBackups,
  selectReconcileBusy,
  selectReconcileError,
  selectReconcileErrorAt,
  selectReconcilePlan
} from '../../core/state/packaging/packaging.selectors';
import { selectAllFerments } from '../../core/state/ferment/ferment.selectors';
import { selectAllRecipes, selectSelectedRecipeId } from '../../core/state/recipe/recipe.selectors';
import { RecipeActions } from '../../core/state/recipe/recipe.actions';
import { FermentActions } from '../../core/state/ferment/ferment.actions';
import {
  countAll,
  DB_NAME,
  DB_SCHEMA_VERSION,
  exportSnapshot,
  importSnapshot,
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
import { packagingGravityFromFerments } from '../../core/models/packaging.model';
import { planToPatches, type ReconcileItem } from '../../core/utils/reconcile';

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
    MatProgressSpinnerModule,
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
            本地库 {{ dbName }}（结构版本 v{{ schemaVersion }}）· 罐装批次登记 OG / FG，月底按批次号与发酵读数对账合并实绩。
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

      <!-- 月底对账：糖化 × 罐装实绩合并 -->
      <mat-card appearance="outlined" class="reconcile-card">
        <mat-card-header>
          <mat-card-title>
            月底对账 · 按批次号合并糖化与罐装实绩
            @if (reconcileBusy()) {
              <mat-progress-spinner mode="indeterminate" diameter="18" class="inline-spinner"></mat-progress-spinner>
            }
          </mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <p class="muted">
            同一批次号糖化（发酵读数）与罐装各记一次：以发酵首尾读数为准改写罐装批次的 OG / FG / ABV；
            缺读数、读数不足或抄值对不上的批次单独列入备查清单，不做暗改。整批改写走事务分批写入，失败可重试，也可一键退回对账前数值。
          </p>
          <div class="archive-actions">
            <button mat-flat-button color="primary" type="button" (click)="runReconcile()" [disabled]="reconcileBusy()">
              <mat-icon>fact_check</mat-icon>
              {{ plan() ? '重新按批次号对账' : '按批次号对账' }}
            </button>
            @if (plan(); as plan) {
              <button
                mat-flat-button
                color="accent"
                type="button"
                (click)="applyReconcile()"
                [disabled]="reconcileBusy() || plan.summary.toUpdate === 0"
              >
                <mat-icon>sync_alt</mat-icon>
                按发酵读数改写 {{ plan.summary.toUpdate }} 批
              </button>
              <button
                mat-stroked-button
                color="warn"
                type="button"
                (click)="rollbackReconcile()"
                [disabled]="reconcileBusy() || reconcileBackups().length === 0"
              >
                <mat-icon>undo</mat-icon>
                退回对账前数值（{{ reconcileBackups().length }} 批留底）
              </button>
              <button mat-stroked-button type="button" (click)="exportMismatchCsv()" [disabled]="plan.mismatches.length === 0">
                <mat-icon>download</mat-icon>
                导出备查清单 CSV
              </button>
            }
          </div>

          @if (reconcileError(); as error) {
            <p class="reconcile-error"><mat-icon>error_outline</mat-icon>{{ error }}</p>
          }

          @if (plan(); as plan) {
            <div class="badge-row reconcile-badges">
              <app-stat-badge label="罐装批次总数" [value]="plan.summary.total" suffix="批" tone="primary" icon="inventory_2" />
              <app-stat-badge label="两边一致" [value]="plan.summary.matched" suffix="批" tone="success" icon="check_circle" />
              <app-stat-badge label="待按读数改写" [value]="plan.summary.toUpdate" suffix="批" tone="warning" icon="sync_alt" />
              <app-stat-badge label="罐装无发酵读数" [value]="plan.summary.missingFerment" suffix="批" tone="danger" icon="link_off" />
              <app-stat-badge label="发酵读数不足" [value]="plan.summary.incompleteFerment" suffix="批" tone="info" icon="query_builder" />
            </div>

            @if (plan.mismatches.length === 0) {
              <p class="reconcile-ok"><mat-icon>verified</mat-icon>全部批次两边对得上，无需备查。</p>
            } @else {
              <p class="muted">对不上的批次（备查，共 {{ plan.mismatches.length }} 批）：</p>
              <div class="table-scroll">
                <table class="data-table reconcile-table">
                  <thead>
                    <tr>
                      <th>批次号</th>
                      <th>配方</th>
                      <th>罐装 OG/FG/ABV</th>
                      <th>发酵读数 OG/FG/ABV</th>
                      <th>对不上的原因</th>
                      <th>处理</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (item of plan.mismatches; track item.packaging.id) {
                      <tr>
                        <td>{{ item.packaging.batchNo }}</td>
                        <td>{{ recipeName(item.packaging.recipeId) }}</td>
                        <td>
                          {{ item.packaging.og || '—' }} / {{ item.packaging.fg || '—' }} /
                          {{ item.packaging.abv || '—' }}%
                        </td>
                        <td>
                          @if (item.expected; as expected) {
                            {{ expected.og }} / {{ expected.fg }} / {{ expected.abv }}%
                          } @else if (item.ferments.length > 0) {
                            {{ item.ferments[0].gravity }} / 读数不足 / —
                          } @else {
                            — / — / —
                          }
                        </td>
                        <td>
                          <ul class="issue-list">
                            @for (issue of item.issues; track issue.kind) {
                              <li>
                                <span class="issue-tag" [class]="'issue-tag--' + issueClass(issue.kind)">{{ issue.kind }}</span>
                                {{ issue.detail }}
                              </li>
                            }
                          </ul>
                        </td>
                        <td>
                          @if (item.needsUpdate) {
                            <span class="treat-tag treat-tag--update">将按读数改写</span>
                          } @else {
                            <span class="treat-tag treat-tag--hold">仅备查不改写</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        </mat-card-content>
      </mat-card>

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
          description="登记罐装日期、容器与数量，并按发酵读数带出 OG / FG 与 ABV。"
          createText="新增罐装批次"
          (create)="openCreate()"
        ></app-empty-panel>
      } @else {
        <mat-card appearance="outlined">
          <mat-card-content>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>批次号</th>
                    <th>配方</th>
                    <th>罐装日期</th>
                    <th>容器</th>
                    <th>数量</th>
                    <th>CO₂ 体积</th>
                    <th>OG</th>
                    <th>FG</th>
                    <th>ABV</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of filtered(); track row.id) {
                    <tr [class.row--pending]="pendingUpdateIds().has(row.id)">
                      <td>{{ row.batchNo }}</td>
                      <td>{{ recipeName(row.recipeId) }}</td>
                      <td>{{ row.packDate }}</td>
                      <td>{{ row.container }}</td>
                      <td>{{ row.quantity }}</td>
                      <td>{{ row.carbonationVol }}</td>
                      <td>{{ row.og || '—' }}</td>
                      <td>{{ row.fg || '—' }}</td>
                      <td>{{ row.abv }} %vol</td>
                      <td>
                        <button mat-button type="button" (click)="edit(row)">编辑</button>
                        <button mat-button color="warn" type="button" (click)="remove(row)">删除</button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
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
                <mat-label>OG 初始比重（罐装抄写）</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.og" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>FG 最终比重（罐装抄写）</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.fg" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>最终酒精度 %vol（由读数带出）</mat-label>
                <input matInput type="number" step="0.1" [(ngModel)]="form.abv" />
              </mat-form-field>
            </div>
            <p class="muted">
              提示：批次号选定后可按该批次发酵读数回填 OG / FG / ABV
              （当前建议值 OG {{ suggestedOg() }} / FG {{ suggestedFg() }} / ABV {{ suggestedAbv() }} %vol；读数不足时只带出 OG）。
            </p>
          </mat-card-content>
          <mat-card-actions align="end">
            <button mat-button type="button" (click)="formVisible = false">取消</button>
            <button mat-button type="button" (click)="fillFromFerments()">按读数回填 OG / FG / ABV</button>
            <button mat-flat-button color="primary" type="button" (click)="submit()">保存</button>
          </mat-card-actions>
        </mat-card>
      }

      <div class="grid-cards">
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
              <button mat-flat-button color="primary" type="button" (click)="doImport()">确认导入（覆盖现有数据）</button>
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
        align-items: center;
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
      .reconcile-card {
        margin-bottom: 16px;
      }
      .inline-spinner {
        display: inline-block;
        vertical-align: middle;
        margin-left: 8px;
      }
      .reconcile-badges {
        margin: 12px 0;
      }
      .reconcile-error {
        color: #b3261e;
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 8px 0;
      }
      .reconcile-ok {
        color: #1e6b3a;
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 8px 0;
      }
      .table-scroll {
        overflow-x: auto;
      }
      .reconcile-table td,
      .reconcile-table th {
        vertical-align: top;
        white-space: nowrap;
      }
      .issue-list {
        margin: 0;
        padding-left: 0;
        list-style: none;
      }
      .issue-list li {
        margin-bottom: 4px;
        white-space: normal;
        min-width: 240px;
      }
      .issue-tag {
        display: inline-block;
        padding: 0 6px;
        border-radius: 10px;
        font-size: 11px;
        margin-right: 6px;
        border: 1px solid currentColor;
      }
      .issue-tag--warn {
        color: #9a6b00;
        background: #fff6e0;
      }
      .issue-tag--danger {
        color: #b3261e;
        background: #fdecea;
      }
      .issue-tag--info {
        color: #0b4f8a;
        background: #e8f2fd;
      }
      .treat-tag {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        white-space: nowrap;
      }
      .treat-tag--update {
        color: #9a6b00;
        background: #fff6e0;
      }
      .treat-tag--hold {
        color: #555;
        background: #eee;
      }
      .row--pending td {
        background: #fff8e6;
      }
    `
  ]
})
export class PackagingListComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snack = inject(MatSnackBar);

  readonly dbName = DB_NAME;
  readonly schemaVersion = DB_SCHEMA_VERSION;
  readonly containers = CONTAINER_TYPES;

  readonly filtered = this.store.selectSignal(selectFilteredPackagings);
  readonly allPackagings = this.store.selectSignal(selectAllPackagings);
  readonly filter = this.store.selectSignal(selectPackagingFilter);
  readonly recipes = this.store.selectSignal(selectAllRecipes);
  readonly selectedRecipeId = this.store.selectSignal(selectSelectedRecipeId);
  private readonly ferments = this.store.selectSignal(selectAllFerments);

  readonly plan = this.store.selectSignal(selectReconcilePlan);
  readonly reconcileBusy = this.store.selectSignal(selectReconcileBusy);
  readonly reconcileError = this.store.selectSignal(selectReconcileError);
  readonly reconcileBackups = this.store.selectSignal(selectReconcileBackups);

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

  /**
   * 当前表单批次号在发酵表里的读数口径（OG / FG / ABV）。
   * 用普通方法而非 computed：表单是被 ngModel 直接改写的可变字段，computed 里读它不具追踪意义。
   */
  private formFermentDerived(): ReturnType<typeof packagingGravityFromFerments> {
    const { batchNo, recipeId } = this.form;
    const rows = this.ferments().filter(
      (item) => item.batchNo === batchNo || (batchNo.trim().length === 0 && item.recipeId === recipeId)
    );
    return packagingGravityFromFerments(rows);
  }
  suggestedOg(): number {
    return this.formFermentDerived()?.og ?? 0;
  }
  suggestedFg(): number {
    const derived = this.formFermentDerived();
    return derived?.complete ? derived.fg : 0;
  }
  suggestedAbv(): number {
    const derived = this.formFermentDerived();
    return derived?.complete ? derived.abv : 0;
  }

  /** 对账计划里待改写的罐装行 id：表格中高亮，提醒这批值马上会被发酵读数覆盖 */
  readonly pendingUpdateIds = computed(() => new Set((this.plan()?.updates ?? []).map((item) => item.packaging.id)));

  constructor() {
    // 改写 / 回滚成功或失败时给出提示；改写或回滚后自动重新对账刷新备查清单。
    // 用时间戳信号触发而不是条数：同样 N 批重试成功也要重新提示与刷新。
    const lastAppliedAt = this.store.selectSignal(selectLastAppliedAt);
    const lastRestoredAt = this.store.selectSignal(selectLastRestoredAt);
    const errorAt = this.store.selectSignal(selectReconcileErrorAt);
    effect(() => {
      if (errorAt() > 0) {
        this.snack.open(this.reconcileError(), '关闭', { duration: 3200 });
      }
    });
    effect(() => {
      if (lastAppliedAt() > 0) {
        this.snack.open(`已按发酵读数改写，可随时退回对账前数值`, '关闭', { duration: 3000 });
        this.store.dispatch(PackagingActions.runReconcile());
      }
    });
    effect(() => {
      if (lastRestoredAt() > 0) {
        this.snack.open('已退回对账前数值', '关闭', { duration: 3000 });
        this.store.dispatch(PackagingActions.runReconcile());
      }
    });
  }

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

  /** 备查清单里的原因徽标配色 */
  issueClass(kind: string): 'warn' | 'danger' | 'info' {
    if (kind === '罐装无发酵读数') return 'danger';
    if (kind === '发酵读数不足') return 'info';
    return 'warn';
  }

  /* ------------------------------- 月底对账 ------------------------------- */

  runReconcile(): void {
    this.store.dispatch(PackagingActions.runReconcile());
  }

  applyReconcile(): void {
    const plan = this.plan();
    if (!plan || plan.summary.toUpdate === 0) return;
    // 失败时库内仍是对账前数值，用户再次点本按钮即按同一计划重试
    this.store.dispatch(PackagingActions.applyReconcile({ patches: planToPatches(plan) }));
  }

  rollbackReconcile(): void {
    const backups = this.reconcileBackups();
    if (backups.length === 0) return;
    if (!window.confirm(`将 ${backups.length} 批罐装记录退回对账前的 OG / FG / ABV，是否继续？`)) return;
    this.store.dispatch(PackagingActions.rollbackReconcile({ backups }));
  }

  /** 对不上的批次导出 CSV 备查（带 BOM，Excel 直接打开不乱码） */
  exportMismatchCsv(): void {
    const plan = this.plan();
    if (!plan || plan.mismatches.length === 0) return;
    const header = ['批次号', '配方', '罐装日期', '容器', '罐装OG', '罐装FG', '罐装ABV', '发酵OG', '发酵FG', '发酵ABV', '问题'];
    const escape = (value: string | number): string => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = plan.mismatches.map((item: ReconcileItem) => {
      const p = item.packaging;
      const cells = [
        p.batchNo,
        this.recipeName(p.recipeId),
        p.packDate,
        p.container,
        p.og || '',
        p.fg || '',
        p.abv || '',
        item.expected?.og ?? (item.ferments.length > 0 ? item.ferments[0].gravity : ''),
        item.expected?.fg ?? '',
        item.expected?.abv ?? '',
        item.issues.map((issue) => `${issue.kind}：${issue.detail}`).join('；')
      ];
      return cells.map(escape).join(',');
    });
    const csv = `\uFEFF${header.join(',')}\n${lines.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `对账备查-${plan.reconciledAt.slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  /* ------------------------------ 罐装批次表单 ------------------------------ */

  fillFromFerments(): void {
    const derived = this.formFermentDerived();
    if (!derived) {
      this.snack.open('该批次号还没有发酵读数，无法回填', '关闭', { duration: 2200 });
      return;
    }
    this.form.og = derived.og;
    if (derived.complete) {
      this.form.fg = derived.fg;
      this.form.abv = derived.abv;
      this.snack.open('已按发酵读数回填 OG / FG / ABV', '关闭', { duration: 1800 });
    } else {
      this.snack.open('只有 1 条发酵读数，仅回填 OG；FG / ABV 待读数补齐', '关闭', { duration: 2600 });
    }
  }

  openCreate(): void {
    this.editingId = null;
    this.form = createEmptyPackaging();
    this.form.recipeId = this.selectedRecipeId() ?? this.recipes()[0]?.id ?? '';
    this.form.batchNo = this.ferments()[0]?.batchNo ?? '';
    const derived = packagingGravityFromFerments(this.ferments().filter((item) => item.batchNo === this.form.batchNo));
    if (derived) {
      this.form.og = derived.og;
      if (derived.complete) {
        this.form.fg = derived.fg;
        this.form.abv = derived.abv;
      }
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
      await importSnapshot(snapshot);
      await this.refreshCounts();
      this.store.dispatch(RecipeActions.reloadAll());
      this.store.dispatch(FermentActions.loadFerments());
      this.store.dispatch(PackagingActions.clearReconcile());
      this.importVisible = false;
      this.importText = '';
      this.snack.open('备份已导入（旧备份缺失的罐装 OG / FG 已按当前结构回填）', '关闭', { duration: 2800 });
    } catch (error) {
      this.snack.open(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, '关闭', { duration: 3000 });
    }
  }

  async resetDemo(): Promise<void> {
    if (!window.confirm('将清空本地库并重新灌入演示数据，是否继续？')) return;
    await resetDatabase();
    await this.refreshCounts();
    this.store.dispatch(RecipeActions.reloadAll());
    this.store.dispatch(FermentActions.loadFerments());
    this.store.dispatch(PackagingActions.clearReconcile());
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
