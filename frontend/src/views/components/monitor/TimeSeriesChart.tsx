import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TimePoint } from '@/types/monitor';
import { useLocale } from '@/context/LocaleContext';
import { MONITOR_SERIES_PALETTE } from '@/views/components/monitor/chartPalette';

echarts.use([LineChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer]);

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
  yAxisUnit?: string;
  legendPosition?: 'top' | 'bottom';
  legendAlign?: 'left' | 'center' | 'right';
  legendFontSize?: string;
  legendMarkerSize?: number;
  xMin?: number;
  xMax?: number;
}

function fmtTime(value: number, intlLocale: string): string {
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
  yAxisUnit,
  legendPosition,
  legendAlign,
  legendFontSize,
  legendMarkerSize,
  xMin,
  xMax,
}: Props) {
  const { intlLocale } = useLocale();
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const legendKeyRef = useRef('');

  const isMulti = Boolean(multiSeries && multiSeries.length > 0);
  const flatPoints = isMulti
    ? (multiSeries ?? []).flatMap((s) => s.points)
    : points;

  const firstTs = flatPoints[0] ? new Date(flatPoints[0].ts).getTime() : undefined;
  const lastTs = flatPoints[flatPoints.length - 1]
    ? new Date(flatPoints[flatPoints.length - 1].ts).getTime()
    : undefined;
  const values = flatPoints.map((p) => p.value);
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

  const palette = useMemo(() => {
    if (!isMulti) return [color];
    return (multiSeries ?? []).map(
      (s, i) => s.color ?? MONITOR_SERIES_PALETTE[i % MONITOR_SERIES_PALETTE.length],
    );
  }, [color, isMulti, multiSeries]);

  const series = useMemo(() => {
    if (isMulti) {
      return (multiSeries ?? []).map((s, i) => ({
        name: s.name,
        type: 'line' as const,
        data: s.points.map((p) => [new Date(p.ts).getTime(), p.value] as [number, number]),
        smooth: 0.4,
        symbol: 'none' as const,
        lineStyle: { width: 1.6, cap: 'round' as const },
        color: s.color ?? palette[i],
      }));
    }
    return [{
      name: title,
      type: 'line' as const,
      data: points.map((p) => [new Date(p.ts).getTime(), p.value] as [number, number]),
      smooth: 0.4,
      symbol: 'none' as const,
      lineStyle: { width: 2, cap: 'round' as const },
      color,
    }];
  }, [isMulti, multiSeries, points, title, color, palette]);

  const subtitleText = useMemo(() => {
    if (isMulti && multiSeries && multiSeries.length === 1) return multiSeries[0].name;
    if (!isMulti && points.length > 0) return title;
    return '';
  }, [isMulti, multiSeries, points.length, title]);

  const yLabelFmt = useMemo(() => {
    const fmt = axisValueFormatter || valueFormatter;
    return (value: number) => {
      const num = Number(value);
      const formatted = fmt ? fmt(num) : Math.round(num).toString();
      return yAxisUnit ? `${formatted} ${yAxisUnit}` : formatted;
    };
  }, [axisValueFormatter, valueFormatter, yAxisUnit]);

  const legendAtBottom = legendPosition === 'bottom';

  const option = useMemo(() => {
    const gridColorVal = gridColor || '#d2ddf0';
    const labelColorVal = labelColor || '#7f94b4';
    const gridTop = subtitleText ? 26 : 6;
    const gridBottom = legendAtBottom && showLegend && series.length > 0 ? 28 : 4;

    return {
      title: subtitleText ? {
        text: subtitleText,
        left: 'center',
        top: 0,
        textStyle: {
          fontSize: 11,
          fontWeight: 500,
          color: labelColorVal,
          fontFamily: 'var(--font-mono)',
        },
      } : undefined,
      color: palette,
      grid: {
        left: 12,
        right: 8,
        top: gridTop,
        bottom: gridBottom,
        containLabel: false,
      },
      xAxis: {
        type: 'time' as const,
        min: xMin ?? firstTs,
        max: xMax ?? lastTs,
        axisLine: { lineStyle: { color: gridColorVal }, show: !hideXAxis },
        axisTick: { lineStyle: { color: gridColorVal }, show: !hideXAxis },
        axisLabel: {
          show: !hideXAxis,
          color: labelColorVal,
          fontSize: 10,
          margin: 2,
          formatter: (value: number) => {
            const span = (lastTs ?? Date.now()) - (firstTs ?? 0);
            const d = new Date(value);
            const pad = (n: number) => String(n).padStart(2, '0');
            const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            if (span < 3600000) return `${hm}:${pad(d.getSeconds())}`;
            if (span < 86400000) return hm;
            if (span < 604800000) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
            return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        min: computedMinY,
        max: computedMaxY,
        splitNumber: yTickAmount,
        axisLabel: {
          color: labelColorVal,
          fontSize: 10,
          formatter: yLabelFmt,
        },
        splitLine: {
          lineStyle: { color: gridColorVal, type: 'dashed' as const },
        },
      },
      tooltip: {
        trigger: isMulti ? ('axis' as const) : ('item' as const),
        backgroundColor: 'rgba(20,20,30,0.92)',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        padding: [6, 10],
        textStyle: { fontSize: 12, color: '#e8e8ec' },
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.35);',
        formatter: (params: unknown) => {
          const items = (Array.isArray(params) ? params : [params]) as Array<{
            seriesName: string;
            color: string;
            data: [number, number];
          }>;
          const p0 = items[0];
          if (!p0) return '';
          const timeStr = fmtTime(p0.data[0], intlLocale);
          const lines = items.map(
            (p) => `<span style="display:flex;align-items:center;gap:6px;margin:2px 0">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0"></span>
              ${p.seriesName}: <b>${valueFormatter ? valueFormatter(p.data[1]) : p.data[1].toFixed(2)}</b>
            </span>`,
          );
          return `<div style="font-size:10px;color:#9a9aad;margin-bottom:3px">${timeStr}</div>${lines.join('')}`;
        },
      },
      legend: showLegend && series.length > 0 ? {
        show: true,
        ...(legendAtBottom ? { bottom: 0 } : { top: 0 }),
        left: (legendAlign === 'right' ? 'right' : legendAlign === 'center' ? 'center' : 'left') as string,
        textStyle: {
          color: labelColorVal,
          fontSize: parseInt(legendFontSize || '11', 10) || 11,
          fontFamily: 'var(--font-mono)',
        },
        itemWidth: (legendMarkerSize ?? 5) * 2,
        itemHeight: (legendMarkerSize ?? 5) * 2,
        itemGap: 8,
        icon: 'circle',
      } : { show: false },
      series,
    };
  }, [
    subtitleText, palette, firstTs, lastTs, hideXAxis, computedMinY, computedMaxY,
    yTickAmount, yLabelFmt, isMulti, showLegend, legendAtBottom, legendAlign,
    legendFontSize, legendMarkerSize, gridColor, labelColor, series,
    valueFormatter, intlLocale,
  ]);

  const legendKey = `${isMulti}-${showLegend}-${subtitleText}`;

  // init
  useEffect(() => {
    if (!chartRef.current) return;
    const inst = echarts.init(chartRef.current);
    instanceRef.current = inst;
    inst.setOption(option, true);
    legendKeyRef.current = legendKey;

    return () => {
      inst.dispose();
      instanceRef.current = null;
    };
  }, []);

  // resize
  useEffect(() => {
    if (!chartRef.current) return;
    const observer = new ResizeObserver(() => {
      instanceRef.current?.resize();
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);

  // update
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;

    const structural = legendKey !== legendKeyRef.current;
    inst.setOption(option, structural ? true : false);
    legendKeyRef.current = legendKey;
  }, [option, legendKey]);

  return (
    <div className="spark">
      <div ref={chartRef} className="spark-chart" style={{ height: '100%' }} />
    </div>
  );
}
