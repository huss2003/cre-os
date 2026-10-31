import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CRE OS", template: "%s · CRE OS" },
  description: "Evidence-linked operating workbench for commercial real estate advisers",
  manifest: "/manifest.webmanifest",
};
export const viewport: Viewport = { themeColor: "#13303b", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
