// src/app/layout.tsx

import type { Metadata } from "next";
// The line below that imports 'Inter' or 'Geist_Sans' is often the cause.
// We are removing it for simplicity to fix the build error.
// import { Inter } from "next/font/google"; 
import "./globals.css";

// const inter = Inter({ subsets: ["latin"] }); // Remove this line

export const metadata: Metadata = {
  title: "Menu Extractor",
  description: "Extract a restaurant menu from a URL",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* 
        Remove the className from the body tag.
        BEFORE: <body className={inter.className}>
        AFTER: <body>
      */}
      <body>{children}</body>
    </html>
  );
}