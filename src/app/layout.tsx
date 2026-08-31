import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TimeSats — Seu Bitcoin. Seu prazo. Suas chaves.",
  description: "Defina hoje o prazo do seu Bitcoin. Suas chaves, seu prazo. Software experimental para Signet e Regtest.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
