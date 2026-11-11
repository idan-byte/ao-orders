import type { Metadata } from "next";
import { Heebo, Rubik } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const heebo = Heebo({ variable: "--font-heebo", subsets: ["hebrew", "latin"] });
const rubik = Rubik({ variable: "--font-rubik", subsets: ["hebrew", "latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "A&O ניהול הזמנות",
  description: "הצעות מחיר, הזמנות, ייצור ושילוח",
};

const NAV = [
  { href: "/", label: "דשבורד" },
  { href: "/catalog", label: "קטלוג" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${rubik.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-2.5">
            <div className="font-display text-lg font-bold">A&amp;O</div>
            <nav className="flex gap-1" aria-label="מסכים">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded-lg px-3 py-2 text-muted hover:bg-accent-soft hover:text-accent">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
