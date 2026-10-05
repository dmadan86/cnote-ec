/**
 * Dev seed: dummy categories, ~44 fictional Indian seller businesses and ~150 published listings.
 *
 *   pnpm db:seed                 idempotent upsert (safe to re-run; keys are stable ids / slugs / GSTINs)
 *   pnpm db:seed -- --reset      delete all seeded sellers + their listings, then seed again
 *   pnpm db:seed -- --clean      delete seeded sellers + listings and stop
 *   pnpm db:seed -- --vertical=<key> [--only]
 *                                load a vertical playbook (categories + candidate vertical, ADR-011/016); never
 *                                automatic. With --only the dummy data is skipped. Keys: see listPlaybooks().
 *
 * Seeded rows are identifiable by their owner Person: email `*@example.com` (sellerN@, seller-demo@,
 * buyer-demo@). Categories are kept on reset (real data may reference them). Real catalogue data will
 * replace all of this, so nothing in the product may depend on specific seed rows.
 *
 * All business names, GSTINs and people are fictional. GSTINs are format- and checksum-valid but not real.
 */
import * as ai from "@cnote/ai";
import * as billing from "@cnote/billing";
import * as catalogue from "@cnote/catalogue";
import { prisma, toVectorLiteral, withPurge } from "@cnote/db";
import * as identity from "@cnote/identity";
import { listPlaybooks, loadPlaybook } from "@cnote/verticals";
import { createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const RESET = process.argv.includes("--reset");
const CLEAN = process.argv.includes("--clean");
const VERTICAL = process.argv.find((a) => a.startsWith("--vertical="))?.slice("--vertical=".length);
const ONLY = process.argv.includes("--only");

/* ------------------------------------------------------------------ helpers */

/** Deterministic UUID (v5-style) from a name so re-runs upsert the same rows. */
function stableId(name: string): string {
  const h = createHash("sha1").update(`cnote-seed:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** GSTIN check character (mod-36 weighted sum over the first 14 characters). */
function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36]!;
}
function makeGstin(stateCode: string, r: () => number): string {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const pick = (s: string) => s[Math.floor(r() * s.length)]!;
  const pan = `${pick(L)}${pick(L)}${pick(L)}${pick("CFHP")}${pick(L)}${Math.floor(1000 + r() * 9000)}${pick(L)}`;
  const first14 = `${stateCode}${pan}${1 + Math.floor(r() * 9)}Z`;
  return first14 + gstinCheckChar(first14);
}

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
/** Same format as @cnote/identity: scrypt$N$r$p$salt(b64)$hash(b64). Uses identity's hasher when exported. */
async function hashPassword(password: string): Promise<string> {
  const exported = (identity as Record<string, unknown>).hashPassword;
  if (typeof exported === "function") return (exported as (p: string) => Promise<string>)(password);
  const N = 16384, R = 8, P = 1;
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N, r: R, p: P, maxmem: 256 * N * R });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/* --------------------------------------------------------------- categories */

type Field = { key: string; label: string; type: "text" | "number" | "select"; required?: boolean; unit?: string; options?: string[] };
interface Cat { key: string; slug: string; name: string; icon: string; fields: Field[]; prohibited?: boolean }

const CATS: Cat[] = [
  { key: "pkg", slug: "packaging-printing", name: "Packaging & Printing", icon: "package", fields: [
    { key: "material", label: "Material", type: "select", required: true, options: ["Corrugated", "Kraft paper", "Duplex board", "Poly / plastic", "Glass", "HDPE"] },
    { key: "ply", label: "Ply", type: "number" },
    { key: "dimensions", label: "Dimensions", type: "text" },
    { key: "gsm", label: "GSM", type: "number" },
    { key: "printing", label: "Printing", type: "select", options: ["Plain", "1 colour", "Multi-colour", "Offset"] },
  ] },
  { key: "app", slug: "apparel-textiles", name: "Apparel & Textiles", icon: "shirt", fields: [
    { key: "fabric", label: "Fabric", type: "text", required: true },
    { key: "gsm", label: "GSM", type: "number" },
    { key: "size_range", label: "Size range", type: "text" },
    { key: "color", label: "Colour", type: "text" },
    { key: "width", label: "Width", type: "text" },
  ] },
  { key: "off", slug: "office-stationery", name: "Office & Stationery", icon: "pencil-ruler", fields: [
    { key: "material", label: "Material", type: "text" },
    { key: "pack_size", label: "Pack size", type: "text" },
    { key: "color", label: "Colour", type: "text" },
  ] },
  { key: "home", slug: "home-kitchen", name: "Home & Kitchen", icon: "cooking-pot", fields: [
    { key: "material", label: "Material", type: "text", required: true },
    { key: "capacity", label: "Capacity", type: "text" },
    { key: "finish", label: "Finish", type: "text" },
    { key: "color", label: "Colour", type: "text" },
  ] },
  { key: "ele", slug: "electronics-accessories", name: "Electronics & Accessories", icon: "headphones", fields: [
    { key: "power", label: "Power / voltage", type: "text" },
    { key: "connectivity", label: "Connectivity", type: "text" },
    { key: "warranty_months", label: "Warranty", type: "number", unit: "months" },
    { key: "bis_certified", label: "BIS certified", type: "select", options: ["Yes", "No"] },
  ] },
  { key: "gift", slug: "gifts-promotions", name: "Gifts & Promotions", icon: "gift", fields: [
    { key: "material", label: "Material", type: "text" },
    { key: "customisation", label: "Customisation", type: "select", options: ["Logo print", "Engraving", "Embroidery", "None"] },
    { key: "pack_contents", label: "Pack contents", type: "text" },
    { key: "occasion", label: "Occasion", type: "text" },
  ] },
  { key: "fur", slug: "furniture-fixtures", name: "Furniture & Fixtures", icon: "armchair", fields: [
    { key: "material", label: "Material", type: "text", required: true },
    { key: "dimensions", label: "Dimensions", type: "text" },
    { key: "finish", label: "Finish", type: "text" },
    { key: "warranty_years", label: "Warranty", type: "number", unit: "years" },
  ] },
  { key: "health", slug: "health-personal-care", name: "Health & Personal Care", icon: "heart-pulse", fields: [
    { key: "form", label: "Form", type: "text" },
    { key: "volume", label: "Volume / count", type: "text" },
    { key: "shelf_life_months", label: "Shelf life", type: "number", unit: "months" },
    { key: "certification", label: "Certification", type: "text" },
  ] },
  { key: "ind", slug: "industrial-raw-materials", name: "Industrial & Raw Materials", icon: "factory", fields: [
    { key: "material", label: "Material", type: "text", required: true },
    { key: "grade", label: "Grade", type: "text" },
    { key: "size", label: "Size / thickness", type: "text" },
    { key: "standard", label: "Standard", type: "text" },
  ] },
  { key: "agri", slug: "agriculture-food-products", name: "Agriculture & Food Products", icon: "wheat", fields: [
    { key: "variety", label: "Variety", type: "text", required: true },
    { key: "origin", label: "Origin", type: "text" },
    { key: "packaging", label: "Packaging", type: "text" },
    { key: "shelf_life_months", label: "Shelf life", type: "number", unit: "months" },
    { key: "fssai", label: "FSSAI licensed", type: "select", options: ["Yes", "No"] },
  ] },
  { key: "bld", slug: "building-construction", name: "Building & Construction", icon: "building-2", fields: [
    { key: "material", label: "Material", type: "text", required: true },
    { key: "grade", label: "Grade", type: "text" },
    { key: "size", label: "Size", type: "text" },
    { key: "standard", label: "Standard", type: "text" },
  ] },
  { key: "mro", slug: "industrial-mro-safety", name: "Industrial MRO & Safety", icon: "hard-hat", fields: [
    { key: "material", label: "Material", type: "text" },
    { key: "standard", label: "Standard", type: "text" },
    { key: "size", label: "Size", type: "text" },
    { key: "color", label: "Colour", type: "text" },
  ] },
];
const PROHIBITED: Cat[] = [
  { key: "x1", slug: "pharmaceuticals-restricted", name: "Pharmaceuticals (restricted)", icon: "pill", fields: [], prohibited: true },
  { key: "x2", slug: "explosives-fireworks-restricted", name: "Explosives & Fireworks (restricted)", icon: "flame", fields: [], prohibited: true },
];

/* ------------------------------------------------------------------ sellers */

interface City { name: string; state: string; code: string; pincode: string }
const CITY: Record<string, City> = {
  mum: { name: "Mumbai", state: "Maharashtra", code: "27", pincode: "400069" },
  tir: { name: "Tiruppur", state: "Tamil Nadu", code: "33", pincode: "641604" },
  mor: { name: "Moradabad", state: "Uttar Pradesh", code: "09", pincode: "244001" },
  lud: { name: "Ludhiana", state: "Punjab", code: "03", pincode: "141003" },
  sur: { name: "Surat", state: "Gujarat", code: "24", pincode: "395002" },
  raj: { name: "Rajkot", state: "Gujarat", code: "24", pincode: "360001" },
  blr: { name: "Bengaluru", state: "Karnataka", code: "29", pincode: "560058" },
  del: { name: "Delhi", state: "Delhi", code: "07", pincode: "110020" },
  noi: { name: "Noida", state: "Uttar Pradesh", code: "09", pincode: "201301" },
  ggn: { name: "Gurugram", state: "Haryana", code: "06", pincode: "122001" },
  amd: { name: "Ahmedabad", state: "Gujarat", code: "24", pincode: "380015" },
  cbe: { name: "Coimbatore", state: "Tamil Nadu", code: "33", pincode: "641014" },
  kol: { name: "Kolkata", state: "West Bengal", code: "19", pincode: "700091" },
  jai: { name: "Jaipur", state: "Rajasthan", code: "08", pincode: "302003" },
  pun: { name: "Pune", state: "Maharashtra", code: "27", pincode: "411001" },
};

// [business name, city, category keys sold]
const SELLERS: [string, string, string[]][] = [
  ["Demo Packaging Works", "mum", ["pkg", "gift"]], // demo seller login
  ["Shree Laxmi Packaging Industries", "mum", ["pkg"]],
  ["Bombay Print & Pack Solutions LLP", "mum", ["pkg", "gift"]],
  ["Andheri Stationers & Traders", "mum", ["off"]],
  ["Vashi Polymers Pvt Ltd", "mum", ["pkg", "ind"]],
  ["Dharavi Leather Craft Exports", "mum", ["app", "gift"]],
  ["Kaveri Knitwear", "tir", ["app"]],
  ["Noyyal Textiles Pvt Ltd", "tir", ["app"]],
  ["Sri Murugan Garments", "tir", ["app"]],
  ["Tirumala Hosiery Mills", "tir", ["app", "home"]],
  ["Moradabad Metal Crafts", "mor", ["gift", "home"]],
  ["Ganga Jamuna Handicrafts", "mor", ["gift", "home"]],
  ["Rampur Steelware Works", "mor", ["home", "gift"]],
  ["Punjab Fasteners & Tools", "lud", ["ind", "mro", "bld"]],
  ["Sutlej Knit Fab", "lud", ["app"]],
  ["Doaba Industrial Supplies", "lud", ["ind", "mro"]],
  ["Bharat Safety Gear Co.", "lud", ["mro"]],
  ["Tapi Textile Mills", "sur", ["app"]],
  ["Diamond City Fabrics", "sur", ["app"]],
  ["Varachha Silk Traders", "sur", ["app"]],
  ["Surat Weave Co.", "sur", ["app", "home"]],
  ["Saurashtra Engineering Works", "raj", ["ind", "mro"]],
  ["Rajkot Pump & Valve Co.", "raj", ["ind", "mro"]],
  ["Gondal Castings Pvt Ltd", "raj", ["ind", "bld"]],
  ["Peenya Precision Components", "blr", ["ind", "ele"]],
  ["Whitefield Electronics Trading", "blr", ["ele"]],
  ["Karnataka Office Solutions", "blr", ["off", "fur"]],
  ["Namma Organics", "blr", ["agri", "health"]],
  ["Okhla Industrial Traders", "del", ["ind", "mro"]],
  ["Noida Furniture Works", "noi", ["fur", "off"]],
  ["Gurugram Corporate Gifting Co.", "ggn", ["gift", "ele"]],
  ["Narela Packaging Works", "del", ["pkg"]],
  ["Sadar Bazaar Stationery House", "del", ["off"]],
  ["Sabarmati Packaging Co.", "amd", ["pkg"]],
  ["Naroda Chemicals & Paints", "amd", ["bld", "ind"]],
  ["Gujarat Agro Foods", "amd", ["agri"]],
  ["Kovai Pumpsets Pvt Ltd", "cbe", ["ind", "ele"]],
  ["Peelamedu Textiles", "cbe", ["app", "home"]],
  ["Coimbatore Wet Grinder Works", "cbe", ["home", "ele"]],
  ["Howrah Steel Traders", "kol", ["ind", "bld"]],
  ["Bengal Jute & Paper Mills", "kol", ["pkg", "agri"]],
  ["Salt Lake Health Essentials", "kol", ["health"]],
  ["Pink City Handicrafts", "jai", ["gift", "home"]],
  ["Jaipur Block Print House", "jai", ["app", "home"]],
  ["Amer Stone & Tiles", "jai", ["bld"]],
];

const OWNERS = [
  "Rajesh Mehta", "Sunita Iyer", "Amit Khanna", "Priya Nair", "Vikram Singh", "Farhan Qureshi", "Anjali Deshmukh", "Karthik Subramanian",
  "Harpreet Kaur", "Manoj Patel", "Neha Agarwal", "Suresh Reddy", "Deepa Banerjee", "Imran Ansari", "Lakshmi Venkatesh", "Rohit Sharma",
  "Meena Joshi", "Gurpreet Sandhu", "Bhavesh Shah", "Pooja Choudhary",
];

/* ----------------------------------------------------------------- products */

interface Tpl {
  cat: string; titles: string; type: string; price: number; unit: string; moq: number; moqUnit: string; hsn: string;
  attrs: Record<string, string | number>; desc: string;
}
const T = (cat: string, titles: string, type: string, price: number, unit: string, moq: number, moqUnit: string, hsn: string, attrs: Tpl["attrs"], desc: string): Tpl =>
  ({ cat, titles, type, price, unit, moq, moqUnit, hsn, attrs, desc });

const TEMPLATES: Tpl[] = [
  // Packaging & Printing
  T("pkg", "Custom Packaging Boxes|Printed Corrugated Boxes", "box", 5.2, "piece", 500, "pcs", "4819", { material: "Corrugated", ply: 3, dimensions: "12 x 9 x 6 in", gsm: 150, printing: "Multi-colour" }, "3-ply corrugated boxes, custom size and brand print, suitable for e-commerce and retail shipping"),
  T("pkg", "Paper Shopping Bags|Kraft Paper Carry Bags", "paperbag", 3.5, "piece", 1000, "pcs", "4819", { material: "Kraft paper", gsm: 120, dimensions: "10 x 4 x 12 in", printing: "1 colour" }, "Twisted-handle kraft paper bags for retail, boutiques and events"),
  T("pkg", "Poly Mailer Bags|Courier Bags with Tamper Seal", "mailer", 2.8, "piece", 1000, "pcs", "3923", { material: "Poly / plastic", dimensions: "10 x 14 in", gsm: 60, printing: "Plain" }, "Tamper-proof self-seal courier bags, waterproof and lightweight"),
  T("pkg", "BOPP Packaging Tape 48mm|Brown Carton Sealing Tape", "tape", 38, "roll", 72, "rolls", "3919", { material: "Poly / plastic", dimensions: "48 mm x 65 m", printing: "Plain" }, "Strong-adhesive BOPP tape for carton sealing, 6 rolls per pack"),
  T("pkg", "Glass Jars with Lids|Airtight Glass Storage Jars", "jar", 18, "piece", 500, "pcs", "7010", { material: "Glass", dimensions: "500 ml", printing: "Plain" }, "Food-grade glass jars with metal lids for pickles, spices and honey"),
  T("pkg", "HDPE Plastic Pallets|Heavy Duty Pallets", "pallet", 950, "piece", 20, "pcs", "3923", { material: "HDPE", dimensions: "1200 x 1000 mm", printing: "Plain" }, "Reusable four-way entry pallets, 1 tonne dynamic load"),
  // Apparel & Textiles
  T("app", "Plain Cotton T-Shirts|Round Neck Cotton T-Shirts", "tshirt", 120, "piece", 50, "pcs", "6109", { fabric: "100% combed cotton", gsm: 180, size_range: "S-XXL", color: "Assorted" }, "Bio-washed round neck tees, ideal for printing, uniforms and promotions"),
  T("app", "Polo T-Shirts with Collar|Corporate Polo T-Shirts", "polo", 210, "piece", 50, "pcs", "6105", { fabric: "Cotton pique", gsm: 220, size_range: "S-XXL", color: "Assorted" }, "Pique polo tees with embroidery-friendly finish for corporate uniforms"),
  T("app", "Cotton Fabric|Poplin Cotton Fabric", "fabric", 85, "meter", 200, "meters", "5208", { fabric: "Cotton poplin", gsm: 110, width: "44 in", color: "Assorted" }, "Dyed cotton fabric on rolls for shirting and garment manufacturing"),
  T("app", "Denim Fabric 10 oz|Stretch Denim Fabric", "fabric", 165, "meter", 300, "meters", "5209", { fabric: "Cotton denim", gsm: 340, width: "58 in", color: "Indigo" }, "Mill-direct denim for jeans and jackets"),
  T("app", "Cotton Bath Towels|Terry Cotton Towels", "towel", 145, "piece", 100, "pcs", "6302", { fabric: "Terry cotton", gsm: 400, size_range: "27 x 54 in", color: "Assorted" }, "Absorbent terry towels for hotels, spas and gifting"),
  T("app", "Corporate Uniform Shirts|Formal Uniform Shirts", "polo", 380, "piece", 30, "pcs", "6205", { fabric: "Poly-cotton", gsm: 130, size_range: "S-XXXL", color: "Custom" }, "Stitched to size and colour with your logo embroidery"),
  T("app", "Fleece Hoodies|Printed Hooded Sweatshirts", "tshirt", 420, "piece", 30, "pcs", "6110", { fabric: "Cotton fleece", gsm: 320, size_range: "S-XXL", color: "Assorted" }, "Brushed fleece hoodies for winter merchandise and uniforms"),
  T("app", "Hand Block Printed Fabric|Jaipuri Print Cotton", "fabric", 110, "meter", 100, "meters", "5407", { fabric: "Cotton voile", gsm: 90, width: "42 in", color: "Multi" }, "Traditional hand block prints with natural dyes"),
  // Office & Stationery
  T("off", "Spiral Notebooks A5|Ruled Spiral Notebooks", "notebook", 42, "piece", 200, "pcs", "4820", { material: "Paper 70 GSM", pack_size: "160 pages", color: "Assorted" }, "Wiro-bound ruled notebooks with custom cover printing"),
  T("off", "Ball Pens Pack|Blue Ball Point Pens", "pen", 4.5, "piece", 1000, "pcs", "9608", { material: "Plastic", pack_size: "Box of 50", color: "Blue" }, "Smooth 0.7 mm ball pens, branding on barrel available"),
  T("off", "A4 Copier Paper 75 GSM|Multipurpose A4 Paper", "notebook", 235, "ream", 50, "reams", "4802", { material: "Paper 75 GSM", pack_size: "500 sheets", color: "White" }, "Bright white paper for laser and inkjet printers"),
  T("off", "Box File Folders|Lever Arch Files", "notebook", 24, "piece", 500, "pcs", "4820", { material: "Board", pack_size: "Foolscap", color: "Assorted" }, "Sturdy office files with metal fittings"),
  T("off", "Whiteboard Markers|Dry Erase Markers", "pen", 12, "piece", 500, "pcs", "9608", { material: "Plastic", pack_size: "Box of 10", color: "Assorted" }, "Low-odour dry-erase markers, easy wipe"),
  T("off", "Metal Desk Organisers|Mesh Desk Organizer", "box", 180, "piece", 100, "pcs", "9403", { material: "Steel mesh", color: "Black" }, "Multi-compartment desk organisers for pens, cards and notes"),
  // Home & Kitchen
  T("home", "Stainless Steel Bottles|Insulated Steel Water Bottles", "bottle", 299, "piece", 100, "pcs", "7323", { material: "Stainless steel 304", capacity: "750 ml", finish: "Matte", color: "Assorted" }, "Double-wall vacuum bottles, keep water cold for 24 hours"),
  T("home", "Ceramic Coffee Mugs|White Ceramic Mugs", "mug", 95, "piece", 200, "pcs", "6912", { material: "Ceramic", capacity: "325 ml", finish: "Glossy", color: "White" }, "Sublimation-ready mugs, dishwasher safe"),
  T("home", "Stainless Steel Cookware Set|Triply Cookware Set", "cookware", 1450, "set", 20, "sets", "7323", { material: "Stainless steel 304", capacity: "5 pcs", finish: "Mirror", color: "Steel" }, "Induction-compatible cookware set with glass lids"),
  T("home", "Non-Stick Kadhai|Aluminium Non-stick Kadai", "cookware", 380, "piece", 50, "pcs", "7615", { material: "Aluminium", capacity: "3 L", finish: "Non-stick", color: "Black" }, "Heavy-gauge kadai with cool-touch handles"),
  T("home", "Cotton Bedsheets Double|Printed Double Bedsheets", "towel", 420, "piece", 50, "pcs", "6302", { material: "Cotton 144 TC", capacity: "Double bed", finish: "Printed", color: "Assorted" }, "Bedsheet with two pillow covers, colour-fast prints"),
  T("home", "Steel Lunch Boxes|3-Tier Tiffin Boxes", "bottle", 260, "piece", 100, "pcs", "7323", { material: "Stainless steel", capacity: "3 containers", finish: "Mirror", color: "Steel" }, "Leak-proof tiffin with carry clip"),
  // Electronics & Accessories
  T("ele", "Bluetooth Earphones|Wireless Neckband Earphones", "headphones", 349, "piece", 100, "pcs", "8518", { power: "5V", connectivity: "Bluetooth 5.3", warranty_months: 6, bis_certified: "Yes" }, "Neckband earphones with 30-hour battery, ideal for gifting and resale"),
  T("ele", "USB-C Charging Cables|Fast Charging USB Cable", "cable", 39, "piece", 500, "pcs", "8544", { power: "3A", connectivity: "USB-C", warranty_months: 6, bis_certified: "Yes" }, "1 metre braided cable, 3A fast charging"),
  T("ele", "LED Bulbs 9W|B22 LED Bulbs", "lamp", 42, "piece", 500, "pcs", "9405", { power: "9W, 220-240V", connectivity: "B22 base", warranty_months: 12, bis_certified: "Yes" }, "Energy-saving cool white LED bulbs"),
  T("ele", "Power Banks 10000mAh|Slim Power Banks", "cable", 620, "piece", 50, "pcs", "8507", { power: "10000 mAh", connectivity: "USB-C, USB-A", warranty_months: 12, bis_certified: "Yes" }, "Dual output power banks with LED indicator"),
  T("ele", "Extension Boards 4 Socket|Surge Protected Extension Board", "cable", 210, "piece", 100, "pcs", "8536", { power: "6A, 250V", connectivity: "4 sockets, 2 m cord", warranty_months: 12, bis_certified: "Yes" }, "Fire-retardant body with master switch"),
  // Gifts & Promotions
  T("gift", "Corporate Gift Sets|Branded Executive Gift Set", "giftset", 450, "set", 50, "sets", "4202", { material: "Assorted", customisation: "Logo print", pack_contents: "Diary, pen, mug", occasion: "Corporate" }, "Ready gift sets with logo branding and premium box"),
  T("gift", "Brass Table Decor Showpiece|Handcrafted Brass Decor", "giftset", 890, "piece", 25, "pcs", "7418", { material: "Brass", customisation: "Engraving", pack_contents: "1 piece", occasion: "Corporate / festive" }, "Hand-finished brass decor from Moradabad artisans"),
  T("gift", "Customised Laptop Backpacks|Branded Office Backpacks", "backpack", 549, "piece", 50, "pcs", "4202", { material: "Polyester 600D", customisation: "Logo print", pack_contents: "1 bag", occasion: "Corporate" }, "Water-resistant backpacks with padded laptop sleeve"),
  T("gift", "Logo Printed Coffee Mugs|Promotional Mugs", "mug", 130, "piece", 200, "pcs", "6912", { material: "Ceramic", customisation: "Logo print", pack_contents: "1 mug", occasion: "Promotional" }, "Full-wrap logo print, individually boxed"),
  T("gift", "Festive Gift Hampers|Diwali Gift Hampers", "giftset", 799, "set", 25, "sets", "2106", { material: "Assorted", customisation: "None", pack_contents: "Dry fruits, sweets, diya", occasion: "Diwali" }, "Curated festive hampers in reusable boxes"),
  T("gift", "Leather Diaries|PU Leather Executive Diary", "notebook", 240, "piece", 100, "pcs", "4820", { material: "PU leather", customisation: "Embossing", pack_contents: "1 diary", occasion: "Corporate" }, "A5 dated diaries with logo embossing"),
  // Furniture & Fixtures
  T("fur", "Office Chairs|Ergonomic Mesh Office Chair", "chair", 1999, "piece", 10, "pcs", "9401", { material: "Mesh, nylon base", dimensions: "60 x 60 x 105 cm", finish: "Black", warranty_years: 1 }, "Mid-back ergonomic chairs with lumbar support and gas lift"),
  T("fur", "Office Desks|Modular Workstation Desk", "desk", 5200, "piece", 5, "pcs", "9403", { material: "Pre-laminated board", dimensions: "120 x 60 x 75 cm", finish: "Walnut", warranty_years: 2 }, "Workstation desks with cable management"),
  T("fur", "Steel Almirah|Two-Door Steel Cupboard", "shelf", 6800, "piece", 5, "pcs", "9403", { material: "CRCA steel", dimensions: "180 x 90 x 45 cm", finish: "Powder coated", warranty_years: 5 }, "Lockable steel almirah with 5 shelves"),
  T("fur", "Stackable Visitor Chairs|Plastic Stackable Chairs", "chair", 380, "piece", 50, "pcs", "9401", { material: "Polypropylene", dimensions: "45 x 50 x 80 cm", finish: "Matte", warranty_years: 1 }, "Lightweight stackable chairs for waiting areas and events"),
  T("fur", "Heavy Duty Storage Racks|Slotted Angle Racks", "shelf", 2400, "piece", 10, "pcs", "9403", { material: "Mild steel", dimensions: "180 x 90 x 45 cm", finish: "Powder coated", warranty_years: 2 }, "Boltless racks for warehouse and office storage"),
  // Health & Personal Care
  T("health", "Herbal Hand Wash 5L|Liquid Hand Wash Can", "cosmetic", 320, "can", 24, "cans", "3401", { form: "Liquid", volume: "5 L", shelf_life_months: 24, certification: "Dermatologically tested" }, "Neem and aloe liquid hand wash for offices and institutions"),
  T("health", "3-Ply Face Masks|Disposable Face Masks", "mask", 1.2, "piece", 5000, "pcs", "6307", { form: "Disposable", volume: "Box of 50", shelf_life_months: 36, certification: "ISI marked" }, "Non-woven 3-ply masks with nose pin"),
  T("health", "Hand Sanitizer 500ml|Alcohol Hand Sanitizer", "cosmetic", 95, "piece", 100, "pcs", "3808", { form: "Gel", volume: "500 ml", shelf_life_months: 24, certification: "ISO 9001" }, "70% alcohol gel sanitiser with pump"),
  T("health", "Herbal Bathing Soap|Neem Soap Bar", "cosmetic", 22, "piece", 500, "pcs", "3401", { form: "Bar", volume: "100 g", shelf_life_months: 24, certification: "AYUSH" }, "Herbal soap, private label available"),
  // Industrial & Raw Materials
  T("ind", "MS Pipes|Mild Steel Round Pipes", "pipe", 72, "kg", 1, "ton", "7306", { material: "Mild steel", grade: "IS 1239", size: "1 inch, 2.6 mm", standard: "IS 1239" }, "ERW black pipes, mill test certificate supplied"),
  T("ind", "Stainless Steel Sheets 304|SS 304 Sheets", "steel", 210, "kg", 500, "kg", "7219", { material: "Stainless steel", grade: "304", size: "1.5 mm, 4 x 8 ft", standard: "ASTM A240" }, "2B finish cold rolled sheets"),
  T("ind", "HDPE Granules|Virgin HDPE Granules", "sack", 105, "kg", 1, "ton", "3901", { material: "HDPE", grade: "Injection grade", size: "25 kg bag", standard: "IS 7328" }, "Virgin granules for moulding and extrusion"),
  T("ind", "Copper Wire Rods|Electrolytic Copper Wire", "wire", 780, "kg", 100, "kg", "7408", { material: "Copper", grade: "99.9%", size: "8 mm", standard: "IS 613" }, "Bright copper wire for cable and winding"),
  T("ind", "Aluminium Ingots|Primary Aluminium Ingots", "steel", 245, "kg", 1, "ton", "7601", { material: "Aluminium", grade: "99.7%", size: "10 kg ingot", standard: "IS 5482" }, "Ingots for casting and rolling"),
  T("ind", "MS Angles|Mild Steel Angle Bars", "steel", 64, "kg", 1, "ton", "7216", { material: "Mild steel", grade: "IS 2062 E250", size: "50 x 50 x 5 mm", standard: "IS 2062" }, "Hot-rolled angles for fabrication"),
  // Agriculture & Food
  T("agri", "Basmati Rice|1121 Steam Basmati Rice", "sack", 92, "kg", 500, "kg", "1006", { variety: "1121 Steam", origin: "Haryana", packaging: "25 kg PP bag", shelf_life_months: 18, fssai: "Yes" }, "Extra-long grain aged basmati"),
  T("agri", "Turmeric Powder|Salem Turmeric Powder", "sack", 145, "kg", 100, "kg", "0910", { variety: "Salem", origin: "Tamil Nadu", packaging: "25 kg bag", shelf_life_months: 12, fssai: "Yes" }, "High curcumin turmeric, lab tested"),
  T("agri", "Cashew Kernels W320|Raw Cashew Kernels", "sack", 720, "kg", 50, "kg", "0801", { variety: "W320", origin: "Kerala", packaging: "10 kg tin", shelf_life_months: 9, fssai: "Yes" }, "Whole white kernels, vacuum packed"),
  T("agri", "CTC Tea|Assam CTC Tea", "sack", 260, "kg", 100, "kg", "0902", { variety: "Assam CTC", origin: "Assam", packaging: "25 kg bag", shelf_life_months: 12, fssai: "Yes" }, "Strong liquor dust tea for retail and tea shops"),
  T("agri", "Groundnut Oil|Cold Pressed Groundnut Oil", "jar", 165, "litre", 200, "litres", "1508", { variety: "Cold pressed", origin: "Gujarat", packaging: "15 L tin", shelf_life_months: 9, fssai: "Yes" }, "Filtered groundnut oil in tins"),
  // Building & Construction
  T("bld", "Vitrified Floor Tiles|Glazed Vitrified Tiles 2x2", "tiles", 38, "sq ft", 500, "sq ft", "6907", { material: "Vitrified", grade: "Premium", size: "600 x 600 mm", standard: "IS 15622" }, "Glossy double-charge tiles, first quality"),
  T("bld", "PPC Cement|Portland Pozzolana Cement", "cement", 385, "bag", 100, "bags", "2523", { material: "Cement", grade: "PPC", size: "50 kg bag", standard: "IS 1489" }, "Bulk supply for construction sites"),
  T("bld", "TMT Steel Bars|Fe 500D TMT Bars", "steel", 68, "kg", 1, "ton", "7214", { material: "Steel", grade: "Fe 500D", size: "12 mm", standard: "IS 1786" }, "Earthquake-resistant TMT bars"),
  T("bld", "Wall Putty 20kg|White Cement Wall Putty", "cement", 720, "bag", 50, "bags", "3214", { material: "White cement based", grade: "Premium", size: "20 kg bag", standard: "IS 5410" }, "Smooth finish putty for interior walls"),
  T("bld", "Exterior Emulsion Paint 20L|Weatherproof Exterior Paint", "paint", 3400, "bucket", 10, "buckets", "3209", { material: "Acrylic emulsion", grade: "Premium", size: "20 L", standard: "IS 15489" }, "Weather-shield paint with 7-year warranty"),
  T("bld", "Kota Stone Slabs|Natural Kota Stone", "tiles", 55, "sq ft", 1000, "sq ft", "6802", { material: "Natural stone", grade: "Select", size: "2 x 2 ft", standard: "IS 1130" }, "Blue-green flooring stone, polished or natural finish"),
  // Industrial MRO & Safety
  T("mro", "Safety Helmets|Industrial Safety Helmet", "helmet", 185, "piece", 50, "pcs", "6506", { material: "HDPE", standard: "IS 2925", size: "Adjustable", color: "Yellow" }, "Ratchet-adjust helmets with chin strap"),
  T("mro", "Work Gloves|Cotton Knitted Gloves", "gloves", 65, "pair", 200, "pairs", "6116", { material: "Cotton with PVC dots", standard: "EN 388", size: "Free", color: "Orange" }, "Grip gloves for handling and packaging"),
  T("mro", "Safety Shoes|Steel Toe Safety Shoes", "gloves", 890, "pair", 50, "pairs", "6402", { material: "Leather / PU sole", standard: "IS 15298", size: "6-11", color: "Black" }, "Steel toe cap, oil and slip resistant"),
  T("mro", "Hex Bolts and Nuts|Assorted MS Fasteners", "fasteners", 110, "kg", 100, "kg", "7318", { material: "Mild steel", standard: "IS 1363", size: "M8-M16", color: "Zinc plated" }, "Mixed hex bolt and nut lots, size on request"),
  T("mro", "Ball Bearings 6204|Deep Groove Ball Bearing", "fasteners", 95, "piece", 100, "pcs", "8482", { material: "Chrome steel", standard: "ISO 15", size: "20 x 47 x 14 mm", color: "Steel" }, "2RS sealed bearings for motors and pumps"),
  T("mro", "Reflective Safety Jackets|Hi-Vis Vests", "helmet", 130, "piece", 100, "pcs", "6210", { material: "Polyester", standard: "EN ISO 20471", size: "Free", color: "Fluorescent green" }, "Reflective strips, velcro front"),
];

/* ------------------------------------------------------------------- main */

async function cleanSeed() {
  const persons = await prisma.person.findMany({ where: { email: { endsWith: "@example.com" } }, select: { id: true } });
  const personIds = persons.map((p) => p.id);
  const members = await prisma.businessMember.findMany({ where: { personId: { in: personIds } }, select: { businessId: true } });
  const bizIds = [...new Set(members.map((m) => m.businessId))];
  let removed = 0;
  for (const id of bizIds) {
    try {
      await prisma.$transaction([
        prisma.listing.deleteMany({ where: { sellerBusinessId: id } }),
        prisma.verificationRecord.deleteMany({ where: { businessId: id } }),
        prisma.businessMember.deleteMany({ where: { businessId: id } }),
        prisma.business.delete({ where: { id } }),
      ]);
      removed++;
    } catch (e) {
      console.warn(`  ! could not remove business ${id} (has dependent rows): ${(e as Error).message.split("\n").pop()}`);
    }
  }
  for (const id of personIds) {
    try {
      // dev-only reset: the consent ledger is append-only at the DB level, so the delete runs as a purge (M5)
      await withPurge(async (tx) => {
        await tx.authSession.deleteMany({ where: { personId: id } });
        await tx.consent.deleteMany({ where: { personId: id } });
        await tx.person.delete({ where: { id } });
      });
    } catch {
      /* person still referenced (e.g. enquiries): leave */
    }
  }
  console.log(`Reset: removed ${removed} seed businesses (and their listings).`);
}

async function seedCategories(): Promise<Map<string, string>> {
  const all = [...CATS, ...PROHIBITED];
  const upsertCategories = (catalogue as Record<string, unknown>).upsertCategories;
  if (typeof upsertCategories === "function") {
    try {
      await (upsertCategories as (rows: unknown[]) => Promise<unknown>)(
        all.map((c, i) => ({ slug: c.slug, name: c.name, icon: c.icon, leadCap: 3, prohibited: !!c.prohibited, attributeSchema: { fields: c.fields }, sortOrder: i })),
      );
    } catch (e) {
      console.warn("  catalogue.upsertCategories failed, falling back to prisma:", (e as Error).message);
    }
  }
  const ids = new Map<string, string>();
  for (const [i, c] of all.entries()) {
    const data = { name: c.name, icon: c.icon, leadCap: 3, prohibited: !!c.prohibited, attributeSchema: { fields: c.fields }, sortOrder: i };
    const row = await prisma.category.upsert({ where: { slug: c.slug }, update: data, create: { slug: c.slug, ...data } });
    ids.set(c.key, row.id);
  }
  return ids;
}

interface SeededSeller { id: string; name: string; city: City; cats: string[]; tier: number }

async function seedSellers(): Promise<SeededSeller[]> {
  const demoHash = await hashPassword("DemoSeller#2026");
  const out: SeededSeller[] = [];
  for (const [i, [name, cityKey, cats]] of SELLERS.entries()) {
    const r = rng(1000 + i);
    const city = CITY[cityKey]!;
    const tier = i === 0 ? 2 : [2, 1, 1, 0, 2, 1, 0, 1, 2, 1][i % 10]!;
    const score = i === 0 ? 88 : tier === 2 ? 65 + Math.floor(r() * 31) : tier === 1 ? 35 + Math.floor(r() * 51) : 30 + Math.floor(r() * 31);
    const badgeActive = tier >= 1 && score >= 40;
    const gstin = makeGstin(city.code, rng(5000 + i));
    const bizId = stableId(`business:${i}`);
    const email = i === 0 ? "seller-demo@example.com" : `seller${i}@example.com`;
    const personId = stableId(`person:${email}`);
    const owner = OWNERS[i % OWNERS.length]!;

    await prisma.person.upsert({
      where: { email },
      update: { name: owner, ...(i === 0 ? { passwordHash: demoHash } : {}) },
      create: { id: personId, email, emailVerifiedAt: new Date(), name: owner, passwordHash: i === 0 ? demoHash : null },
    });
    const person = await prisma.person.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const bizData = {
      name, gstin: tier >= 1 ? gstin : null, city: city.name, state: city.state, pincode: city.pincode,
      isSeller: true, isBuyer: false, verificationTier: tier, trustScore: score, badgeActive, languages: ["en", "hi"],
    };
    await prisma.business.upsert({ where: { id: bizId }, update: bizData, create: { id: bizId, ...bizData } });
    await prisma.businessMember.upsert({
      where: { businessId_personId: { businessId: bizId, personId: person.id } },
      update: {},
      create: { businessId: bizId, personId: person.id, role: "owner" },
    });
    if (tier >= 1) {
      await prisma.verificationRecord.upsert({
        where: { id: stableId(`vr:gstin:${i}`) },
        // legalName lets the public evidence panel show "GST name matches" (identity/evidence.ts), as a real GST check would.
        update: { details: { gstin, legalName: name } },
        create: { id: stableId(`vr:gstin:${i}`), businessId: bizId, tier: 1, kind: "gstin", status: "passed", provider: "seed-mock", details: { gstin, legalName: name } },
      });
    }
    if (tier >= 2) {
      await prisma.verificationRecord.upsert({
        where: { id: stableId(`vr:doc:${i}`) },
        update: {},
        create: { id: stableId(`vr:doc:${i}`), businessId: bizId, tier: 2, kind: "document", status: "passed", provider: "seed-mock", details: {} },
      });
      // T2 evidence needs documents AND video KYC (identity/evidence.ts); without it a "KYC verified" badge had no T2 check behind it.
      await prisma.verificationRecord.upsert({
        where: { id: stableId(`vr:kyc:${i}`) },
        update: {},
        create: { id: stableId(`vr:kyc:${i}`), businessId: bizId, tier: 2, kind: "video_kyc", status: "passed", provider: "seed-mock", details: {} },
      });
    }
    out.push({ id: bizId, name, city, cats, tier });
  }

  // Demo buyer login.
  const buyerHash = await hashPassword("DemoBuyer#2026");
  const buyerEmail = "buyer-demo@example.com";
  await prisma.person.upsert({
    where: { email: buyerEmail },
    update: { passwordHash: buyerHash, name: "Demo Buyer" },
    create: { id: stableId(`person:${buyerEmail}`), email: buyerEmail, emailVerifiedAt: new Date(), name: "Demo Buyer", passwordHash: buyerHash },
  });
  const buyer = await prisma.person.findUniqueOrThrow({ where: { email: buyerEmail }, select: { id: true } });
  const buyerBizId = stableId("business:demo-buyer");
  const pune = CITY.pun!;
  const buyerBiz = { name: "Demo Buyer Enterprises", city: pune.name, state: pune.state, pincode: pune.pincode, isSeller: false, isBuyer: true, verificationTier: 0, trustScore: 50, badgeActive: false, languages: ["en"] };
  await prisma.business.upsert({ where: { id: buyerBizId }, update: buyerBiz, create: { id: buyerBizId, ...buyerBiz } });
  await prisma.businessMember.upsert({
    where: { businessId_personId: { businessId: buyerBizId, personId: buyer.id } },
    update: {},
    create: { businessId: buyerBizId, personId: buyer.id, role: "owner" },
  });
  return out;
}

function priceFor(base: number, instance: number, r: () => number): number {
  if (instance === 0) return Math.round(base * 100);
  const j = 0.88 + r() * 0.24;
  const v = base * j;
  return Math.round((v < 20 ? Math.round(v * 20) / 20 : Math.round(v)) * 100);
}

/** Dev-only demo data: every other template gets quantity slabs and trade info so the product page shows them. */
function tradeDemo(ti: number, t: Tpl, pricePaise: number, k: number) {
  const none = { priceTiers: [] as { minQty: number; pricePaise: number }[], leadTimeDays: null as number | null, packaging: null as string | null, sampleAvailable: false, samplePricePaise: null as bigint | null, supplyCapacityPerMonth: null as number | null, paymentTerms: null as string | null, certifications: [] as string[] };
  if (ti % 2 !== 0) return none;
  const at = (mult: number, pct: number) => ({ minQty: t.moq * mult, pricePaise: Math.max(1, Math.round((pricePaise * pct) / 100)) });
  return {
    ...none,
    priceTiers: [at(1, 100), at(5, 94), at(20, 88)],
    leadTimeDays: 5 + (ti % 4) * 3,
    packaging: `Packed in export-grade cartons, ${t.moqUnit} bundled in 10s`,
    sampleAvailable: k === 0,
    samplePricePaise: k === 0 ? BigInt(Math.max(100, Math.round(pricePaise * 2))) : null,
    supplyCapacityPerMonth: t.moq * 100,
    paymentTerms: "50% advance, balance before dispatch. Net 30 for repeat buyers.",
    certifications: ti % 4 === 0 ? ["ISO 9001:2015", "BIS"] : ["MSME registered"],
  };
}

async function seedListings(catIds: Map<string, string>, sellers: SeededSeller[]): Promise<string[]> {
  const ids: string[] = [];
  const perCatIndex = new Map<string, number>();
  const now = Date.now();
  for (const [ti, t] of TEMPLATES.entries()) {
    const idxInCat = perCatIndex.get(t.cat) ?? 0;
    perCatIndex.set(t.cat, idxInCat + 1);
    const eligible = sellers.filter((s) => s.cats.includes(t.cat));
    const n = Math.min(eligible.length, idxInCat < 2 ? 3 : 2);
    const titles = t.titles.split("|");
    for (let k = 0; k < n; k++) {
      const seller = eligible[(ti + k) % eligible.length]!;
      const r = rng(ti * 97 + k * 13 + 7);
      const title = titles[k % titles.length]!;
      const id = stableId(`listing:${ti}:${k}`);
      const pricePaise = priceFor(t.price, k, r);
      const data = {
        ...tradeDemo(ti, t, pricePaise, k),
        sellerBusinessId: seller.id,
        categoryId: catIds.get(t.cat)!,
        title,
        description: `${t.desc}. Supplied by ${seller.name}, ${seller.city.name}. GST invoice, bulk pricing and dispatch across India.`,
        attributes: t.attrs,
        pricePaise: BigInt(pricePaise),
        priceUnit: t.unit,
        moq: t.moq,
        moqUnit: t.moqUnit,
        hsn: t.hsn,
        language: "en",
        imageUrls: [`/placeholders/${t.type}.svg`],
        aiGenerated: false,
        status: "published" as const,
        moderationStatus: "approved" as const,
      };
      await prisma.listing.upsert({
        where: { id },
        update: data,
        // Spread creation times so "New Arrivals" has an order.
        create: { id, ...data, createdAt: new Date(now - Math.floor(r() * 60) * 86_400_000 - ti * 3_600_000) },
      });
      ids.push(id);
    }
  }
  return ids;
}

async function embed(ids: string[]) {
  const reindex = (catalogue as Record<string, unknown>).reindexEmbeddings;
  if (typeof reindex === "function") {
    try {
      const res = await (reindex as (o: { onlyMissing: boolean }) => Promise<unknown>)({ onlyMissing: true });
      console.log("  embeddings: catalogue.reindexEmbeddings", JSON.stringify(res ?? {}));
      return;
    } catch (e) {
      console.warn("  catalogue.reindexEmbeddings failed:", (e as Error).message);
    }
  }
  try {
    const rows = await prisma.$queryRaw<{ id: string; title: string; description: string }[]>`
      SELECT id::text AS id, title, description FROM listings WHERE embedding IS NULL AND id::text = ANY(${ids})`;
    for (let i = 0; i < rows.length; i += 32) {
      const batch = rows.slice(i, i + 32);
      const { vectors, version } = await ai.embed(batch.map((b) => `${b.title}\n${b.description}`));
      for (const [j, b] of batch.entries()) {
        await prisma.$executeRaw`UPDATE listings SET embedding = ${toVectorLiteral(vectors[j]!)}::vector, embedding_version = ${version} WHERE id = ${b.id}::uuid`;
      }
    }
    console.log(`  embeddings: wrote ${rows.length} via ai.embed`);
  } catch (e) {
    console.warn(`  ! embeddings skipped (${(e as Error).message}). Run the catalogue reindex once it is available.`);
  }
}

async function main() {
  if (VERTICAL !== undefined) {
    // Explicit opt-in (ADR-011): the playbook is data, loaded only when asked for by key.
    const known = listPlaybooks().map((p) => p.key);
    if (!known.includes(VERTICAL)) throw new Error(`Unknown vertical "${VERTICAL}". Available: ${known.join(", ")}`);
    const res = await loadPlaybook(VERTICAL);
    console.log(`Vertical playbook "${res.playbook}": ${res.categories} categories upserted; vertical ${res.verticalCreated ? "created as candidate" : "already existed (stage unchanged)"}.`);
    if (ONLY) return;
  }
  if (RESET || CLEAN) await cleanSeed();
  if (CLEAN) return;

  console.log("Seeding categories…");
  const catIds = await seedCategories();
  console.log("Seeding sellers…");
  const sellers = await seedSellers();
  console.log("Seeding listings…");
  const listingIds = await seedListings(catIds, sellers);
  console.log("Embedding listings…");
  await embed(listingIds);

  const seedPlans = (billing as Record<string, unknown>).seedPlans;
  if (typeof seedPlans === "function") {
    try {
      await (seedPlans as () => Promise<unknown>)();
      console.log("Plans seeded.");
    } catch (e) {
      console.warn(`  ! billing.seedPlans failed: ${(e as Error).message}`);
    }
  }

  const tiers = [0, 1, 2].map((t) => sellers.filter((s) => s.tier === t).length);
  console.log("\nSeed summary");
  console.log(`  categories : ${CATS.length} + ${PROHIBITED.length} prohibited`);
  console.log(`  sellers    : ${sellers.length} (tier0 ${tiers[0]}, tier1 ${tiers[1]}, tier2 ${tiers[2]})`);
  console.log(`  listings   : ${listingIds.length} (published, approved)`);
  console.log("\nDemo logins (email / password)");
  console.log("  seller: seller-demo@example.com / DemoSeller#2026   (Demo Packaging Works, tier 2)");
  console.log("  buyer : buyer-demo@example.com  / DemoBuyer#2026    (Demo Buyer Enterprises)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Imported modules may hold Redis connections open; this is a one-shot script.
    process.exit(process.exitCode ?? 0);
  });
