[English](README.md) | [中文](README.zh-CN.md)

# 日历工具（Calendar Utilities）

## 脚本总览
- `economic_calendar_fetcher.py`：调用 API，按日刷新经济日历数据并拆分到 `data/Economic_Calendar/<年份>/`。
- `preprocess_price_minutes.py`：把交易明细 CSV 转为连续的分钟行情（UTC+8），供 Stage A 管线使用。
- `workflow/calendar_price_pipeline.py`：Stage A 实作，将分钟行情与经济事件对齐，生成后续分析所需的统一特征集。
- `workflow/event_price_alignment.py`：Stage A 延伸，评估 Medium / High 事件前后的价格表现。
- `workflow/event_price_deepdive.py`：Stage B 深入，生成事件落地图表、阈值判定与 Stage C/D 的跟进标记。
- `workflow/event_preheat_monitor.py`：Stage B 泄露/预热监控，追踪事件前异常价格与量能偏移，标记“提前走”案例。
- `workflow/event_trend_analysis.py`：Stage B 经济指标趋势分析，梳理历史趋势、周期性与联动预测信号。
- `workflow/event_component_decomposition.py`：Stage B 成分分解，比较核心/非核心与能源、住房等子项的方向占比。
- `workflow/event_path_dependency.py`：Stage B 路径依赖，评估连续惊喜方向的一致/反转及其价格记忆。
- `workflow/event_adaptive_window.py`：Stage C 自适应窗口，依据惊喜强度推荐 Post 观察窗并输出汇总与规则。
- `workflow/event_priority_routing.py`：Stage C 事件优先级调度，在信号冲突时生成治理顺序与解读。
- `workflow/event_uncertainty_analysis.py`：Stage C 预测不确定性，输出置信区间与校准曲线。
- `run_stage_workflow.py`：Stage A/B 封装脚本，串接上述步骤，减少手动操作。

## 下载经济日历
```bash
python scripts/calendar/economic_calendar_fetcher.py --start-date 2025-01-01 --end-date 2025-01-07
```
说明：
- 默认把“抓取到的日期窗口”视为权威：会在合并前先删除该窗口内的旧记录；同时按“逐日覆盖率阈值”做 prune guard，避免上游结果不完整时误删数据。
- JSON 会将缺失值统一规范为 `null`，减少反复抓取导致的无意义 diff。
- 如遇 429，可通过设置 `CALENDAR_HTTP_MIN_INTERVAL_SECONDS`（例如 `2`）并增大翻页间隔（例如 `CALENDAR_PAGE_DELAY_MIN_SECONDS=5`、`CALENDAR_PAGE_DELAY_MAX_SECONDS=7`）来降低请求频率。
- 如果仍出现“窗口不完整”，可调小单次抓取的 chunk 天数：`CALENDAR_RANGE_CHUNK_DAYS`（默认 `4`）。
- 当 `CALENDAR_RANGE_CHUNK_DAYS=4` 时，若某个 4 天 chunk 全部是工作日（weekday），会自动缩成 3 天，以降低忙碌工作日导致的翻页深度与风险。
- 若仍出现“某一天整天消失”等明显异常，可设置 `CALENDAR_REFETCH_ANOMALIES=1`，自动对异常日期逐日重试抓取。
- `CALENDAR_REFETCH_ANOMALIES` 默认启用；如需关闭可设置 `CALENDAR_REFETCH_ANOMALIES=0`。
- `CALENDAR_REFETCH_MAX_DAYS` 默认不设上限；如需限制单次最多补抓天数，可设置为正整数。
- 若要排查限流与翻页终止原因，可设置 `CALENDAR_HTTP_STATS=1` 输出请求速率统计与翻页停止原因。
- 如需关闭窗口内 prune，可设置 `CALENDAR_PRUNE_EXISTING_IN_RANGE=0` 或传 `--no-prune-existing-in-range`。

输出文件位于仓库根目录 `data/Economic_Calendar/<年份>/<年份>_calendar.(xlsx|csv|json)`。GitHub Actions 工作流也会调用同一脚本，确保远端 `data/` 始终保持最新。

## Stage A 快速执行
```bash
python scripts/calendar/run_stage_workflow.py \
  --price-path data/XAUUSD_1m_data/preprocessed_minutes.parquet \
  --calendar-dir data/Economic_Calendar \
  --output-dir data/calendar_outputs/minute_event_datasets \
  --start-year 2020 --end-year 2020 \
  --currencies USD \
  --pre-window 1440 --post-window 1440
```
默认会依序运行合并管线、事件 ↔ 价格汇总、Stage B 深入分析＋预热监控＋趋势分析：
- 使用 `--skip-pipeline`、`--skip-alignment`、`--skip-deepdive`、`--skip-path`、`--skip-prototypes`、`--skip-components`、`--skip-preheat`、`--skip-trend`、`--skip-adaptive` 可按需跳过任一步骤。
- 当仅执行对齐、深挖、预热或趋势分析时，需额外指定 `--minutes-dir` 指向 Stage A 的产出目录。
- 对齐阶段可通过 `--alignment-pre-window` / `--alignment-post-window`、`--alignment-importance` 调整窗口设定与重要度筛选。
- Stage B 深挖输出可用 `--deepdive-flag-quantile`、`--deepdive-no-heatmap-csv`、`--deepdive-no-flags-csv` 等旗标微调。
- Stage B 泄露/预热监控可用 `--preheat-pre-windows`、`--preheat-volume-baselines`、`--preheat-flag-quantile`、`--preheat-no-*-csv` 等参数调整窗口与输出。
- Stage B 趋势分析可用 `--trend-monthly-windows`、`--trend-min-events`、`--trend-top-corr-pairs` 与 `--trend-no-*-csv` 控制窗口长度、纳入阈值与输出格式。

运行结束后会在 `data/calendar_outputs/minute_event_datasets/<年份>/`、`data/calendar_outputs/event_price_alignment/`、`data/calendar_outputs/event_price_deepdive/`、`data/calendar_outputs/event_prototypes/`、`data/calendar_outputs/path_dependency/`、`data/calendar_outputs/component_decomposition/`、`data/calendar_outputs/event_preheat_monitor/` 与 `data/calendar_outputs/event_trend_analysis/` 写出阶段成果；若想纯内存跳过 Stage A 落盘，可加 `--memory-only-stage-a`（如需额外写出 CSV 请加 `--pipeline-csv`，但完整 CSV 体积巨大，建议改用 Parquet；样本可用 `--no-pipeline-xlsx` 关闭）。

## Stage A：行情 × 事件整合管线
```bash
python scripts/calendar/workflow/calendar_price_pipeline.py \
  --price-path data/XAUUSD_1m_data/preprocessed_minutes.parquet \
  --calendar-dir data/Economic_Calendar \
  --output-dir data/calendar_outputs/minute_event_datasets \
  --start-year 2020 --end-year 2020 \
  --currencies USD \
  --pre-window 1440 --post-window 1440
```
输出结构：
- `data/calendar_outputs/minute_event_datasets/<年份>/xauusd_minutes_with_events.parquet`（全量分钟 × 事件特征，`--no-parquet` 可关闭）
- `.../xauusd_minutes_with_events.csv`（全量 CSV，默认跳过；如需启用请加 `--csv`，单年文件可达 ~7 GB，非必要不建议开启）
- `.../xauusd_minutes_with_events_sample.xlsx`（前 5,000 行抽样，`--no-xlsx` 可关闭）
如仅需在内存中处理，可与 `--no-parquet --no-xlsx` 搭配，或直接使用上方封装脚本。

每条记录包含 `event_stage`、`minutes_from_event`、`surprise` 等字段，为阶段 B、C、D 的窗口拆解、联合事件归因与新闻整合提供统一输入。

## Stage A：事件 ↔ 价格关系
```bash
python scripts/calendar/workflow/event_price_alignment.py \
  --minutes-dir data/calendar_outputs/minute_event_datasets \
  --output-parquet data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --start-year 2020 --end-year 2020 \
  --pre-window 1440 --post-window 1440
```
该脚本在 Stage A 产物上突出 Medium / High 事件的价格表现，输出 `event_price_alignment.parquet/csv`，内容包含：事件详情、事件前后收益（例如 `return_pre_15_pct`、`return_post_240_pct`）以及事件当下的即时反应（`return_at_pct`、`volume_at_avg` 等），并同步统计波动与成交量，为下一阶段的进阶分析奠定基础。额外提供 `surprise_pct`、`revision_pct`、`forecast_minus_previous_pct` 等百分比扰动，并以这些百分比作为归一化分母，提高不同事件之间的可比性（同时对近零分母自动置空，避免极端值）。除此之外，还会给出 `surprise_category`、`forecast_prev_category`、`scenario_expectation_vs_actual` 等情境标签，便于快速区分“预期改善但实际下滑”“预期走弱却大幅超预期”等组合。 同时，对于同一分钟发布的多项指标，还会提供 `joint_event_group_size`、`joint_event_group_weight`、`joint_event_group_event_ids` 等字段，用来标记联合事件并将收益拆分为每个子事件的份额（例如 `return_post_pct_share` 表示在该组合中归属于当前事件的份额）。默认会生成 1/15/60/120/240/1440 分钟的窗口统计，`return_pre_pct` / `return_post_pct` 保留 60 分钟视图；如需缩短或加长最大观察窗，可透过 `--pre-window` / `--post-window` 调整。

## Stage B：事件 ↔ 价格关系深入
```bash
python scripts/calendar/workflow/event_price_deepdive.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --heatmap-output-parquet data/calendar_outputs/event_price_deepdive/event_response_heatmap.parquet \
  --thresholds-output-csv data/calendar_outputs/event_price_deepdive/return_thresholds.csv \
  --flags-output-parquet data/calendar_outputs/event_price_deepdive/event_followup_flags.parquet
```
Stage B 深入脚本会在事件对齐产物上继续聚合：
- 生成事件落地图表（`event_response_heatmap.*`），按事件名称/货币汇总多窗口平均收益、中位数与上涨占比，可直接投射为热力图。
- 写出关键阈值表（`return_thresholds.csv`），按 `surprise_direction` 拆分 positive / negative / neutral，提供多窗口的 q75/q90 上下界与绝对值阈值，为 Stage C 的窗口拆解与风控提醒提供可复现的参考线。
- 建立后续跟进标记（`event_followup_flags.*`），依据 q90 绝对阈值与“低惊喜但大幅波动”情境，区分需要 Stage C 深入窗口分析与 Stage D 新闻追溯的候选事件，并附带 `surprise_direction`、`stage_c_windows_used`、`threshold_direction_stage_c` 等字段，记录触发所用的方向阈值与窗口。

可用 `--flag-quantile`（封装脚本使用 `--deepdive-flag-quantile` 传入）调整告警阈值；如需针对不同惊喜方向设定观察窗，可在脚本层使用 `--stage-c-windows-positive` / `--stage-c-windows-negative` 与 `--stage-d-windows-positive` / `--stage-d-windows-negative`（封装脚本对应 `--deepdive-stage-c-windows-positive`、`--deepdive-stage-c-windows-negative`、`--deepdive-stage-d-windows-positive`、`--deepdive-stage-d-windows-negative`），也可透过 `--stage-c-windows` / `--stage-d-windows` 覆盖通用窗口。

## Stage B：成分分解
```bash
python scripts/calendar/workflow/event_component_decomposition.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --detail-output-parquet data/calendar_outputs/component_decomposition/component_breakdown.parquet \
  --summary-output-parquet data/calendar_outputs/component_decomposition/component_summary.parquet
```
该模块会根据事件名称推导基础指标、频率标签与成分类别：
- `component_breakdown.*`：按 `base_indicator × frequency_tag × core_category × component_category` 汇总惊喜与价格反应的方向占比，提供正/负/持平比例、样本量与平均值。
- `component_summary.*`：将各成分聚合到 core/headline 与 energy / housing / food / other 维度，方便快速比较主要子项的动向。

若默认样本量过低，可透过 `--min-events`（封装脚本使用 `--components-min-events`）抬高最小纳入阈值；`--components-no-detail-csv` / `--components-no-summary-csv` 则可关闭额外的 CSV 导出。与其他 Stage B 脚本相同，`run_stage_workflow.py` 已内建 `--skip-components`、`--components-detail-output-*`、`--components-summary-output-*` 等参数，可统一调度。

## Stage B：路径依赖
```bash
python scripts/calendar/workflow/event_path_dependency.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --detail-output-parquet data/calendar_outputs/path_dependency/path_dependency_events.parquet \
  --summary-output-parquet data/calendar_outputs/path_dependency/path_dependency_summary.parquet
```
该模块聚焦同一基础指标在时间序列上的惊喜方向连贯性：
- `path_dependency_events.*`：逐事件标记 `streak_state`（baseline/momentum/fatigue/neutral）、连续同方向计数、前一次惊喜/收益等，用于识别动量或反转后的即时表现。
- `path_dependency_summary.*`：按指标 × 频率 × 状态聚合统计样本量、平均惊喜、前后 60/240 分钟收益与正向占比，可快速比较动量与疲乏情境。

可透过 `--min-events`（封装脚本使用 `--path-min-events`）设置汇总最小样本量，并以 `--path-no-detail-csv` / `--path-no-summary-csv` 控制额外 CSV 导出；`run_stage_workflow.py` 提供 `--skip-path` 与 `--path-*-output-*` 参数，便于与其他 Stage B 任务联动。

## Stage B：事件簇 / 原型库
```bash
python scripts/calendar/workflow/event_prototype_analysis.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --detail-output-parquet data/calendar_outputs/event_prototypes/event_prototype_events.parquet \
  --summary-output-parquet data/calendar_outputs/event_prototypes/event_prototype_summary.parquet \
  --centroid-output-parquet data/calendar_outputs/event_prototypes/event_prototype_centroids.parquet
```
该模块会对同货币、同基础指标的事件进行聚类，提炼不同情景的价格响应原型：
- `event_prototype_events.*`：记录每个事件的聚类标签、距离与多窗口收益特征，可快速定位属于同一 Playbook 的样本。
- `event_prototype_summary.*`：聚合各簇样本量、关键窗口收益与上涨占比，帮助比较动量 vs. 回落等情景。
- `event_prototype_centroids.*`：保留各簇的平均收益轨迹，为后续绘图与策略回放提供基准。

可通过 `--prototype-min-events`、`--prototype-max-clusters` 控制聚类粒度，并以 `--prototype-no-*-csv` 管理额外输出；封装脚本提供 `--skip-prototypes` 与 `--prototype-*-output-*` 参数，便于与其他 Stage B 步骤联合执行。

## Stage B：泄露 / 预热监控
```bash
python scripts/calendar/workflow/event_preheat_monitor.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --metrics-output-parquet data/calendar_outputs/event_preheat_monitor/preheat_metrics.parquet \
  --flags-output-parquet data/calendar_outputs/event_preheat_monitor/preheat_flags.parquet
```
该脚本基于事件 ↔ 价格汇总结果，追踪事件前 15 / 60 分钟的价格、波动与量能偏移：
- 计算绝对收益（`abs_return_pre_*`）、波动率与多种量能比值（例：`volume_ratio_pre_15_over_60`），并输出 `preheat_metrics.*` 供后续分析。
- 依据 q75 / q90 / q95 阈值写出 `preheat_thresholds.csv`，帮助定义“提前走”判定线。
- 自动筛选超过阈值的事件，生成 `preheat_flags.*` 与 `preheat_summary.*`，标记是否由价格、波动或量能触发，并提供复核理由。

可搭配 `--preheat-pre-windows`、`--preheat-volume-baselines`、`--preheat-flag-quantile` 等参数调整监控窗口与告警敏感度。

## Stage B：经济指标趋势分析
```bash
python scripts/calendar/workflow/event_trend_analysis.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --summary-output-parquet data/calendar_outputs/event_trend_analysis/trend_event_summary.parquet \
  --correlation-output-parquet data/calendar_outputs/event_trend_analysis/trend_correlation_pairs.parquet
```
趋势分析模块会按月聚合经济指标，衡量长期走势与季节性：
- 自动输出 `alias_suggestions.csv`，帮助识别命名相近的指标；可在 `indicator_aliases.csv` 中确认/维护合并规则，脚本会记录自动合并结果到 `auto_aliases.csv`。
- 输出 `trend_monthly_metrics.*`，包含每月实际值/惊喜百分比、3/6/12 个月滚动均值与 YoY 变化。
- `trend_event_summary.*` 汇整各指标的线性趋势斜率、惊喜自相关、季节性强度以及与 XAUUSD 事件后收益的相关性。
- `trend_correlation_pairs.*` 记录惊喜百分比相关性最高的指标对，辅助识别联动关系与潜在组合冲击。

可通过 `--trend-monthly-windows`、`--trend-min-events`、`--trend-top-corr-pairs` 等参数控制滚动窗口、纳入条件与输出规模。

## Stage C：自适应窗口
```bash
python scripts/calendar/workflow/event_adaptive_window.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```
- `adaptive_window_events.*`：逐事件记录峰值窗口、主导窗口、惊喜分箱等指标，协助判断多久完成价格消化。
- `adaptive_window_summary.*`：按货币、重要度与惊喜区间聚合主导窗口分布，给出覆盖率阈值与推荐分钟数。
- `adaptive_window_recommendations.json`：整理正向/负向/全体的建议窗口，`run_stage_workflow` 默认用于覆盖 Stage B Deep-Dive 的 Stage C 跟进窗口（除非加 `--adaptive-disable-deepdive` 或手动指定 `--deepdive-stage-c-*`）。

## Stage C：事件优先级调度
```bash
python scripts/calendar/workflow/event_priority_routing.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --adaptive-events-path data/calendar_outputs/event_adaptive_window/adaptive_window_events.parquet
```
- `priority_event_scores.*`：逐事件记录重要度、惊喜幅度、主导窗口收益等评分要素与最终优先级。
- `priority_group_resolutions.*`：对同一时刻的多事件组合生成治理顺序，注明冲突方向与推荐处理逻辑。
- `priority_rules.json`：记录权重配置、冲突组统计，为后续策略或告警管线加载治理规则。

## Stage C：预测不确定性
```bash
python scripts/calendar/workflow/event_uncertainty_analysis.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```
- `uncertainty_interval_summary.*`：按事件、方向与窗口输出均值、标准差及多组置信区间（如 80%/90%）。
- `uncertainty_calibration_summary.*`：基于预测命中率分箱的校准曲线，比较预测概率与实际收益方向。
- `uncertainty_event_predictions.*`：逐事件记录预测上涨概率与真实结果，便于后续模型复核或可视化。

## 后续深化计划
- 事件 ↔ 价格关系深入（已完成）：提供事件落地图表、关键阈值与 Stage C/D 跟进标记输出，为窗口拆解与新闻衔接铺垫。
- 泄露/预热监控（已完成）：标记事件前异常价格/量能偏移，识别“提前走”的情况。
- 经济指标趋势分析（已完成）：梳理指标历史趋势、季节性与联动预测信号。
- 方向非对称阈值（已完成）：对正向/负向惊喜设定不同阈值与窗口，捕捉偏态反应。
- 成分分解（已完成）：标注核心/非核心、YoY/MoM、能源/住房等成分的方向占比。
- 路径依赖（已完成）：记录连续惊喜方向一致或反转的走势记忆（momentum vs. fatigue）。
- 事件簇/原型库（已完成）：聚类同主题事件，沉淀响应形状与时长的情景 Playbook。

- 自适应窗口（已完成）：根据惊喜强度自动拉长/缩短 Post 观察窗，贴合市场消化节奏。
- 事件优先级调度（已完成）：在信号冲突时建立优先级治理规则。
- 预测不确定性（已完成）：输出置信区间与校准曲线，避免只看点预测。
- 无事件的波动解释：标记 Forecast/Actual 无法解释的行情，并细分“快速回落”“持续突破”等模式。
- 新闻驱动的独立波动：完善新闻采集与分类，记录无重大事件仍触发行情的资讯。
- 事件解释的新闻线索：回溯重大事件对应的新闻与预测文本，理解差异成因。
- “消息真空”雷达：监控长时间无事件、无新闻却波动升温的状况，触发风控或降权。
