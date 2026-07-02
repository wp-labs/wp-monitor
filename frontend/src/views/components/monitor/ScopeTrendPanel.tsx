import { Spin } from "antd";
import { useTranslation } from "react-i18next";
import TimeSeriesChart from "@/views/components/monitor/TimeSeriesChart";
import type { TimePoint } from "@/types/monitor";

interface ScopeSeriesLine {
  name: string;
  points: TimePoint[];
  color?: string;
}

interface ScopeTrendPanelProps {
  parseMultiSeries: ScopeSeriesLine[];
  visibleParseMultiSeries: ScopeSeriesLine[];
  hiddenScopeSeriesNames: string[];
  accentColor: string;
  onToggleSeries: (name: string) => void;
  formatRate2: (value: number) => string;
  formatCount2: (value: number) => string;
  metricMode: "rate" | "count";
  loading?: boolean;
  xMin?: number;
  xMax?: number;
}

export default function ScopeTrendPanel({
  parseMultiSeries,
  visibleParseMultiSeries,
  hiddenScopeSeriesNames,
  accentColor,
  onToggleSeries,
  formatRate2,
  formatCount2,
  metricMode,
  loading = false,
  xMin,
  xMax,
}: ScopeTrendPanelProps) {
  const { t } = useTranslation();

  return (
    <section className="detail-col">
      {parseMultiSeries.length > 0 && (
        <>
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
                <span
                  key={line.name}
                  onClick={() => onToggleSeries(line.name)}
                  title={hidden ? t("monitor.detail.showSeries") : t("monitor.detail.hideSeries")}
                  style={{
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 12,
                    color: hidden ? "var(--text-muted)" : "var(--text-sub)",
                    textDecoration: hidden ? "line-through" : "none",
                    userSelect: "none",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: hidden ? "var(--text-muted)" : (line.color ?? accentColor),
                      flexShrink: 0,
                    }}
                  />
                  {line.name}
                </span>
              );
            })}
          </div>
        </>
      )}
      <Spin spinning={loading}>
        <TimeSeriesChart
          key={`scope-${metricMode}`}
          title={
            metricMode === "count"
              ? t("monitor.detail.countTrend")
              : t("monitor.detail.rateTrend")
          }
          points={[]}
          multiSeries={visibleParseMultiSeries}
          showLegend={false}
          color={accentColor}
          valueFormatter={metricMode === "count" ? formatCount2 : formatRate2}
          axisValueFormatter={metricMode === "count" ? formatCount2 : formatRate2}
          minY={0}
          yTickAmount={6}
          xMin={xMin}
          xMax={xMax}
        />
      </Spin>
      {parseMultiSeries.length === 0 && (
        <div className="scope-empty-hint">{t("monitor.detail.noScopeData")}</div>
      )}
      {parseMultiSeries.length > 0 && visibleParseMultiSeries.length === 0 && (
        <div className="scope-empty-hint">{t("monitor.detail.allSeriesHidden")}</div>
      )}
    </section>
  );
}
