/**
 * Photos from Unsplash (free under the Unsplash License). Each id was checked to load
 * and to show the subject described; credits link to the photo page.
 */

export interface Photo {
  id: string;
  alt: string;
  by: string;
  page: string;
}

export function photoUrl(p: Photo, w: number, h?: number): string {
  return `https://images.unsplash.com/${p.id}?w=${w}${h ? `&h=${h}&fit=crop` : ""}&q=70&auto=format`;
}

export const PHOTOS = {
  warehouse: { id: "photo-1644079446600-219068676743", alt: "Long warehouse aisle with stocked shelves", by: "Lance Chang", page: "https://unsplash.com/photos/a-large-warehouse-filled-with-lots-of-shelves-h3pVxOIpnzk" },
  shelves: { id: "photo-1694885156873-6a0823e14848", alt: "Row of shelves in a warehouse", by: "Brian Wangenheim", page: "https://unsplash.com/photos/a-long-row-of-shelves-in-a-warehouse-1Elnip2SeM8" },
  boxes: { id: "photo-1736507748808-31bb64ce6fcc", alt: "Stack of flat cardboard boxes on a shelf", by: "Ant Rozetsky", page: "https://unsplash.com/photos/a-stack-of-boxes-sitting-on-top-of-a-shelf-vR_HioCRfa4" },
  truck: { id: "photo-1681004478577-cb7f8421f78c", alt: "Painted Indian goods truck on a rural road", by: "Gowtham AGM", page: "https://unsplash.com/photos/a-colorful-truck-driving-down-a-rural-road-82rfXKNSNOY" },
  field: { id: "photo-1728895604559-a4e16081504e", alt: "Golden rice stalks in a green field", by: "Declan Sun", page: "https://unsplash.com/photos/golden-rice-stalks-in-green-field-wnIeCBJfUYM" },
} satisfies Record<string, Photo>;

export interface CategoryLook {
  photo: Photo;
  color: string; // CSS variable name holding the category colour
  label: string;
}

const CATEGORY: Record<string, CategoryLook> = {
  Beverage: { label: "Beverage", color: "var(--cat-beverage)", photo: { id: "photo-1546173159-315724a31696", alt: "Glass of mango juice with mango slices", by: "Sam Hojati", page: "https://unsplash.com/photos/mango-and-lemon-juice-lw8GflbJwLc" } },
  Snack: { label: "Snack", color: "var(--cat-snack)", photo: { id: "photo-1631311253861-52eaf0337adb", alt: "Stack of oatmeal cookies on a plate", by: "Caroline Green", page: "https://unsplash.com/photos/Ir1EmjxRua4" } },
  Staple: { label: "Staple", color: "var(--cat-staple)", photo: { id: "photo-1586201375761-83865001e31c", alt: "Raw white rice grains", by: "Pierre Bamin", page: "https://unsplash.com/photos/raw-white-rice-grains-background--LdilhDx3sk" } },
  "Dairy Alt": { label: "Dairy alt", color: "var(--cat-dairy)", photo: { id: "photo-1601436423474-51738541c1b1", alt: "Milk in a clear glass bottle", by: "Sandi Benedicta", page: "https://unsplash.com/photos/white-milk-in-clear-glass-bottle-8Pp9M13xuzs" } },
  Condiment: { label: "Condiment", color: "var(--cat-condiment)", photo: { id: "photo-1587049352851-8d4e89133924", alt: "Jar of honey with a dipper", by: "Art Rachen", page: "https://unsplash.com/photos/clear-glass-jar-with-brown-liquid-Asj5DFw8UAw" } },
};

export function categoryLook(category: string | null | undefined): CategoryLook {
  return CATEGORY[category ?? ""] ?? { label: category ?? "Other", color: "var(--muted)", photo: PHOTOS.boxes };
}
