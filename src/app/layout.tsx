import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const title = 'Bramble';
const description = 'your real life. infinitely playable.';

export const metadata: Metadata = {
  // The public site, not NEXT_PUBLIC_APP_URL, which is the API's host. Social
  // crawlers need absolute URLs, and this is what resolves `opengraph-image.png`.
  metadataBase: new URL('https://www.brambleworld.com'),
  title,
  description,
  openGraph: { title, description, siteName: title, type: 'website' },
  twitter: { card: 'summary_large_image', title, description },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-[#FFFFFB]">{children}</body>
    </html>
  );
}
