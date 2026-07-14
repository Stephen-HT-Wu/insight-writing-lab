import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insight Writing Lab｜研究、寫作與獨立編輯",
  description: "從一個念頭出發，經過權威研究、嚴謹寫作與獨立總編審稿，完成可追溯的 Markdown 文章。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
