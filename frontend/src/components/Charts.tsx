import { useId } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistoryPoint, StockPoint } from '../types';
const axis = { fontSize: 11, fill: '#85818f' };
export function StockChart({ data, scenario = false }: { data: StockPoint[]; scenario?: boolean }) {
  const fillId = useId().replaceAll(':', '');
  return (
    <div
      className="stock-chart"
      role="img"
      aria-label="Прогноз запаса по дням: исходный запас, сценарий и запас после заказа"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 14, right: 6, left: -23, bottom: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7da598" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#7da598" stopOpacity={0.06} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#edf0eb" vertical={false} />
          <XAxis
            dataKey="date"
            tick={axis}
            tickLine={false}
            axisLine={false}
            interval={6}
            minTickGap={15}
          />
          <YAxis tick={axis} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ borderRadius: 12, border: '1px solid #e3e9e2', fontSize: 12 }}
            formatter={(value) => (typeof value === 'number' ? Math.round(value) : value)}
          />
          <ReferenceLine y={0} stroke="#c88776" strokeDasharray="4 4" />
          <Area
            name="С заказом"
            type="linear"
            dataKey="with_order"
            fill={`url(#${fillId})`}
            stroke="#7da598"
            strokeWidth={2.5}
            isAnimationActive={false}
          />
          <Line
            name="Без заказа"
            type="monotone"
            dataKey="baseline"
            stroke="#aaa0d0"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            isAnimationActive={false}
          />
          {scenario && (
            <Line
              name="Сценарий без заказа"
              type="monotone"
              dataKey="scenario"
              stroke="#cc805c"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
export function HistoryChart({ data }: { data: HistoryPoint[] }) {
  return (
    <div className="history-chart" role="img" aria-label="История фактических и регулярных продаж">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 5, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#edf0eb" />
          <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} />
          <YAxis tick={axis} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12, border: '1px solid #e3e9e2' }} />
          <Bar
            dataKey="actual"
            name="Фактические продажи"
            fill="#e0daed"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="regular"
            name="Регулярный спрос"
            stroke="#8b7cac"
            strokeWidth={2.5}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
