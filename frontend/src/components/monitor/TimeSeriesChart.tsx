import { useEffect, useMemo, useRef, useState } from 'react';
import ApexCharts, { type ApexOptions } from 'apexcharts';
import type { TimePoint } from '../../types/monitor';

interface Props {
  title: string;
  points: TimePoint[];
  color: string;
  showTitleValue?: boolean;
  valueFormatter?: (v: number) => string;
  axisValueFormatter?: (v: number) => string;
  minY?: number;
  yTickAmount?: number;
  rangeStartLabel?: string;
  rangeEndLabel?: string;
  showRangeMeta?: boolean;
}

function timeText(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export default function TimeSeriesChart({
  title,
  points,
  color,
  showTitleValue = true,
  valueFormatter,
  axisValueFormatter,
  minY,
  yTickAmount = 6,
  rangeStartLabel,
  rangeEndLabel,
  showRangeMeta = true,
}: Props) {
  const latest = points[points.length - 1]?.value ?? 0;
  const firstTs = points[0] ? new Date(points[0].ts).getTime() : undefined;
  const lastTs = points[points.length - 1]
    ? new Date(points[points.length - 1].ts).getTime()
    : undefined;
  const values = points.map((p) => p.value);
  const valueMin = values.length > 0 ? Math.min(...values) : undefined;
  const valueMax = values.length > 0 ? Math.max(...values) : undefined;
  const computedMinY =
    typeof minY === 'number'
      ? minY
      : typeof valueMin === 'number'
        ? Math.max(0, valueMin * 0.95)
        : undefined;
  const computedMaxY =
    typeof valueMax === 'number'
      ? Math.max(valueMax * 1.05, (computedMinY ?? 0) + 1)
      : undefined;
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ApexCharts | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const xTickAmount = useMemo(() => {
    const baseWidth = chartWidth > 0 ? chartWidth : 560;
    const ticksByWidth = Math.max(4, Math.min(12, Math.floor(baseWidth / 88)));
    const maxTicksByPoints = points.length > 0 ? Math.max(2, points.length) : 4;
    return Math.min(ticksByWidth, maxTicksByPoints);
  }, [chartWidth, points.length]);

  const series = useMemo(
    () => [
      {
        name: title,
        data: points.map((p) => ({ x: new Date(p.ts).getTime(), y: p.value })),
      },
    ],
    [points, title],
  );

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'line',
        height: '100%',
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: true, speed: 320 },
        fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif',
      },
      colors: [color],
      stroke: {
        curve: 'monotoneCubic',
        width: 2,
        lineCap: 'round',
      },
      dataLabels: { enabled: false },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 2 },
      },
      grid: {
        borderColor: '#d2ddf0',
        strokeDashArray: 4,
        padding: { left: 16, right: 10, top: 4, bottom: 8 },
      },
      xaxis: {
        type: 'datetime',
        min: firstTs,
        max: lastTs,
        tickAmount: xTickAmount,
        labels: {
          show: true,
          style: { colors: '#7f94b4', fontSize: '10px' },
          offsetY: 0,
          datetimeUTC: false,
          datetimeFormatter: {
            year: 'yyyy',
            month: 'MM/dd',
            day: 'MM/dd',
            hour: 'HH:mm',
            minute: 'HH:mm',
            second: 'HH:mm:ss',
          },
        },
        tooltip: { enabled: false },
        axisBorder: { color: '#cfdcf1' },
        axisTicks: { color: '#cfdcf1' },
      },
      yaxis: {
        min: computedMinY,
        max: computedMaxY,
        tickAmount: yTickAmount,
        forceNiceScale: true,
        labels: {
          show: true,
          minWidth: 64,
          offsetX: -2,
          style: { colors: '#6b84a8', fontSize: '10px' },
          formatter: (v) => {
            if (axisValueFormatter) return axisValueFormatter(Number(v));
            return valueFormatter ? valueFormatter(Number(v)) : Number(v).toFixed(1);
          },
        },
      },
      tooltip: {
        shared: false,
        intersect: false,
        followCursor: true,
        x: {
          formatter: (v) => {
            const d = new Date(v);
            return d.toLocaleString('zh-CN', { hour12: false });
          },
        },
        y: {
          formatter: (v) => (valueFormatter ? valueFormatter(Number(v)) : Number(v).toFixed(2)),
        },
      },
      legend: { show: false },
    }),
    [
      axisValueFormatter,
      color,
      computedMaxY,
      computedMinY,
      firstTs,
      lastTs,
      xTickAmount,
      valueFormatter,
      yTickAmount,
    ],
  );

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = new ApexCharts(chartRef.current, { ...options, series });
    instanceRef.current = chart;
    void chart.render();

    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    setChartWidth(chartRef.current.clientWidth || 0);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setChartWidth(entry.contentRect.width || 0);
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!instanceRef.current) return;
    // 实时刷新时避免整图重绘与动画闪烁，仅增量更新坐标轴与序列。
    void instanceRef.current.updateOptions(
      {
        xaxis: options.xaxis,
        yaxis: options.yaxis,
        series,
      },
      false,
      false,
      false,
    );
  }, [options, series]);

  return (
    <div className="spark">
      <div className="spark-title">
        {showTitleValue
          ? `${title} · ${valueFormatter ? valueFormatter(latest) : latest.toFixed(2)}`
          : title}
      </div>
      <div ref={chartRef} className="spark-chart" />
      {showRangeMeta && (
        <div className="spark-meta">
          <span>{rangeStartLabel ?? (points[0] ? timeText(points[0].ts) : '-')}</span>
          <span>{rangeEndLabel ?? (points[points.length - 1] ? timeText(points[points.length - 1].ts) : '-')}</span>
        </div>
      )}
    </div>
  );
}
