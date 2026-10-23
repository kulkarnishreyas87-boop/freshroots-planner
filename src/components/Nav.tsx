"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Review" },
  { href: "/status", label: "Status" },
  { href: "/data", label: "Data" },
  { href: "/rules", label: "Rules" },
  { href: "/zoho", label: "Zoho" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? "active" : undefined}>
          <span className="dot" aria-hidden="true" />
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
