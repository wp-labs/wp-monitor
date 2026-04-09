import { useEffect, useMemo, useRef } from 'react';
import ApexCharts, { type ApexOptions } from 'apexcharts';
import type { TimePoint } from '../../types/monitor';

interface Props {
  title: string;
  points: TimePoint[];
  color: string;
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
  valueFormatter,
  axisValueFormatter,
  minY,
  yTickAmount = 6,
  rangeStartLabel,
  rangeEndLabel,
  showRangeMeta = true,
}: Props) {
  const latest = points[points.length - 1]?.value ?? 0;
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ApexCharts | null>(null);

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
        tickAmount: 4,
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
        min: minY,
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
    [axisValueFormatter, color, minY, valueFormatter, yTickAmount],
  );

  useEffect(() => {
    if (!chartRef.current) return;

    instanceRef.current?.destroy();
    const chart = new ApexCharts(chartRef.current, {
      ...options,
      series,
    });
    instanceRef.current = chart;
    void chart.render();

    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, [options, series]);

  return (
    <div className="spark">
      <div className="spark-title">{title} · {valueFormatter ? valueFormatter(latest) : latest.toFixed(2)}</div>
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
