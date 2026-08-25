import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TimeSats — Seu Bitcoin. Seu prazo. Suas chaves.",
  description: "Experimental Bitcoin timelock policy builder for Signet and Regtest.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
