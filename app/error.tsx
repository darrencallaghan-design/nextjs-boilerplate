"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Engine Agent runtime error:", error);
  }, [error]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#F8F6F2",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Arial, Helvetica, sans-serif",
      padding: "40px 20px",
      textAlign: "center",
    }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
      <h2 style={{ fontSize: 20, fontWeight: 600, color: "#10121A", marginBottom: 8 }}>
        Something went wrong
      </h2>
      <p style={{ color: "#616368", fontSize: 14, marginBottom: 24, maxWidth: 400 }}>
        The app hit an unexpected error. Click below to reload — your data is saved in Supabase.
      </p>
      <button
        onClick={reset}
        style={{
          background: "#FD4B23",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "10px 24px",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
      {error?.message && (
        <p style={{ marginTop: 20, fontSize: 11, color: "#9E9E9E", fontFamily: "monospace" }}>
          {error.message}
        </p>
      )}
    </div>
  );
}
