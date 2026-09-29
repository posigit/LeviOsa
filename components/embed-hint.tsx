"use client";

import { useEffect, useState } from "react";

/** One-time 4s hint shown when playing inside an embed (iframe controls only). */
export function EmbedHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <p className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-[10px] font-semibold text-white/70 backdrop-blur">
      Embed controls only — switch source for CC / speed / audio
    </p>
  );
}
