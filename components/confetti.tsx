"use client";

import { useEffect, useRef } from "react";

type Piece = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  vy: number;
  vx: number;
  rotation: number;
  vr: number;
  sway: number;
  swaySpeed: number;
  phase: number;
};

/** LeviOsa celebration palette (orange, purple, blue, green, red, brand cream) */
const COLORS = [
  "#f97316", // orange
  "#a855f7", // purple
  "#3b82f6", // blue
  "#22c55e", // green
  "#ef4444", // red
  "#e9e5d2", // brand cream
];

function makePiece(canvasWidth: number, startAbove: boolean): Piece {
  const size = 6 + Math.random() * 8;
  return {
    x: Math.random() * canvasWidth,
    y: startAbove ? -20 - Math.random() * canvasWidth * 0.4 : Math.random() * -40,
    w: size * (0.5 + Math.random() * 0.6),
    h: size,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    vy: 120 + Math.random() * 160,
    vx: -30 + Math.random() * 60,
    rotation: Math.random() * Math.PI * 2,
    vr: -3 + Math.random() * 6,
    sway: 20 + Math.random() * 40,
    swaySpeed: 1 + Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
  };
}

/**
 * Full-screen falling confetti celebration.
 * Fires when `fire` flips to true; runs ~5s then fades out.
 */
export function Confetti({ fire }: { fire: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!fire) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    const width = () => canvas.width / dpr;
    const height = () => canvas.height / dpr;

    const pieces: Piece[] = [];
    const SPAWN_MS = 2600;
    const FADE_MS = 2200;
    const start = performance.now();
    let last = start;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const elapsed = now - start;

      // Spawn while in spawn window
      if (elapsed < SPAWN_MS && pieces.length < 220) {
        for (let i = 0; i < 4; i++) pieces.push(makePiece(width(), true));
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width(), height());

      // Fade the whole layer out at the end
      const fade =
        elapsed > SPAWN_MS
          ? Math.max(0, 1 - (elapsed - SPAWN_MS) / FADE_MS)
          : 1;
      ctx.globalAlpha = fade;

      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        p.phase += p.swaySpeed * dt;
        p.x += (p.vx + Math.sin(p.phase) * p.sway) * dt;
        p.y += p.vy * dt;
        p.rotation += p.vr * dt;

        if (p.y > height() + 30) {
          pieces.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (elapsed < SPAWN_MS + FADE_MS || pieces.length > 0) {
        if (!(elapsed > SPAWN_MS + FADE_MS && pieces.length === 0)) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
      }
      ctx.clearRect(0, 0, width(), height());
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [fire]);

  if (!fire) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-[100] h-full w-full"
      aria-hidden
    />
  );
}
