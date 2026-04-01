import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Engine Agent",
  description: "Partnership Prospecting AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
