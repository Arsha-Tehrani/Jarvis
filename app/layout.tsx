import type { Metadata, Viewport } from "next";
import { Source_Serif_4, Inter, IBM_Plex_Mono } from "next/font/google";
import { RegisterServiceWorker } from "@/components/register-sw";
import "./theme.css";
import "./globals.css";

// Loaded (self-hosted, no <link> tags) and exposed under bridge variable
// names; globals.css layers these onto --font-display/--font-body/--font-data
// ahead of the literal fallback stacks defined in theme.css.
const sourceSerif4 = Source_Serif_4({
  variable: "--ns-display",
  subsets: ["latin"],
  weight: ["600"],
});

const inter = Inter({
  variable: "--ns-body",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--ns-data",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Jarvis",
  description: "Local-first personal command center",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Jarvis",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#7A2E2E",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sourceSerif4.variable} ${inter.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <RegisterServiceWorker />
        {children}
      </body>
    </html>
  );
}
