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
  gridColor?: string;
  labelColor?: string;
  hideXAxis?: boolean;
  legendPosition?: 'top' | 'bottom';
  legendAlign?: 'left' | 'center' | 'right';
  legendFontSize?: string;
  legendMarkerSize?: number;
}

function removeApexNativeSvgTitles(root: HTMLDivElement | null) {
  root?.querySelectorAll('.apexcharts-svg > title').forEach((titleEl) => {
    titleEl.remove();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  gridColor,
  labelColor,
  hideXAxis = false,
  legendPosition,
  legendAlign,
  legendFontSize,
  legendMarkerSize,
}: Props) {
  const { intlLocale } = useLocale();
  const isMulti = Boolean(multiSeries && multiSeries.length > 0);
  const flatPoints = isMulti
    ? (multiSeries ?? []).flatMap((seriesItem) => seriesItem.points)
    : points;
  const firstTs = useMemo(() => {
    if (!isMulti) {
      return flatPoints[0] ? new Date(flatPoints[0].ts).getTime() : undefined;
    }
    let minTs = Infinity;
    for (const s of (multiSeries ?? [])) {
      for (const p of s.points) {
        const t = new Date(p.ts).getTime();
        if (t < minTs) minTs = t;
      }
    }
    return minTs === Infinity ? undefined : minTs;
  }, [isMulti, multiSeries]);
  const lastTs = useMemo(() => {
    if (!isMulti) {
      return flatPoints[flatPoints.length - 1] ? new Date(flatPoints[flatPoints.length - 1].ts).getTime() : undefined;
    }
    let maxTs = -Infinity;
    for (const s of (multiSeries ?? [])) {
      for (const p of s.points) {
        const t = new Date(p.ts).getTime();
        if (t > maxTs) maxTs = t;
      }
    }
    return maxTs === -Infinity ? undefined : maxTs;
  }, [isMulti, multiSeries]);
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
    () => {
      if (!isMulti) {
        return [
          {
            name: title,
            data: points.map((point) => ({ x: new Date(point.ts).getTime(), y: point.value })),
          },
        ];
      }
      // 收集所有 series 的时间戳并排序，构成统一的 x 轴网格。
      const tsSet = new Set<string>();
      for (const s of (multiSeries ?? [])) {
        for (const p of s.points) tsSet.add(p.ts);
      }
      const sortedTs = Array.from(tsSet).sort();
      const sortedTsMs = sortedTs.map((ts) => new Date(ts).getTime());

      return (multiSeries ?? []).map((seriesItem) => {
        const pts = seriesItem.points;
        if (pts.length === 0) {
          return { name: seriesItem.name, data: [] as { x: number; y: number | null }[] };
        }
        // 将本 series 的点转为 {x, y} 并按时间排序
        const own = pts
          .map((p) => ({ x: new Date(p.ts).getTime(), y: p.value }))
          .sort((a, b) => a.x - b.x);
        const firstX = own[0].x;
        const lastX = own[own.length - 1].x;

        let cursor = 0;
        const data = sortedTsMs.map((x) => {
          // 在 series 数据范围之外：留 null
          if (x < firstX || x > lastX) return { x, y: null };
          // 移动 cursor 使 x 落在 own[cursor] 和 own[cursor+1] 之间
          while (cursor < own.length - 2 && own[cursor + 1].x < x) cursor++;
          const a = own[cursor];
          const b = own[cursor + 1];
          if (a.x === x) return { x, y: a.y };
          if (b.x === x) return { x, y: b.y };
          // 线性插值
          if (a.x <= x && x <= b.x && b.x > a.x) {
            const t = (x - a.x) / (b.x - a.x);
            return { x, y: a.y + (b.y - a.y) * t };
          }
          return { x, y: null };
        });
        return { name: seriesItem.name, data };
      });
    },
    [isMulti, multiSeries, points, title],
  );

  const palette = useMemo(() => {
    if (!isMulti) return [color];
    return (multiSeries ?? []).map(
      (seriesItem, index) => seriesItem.color ?? MONITOR_SERIES_PALETTE[index % MONITOR_SERIES_PALETTE.length],
    );
  }, [color, isMulti, multiSeries]);

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'line',
        height: '100%',
        parentHeightOffset: 0,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: true, speed: 320 },
        fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif',
      },
      colors: palette,
      stroke: {
        curve: 'monotoneCubic',
        width: isMulti ? 1.6 : 2,
        lineCap: 'round',
      },
      dataLabels: { enabled: false },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 2 },
      },
      grid: {
        borderColor: gridColor || '#d2ddf0',
        strokeDashArray: 4,
        padding: { left: 16, right: 10, top: -12, bottom: 2 },
      },
      xaxis: {
        type: 'datetime',
        min: firstTs,
        max: lastTs,
        tickAmount: xTickAmount,
        labels: {
          show: !hideXAxis,
          style: { colors: labelColor || '#7f94b4', fontSize: '10px' },
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
        axisBorder: { color: gridColor || '#cfdcf1' },
        axisTicks: { color: gridColor || '#cfdcf1' },
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
          style: { colors: labelColor || '#6b84a8', fontSize: '10px' },
          formatter: (value) => {
            if (axisValueFormatter) return axisValueFormatter(Number(value));
            return valueFormatter ? valueFormatter(Number(value)) : Number(value).toFixed(1);
          },
        },
      },
      tooltip: isMulti
        ? {
            followCursor: true,
            intersect: false,
            shared: false,
            custom({ dataPointIndex, w }) {
              const idx = dataPointIndex;
              if (idx < 0) return '';
              const names: string[] = w.globals.seriesNames ?? [];
              const colors: string[] = w.globals.colors ?? [];
              const allSeries: Array<Array<number | null>> = w.globals.series ?? [];
              const fmt = valueFormatter ?? ((v: number) => v.toFixed(2));
              const xVal = w.globals.seriesX?.[0]?.[idx];
              let timeStr = '';
              if (xVal != null) {
                const date = new Date(xVal);
                if (!Number.isNaN(date.getTime())) {
                  timeStr = new Intl.DateTimeFormat(intlLocale, {
                    hour12: false,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }).format(date);
                }
              }

              const rows: Array<{ name: string; color: string; y: number; label: string }> = [];
              for (let i = 0; i < names.length; i++) {
                const y = allSeries[i]?.[idx];
                if (y == null) continue;
                rows.push({
                  name: names[i],
                  color: colors[i] ?? palette[i % palette.length],
                  y: Number(y),
                  label: fmt(Number(y)),
                });
              }
              rows.sort((a, b) => (b.y ?? -Infinity) - (a.y ?? -Infinity));

              let html = '<div class="custom-tooltip-box">';
              if (timeStr) {
                html += `<div class="custom-tooltip-box__title">${timeStr}</div>`;
              }
              html += '<div class="custom-tooltip-box__list">';
              for (const r of rows) {
                html += `<div class="custom-tooltip-box__row">`;
                html += `<span class="custom-tooltip-box__dot" style="background:${r.color}"></span>`;
                html += `<span class="custom-tooltip-box__name">${escapeHtml(r.name)}</span>`;
                html += `<span class="custom-tooltip-box__value">${r.label}</span>`;
                html += '</div>';
              }
              html += '</div></div>';
              return html;
            },
          }
        : {
            theme: 'dark',
            shared: false,
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
        position: legendPosition || "top",
        horizontalAlign: legendAlign || "left",
        fontSize: legendFontSize || '12px',
        fontFamily: 'var(--font-mono)',
        labels: { colors: labelColor || '#7f94b4' },
        markers: {
          size: legendMarkerSize ?? 6,
          strokeWidth: 0,
        },
        itemMargin: { horizontal: 4, vertical: 2 },
      },
    }),
    [
      axisValueFormatter,
      computedMaxY,
      computedMinY,
      firstTs,
      gridColor,
      hideXAxis,
      intlLocale,
      isMulti,
      labelColor,
      lastTs,
      legendAlign,
      legendFontSize,
      legendMarkerSize,
      legendPosition,
      palette,
      showLegend,
      xTickAmount,
      valueFormatter,
      yTickAmount,
    ],
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

  useEffect(() => {
    if (!instanceRef.current) return;
    // 实时刷新时避免整图重绘与动画闪烁，仅增量更新坐标轴与序列。
    void instanceRef.current.updateOptions(
      {
        colors: options.colors,
        xaxis: options.xaxis,
        yaxis: options.yaxis,
        tooltip: options.tooltip,
        series,
      },
      false,
      false,
      false,
    ).then(() => removeApexNativeSvgTitles(chartRef.current));
  }, [options, series]);

  // 多 series 时 ApexCharts 给 tooltip 内联了 pointer-events:none，
  // 滚轮事件穿透到 chart 容器。这里手动转发滚轮给 custom tooltip 列表。
  useEffect(() => {
    if (!isMulti) return;
    const el = chartRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const box = el.querySelector<HTMLElement>('.custom-tooltip-box');
      if (!box) return;
      const tooltip = box.closest<HTMLElement>('.apexcharts-tooltip');
      if (!tooltip || tooltip.style.display === 'none') return;
      box.scrollTop += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isMulti]);

  return (
    <div className="spark">
      <div ref={chartRef} className="spark-chart" />
    </div>
  );
}
