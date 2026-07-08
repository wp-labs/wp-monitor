import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import {
  CanvasRenderer,
} from 'echarts/renderers';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import {
  LineChart,
  type LineSeriesOption,
} from 'echarts/charts';
import type { ComposeOption } from 'echarts/core';
import type { TimePoint } from '@/types/monitor';
import { useLocale } from '@/context/LocaleContext';
import { MONITOR_SERIES_PALETTE } from '@/views/components/monitor/chartPalette';

echarts.use([
  CanvasRenderer,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  LineChart,
]);

type EChartsOption = ComposeOption<
  GridComponentOption | LegendComponentOption | TooltipComponentOption | LineSeriesOption
>;

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

function trimBoundaryNullPoints(points: TimePoint[]) {
  let start = 0;
  let end = points.length;
  while (start < end && points[start]?.value == null) {
    start += 1;
  }
  while (end > start && points[end - 1]?.value == null) {
    end -= 1;
  }
  return points.slice(start, end);
}

function formatAxisTime(ts: number, intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function formatAxisDateTime(ts: number, intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function formatTooltipTime(ts: number, intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
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
  xMin,
  xMax,
}: Props) {
  const { intlLocale } = useLocale();
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.EChartsType | null>(null);
  const isMulti = Boolean(multiSeries && multiSeries.length > 0);

  const normalizedPoints = useMemo(
    () => trimBoundaryNullPoints(points),
    [points],
  );
  const normalizedMultiSeries = useMemo(
    () =>
      (multiSeries ?? []).map((seriesItem) => ({
        ...seriesItem,
        points: trimBoundaryNullPoints(seriesItem.points),
      })),
    [multiSeries],
  );

  const palette = useMemo(() => {
    if (!isMulti) return [color];
    return normalizedMultiSeries.map(
      (seriesItem, index) => seriesItem.color ?? MONITOR_SERIES_PALETTE[index % MONITOR_SERIES_PALETTE.length],
    );
  }, [color, isMulti, normalizedMultiSeries]);

  const flatPoints = useMemo(
    () => (isMulti
      ? normalizedMultiSeries.flatMap((seriesItem) => seriesItem.points)
      : normalizedPoints),
    [isMulti, normalizedMultiSeries, normalizedPoints],
  );

  const firstTs = useMemo(() => {
    const first = flatPoints[0];
    return first ? new Date(first.ts).getTime() : undefined;
  }, [flatPoints]);

  const lastTs = useMemo(() => {
    const last = flatPoints[flatPoints.length - 1];
    return last ? new Date(last.ts).getTime() : undefined;
  }, [flatPoints]);

  const values = useMemo(
    () => flatPoints
      .map((point) => point.value)
      .filter((value): value is number => typeof value === 'number'),
    [flatPoints],
  );

  const computedMinY = useMemo(() => {
    if (typeof minY === 'number') return minY;
    if (values.length === 0) return undefined;
    return Math.max(0, Math.min(...values) * 0.95);
  }, [minY, values]);

  const computedMaxY = useMemo(() => {
    if (values.length === 0) return undefined;
    return Math.max(Math.max(...values) * 1.05, (computedMinY ?? 0) + 1);
  }, [computedMinY, values]);

  const xAxisMin = typeof xMin === 'number' ? xMin : firstTs;
  const xAxisMax = typeof xMax === 'number' ? xMax : lastTs;
  const xAxisRangeMs = (
    Number.isFinite(xAxisMin) && Number.isFinite(xAxisMax)
      ? Math.max(0, (xAxisMax as number) - (xAxisMin as number))
      : 0
  );
  const axisTimeFormatter = useMemo(() => {
    if (xAxisRangeMs > 24 * 60 * 60 * 1000) {
      return (value: number) => formatAxisDateTime(value, intlLocale);
    }
    return (value: number) => formatAxisTime(value, intlLocale);
  }, [intlLocale, xAxisRangeMs]);
  const xAxisSplitNumber = hideXAxis
    ? 0
    : xAxisRangeMs <= 60 * 60 * 1000
      ? 8
      : xAxisRangeMs <= 6 * 60 * 60 * 1000
        ? 10
        : xAxisRangeMs <= 24 * 60 * 60 * 1000
          ? 12
          : 8;

  const seriesOption = useMemo<LineSeriesOption[]>(() => {
    if (!isMulti) {
      return [{
        type: 'line',
        name: title,
        data: normalizedPoints.map((point) => [
          new Date(point.ts).getTime(),
          typeof point.value === 'number' ? point.value : null,
        ]),
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 4,
        connectNulls: false,
        smooth: 0.25,
        lineStyle: {
          width: 2,
          color,
          cap: 'round',
        },
        itemStyle: {
          color,
        },
      }];
    }
    return normalizedMultiSeries.map((seriesItem, index) => {
      const lineColor = seriesItem.color ?? palette[index % palette.length];
      return {
        type: 'line',
        name: seriesItem.name,
        data: seriesItem.points.map((point) => [
          new Date(point.ts).getTime(),
          typeof point.value === 'number' ? point.value : null,
        ]),
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 4,
        connectNulls: false,
        smooth: 0.2,
        lineStyle: {
          width: 1.6,
          color: lineColor,
          cap: 'round',
        },
        itemStyle: {
          color: lineColor,
        },
      };
    });
  }, [color, isMulti, normalizedMultiSeries, normalizedPoints, palette, title]);

  const options = useMemo<EChartsOption>(() => ({
    animationDuration: 320,
    animationDurationUpdate: 220,
    grid: {
      left: 68,
      right: 18,
      top: isMulti && showLegend && legendPosition === 'top' ? 34 : 14,
      bottom: hideXAxis
        ? (isMulti && showLegend && legendPosition === 'bottom' ? 28 : 12)
        : (isMulti && showLegend && legendPosition === 'bottom' ? 48 : 32),
      containLabel: false,
    },
    color: palette,
    legend: {
      show: isMulti && showLegend,
      type: 'plain',
      top: legendPosition === 'top' ? 4 : undefined,
      bottom: legendPosition === 'bottom' ? 0 : undefined,
      left: legendAlign === 'center' ? 'center' : legendAlign === 'right' ? 'right' : 'left',
      itemWidth: legendMarkerSize ?? 6,
      itemHeight: legendMarkerSize ?? 6,
      icon: 'circle',
      textStyle: {
        color: labelColor || '#7f94b4',
        fontSize: Number.parseInt(legendFontSize || '12', 10),
        fontFamily: 'var(--font-mono)',
      },
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: 'var(--tooltip-bg)',
      borderColor: 'var(--chart-tooltip-border)',
      textStyle: {
        color: 'var(--text-main)',
        fontFamily: 'var(--font-mono)',
      },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        if (list.length === 0) return '';
        const axisValue = Array.isArray(list[0].value)
          ? Number(list[0].value[0])
          : Number(list[0].value);
        const header = formatTooltipTime(axisValue, intlLocale);
        const rows = list.map((item) => {
          const seriesName = item.seriesName ?? '';
          const rawValue = Array.isArray(item.value) ? item.value[1] : item.value;
          const value = rawValue == null || Number.isNaN(Number(rawValue))
            ? '-'
            : (valueFormatter ? valueFormatter(Number(rawValue)) : Number(rawValue).toFixed(2));
          return `${item.marker}${seriesName} ${value}`;
        });
        return [header, ...rows].join('<br/>');
      },
    },
    xAxis: {
      type: 'time',
      min: xAxisMin,
      max: xAxisMax,
      boundaryGap: [0, 0],
      splitNumber: xAxisSplitNumber,
      axisLabel: {
        show: !hideXAxis,
        color: labelColor || '#7f94b4',
        fontSize: 10,
        hideOverlap: false,
        showMinLabel: true,
        showMaxLabel: true,
        formatter: (value: number) => axisTimeFormatter(value),
      },
      axisTick: {
        show: !hideXAxis,
        alignWithLabel: true,
        lineStyle: {
          color: gridColor || '#cfdcf1',
        },
      },
      axisLine: {
        show: !hideXAxis,
        lineStyle: {
          color: gridColor || '#cfdcf1',
        },
      },
      splitLine: {
        show: false,
      },
      minInterval: 1000,
      maxInterval: 24 * 60 * 60 * 1000,
    },
    yAxis: {
      type: 'value',
      min: computedMinY,
      max: computedMaxY,
      minInterval: computedMinY != null && computedMaxY != null
        ? (computedMaxY - computedMinY) / (yTickAmount * 3)
        : undefined,
      splitNumber: yTickAmount,
      axisLabel: {
        color: labelColor || '#6b84a8',
        fontSize: 10,
        formatter: (value: number) => {
          if (axisValueFormatter) return axisValueFormatter(Number(value));
          return valueFormatter ? valueFormatter(Number(value)) : Number(value).toFixed(1);
        },
      },
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      splitLine: {
        show: false,
        lineStyle: {
          color: gridColor || '#d2ddf0',
          type: 'dashed',
        },
      },
    },
    series: seriesOption,
  }), [
    axisValueFormatter,
    color,
    computedMaxY,
    computedMinY,
    gridColor,
    hideXAxis,
    intlLocale,
    isMulti,
    labelColor,
    legendAlign,
    legendFontSize,
    legendMarkerSize,
    legendPosition,
    palette,
    seriesOption,
    showLegend,
    title,
    valueFormatter,
    xAxisMax,
    xAxisMin,
    xAxisSplitNumber,
    xAxisRangeMs,
    yTickAmount,
    axisTimeFormatter,
  ]);

  useEffect(() => {
    if (!chartRef.current) return;
    const instance = echarts.init(chartRef.current, undefined, {
      renderer: 'canvas',
    });
    instanceRef.current = instance;
    return () => {
      instance.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!instanceRef.current) return;
    instanceRef.current.setOption(options, true);
  }, [options]);

  useEffect(() => {
    if (!instanceRef.current) return;
    const handleResize = () => instanceRef.current?.resize();
    const observer = new ResizeObserver(() => handleResize());
    if (chartRef.current) observer.observe(chartRef.current);
    window.addEventListener('resize', handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div className="spark">
      <div ref={chartRef} className="spark-chart" />
    </div>
  );
}
