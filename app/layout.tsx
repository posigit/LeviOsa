import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { OfflinePlayerHost } from "@/components/offline-player-host";
import { DownloadDoneNotifier } from "@/components/download-row";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LeviOsa",
  description: "Personal TV and movie tracker",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "LeviOsa",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  // Pinch zoom allowed (a11y); double-tap zoom is already suppressed where
  // it matters by touch-manipulation on the player, so seek taps are safe.
  maximumScale: 5,
  userScalable: true,
  // Edge-to-edge under notch / home indicator (standalone PWA)
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
      data-theme="amoled"
      suppressHydrationWarning
      className={`${geistSans.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://image.tmdb.org" crossOrigin="" />
        <link rel="dns-prefetch" href="https://image.tmdb.org" />
        <script
          // Apply saved theme before first paint (no FOUC). Defaults to AMOLED.
          // Also toggles .dark (Tailwind dark: variant) and theme-color meta.
          // Light is unlisted (see VISIBLE_THEMES): stored "light" migrates
          // to soft so nobody strands on a theme with no picker entry.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("tv-theme");if(t!=="soft"&&t!=="amoled"){t=t==="light"?"soft":"amoled";try{localStorage.setItem("tv-theme",t)}catch(e){}}var d=document.documentElement;d.dataset.theme=t;if(t!=="light"){d.classList.add("dark")}else{d.classList.remove("dark")}var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"#f4f4f6":t==="soft"?"#101014":"#000000")}catch(e){document.documentElement.dataset.theme="amoled"}})()`,
          }}
        />
      </head>
      <body className="min-h-full min-h-dvh bg-background text-foreground">
        <Providers>
          <DownloadDoneNotifier />
          {children}
        </Providers>
        <OfflinePlayerHost />
      </body>
    </html>
  );
}
