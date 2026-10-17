import type { ReactNode } from "react";

export const metadata = {
  title: "Ploot · Scheduler",
  description: "Demo window into the publishing backend",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 1100, padding: 16 }}>
        {children}
      </body>
    </html>
  );
}
