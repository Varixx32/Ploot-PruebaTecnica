import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Ploot · Scheduler",
  description: "Demo window into the publishing backend",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
