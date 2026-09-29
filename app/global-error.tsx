"use client";

/**
 * Root crash boundary. Must stay lean: plain html/body, no providers,
 * no app imports that could themselves throw.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          background: "#000",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "1.5rem" }}>
          <p style={{ fontSize: "1.1rem", fontWeight: 800, margin: "0 0 0.5rem" }}>
            The app crashed
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "1rem",
              border: 0,
              borderRadius: 999,
              background: "#e9e5d2",
              color: "#000",
              fontWeight: 800,
              padding: "0.8rem 1.6rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
