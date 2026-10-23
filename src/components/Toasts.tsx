"use client";

import { useEffect, useState } from "react";

type Kind = "ok" | "err" | "warn";
interface T { id: number; kind: Kind; text: string }

/** Fire from anywhere: toast("Saved") or toast("Failed", "err"). */
export function toast(text: string, kind: Kind = "ok") {
  window.dispatchEvent(new CustomEvent("fr-toast", { detail: { text, kind } }));
}

export function Toasts() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const { text, kind } = (e as CustomEvent<{ text: string; kind: Kind }>).detail;
      const id = ++n;
      setItems((xs) => [...xs.slice(-3), { id, kind, text }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "err" ? 8000 : 4500);
    };
    window.addEventListener("fr-toast", on);
    return () => window.removeEventListener("fr-toast", on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}><i />{t.text}</div>
      ))}
    </div>
  );
}
