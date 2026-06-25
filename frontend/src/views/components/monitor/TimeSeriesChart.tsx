import { useEffect, useMemo, useRef, useState } from 'react';
import ApexCharts, { type ApexOptions } from 'apexcharts';
import type { TimePoint } from '@/types/monitor';
import { useLocale } from '@/context/LocaleContext';
import { MONITOR_SERIES_PALETTE } from '@/views/components/monitor/chartPalette';

interface Props {
  title: string;
  points: TimePoint[];
  multiSeries?: Array<{ name: string; points: TimePoint[]; color?: string }>;
  color: string;
  showLegend?: boolean;
  showTitleValue?: boolean;
  valueFormatter?: (v: number) => string;
  axisValueFormatter?: (v: number) => string;
  minY?: number;
  yTickAmount?: number;
}

function removeApexNativeSvgTitles(root: HTMLDivElement | null) {
  root?.querySelectorAll('.apexcharts-svg > title').forEach((titleEl) => {
    titleEl.remove();
  });
}

export default function TimeSeriesChart({
  title,
  points,
  multiSeries,
  color,
  showLegend = true,
  valueFormatter,
  axisValueFormatter,
  minY,
  yTickAmount = 6,
}: Props) {
  const { intlLocale } = useLocale();
  const isMulti = Boolean(multiSeries && multiSeries.length > 0);
  const flatPoints = isMulti
    ? (multiSeries ?? []).flatMap((seriesItem) => seriesItem.points)
    : points;
  const firstTs = flatPoints[0] ? new Date(flatPoints[0].ts).getTime() : undefined;
  const lastTs = flatPoints[flatPoints.length - 1]
    ? new Date(flatPoints[flatPoints.length - 1].ts).getTime()
    : undefined;
  const values = flatPoints.map((point) => point.value);
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
    const maxTicksByPoints =
      flatPoints.length > 0 ? Math.max(2, flatPoints.length) : 4;
    return Math.min(ticksByWidth, maxTicksByPoints);
  }, [chartWidth, flatPoints.length]);

  const series = useMemo(
    () =>
      isMulti
        ? (multiSeries ?? []).map((seriesItem) => ({
          name: seriesItem.name,
          data: seriesItem.points.map((point) => ({ x: new Date(point.ts).getTime(), y: point.value })),
        }))
        : [
          {
            name: title,
            data: points.map((point) => ({ x: new Date(point.ts).getTime(), y: point.value })),
          },
        ],
    [isMulti, multiSeries, points, title],
  );

  const seriesKey = useMemo(
    () => JSON.stringify(series),
    [series],
  );

  const palette = useMemo(() => {
    if (!isMulti) return [color];
    return (multiSeries ?? []).map(
      (seriesItem, index) => seriesItem.color ?? MONITOR_SERIES_PALETTE[index % MONITOR_SERIES_PALETTE.length],
    );
  }, [color, isMulti, multiSeries]);

  const chartConfig = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'line',
        height: '100%',
        parentHeightOffset: 0,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: isMulti ? false : true, speed: 320 },
        fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif',
      },
      colors: palette,
      stroke: {
        curve: 'monotoneCubic',
        width: isMulti ? 1.6 : 2,
        lineCap: 'round',
      },
    }),
    [isMulti, palette],
  );

  const axisOptions = useMemo<ApexOptions>(
    () => ({
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
          formatter: (value) => {
            if (axisValueFormatter) return axisValueFormatter(Number(value));
            return valueFormatter ? valueFormatter(Number(value)) : Number(value).toFixed(1);
          },
        },
      },
    }),
    [axisValueFormatter, computedMaxY, computedMinY, firstTs, lastTs, valueFormatter, xTickAmount, yTickAmount],
  );

  const options = useMemo<ApexOptions>(
    () => ({
      ...chartConfig,
      ...axisOptions,
      dataLabels: { enabled: false },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 2 },
      },
      grid: {
        borderColor: '#d2ddf0',
        strokeDashArray: 4,
        padding: { left: 16, right: 10, top: -12, bottom: 2 },
      },
      tooltip: {
        theme: 'dark',
        shared: isMulti,
        intersect: false,
        followCursor: true,
        x: {
          formatter: (value) => {
            const date = new Date(value);
            return new Intl.DateTimeFormat(intlLocale, {
              hour12: false,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }).format(date);
          },
        },
        y: {
          formatter: (value) => (valueFormatter ? valueFormatter(Number(value)) : Number(value).toFixed(2)),
        },
      },
      legend: {
        show: isMulti && showLegend,
        position: "top",
        horizontalAlign: "left",
      },
    }),
    [axisOptions, chartConfig, intlLocale, isMulti, showLegend, valueFormatter],
  );

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = new ApexCharts(chartRef.current, { ...options, series });
    instanceRef.current = chart;
    void chart.render().then(() => removeApexNativeSvgTitles(chartRef.current));

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

  // 仅更新序列数据，避免整图重绘导致的闪烁
  useEffect(() => {
    if (!instanceRef.current) return;
    void instanceRef.current.updateSeries(series, false).then(() => removeApexNativeSvgTitles(chartRef.current));
  }, [seriesKey]);

  // 坐标轴等配置变更时才更新 options（不含 series）
  useEffect(() => {
    if (!instanceRef.current) return;
    void instanceRef.current.updateOptions(
      {
        ...chartConfig,
        ...axisOptions,
      },
      false,
      false,
    ).then(() => removeApexNativeSvgTitles(chartRef.current));
  }, [chartConfig, axisOptions]);

  return (
    <div className="spark">
      <div ref={chartRef} className="spark-chart" />
    </div>
  );
}
