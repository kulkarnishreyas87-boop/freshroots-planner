import type { ReactNode } from "react";
import { photoUrl, type Photo } from "@/lib/photos";

export function PageHero({ photo, eyebrow, title, children, actions }: { photo: Photo; eyebrow: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="hero">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl(photo, 1600, 520)} alt={photo.alt} />
      <div className="hero-body">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children}
        {actions && <div className="row">{actions}</div>}
      </div>
      <span className="credit">Photo: <a href={photo.page} target="_blank" rel="noreferrer">{photo.by}</a> on Unsplash</span>
    </section>
  );
}
