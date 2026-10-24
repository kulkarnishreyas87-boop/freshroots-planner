/**
 * Photos from Unsplash (free under the Unsplash License). Every id was checked to load
 * and looked at to confirm it shows the product or scene named here. Alt text describes
 * what the photo actually shows. Credits link to the photo pages.
 */

export interface Photo {
  id: string;
  alt: string;
  by: string;
  page: string;
}

export function photoUrl(p: Photo, w: number, h?: number): string {
  return `https://images.unsplash.com/${p.id}?w=${w}${h ? `&h=${h}&fit=crop` : ""}&q=72&auto=format`;
}

const u = (id: string, alt: string, by: string, page: string): Photo => ({ id: `photo-${id}`, alt, by, page });

/** Page headers, each matched to the page's job. */
export const PHOTOS = {
  warehouse: u("1644079446600-219068676743", "Long warehouse aisle with stocked shelves", "Lance Chang", "https://unsplash.com/photos/a-large-warehouse-filled-with-lots-of-shelves-h3pVxOIpnzk"),
  kirana: u("1739066598279-1297113f5c6a", "An Indian neighbourhood store front stocked with packaged goods", "Zoshua Colah", "https://unsplash.com/photos/a-store-front-with-many-items-on-display-bAKYjjvAQIE"),
  boxes: u("1736507748808-31bb64ce6fcc", "Stack of flat cardboard boxes on a shelf", "Ant Rozetsky", "https://unsplash.com/photos/a-stack-of-boxes-sitting-on-top-of-a-shelf-vR_HioCRfa4"),
  notebook: u("1513128034602-7814ccaddd4e", "Hand writing a plan in a spiral notebook", "Marissa Grootes", "https://unsplash.com/photos/flRm0z3MEoA"),
  sprouts: u("1457530378978-8bac673b8062", "Young green seedlings growing in soil", "Francesco Gallarotti", "https://unsplash.com/photos/ruQHpukrN7c"),
  truck: u("1681004478577-cb7f8421f78c", "Painted Indian goods truck on a rural road", "Gowtham AGM", "https://unsplash.com/photos/a-colorful-truck-driving-down-a-rural-road-82rfXKNSNOY"),
} satisfies Record<string, Photo>;

/** One photo per product, matched on words in the product name. */
const PRODUCT: { match: RegExp; photo: Photo }[] = [
  { match: /mango/i, photo: u("1546173159-315724a31696", "Glass of mango juice with mango slices", "Sam Hojati", "https://unsplash.com/photos/mango-and-lemon-juice-lw8GflbJwLc") },
  { match: /cookie/i, photo: u("1631311253861-52eaf0337adb", "Stack of oatmeal cookies on a plate", "Caroline Green", "https://unsplash.com/photos/Ir1EmjxRua4") },
  { match: /brown rice/i, photo: u("1646980720696-5520b992c129", "Close-up of red-brown rice grains", "Inkiipow", "https://unsplash.com/photos/0fSCGXRTQv8") },
  { match: /almond milk/i, photo: u("1786246124894-b47100b52af2", "Glass bottle and small jar of almond milk", "Anna Jackowska", "https://unsplash.com/photos/glass-bottle-of-almond-milk-with-almonds-FhzlqJ-Pwv8") },
  { match: /nuts/i, photo: u("1769255484233-94ece98f722d", "Bowls of almonds, cashews, pistachios and walnuts", "Naveena V", "https://unsplash.com/photos/four-bowls-of-assorted-nuts-on-a-dark-surface-rapNRod3W1s") },
  { match: /quinoa/i, photo: u("1722882270502-4758cbd78661", "Close-up of tri-colour quinoa seeds", "Xhiliana", "https://unsplash.com/photos/a-close-up-of-a-bunch-of-seeds-GTbI2tFP96A") },
  { match: /coconut/i, photo: u("1778090970328-3908def01b6e", "Hand holding a fresh green coconut with a straw", "Marcreation", "https://unsplash.com/photos/hand-holding-a-fresh-coconut-drink-on-a-tropical-beach-GVm0S_Ej87s") },
  { match: /granola/i, photo: u("1633360821154-1935fb5671e6", "A granola bar with dried berries", "Towfiqu barbhuiya", "https://unsplash.com/photos/a-bar-of-granola-sitting-on-top-of-a-table-Y-VDI9vQS3M") },
  { match: /chia/i, photo: u("1604768802835-899055f0e245", "Chia seeds spilling from a glass jar", "Brigitta Baranyi", "https://unsplash.com/photos/black-beads-in-clear-glass-jar-TZOYfErRQEE") },
  { match: /vinegar/i, photo: u("1628268909461-ec1eec52a74e", "Glass bottle of apple cider vinegar beside apples", "Towfiqu barbhuiya", "https://unsplash.com/photos/clear-glass-bottle-with-red-liquid-beside-sliced-lemon-on-blue-textile-qxApfY4fGG4") },
  { match: /bread/i, photo: u("1549931319-a545dcf3bc73", "Sliced seeded multigrain loaf", "Jude Infantini", "https://unsplash.com/photos/rYOqbTcGp1c") },
  { match: /tea/i, photo: u("1558160074-4d7d8bdf4256", "Glass cup of tea beside a clay teapot", "Manki Kim", "https://unsplash.com/photos/clear-glass-cup-with-tea-near-brown-ceramic-teapot-L82-kkEBOd0") },
  { match: /peanut/i, photo: u("1691480208637-6ed63aac6694", "Jar of peanut butter with a plain label", "personalgraphic.com", "https://unsplash.com/photos/a-jar-of-peanut-butter-with-a-white-label-RUqCyjDQZ-A") },
  { match: /chocolate/i, photo: u("1575377427642-087cf684f29d", "Broken dark chocolate bars", "Tetiana Bykovets", "https://unsplash.com/photos/chocolate-bars-YemxYB75xvI") },
  { match: /honey/i, photo: u("1587049352851-8d4e89133924", "Jar of honey with a dipper", "Art Rachen", "https://unsplash.com/photos/clear-glass-jar-with-brown-liquid-Asj5DFw8UAw") },
];

const CATEGORY_COLOR: Record<string, string> = {
  Beverage: "var(--cat-beverage)",
  Snack: "var(--cat-snack)",
  Staple: "var(--cat-staple)",
  "Dairy Alt": "var(--cat-dairy)",
  Condiment: "var(--cat-condiment)",
};

export interface ProductLook {
  photo: Photo;
  color: string;
  label: string;
}

/** The product's own photo (by name), its category colour and label. Unknown products get a neutral photo. */
export function productLook(name: string, category: string | null | undefined): ProductLook {
  const hit = PRODUCT.find((p) => p.match.test(name));
  return { photo: hit?.photo ?? PHOTOS.boxes, color: CATEGORY_COLOR[category ?? ""] ?? "var(--muted)", label: category ?? "Other" };
}
