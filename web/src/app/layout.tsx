import type { Metadata } from "next";
import { Heebo, Rubik } from "next/font/google";
import { Suspense } from "react";
import { UserNav } from "@/components/user-nav";
import "./globals.css";

const heebo = Heebo({ variable: "--font-heebo", subsets: ["hebrew", "latin"] });
const rubik = Rubik({ variable: "--font-rubik", subsets: ["hebrew", "latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "A&O ניהול הזמנות",
  description: "הצעות מחיר, הזמנות, ייצור ושילוח",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${rubik.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-2.5">
            <div className="font-display text-lg font-bold">A&amp;O</div>
            {/* The navigation depends on who is signed in, so it streams in after the static header. */}
            <Suspense fallback={null}>
              <UserNav />
            </Suspense>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
