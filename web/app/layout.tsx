import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") || headerStore.get("host") || "localhost:3000";
  const protocol = headerStore.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = `${protocol}://${host}`;
  return {
    metadataBase: new URL(base),
    title: "陈晓卿美食足迹地图",
    description: "沿着时间与地图，探索有来源、有上下文的陈晓卿公开美食足迹。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "陈晓卿美食足迹地图",
      description: "沿着味道，重走真实旅程",
      type: "website",
      images: [{ url: `${base}/og.png`, width: 1733, height: 909, alt: "陈晓卿美食足迹地图" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "陈晓卿美食足迹地图",
      description: "沿着味道，重走真实旅程",
      images: [`${base}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
