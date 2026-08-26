import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { resolveStyle, STYLE_COOKIE } from "@/lib/style";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Travola Console",
  description: "Travola Console — plan, analyse and administer your restaurant.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The visual treatment is a cookie so it can be compared on real data
  // rather than chosen from a mockup. See lib/style.ts.
  const style = resolveStyle((await cookies()).get(STYLE_COOKIE)?.value);
  return (
    <html
      lang="en"
      data-style={style}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
