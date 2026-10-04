import type { Metadata, Viewport } from "next";
import { Geist, Lexend, Permanent_Marker } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { OfflinePlayerHost } from "@/components/offline-player-host";
import { DownloadDoneNotifier } from "@/components/download-row";
import { AppSplash } from "@/components/app-splash";
import { siteUrl } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

// Pause-card pair (VidStuck's exact fonts): Permanent Marker for the title,
// Lexend for every other line in the card (their overlay wrapper sets it).
// Scoped to the player via .pause-title / .pause-body so nothing else moves.
const pauseTitleFont = Permanent_Marker({
  weight: "400",
  variable: "--font-marker",
  subsets: ["latin"],
});

const pauseBodyFont = Lexend({
  variable: "--font-pause",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Absolute base so OG/twitter images and canonicals resolve in scrapers.
  metadataBase: new URL(siteUrl()),
  applicationName: "LeviOsa",
  title: {
    default: "LeviOsa",
    template: "%s · LeviOsa",
  },
  description: "Personal TV and movie tracker — seasons, episodes, watch history and continue-watching in one place.",
  openGraph: {
    siteName: "LeviOsa",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
  },
  manifest: "/manifest.json?v=14",
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
      data-accent="yellow"
      suppressHydrationWarning
      className={`${geistSans.variable} ${pauseTitleFont.variable} ${pauseBodyFont.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://image.tmdb.org" crossOrigin="" />
        <link rel="dns-prefetch" href="https://image.tmdb.org" />
        <script
          // Apply saved theme before first paint (no FOUC). Defaults to AMOLED.
          // Also toggles .dark (Tailwind dark: variant) and theme-color meta.
          // Light is unlisted (see VISIBLE_THEMES): stored "light" migrates
          // to soft so nobody strands on a theme with no picker entry.
          // Accent (tv-accent) applies the same way; unset defaults to Yellow.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("tv-theme");if(t!=="soft"&&t!=="amoled"){t=t==="light"?"soft":"amoled";try{localStorage.setItem("tv-theme",t)}catch(e){}}var d=document.documentElement;d.dataset.theme=t;if(t!=="light"){d.classList.add("dark")}else{d.classList.remove("dark")}var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"#f4f4f6":t==="soft"?"#101014":"#000000")}catch(e){document.documentElement.dataset.theme="amoled"}try{var a=localStorage.getItem("tv-accent");if(a!=="beige"&&a!=="yellow"){if(a)localStorage.setItem("tv-accent","yellow");a="yellow"}document.documentElement.dataset.accent=a}catch(e){document.documentElement.dataset.accent="yellow"}})()`,
          }}
        />
      </head>
      <body className="min-h-full min-h-dvh bg-background text-foreground">
        <AppSplash />
        <Providers>
          <DownloadDoneNotifier />
          {children}
        </Providers>
        <OfflinePlayerHost />
      </body>
    </html>
  );
}
