import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#0e0e0e",
        gap: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div
          style={{
            width: 40,
            height: 40,
            background: "#f5c518",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 18,
            color: "#000",
          }}
        >
          E
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#e8e8e8" }}>
            Engine Agent
          </div>
          <div style={{ fontSize: 10, color: "#666", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Partnership Prospecting AI
          </div>
        </div>
      </div>
      <SignIn />
    </div>
  );
}
