import type { Metadata } from 'next';
import './globals.css';
import { ToastContainer } from '../components/ui/Toast';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Kairos | High-Performance Spot Cryptocurrency Exchange',
  description:
    'Institutional-grade deterministic spot trading terminal with in-memory matching and real-time order books.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="night" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased selection:bg-accent/30">
        <Providers>
          {children}
          <ToastContainer />
        </Providers>
      </body>
    </html>
  );
}
