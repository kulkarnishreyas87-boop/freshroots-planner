"use client";

import { useEffect, useRef, useState } from "react";

/** Counts up to a number on first show (instant when the user prefers reduced motion). */
export function CountUp({ value }: { value: number }) {
  const [v, setV] = useState(value);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || from === value) return setV(value);
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      setV(Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{v}</>;
}

/** Weeks of cover against the min-max window, with an optional marker for cover after the order. */
export function CoverGauge({ cover, min, max, after }: { cover: number | null; min: number; max: number; after?: number | null }) {
  const scale = Math.max(max * 1.5, (cover ?? 0) * 1.08, (after ?? 0) * 1.08, 1);
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / scale) * 100))}%`;
  return (
    <div className="gauge" aria-label={`Weeks of cover ${cover ?? "unknown"}, window ${min} to ${max}${after ? `, ${after} after order` : ""}`}>
      <div className="gauge-track">
        <div className="gauge-band" style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }} />
        {after != null && <div className="gauge-mark after" style={{ left: pct(after) }} title={`After order: ${after} wks`} />}
        {cover != null && <div className="gauge-mark" style={{ left: pct(cover) }} title={`Now: ${cover} wks`} />}
      </div>
      <div className="gauge-legend"><span>0</span><span>window {min}–{max} wks</span><span>{Math.round(scale)}</span></div>
    </div>
  );
}

export function Spark({ data, color }: { data: { week: string; units: number }[]; color: string }) {
  if (data.length < 2) return null;
  const w = 150, h = 40, max = Math.max(...data.map((d) => d.units)), min = Math.min(...data.map((d) => d.units));
  const x = (i: number) => (i / (data.length - 1)) * (w - 6) + 3;
  const y = (v: number) => (max === min ? h / 2 : h - 4 - ((v - min) / (max - min)) * (h - 10));
  const pts = data.map((p, i) => `${x(i).toFixed(1)},${y(p.units).toFixed(1)}`);
  const last = data[data.length - 1];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Weekly sales ${data[0].week} to ${last.week}: ${data.map((p) => p.units).join(", ")}`}>
      {/* colours via style: CSS variables don't resolve inside SVG presentation attributes */}
      <path className="area" d={`M${pts[0]} L${pts.join(" L")} L${x(data.length - 1)},${h} L${x(0)},${h} Z`} style={{ fill: color }} />
      <path className="line-path" d={`M${pts.join(" L")}`} style={{ stroke: color }} />
      <circle cx={x(data.length - 1)} cy={y(last.units)} r={3} style={{ fill: color }} />
    </svg>
  );
}
