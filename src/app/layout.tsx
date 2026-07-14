import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VaultPoint — Unified Portfolio & Savings',
  description:
    'Track your crypto, forex, and savings goals in one place. Built for traders, by traders.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
