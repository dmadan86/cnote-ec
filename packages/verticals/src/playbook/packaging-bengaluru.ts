import { PlaybookSchema, type Playbook, type PlaybookInput } from "./schema";

/**
 * Packaging materials, Bengaluru corridor. Recommended Phase-1 vertical per docs/adr/ADR-011-vertical-selection.md
 * (status: proposed, pending field validation). Evidence: docs/research/vertical-selection.md.
 *
 * DATA ONLY and OFF by default: it is loaded by an explicit action (`loadPlaybook("packaging-bengaluru")`, or
 * `pnpm db:seed -- --vertical=packaging-bengaluru --only`). Do not import this file from product code.
 *
 * HSN codes are 4 or 6 digit tariff-heading codes, deliberately not 8 digit tariff lines (those are not verified here);
 * GST rates are NOT stored, they change (corrugated boxes went 12% -> 5% on 2025-09-22) and belong with billing.
 * Regulatory entries record the state of each regime as last desk-checked on `verifiedOn`; "unverified" means the
 * interview/counsel checklist in the ADR must confirm it before launch.
 */

const DIM = (axis: "length" | "width" | "height") => ({ key: `${axis}_mm`, label: `${axis[0]!.toUpperCase()}${axis.slice(1)}`, type: "number" as const, unit: "mm" as const, required: true });
const PRINTING = { key: "printing", label: "Printing", type: "select" as const, options: ["Plain", "1 colour", "2 colour", "Multi-colour", "Offset"] };
const FOOD_CONTACT_CERT = {
  kind: "fssai" as const,
  standard: "FSSAI Food Safety and Standards (Packaging) Regulations 2018",
  requiresCertificate: true,
  verifiedOn: "2026-10-06",
  note: "Seller must supply a food-contact test report or compliance declaration reference for food-grade claims.",
};

const input: PlaybookInput = {
  key: "packaging-bengaluru",
  name: "Packaging materials (Bengaluru corridor)",
  version: 1,
  decisionStatus: "Proposed — recommended, pending field validation (20+ interviews per ADR-011)",
  languages: ["hi", "en", "kn", "ta", "te"],
  clusters: [
    { label: "Peenya corrugated and packaging", city: "Bengaluru", district: "Bengaluru Urban", state: "Karnataka", industry: "Packaging, corrugated boxes, engineering consumables" },
    { label: "Jigani packaging and engineering", city: "Bengaluru", district: "Anekal", state: "Karnataka", industry: "Corrugated boxes, plastics, engineering" },
    { label: "Bommasandra industrial area", city: "Bengaluru", district: "Anekal", state: "Karnataka", industry: "Packaging converters, electronics and auto ancillary buyers" },
    { label: "Nelamangala-Dabaspete (Dobbaspet)", city: "Nelamangala", district: "Bengaluru Rural", state: "Karnataka", industry: "Corrugated, films, warehousing" },
    { label: "Doddaballapura industrial and apparel park", city: "Doddaballapura", district: "Bengaluru Rural", state: "Karnataka", industry: "Packaging suppliers to garment and textile units" },
    { label: "Tumakuru (Vasanthanarasapura)", city: "Tumakuru", district: "Tumakuru", state: "Karnataka", industry: "Packaging suppliers to manufacturing belt (unverified seller counts)" },
    { label: "Hosur SIPCOT", city: "Hosur", district: "Krishnagiri", state: "Tamil Nadu", industry: "Packaging for engineering, auto component and EV units" },
  ],
  categories: [
    { slug: "packaging-materials", name: "Packaging Materials", icon: "package", sortOrder: 0, note: "Vertical root. Distinct from the generic dummy-seed root 'packaging-printing'." },

    // ---- corrugated and paper ------------------------------------------------------------------------------------
    {
      slug: "corrugated-boxes", name: "Corrugated Boxes", parentSlug: "packaging-materials", icon: "box", sortOrder: 1,
      aliases: ["gatta dabba", "carton box", "cardboard box", "3 ply box", "5 ply box"],
      attributes: [
        DIM("length"), DIM("width"), DIM("height"),
        { key: "ply", label: "Ply", type: "number", required: true },
        { key: "board_grade", label: "Board grade", type: "select", options: ["Kraft", "Semi-kraft", "Virgin kraft", "Recycled"] },
        { key: "liner_gsm", label: "Liner GSM", type: "number", unit: "gsm" },
        { key: "burst_factor", label: "Burst factor", type: "number", unit: "bf" },
        { key: "flute", label: "Flute", type: "select", options: ["B", "C", "E", "BC", "F"] },
        { key: "joint", label: "Joint", type: "select", options: ["Pasted", "Stitched", "Taped"] },
        PRINTING,
      ],
      variantAxes: ["length_mm", "width_mm", "height_mm", "ply", "printing"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 500 },
      hsn: ["481910", "4819"],
      regulations: [
        { kind: "bis-standard", standard: "IS 2771 (corrugated fibreboard boxes)", qcoStatus: "none-found", requiresCertificate: false, verifiedOn: "2026-10-06", note: "No QCO found in desk research. Confirm with counsel before launch (ADR-011 checklist)." },
      ],
      constraints: [{ field: "ply", min: 1, max: 9, message: "Ply must be between 1 and 9" }],
    },
    {
      slug: "corrugated-sheets-rolls", name: "Corrugated Sheets and Rolls", parentSlug: "packaging-materials", icon: "layers", sortOrder: 2,
      aliases: ["gatta sheet", "corrugated roll", "flute roll"],
      attributes: [
        { key: "form", label: "Form", type: "select", required: true, options: ["Sheet", "Roll"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm", required: true },
        { key: "ply", label: "Ply", type: "number", required: true },
        { key: "flute", label: "Flute", type: "select", options: ["B", "C", "E", "BC", "F"] },
        { key: "liner_gsm", label: "Liner GSM", type: "number", unit: "gsm" },
        { key: "burst_factor", label: "Burst factor", type: "number", unit: "bf" },
      ],
      variantAxes: ["form", "width_mm", "ply", "flute"],
      units: { price: ["kg", "sheet", "roll"], moq: ["kg", "sheet", "roll"], defaultPrice: "kg", defaultMoq: "kg", typicalMoq: 500 },
      hsn: ["480810", "4808"],
    },
    {
      slug: "kraft-paper-board", name: "Kraft Paper and Board", parentSlug: "packaging-materials", icon: "scroll", sortOrder: 3,
      aliases: ["kraft paper", "kraft liner", "duplex board", "testliner", "fluting paper"],
      attributes: [
        { key: "paper_type", label: "Paper type", type: "select", required: true, options: ["Kraft liner", "Testliner", "Fluting medium", "Duplex board", "Kraft paper roll"] },
        { key: "gsm", label: "GSM", type: "number", unit: "gsm", required: true },
        { key: "burst_factor", label: "Burst factor", type: "number", unit: "bf" },
        { key: "width_mm", label: "Reel width", type: "number", unit: "mm" },
        { key: "moisture_pct", label: "Moisture", type: "number", unit: "%" },
      ],
      variantAxes: ["paper_type", "gsm", "width_mm"],
      units: { price: ["kg", "tonne"], moq: ["kg", "tonne"], defaultPrice: "kg", defaultMoq: "tonne", typicalMoq: 1 },
      hsn: ["4804", "4805", "4810"],
      regulations: [
        { kind: "bis-standard", standard: "IS 1397 (kraft paper)", qcoStatus: "none-found", requiresCertificate: false, verifiedOn: "2026-10-06", note: "Direct food contact has additional FSSAI restrictions on recycled paper." },
      ],
    },
    {
      slug: "folding-cartons", name: "Folding Cartons and Duplex Boxes", parentSlug: "packaging-materials", icon: "gift", sortOrder: 4,
      aliases: ["duplex box", "mono carton", "printed carton"],
      attributes: [
        DIM("length"), DIM("width"), DIM("height"),
        { key: "board", label: "Board", type: "select", required: true, options: ["Duplex grey back", "Duplex white back", "SBS", "FBB"] },
        { key: "gsm", label: "GSM", type: "number", unit: "gsm" },
        PRINTING,
        { key: "lamination", label: "Lamination", type: "select", options: ["None", "Gloss", "Matt", "Spot UV"] },
      ],
      variantAxes: ["length_mm", "width_mm", "height_mm", "board", "printing"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 1000 },
      hsn: ["481920", "4819"],
    },
    {
      slug: "paper-bags", name: "Paper Bags and Sacks", parentSlug: "packaging-materials", icon: "shopping-bag", sortOrder: 5,
      aliases: ["kagaz ka thaila", "kraft bag", "paper carry bag"],
      attributes: [
        { key: "paper_type", label: "Paper", type: "select", options: ["Kraft", "White kraft", "Multiwall sack paper"] },
        { key: "gsm", label: "GSM", type: "number", unit: "gsm" },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "height_mm", label: "Height", type: "number", unit: "mm" },
        { key: "handle", label: "Handle", type: "select", options: ["None", "Flat", "Twisted"] },
        PRINTING,
      ],
      variantAxes: ["paper_type", "width_mm", "height_mm", "printing"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 1000 },
      hsn: ["481930", "481940", "4819"],
    },

    // ---- plastic films, tapes, bags --------------------------------------------------------------------------------
    {
      slug: "stretch-films", name: "Stretch and Shrink Films", parentSlug: "packaging-materials", icon: "film", sortOrder: 6,
      aliases: ["stretch wrap", "pallet wrap", "shrink film"],
      attributes: [
        { key: "film_type", label: "Film type", type: "select", required: true, options: ["Hand stretch", "Machine stretch", "Shrink"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm", required: true },
        { key: "thickness_micron", label: "Thickness", type: "number", unit: "micron", required: true },
        { key: "weight_kg", label: "Roll weight", type: "number", unit: "kg" },
        { key: "colour", label: "Colour", type: "select", options: ["Clear", "Black", "Blue"] },
      ],
      variantAxes: ["film_type", "width_mm", "thickness_micron"],
      units: { price: ["kg", "roll"], moq: ["kg", "roll"], defaultPrice: "kg", defaultMoq: "kg", typicalMoq: 100 },
      hsn: ["392010", "3920"],
    },
    {
      slug: "packaging-tapes", name: "Packaging Tapes", parentSlug: "packaging-materials", icon: "tape", sortOrder: 7,
      aliases: ["bopp tape", "cello tape", "brown tape", "packing tape"],
      attributes: [
        { key: "tape_type", label: "Tape type", type: "select", required: true, options: ["BOPP clear", "BOPP brown", "Printed BOPP", "Masking", "Double sided"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm", required: true },
        { key: "length_m", label: "Length", type: "number", unit: "m", required: true },
        { key: "thickness_micron", label: "Thickness", type: "number", unit: "micron" },
      ],
      variantAxes: ["tape_type", "width_mm", "length_m"],
      units: { price: ["piece", "roll", "carton"], moq: ["piece", "roll", "carton"], defaultPrice: "roll", defaultMoq: "roll", typicalMoq: 72 },
      hsn: ["391910", "3919"],
    },
    {
      slug: "bubble-wrap-foam", name: "Bubble Wrap and Foam", parentSlug: "packaging-materials", icon: "circle-dot", sortOrder: 8,
      aliases: ["bubble sheet", "air bubble roll", "epe foam", "thermocol sheet"],
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["Air bubble", "EPE foam", "EPS (thermocol)", "PU foam"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "thickness_mm", label: "Thickness", type: "number", unit: "mm" },
        { key: "length_m", label: "Length", type: "number", unit: "m" },
      ],
      variantAxes: ["material", "width_mm", "thickness_mm"],
      units: { price: ["roll", "kg", "sheet"], moq: ["roll", "kg", "sheet"], defaultPrice: "roll", defaultMoq: "roll", typicalMoq: 10 },
      hsn: ["3921", "392111"],
      note: "HSN classification of bubble wrap varies between 3921 and 3923 in practice; confirm with a CA before relying on it.",
    },
    {
      slug: "plastic-bags-pouches", name: "Plastic Bags and Pouches", parentSlug: "packaging-materials", icon: "package-open", sortOrder: 9,
      aliases: ["polythene", "pouch", "zip lock bag", "poly bag", "ldpe bag"],
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["LDPE", "HDPE", "PP", "BOPP", "Biodegradable"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "height_mm", label: "Height", type: "number", unit: "mm" },
        { key: "thickness_micron", label: "Thickness", type: "number", unit: "micron", required: true },
        { key: "closure", label: "Closure", type: "select", options: ["Open", "Zip lock", "Heat seal", "Adhesive strip"] },
        PRINTING,
      ],
      variantAxes: ["material", "width_mm", "height_mm", "thickness_micron"],
      units: { price: ["kg", "piece"], moq: ["kg", "piece"], defaultPrice: "kg", defaultMoq: "kg", typicalMoq: 50 },
      hsn: ["392321", "392329", "3923"],
      regulations: [
        {
          kind: "pwm-epr", standard: "Plastic Waste Management Rules 2016 as amended (EPR registration for producers of plastic packaging)",
          requiresCertificate: false, verifiedOn: "2026-10-06", note: "Unverified in this desk pass; counsel to confirm which sellers need EPR registration numbers shown.",
        },
      ],
    },
    {
      slug: "plastic-carry-bags", name: "Plastic Carry Bags", parentSlug: "packaging-materials", icon: "shopping-bag", sortOrder: 10,
      aliases: ["carry bag", "thaila", "polythene carry bag"],
      note: "Carry bags thinner than 120 micron are banned under the Plastic Waste Management Rules (unverified in this desk pass: confirm).",
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["HDPE", "LDPE", "Non-woven PP", "Compostable"] },
        { key: "thickness_micron", label: "Thickness", type: "number", unit: "micron", required: true },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "height_mm", label: "Height", type: "number", unit: "mm" },
      ],
      variantAxes: ["material", "thickness_micron", "width_mm", "height_mm"],
      units: { price: ["kg", "piece"], moq: ["kg", "piece"], defaultPrice: "kg", defaultMoq: "kg", typicalMoq: 100 },
      hsn: ["392321", "3923"],
      constraints: [{ field: "thickness_micron", min: 120, message: "Plastic carry bags below 120 micron are not permitted" }],
      regulations: [
        { kind: "pwm-epr", standard: "Plastic Waste Management Rules 2016 as amended (minimum carry-bag thickness, EPR)", requiresCertificate: false, verifiedOn: "2026-10-06", note: "Unverified in this desk pass." },
      ],
    },
    {
      slug: "woven-sacks", name: "PP and HDPE Woven Sacks", parentSlug: "packaging-materials", icon: "sack", sortOrder: 11,
      aliases: ["pp bag", "bori", "plastic boriya", "woven bag"],
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["PP", "HDPE"] },
        { key: "capacity_kg", label: "Capacity", type: "number", unit: "kg", required: true },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "length_mm", label: "Length", type: "number", unit: "mm" },
        { key: "gsm", label: "GSM", type: "number", unit: "gsm" },
        { key: "liner", label: "Liner", type: "select", options: ["None", "LDPE liner"] },
        { key: "laminated", label: "Laminated", type: "select", options: ["Yes", "No"] },
      ],
      variantAxes: ["capacity_kg", "width_mm", "length_mm", "laminated"],
      units: { price: ["piece", "kg"], moq: ["piece", "kg"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 500 },
      hsn: ["630533", "6305"],
    },
    {
      slug: "jute-sacks", name: "Jute Sacks", parentSlug: "packaging-materials", icon: "sack", sortOrder: 12,
      aliases: ["jute bag", "boriya", "gunny bag", "hessian"],
      attributes: [
        { key: "capacity_kg", label: "Capacity", type: "number", unit: "kg", required: true },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "length_mm", label: "Length", type: "number", unit: "mm" },
        { key: "weave", label: "Weave", type: "select", options: ["Plain", "Twill", "Hessian"] },
      ],
      variantAxes: ["capacity_kg", "width_mm", "length_mm"],
      units: { price: ["piece", "bundle"], moq: ["piece", "bundle"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 500 },
      hsn: ["630510", "6305"],
      regulations: [
        { kind: "bis-standard", standard: "Jute packaging material reservation norms for foodgrain and sugar", qcoStatus: "unverified", requiresCertificate: false, verifiedOn: "2026-10-06", note: "Mandatory-use norms exist for some commodities; counsel to confirm obligations on sellers." },
      ],
    },
    {
      slug: "strapping-edge-protectors", name: "Strapping and Edge Protectors", parentSlug: "packaging-materials", icon: "link", sortOrder: 13,
      aliases: ["pp strap", "box strapping", "edge guard", "corner protector"],
      attributes: [
        { key: "item", label: "Item", type: "select", required: true, options: ["PP strapping", "PET strapping", "Paper edge protector", "Plastic corner"] },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "thickness_mm", label: "Thickness", type: "number", unit: "mm" },
        { key: "length_m", label: "Length", type: "number", unit: "m" },
      ],
      variantAxes: ["item", "width_mm", "thickness_mm"],
      units: { price: ["kg", "roll", "piece"], moq: ["kg", "roll", "piece"], defaultPrice: "kg", defaultMoq: "kg", typicalMoq: 50 },
      hsn: ["3920", "4823"],
    },

    // ---- rigid containers -------------------------------------------------------------------------------------------
    {
      slug: "plastic-containers", name: "Plastic Bottles and Containers", parentSlug: "packaging-materials", icon: "cup-soda", sortOrder: 14,
      aliases: ["pet bottle", "hdpe drum", "plastic jar", "container"],
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["PET", "HDPE", "PP", "LDPE", "PVC"] },
        { key: "capacity_ml", label: "Capacity", type: "number", unit: "ml", required: true },
        { key: "neck_mm", label: "Neck size", type: "number", unit: "mm" },
        { key: "colour", label: "Colour", type: "text" },
        { key: "closure", label: "Closure", type: "select", options: ["Screw cap", "Flip top", "Pump", "Dropper", "None"] },
      ],
      variantAxes: ["material", "capacity_ml", "neck_mm", "colour"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 1000 },
      hsn: ["392330", "3923"],
    },
    {
      slug: "food-grade-containers", name: "Food-grade Packaging (certificate required)", parentSlug: "plastic-containers", icon: "utensils", sortOrder: 15,
      aliases: ["food grade box", "food container", "food packaging"],
      note: "Any listing claiming food-grade or food-contact suitability sits here and needs a certificate / test-report reference.",
      attributes: [
        { key: "material", label: "Material", type: "select", required: true, options: ["PET", "HDPE", "PP", "Glass", "Paperboard", "Aluminium foil"] },
        { key: "capacity_ml", label: "Capacity", type: "number", unit: "ml" },
        { key: "recycled_content_pct", label: "Recycled content", type: "number", unit: "%" },
      ],
      variantAxes: ["material", "capacity_ml"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 1000 },
      hsn: ["392310", "392330", "7010"],
      constraints: [{ field: "recycled_content_pct", min: 0, max: 100, message: "Recycled content is a percentage between 0 and 100" }],
      regulations: [
        FOOD_CONTACT_CERT,
        { kind: "bis-standard", standard: "IS 10146 (polyethylene), IS 12252 (PET), IS 14534 (recycled plastics)", qcoStatus: "none-found", requiresCertificate: true, verifiedOn: "2026-10-06", note: "FSSAI recycled-content rules reference IS 14534. Polymer-resin QCOs were rescinded in Nov 2025." },
      ],
    },
    {
      slug: "glass-bottles-jars", name: "Glass Bottles and Jars", parentSlug: "packaging-materials", icon: "wine", sortOrder: 16,
      aliases: ["kaanch ki bottle", "glass jar", "amber bottle"],
      attributes: [
        { key: "type", label: "Type", type: "select", required: true, options: ["Bottle", "Jar", "Vial"] },
        { key: "capacity_ml", label: "Capacity", type: "number", unit: "ml", required: true },
        { key: "colour", label: "Colour", type: "select", options: ["Clear", "Amber", "Green", "Blue"] },
        { key: "neck_mm", label: "Neck size", type: "number", unit: "mm" },
      ],
      variantAxes: ["type", "capacity_ml", "colour", "neck_mm"],
      units: { price: ["piece"], moq: ["piece", "carton"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 500 },
      hsn: ["701090", "7010"],
      regulations: [{ ...FOOD_CONTACT_CERT, requiresCertificate: false, note: "Food-contact use needs a declaration; certificate is requested when the seller claims food-grade (use the food-grade category)." }],
    },
    {
      slug: "wooden-pallets-crates", name: "Wooden Pallets and Crates", parentSlug: "packaging-materials", icon: "pallet", sortOrder: 17,
      aliases: ["wooden pallet", "pallet", "lakdi ka crate", "wooden box"],
      attributes: [
        { key: "item", label: "Item", type: "select", required: true, options: ["Pallet", "Crate", "Box"] },
        DIM("length"), DIM("width"),
        { key: "height_mm", label: "Height", type: "number", unit: "mm" },
        { key: "wood", label: "Wood", type: "select", options: ["Pine", "Rubberwood", "Eucalyptus", "Plywood"] },
        { key: "ispm15", label: "ISPM-15 heat treated", type: "select", options: ["Yes", "No"] },
      ],
      variantAxes: ["item", "length_mm", "width_mm", "wood"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 20 },
      hsn: ["4415"],
      regulations: [{ kind: "ispm-15", standard: "ISPM-15 (wood packaging for export)", requiresCertificate: false, verifiedOn: "2026-10-06", note: "Relevant only for export shipments; heat-treatment certificate requested when the seller claims ISPM-15." }],
    },
    {
      slug: "un-certified-packaging", name: "UN-certified Hazardous-goods Packaging (certificate required)", parentSlug: "packaging-materials", icon: "triangle-alert", sortOrder: 18,
      aliases: ["un drum", "un certified drum", "dg packaging", "ibc tank"],
      note: "Drums, jerrycans and IBCs sold as UN-rated for dangerous goods. Listing without a certificate reference is not approved.",
      attributes: [
        { key: "item", label: "Item", type: "select", required: true, options: ["Steel drum", "Plastic drum", "Jerrycan", "IBC"] },
        { key: "capacity_l", label: "Capacity", type: "number", unit: "l", required: true },
        { key: "un_code", label: "UN marking", type: "text", required: true },
      ],
      variantAxes: ["item", "capacity_l"],
      units: { price: ["piece"], moq: ["piece"], defaultPrice: "piece", defaultMoq: "piece", typicalMoq: 10 },
      hsn: ["3923", "7310"],
      regulations: [{ kind: "un-dg", standard: "UN packaging performance marking (dangerous goods)", requiresCertificate: true, verifiedOn: "2026-10-06", note: "Unverified in this desk pass: confirm the applicable Indian authority and testing regime with counsel." }],
    },

    // ---- prohibited ------------------------------------------------------------------------------------------------
    {
      slug: "banned-single-use-plastics", name: "Banned Single-use Plastics (prohibited)", parentSlug: "packaging-materials", icon: "ban", sortOrder: 99, prohibited: true,
      note: "Identified single-use plastic items (plastic sticks for ear buds and balloons, plastic cutlery, plates, cups, straws, thermocol for decoration, thin wrapping films, etc.) are banned under the Plastic Waste Management Amendment Rules (from 2022-07-01). Unverified in this desk pass: confirm the list with counsel.",
      aliases: ["plastic straw", "plastic cutlery", "thermocol plate", "plastic cup", "plastic spoon"],
    },
  ],
};

export const PACKAGING_BENGALURU: Playbook = PlaybookSchema.parse(input);
