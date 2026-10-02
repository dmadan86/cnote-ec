import type { ModerateInput, ModerateOutput } from "../index";
import type { ProviderResult } from "../types";
import { HEURISTIC_MODEL } from "./intent";

export const MODERATE_HEURISTIC_VERSION = "moderate-heuristic-v3";

interface Rule { cls: string; strong: RegExp[]; weak: RegExp[] }

// Prohibited categories per ADR-003. Strong = block, weak = human review.
// Lookarounds carve out common legitimate B2B phrases (injection moulding, glue gun, acid-free paper).
// Devanagari terms use plain substring patterns because \b is ASCII-only in JS.
const RULES: Rule[] = [
  {
    cls: "pharma",
    strong: [
      /\bschedule\s*h\b/, /\bcodeine\b/, /\btramadol\b/, /\balprazolam\b/, /\bsildenafil\b/, /\bnimesulide\b/,
      /\bprescription\s+(?:drug|medicine|tablet)s?\b/, /\binjections?\b(?!\s*(?:mou?ld|molding|machine|pump|grade|nozzle|plastic))/,
      /\btablets?\b(?=[^.]{0,40}\b(?:mg|strip|medicine|drug|pharma)\b)/, /\b(?:mg)\s+(?:tablets?|capsules?)\b/,
    ],
    weak: [/\b(?:tablets?|capsules?|syrup|antibiotics?|medicines?|dawai|dawa|drugs?)\b(?!\s*(?:pc|computer|holder|cover|stand|case))/, /दवा(?:ई|इयां)?/],
  },
  {
    cls: "narcotics",
    strong: [/\bbhang\b/, /\bbrown\s+sugar\b/, /\b(?:cocaine|heroin|mdma|opium|afeem|charas|ganja|marijuana|cannabis|weed|lsd)\b/, /अफीम|गांजा|चरस/],
    weak: [],
  },
  {
    cls: "explosives",
    strong: [
      /\bexplosives?\b/, /\bgun\s*powder\b|\bgunpowder\b/, /\bdetonators?\b/, /\bdynamite\b/, /\bammonium\s+nitrate\b/,
      /\bfire\s*works?\b/, /\bfire\s*crackers?\b/, /\bpatakh?[ae]s?\b/, /(?<!\bbath\s)\bbombs?\b(?!\s*(?:proof|disposal|calorimeters?|shelters?))/, /पटाख[ेा]|बारूद/,
    ],
    weak: [/\bsparklers?\b/, /\bflare\b/],
  },
  {
    cls: "weapons",
    strong: [
      /\bpistols?\b/, /\brevolvers?\b/, /\brifles?\b/, /\bammunition\b/, /\bbullets?\b(?!\s*(?:train|point|proof))/, /\bak\s*-?\s*47\b/,
      /\bkatta\b/, /\bbandook\b/, /\btamancha\b/, /\bhathiyar\b/, /\bcountry\s*made\s+(?:gun|pistol)/, /\bstun\s+gun\b/, /\bcombat\s+knife|\bbutterfly\s+knife|\bswitch\s*blade\b|\btrench\s+knife/, /बंदूक|कट्टा|कारतूस/,
    ],
    weak: [/(?<!\b(?:glue|spray|heat|grease|staple|nail|paint|air|hot\s+melt|caulking|water)\s)\bguns?\b/, /\btalwar\b|\bswords?\b/, /\bpepper\s+spray\b/, /\bknuckle\s*dusters?\b/],
  },
  {
    cls: "hazardous_chemicals",
    strong: [
      /\bsodium\s+cyanide\b/, /\bpotassium\s+cyanide\b/, /\bendosulfan\b/, /\bmonocrotophos\b/, /\bparaquat\b/, /\bmethyl\s+parathion\b/, /\bddt\b/,
      /\bmercury\s+(?:metal|liquid)\b/, /\bsulphuric\s+acid\b|\bsulfuric\s+acid\b|\bnitric\s+acid\b|\bhydrochloric\s+acid\b/,
    ],
    // Mercury-containing instruments (thermometers, barometers, manometers) are restricted: route to a human.
    weak: [/\bmercury\b(?!\s*(?:ltd|limited|pvt|private|brand|enterprises?|industries|traders|free))/, /\bacids?\b(?!\s*(?:free|proof|resistant|wash\s+free))/, /\bpesticides?\b|\binsecticides?\b|\bherbicides?\b/, /\btoxic\b/, /\basbestos\b/, /तेज़ाब|तेजाब|कीटनाशक/, /\btezaab\b|\bkeetnashak\b/],
  },
  {
    cls: "wildlife",
    strong: [
      // "ivory" is also a colour name in paints, fabrics, paper and tiles.
      /(?<!\b(?:colou?r|shade|tone)\s)\bivory\b(?!\s*(?:white|colou?r(?:ed)?|shade|finish|paper|cream|tone|paint|fabric|silk|tiles?|board|card|sheet))/, /\btusks?\b/, /\bshahtoosh\b/, /\bpangolin\b/, /\brhino\s+horn\b/, /\b(?:tiger|leopard|lion)\s+(?:skin|claw|nail)s?\b/, /\bhathi\s*dant\b/, /हाथी\s*दांत/,
    ],
    weak: [/\bred\s+sanders?\b|\bsnake\s+skin\b|\bpython\s+skin\b|\bmor\s*pankh\b|\bpeacock\s+feathers?\b/, /\bexotic\s+(?:animal|bird)s?\b/],
  },
  {
    cls: "counterfeit",
    strong: [
      /\bfirst[\s-]*copy\b|\b1st[\s-]*copy\b/, /\bmaster[\s-]*copy\b/, /\bmirror[\s-]*copy\b/, /\bsuper[\s-]*copy\b/, /\breplicas?\b/, /\bduplicate\s+(?:brand|nike|adidas|rolex|apple|gucci|puma)/,
      /\b7a\s+quality\b/, /\bbranded\s+copy\b/, /\bcopy\s+of\s+(?:nike|adidas|rolex|apple|gucci|puma|louis)/,
    ],
    weak: [/\bfake\b/, /\bnakli\b/, /\bclones?\b/, /\bduplicate\b/, /नकली|डुप्लीकेट/, /\bunbranded\s+but\s+brand\b/],
  },
  {
    cls: "adult",
    strong: [/\bporn(?:o|ography)?\b/, /\bxxx\b/, /\bescort\s+service/, /\bsex\s+toys?\b/, /\bvibrators?\b/, /\bnude\b/],
    weak: [/\blingerie\b/, /\bsexy\b/, /\badult\s+(?:toys?|content|products?)\b/, /\bcondoms?\b/],
  },
  {
    cls: "tobacco_alcohol",
    strong: [/\bvap(?:e|es|ing)\b/, /\be-?\s?cig(?:arette)?s?\b/, /\bgutk(?:h)?a\b/, /\bhookah\s+(?:flavou?r|tobacco)/],
    weak: [
      /\btobacco\b|\bcigarettes?\b|\bbidi\b|\bhookah\b|\btambaku\b|\bkhaini\b|\bsharab\b/, /\b(?:alcohol|whisky|whiskey|vodka|liquor|beer|daru|daaru|rum|wine)\b(?!\s*(?:wipe|swab|pad))/, /शराब|दारू|तंबाकू/,
    ],
  },
];

// ---- Evasion-aware pass --------------------------------------------------------------------------------
// Sellers of prohibited goods obfuscate: letter spacing (p i s t o l), leetspeak (tramad0l, tr@madol),
// look-alike Cyrillic/Greek letters (tramаdol), and split words (tram-adol, gan ja). The second pass matches the
// same strong rules on de-obfuscated forms; any hit found ONLY this way is treated as intentional evasion → block.

const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", т: "t", н: "h", в: "b", ԁ: "d", ӏ: "l",
  α: "a", ε: "e", ο: "o", ι: "i", κ: "k", ν: "v", ρ: "p", τ: "t", υ: "u", χ: "x", β: "b", μ: "m",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "|": "l" };

const foldHomoglyphs = (t: string) => t.replace(/[\u0370-\u03ff\u0400-\u04ff\u0500-\u052f]/g, (c) => HOMOGLYPHS[c] ?? c);

/** Leet-decode tokens that MIX letters with substitution symbols (keeps SKUs like "7a", "ak 47", "10mg" intact). */
function deLeet(token: string): string {
  const letters = (token.match(/[a-z]/g) ?? []).length;
  if (letters < 2 || !/[0134578@$!|]/.test(token) || /^\d+[a-z]{1,3}$/.test(token)) return token;
  return token.replace(/[0134578@$!|]/g, (c) => LEET[c]!); // every char in the class has a mapping
}

/** Single words hidden across separators: checked as substrings of rejoined short-fragment runs (≥ 5 letters). */
const EVASION_TERMS = [
  "tramadol", "codeine", "alprazolam", "sildenafil", "cocaine", "heroin", "ganja", "charas", "opium", "marijuana", "cannabis",
  "pistol", "revolver", "rifle", "ammunition", "detonator", "dynamite", "explosive", "gunpowder", "ivory", "pangolin", "shahtoosh",
];

export function deobfuscate(text: string): { folded: string; runs: string[] } {
  const tokens = foldHomoglyphs(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => deLeet(t).replace(/(?<=[a-z])[-._*~]+(?=[a-z])/g, ""));
  const runs: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length >= 2) runs.push(cur.join(""));
    cur = [];
  };
  for (const t of tokens) {
    if (/^[a-z]{1,3}$/.test(t)) cur.push(t);
    else flush();
  }
  flush();
  return { folded: tokens.join(" "), runs };
}

function firstMatch(text: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

export function moderateHeuristic(input: ModerateInput): ProviderResult<ModerateOutput> {
  const text = input.text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g, "").toLowerCase().replace(/[’']/g, "");
  const strong: { cls: string; hit: string }[] = [];
  const weak: { cls: string; hit: string }[] = [];
  for (const r of RULES) {
    const s = firstMatch(text, r.strong);
    if (s) { strong.push({ cls: r.cls, hit: s }); continue; }
    const w = firstMatch(text, r.weak);
    if (w) weak.push({ cls: r.cls, hit: w });
  }
  if (!strong.length) {
    const { folded, runs } = deobfuscate(text);
    for (const r of folded === text ? [] : RULES) {
      const s = firstMatch(folded, r.strong);
      if (s) strong.push({ cls: r.cls, hit: `${s} (obfuscated)` });
    }
    for (const run of runs) {
      const term = EVASION_TERMS.find((t) => run.includes(t));
      if (!term) continue;
      const cls = RULES.find((r) => firstMatch(term, r.strong))?.cls;
      if (cls && !strong.some((x) => x.cls === cls)) strong.push({ cls, hit: `${term} (obfuscated)` });
    }
  }
  const describe = (xs: { cls: string; hit: string }[]) => xs.map((x) => `${x.cls} ("${x.hit}")`).join(", ");
  let verdict: ModerateOutput["verdict"] = "allow";
  let hits = strong;
  let confidence = text.split(/\s+/).length < 3 ? 0.75 : 0.88;
  if (strong.length) { verdict = "block"; confidence = 0.95; }
  else if (weak.length) { verdict = "review"; hits = weak; confidence = 0.6; }
  return {
    output: {
      verdict,
      flags: [...new Set(hits.map((h) => h.cls))],
      reason: verdict === "allow" ? null
        : verdict === "block" ? `Matches prohibited category: ${describe(hits)}`
        : `Possible restricted item, needs review: ${describe(hits)}`,
    },
    confidence,
    provider: "heuristic",
    modelId: HEURISTIC_MODEL,
    promptVersion: MODERATE_HEURISTIC_VERSION,
  };
}
