// India Post PIN prefix -> state / union territory (ADR-022). PIN structure: digit 1 = postal zone, digits 1-2 = sub-zone
// ("circle" region), digits 1-3 = sorting district. Lookup is longest-prefix-wins over prefixes of 2 to 6 digits, so a
// 2- or 3-digit default can carry precise exceptions where a postal circle straddles a state border (Uttarakhand /
// Uttar Pradesh, Jharkhand / Bihar, Puducherry enclaves, Daman and Diu, Lakshadweep, ...). Slugs are kebab-case names.
// Source: the India Post PIN code directory structure; exceptions are the well-known straddles, not every border village.
// 9x prefixes are the Army Postal Service (not a place) and are deliberately absent.

const table: Record<string, string> = {};
const put = (state: string, ...prefixes: string[]): void => { for (const p of prefixes) table[p] = state; };
/** inclusive range of 3-digit sorting districts */
const span = (state: string, from: number, to: number): void => { for (let n = from; n <= to; n++) table[String(n)] = state; };

// ---- 2-digit defaults (postal sub-zones) ------------------------------------------------------------------------------------
put("delhi", "11");
put("haryana", "12", "13");
put("punjab", "14", "15", "16");
put("himachal-pradesh", "17");
put("jammu-and-kashmir", "18", "19");
put("uttar-pradesh", "20", "21", "22", "23", "24", "25", "26", "27", "28");
put("rajasthan", "30", "31", "32", "33", "34");
put("gujarat", "36", "37", "38", "39");
put("maharashtra", "40", "41", "42", "43", "44");
put("madhya-pradesh", "45", "46", "47", "48");
put("chhattisgarh", "49");
put("telangana", "50");
put("andhra-pradesh", "51", "52", "53");
put("karnataka", "56", "57", "58", "59");
put("tamil-nadu", "60", "61", "62", "63", "64");
put("kerala", "67", "68", "69");
put("west-bengal", "70", "71", "72", "73", "74");
put("odisha", "75", "76", "77");
put("assam", "78");
put("bihar", "80", "81", "82", "83", "84", "85");

// ---- 3-digit sorting-district overrides -------------------------------------------------------------------------------------
put("chandigarh", "160");
put("ladakh", "194");
put("goa", "403");
span("uttarakhand", 246, 246); span("uttarakhand", 248, 249); span("uttarakhand", 263, 263);
put("sikkim", "737");
put("andaman-and-nicobar-islands", "744");
span("arunachal-pradesh", 790, 792); put("meghalaya", "793", "794"); put("manipur", "795"); put("mizoram", "796");
put("nagaland", "797", "798"); put("tripura", "799");
// Jharkhand: 814-816 (Dumka/Giridih/Sahibganj), 822, 825-829 (Palamu/Hazaribagh/Koderma/Bokaro/Dhanbad), 831-835 (Singhbhum/Ranchi)
span("jharkhand", 814, 816); put("jharkhand", "822"); span("jharkhand", 825, 829); span("jharkhand", 831, 835);

// ---- 4 to 6 digit exceptions (postal circles that straddle a border) --------------------------------------------------------
put("uttarakhand", "2447", "2624", "2625", "24765", "24766");        // Udham Singh Nagar / Pithoragarh / Champawat / Roorkee
put("uttar-pradesh", "2467");                                          // Bijnor sits inside the 246 (Pauri/Chamoli) district
put("puducherry", "6050", "6051", "6096", "67331", "533464");          // Pondicherry proper, Karaikal, Mahe, Yanam enclaves
put("lakshadweep", "68255");                                           // Kavaratti and the other islands (Kerala circle)
put("dadra-and-nagar-haveli-and-daman-and-diu", "36252", "39621", "39622", "39623", "39624"); // Diu, Daman, Silvassa

export const PIN_PREFIX_STATE: Readonly<Record<string, string>> = table;
export const PIN_MAX_PREFIX = 6;
export const PIN_MIN_PREFIX = 2;
