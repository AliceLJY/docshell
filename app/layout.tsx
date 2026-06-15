import type { Metadata, Viewport } from 'next';
import './globals.css';

// 标题、描述都做成普通文档的样子（文档式呈现，浏览器标签 / 任务切换里只是一份文档）
export const metadata: Metadata = {
  title: '文档',
  description: '文档',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: '文档',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-180.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
