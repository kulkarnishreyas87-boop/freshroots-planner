import type { Metadata } from "next";
import { Archivo, Source_Sans_3, JetBrains_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { KillSwitchBanner } from "@/components/KillSwitchBanner";
import "./globals.css";

const display = Archivo({ variable: "--font-display", subsets: ["latin"], weight: ["600", "700", "800"] });
const body = Source_Sans_3({ variable: "--font-body", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Freshroots Demand Planner",
  description: "Raghav's forecast rules, decided by Gemini twice a week, approved by Raghav.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <aside className="side">
            <div className="brand">
              <b>Freshroots</b>
              <span>Demand Planner</span>
            </div>
            <Nav />
            <div className="side-foot">Runs Mon and Thu, 7am IST. Gemini decides, Raghav approves, procurement places the PO in Zoho.</div>
          </aside>
          <main className="main">
            <KillSwitchBanner />
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
