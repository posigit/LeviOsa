"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

const HOLD_MS = 3000;
const FADE_MS = 400;

type Phase = "hold" | "fade" | "gone";

export function AppSplash() {
  const [phase, setPhase] = useState<Phase>("hold");

  useEffect(() => {
    const fade = setTimeout(() => setPhase("fade"), HOLD_MS);
    const gone = setTimeout(() => setPhase("gone"), HOLD_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: phase === "fade" ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: phase === "fade" ? "none" : "auto",
      }}
    >
      <div
        className={`splash-mark${phase === "fade" ? " is-leaving" : ""}`}
        style={{ width: "min(36vw, 160px)" }}
      >
        <div className="splash-glow" />
        <Image
          className="splash-logo"
          src="/icons/icon-512x512.png?v=14"
          alt=""
          width={160}
          height={160}
          priority
          unoptimized
          style={{ width: "100%", height: "auto" }}
        />
        <div className="splash-shine" />
      </div>
    </div>
  );
}
