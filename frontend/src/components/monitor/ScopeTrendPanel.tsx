import TimeSeriesChart from "./TimeSeriesChart";
import type { NodeTimeSeries, TimePoint } from "../../types/monitor";

interface ScopeSeriesLine {
  name: string;
  points: TimePoint[];
  color?: string;
}

interface ScopeTrendPanelProps {
  title: string;
  parseSeriesList: NodeTimeSeries[];
  parseMultiSeries: ScopeSeriesLine[];
  visibleParseMultiSeries: ScopeSeriesLine[];
  hiddenScopeSeriesNames: string[];
  detailTrendAutoRefresh: boolean;
  detailStartTime: string;
  detailEndTime: string;
  onToggleAutoRefresh: () => void;
  onShowAll: () => void;
  onToggleSeries: (name: string) => void;
  formatRate2: (value: number) => string;
  formatLocalTime: (iso: string) => string;
}

export default function ScopeTrendPanel({
  title,
  parseSeriesList,
  parseMultiSeries,
  visibleParseMultiSeries,
  hiddenScopeSeriesNames,
  detailTrendAutoRefresh,
  detailStartTime,
  detailEndTime,
  onToggleAutoRefresh,
  onShowAll,
  onToggleSeries,
  formatRate2,
  formatLocalTime,
}: ScopeTrendPanelProps) {
  return (
    <section className="panel card detail-col">
      <div className="panel-head">
        <div className="panel-head-main">
          <div className="panel-title">{title || "Parse 节点趋势"}</div>
          <span className="detail-kv-value detail-time-value detail-param-list">
            <span className="detail-param-item">
              <span className="detail-param-name">采样间隔</span>
              <span className="detail-param-data">
                {parseSeriesList[0]?.step_secs
                  ? `${parseSeriesList[0].step_secs}s`
                  : "--"}
              </span>
            </span>
            <span className="detail-param-item">
              <span className="detail-param-name">统计窗口</span>
              <span className="detail-param-data">
                {parseSeriesList[0]?.rate_window_secs
                  ? `${parseSeriesList[0].rate_window_secs}s`
                  : "--"}
              </span>
            </span>
          </span>
        </div>
        <button
          className={`toggle-switch ${detailTrendAutoRefresh ? "on" : ""}`}
          type="button"
          role="switch"
          aria-checked={detailTrendAutoRefresh}
          aria-label="切换范围趋势实时刷新"
          onClick={onToggleAutoRefresh}
        >
          <span className="toggle-switch-label">实时刷新</span>
          <span className="toggle-switch-track">
            <span className="toggle-switch-thumb" />
          </span>
        </button>
      </div>
      {parseMultiSeries.length > 0 && (
        <>
          <div
            style={{
              margin: "8px 0 4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div
              style={{
                color: "#64748b",
                fontSize: "12px",
              }}
            >
              点击图例可切换曲线显示
            </div>
            <button
              className="mini-btn"
              type="button"
              onClick={onShowAll}
              disabled={hiddenScopeSeriesNames.length === 0}
            >
              全部显示
            </button>
          </div>
          <div
            style={{
              margin: "0 0 4px",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 12px",
            }}
          >
            {parseMultiSeries.map((line) => {
              const hidden = hiddenScopeSeriesNames.includes(line.name);
              return (
                <button
                  key={line.name}
                  type="button"
                  onClick={() => onToggleSeries(line.name)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    color: hidden ? "#94a3b8" : "#4b6386",
                    fontSize: "12px",
                    border: "1px solid #dbe5f3",
                    background: hidden ? "#f8fafc" : "#ffffff",
                    borderRadius: "999px",
                    padding: "2px 8px",
                    cursor: "pointer",
                    opacity: hidden ? 0.65 : 1,
                  }}
                  aria-pressed={!hidden}
                  title={hidden ? "点击显示该曲线" : "点击隐藏该曲线"}
                >
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: line.color ?? "#2f6df6",
                    }}
                  />
                  <span
                    style={{
                      textDecoration: hidden ? "line-through" : "none",
                    }}
                  >
                    {line.name}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <TimeSeriesChart
        title="速率趋势"
        points={[]}
        multiSeries={visibleParseMultiSeries}
        showLegend={false}
        color="#2f6df6"
        showTitleValue={false}
        valueFormatter={formatRate2}
        axisValueFormatter={formatRate2}
        minY={0}
        yTickAmount={6}
        rangeStartLabel={formatLocalTime(detailStartTime)}
        rangeEndLabel={formatLocalTime(detailEndTime)}
        showRangeMeta={false}
      />
      {parseMultiSeries.length === 0 && (
        <div className="scope-empty-hint">当前范围暂无节点时序数据</div>
      )}
      {parseMultiSeries.length > 0 && visibleParseMultiSeries.length === 0 && (
        <div className="scope-empty-hint">当前已隐藏全部曲线</div>
      )}
    </section>
  );
}
