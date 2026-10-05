# Phase-1 vertical selection: desk research (ADR-011)

Status: desk research, 2026-10-06. Nothing here is field-validated. Market-size figures come from commercial research summaries (IMARC, Ken Research, Grand View and similar) that disagree with each other by 2-3x, so treat every size as an order of magnitude. Competitor numbers come from trade-press summaries of filings. Claims that no source supported are marked **[unverified]** and become interview questions in `docs/adr/ADR-011-vertical-selection.md`.

## 1. Question

ADR-011 shortlists four verticals and asks us to pick one for Phase 1: (a) industrial MRO and safety supplies, (b) packaging materials, (c) construction hardware and fasteners, (d) apparel/textile job-work (Tiruppur-Bengaluru). Criteria: high fraud/quality pain, structured specs (embeddable), repeat purchase, Bengaluru-reachable seller clusters, low regulatory risk. The ADR leans to (a) or (b).

## 2. Scored matrix

Scores run 1 (worst) to 5 (best) per criterion; "regulatory" and "competition" are scored so that 5 = low risk / open field. Weights sum to 100. Weighted score = sum(weight x score) / 5, so the maximum is 100.

| Criterion | Weight | (a) MRO and safety | (b) Packaging | (c) Fasteners and hardware | (d) Apparel job-work |
|---|---|---|---|---|---|
| Fraud / quality pain | 20 | 4 | 4 | 4 | 5 |
| Structured, embeddable specs | 20 | 3 | 5 | 5 | 2 |
| Repeat purchase frequency | 15 | 5 | 5 | 4 | 3 |
| Bengaluru-reachable seller clusters | 15 | 4 | 5 | 4 | 4 |
| Regulatory risk (5 = low) | 15 | 2 | 4 | 1 | 3 |
| Competitive whitespace (5 = open) | 10 | 2 | 3 | 3 | 4 |
| Average order value / unit economics | 5 | 3 | 3 | 3 | 3 |
| **Weighted score (/100)** | 100 | **68** | **87** | **72** | **69** |

Sensitivity: with equal weights the means are (b) 4.1, (c) 3.4, (d) 3.4, (a) 3.3, so (b) still leads; (b) scores 4 or 5 on every criterion except competition and order value (3). The 15-point margin over the runner-up is large relative to the noise of desk research, but scores are single-analyst judgements, so field validation can still flip them.

Recommendation: **(b) packaging materials**, with **(a) MRO and safety** as the first Phase-2 expansion candidate (ADR-016), because it shares buyers (a packaging buyer is a factory buying MRO) but carries QCO exposure that needs a certificate-gated listing flow first.

## 3. Evidence per vertical

### 3.1 Market size, competition, order value

| | (a) MRO and safety | (b) Packaging | (c) Fasteners | (d) Apparel job-work |
|---|---|---|---|---|
| Market size (India) | MRO USD 56.1bn in 2024 per IMARC [S1]; NITI Aayog's report gives a far smaller organised figure (USD 1.7bn in 2021, 4bn by 2031) [S2]. PPE USD 2.2-2.8bn in 2025, gloves the largest segment (41.5%) [S3] | Packaging USD 94bn in 2025 [S4]; corrugated boxes USD 8.6bn in 2025, 40% of paper packaging [S4][S5]; 22,000+ units, about 85% small or medium [S5] | Fasteners USD 11.2bn in 2025 (IMARC) or USD 8.0bn (MarketsandMarkets) [S6] | Tiruppur exports above Rs 46,000 crore in 2025-26, about 55-60% of knitwear exports, around 20,000 units, most single-stage [S7]. Bengaluru: 1,200+ factories, 5 lakh+ workers [S8] |
| Competitive density | High. Moglix (FY25 operating revenue USD 681m [S9]; catalogue of 3-5 lakh SKUs in MRO and packaging [S9]), OfBusiness (FY25 revenue about Rs 22,500 crore, mostly metals and commodities, outside the MSME-lead space [S10]), IndiaMART (217,000 paying suppliers, 119m listings, 56 industries [S11]) | Medium. Moglix lists packaging [S9] and IndiaMART has many box makers [S11], but the long tail of local corrugated and film converters sells through phone and WhatsApp; no packaging-specialist marketplace surfaced in the search [unverified] | Medium. Strong on IndiaMART (Ludhiana, Rajkot, Mumbai sellers) [S11]; Moglix sells branded fasteners [S9] | IndiaMART has a "garment job work Bengaluru" directory [S12]; no AI-matched, trust-scored alternative found |
| Udaan | FY25 operating revenue Rs 4,561 crore, down 54% from FY22; FMCG/staples-led, not an industrial competitor [S13] | same | same | same |
| Typical order value | Safety kits and consumables: Rs 5k-50k per order [unverified] | Corrugated boxes: Rs 10k-2 lakh per PO, monthly [unverified]; sample prices on lntsufin-type listings are per-piece [S14] | Rs 5k-1 lakh per PO [unverified] | Per-job Rs 50k-10 lakh by volume [unverified] |
| GST HSN coverage | Fragmented: 6506 (helmets), 6401-6403 (footwear), 4015 (gloves), 8424 (extinguishers) and others; many catalogue SKUs are branded | Clean: 4819 (cartons), 4808 (corrugated paper), 4804/4805 (kraft/board), 3923 (plastic packing), 3919 (tapes), 6305 (sacks), 7010 (glass jars). Corrugated boxes moved from 12% to 5% GST on 2025-09-22 while kraft paper and board went from 12% to 18% [S15] | Clean: 7318 (screws, bolts, nuts), 7317, 7415 | Chapters 61/62 for goods; job-work is a service (SAC 9988) so no HSN for the transaction itself |

### 3.2 Fraud and quality pain

| Vertical | Observed pain | Source |
|---|---|---|
| (a) | Counterfeit ISI marks on helmets are documented; BIS and CCPA raids on fake IS marks [S16]. IS 2925 industrial helmets are under a Quality Control Order (BIS licence required) [S17] | [S16][S17] |
| (b) | Spec shortfall is the classic complaint: only 90.4% of surveyed corrugated master cartons met the bursting-strength spec, blamed on poor kraft liner [S18]. Ply, GSM, burst factor (BF) and burst strength are all measurable but rarely verified at order time | [S18] |
| (c) | Grade and property-class misrepresentation (8.8 vs 4.6, plating) is a recognised hazard; the March 2025 QCO on steel fasteners itself shows policy concern about quality [S19] | [S19] |
| (d) | Payment delays and wage disputes in the Bengaluru garment hub [S20]; job-work buyers squeeze stitchers (US-tariff-era discount demands of 20-25% on Tiruppur MSMEs) [S7]; delayed-payment recovery runs through MSME Samadhaan [S21] | [S7][S20][S21] |

Caveat: for all four, our evidence is anecdotal or indirect. The interview script asks sellers and buyers for the last three bad orders to get first-party incident rates.

### 3.3 Specs (embeddability)

- (b) Packaging is the most structured: corrugated boxes are fully described by L x W x H, ply (3/5/7), liner and flute GSM, burst factor, flute type (B/C/E), printing, and quantity. The eval fixtures already extract `ply` and `gsm` from Hinglish text (`packages/ai/evals/data/extraction.json`), which is evidence the extraction path works on this vertical today.
- (c) Fasteners are equally structured (diameter, length, property class, plating, standard), but deep-tail SKUs (hex bolt M12 x 60 class 8.8 zinc) are a catalogue problem; the standard parts are close to commodities.
- (a) MRO is brand and part-number driven; safety items have standard attributes (EN/IS class) but much of MRO is long-tail SKUs where search by part number beats embeddings.
- (d) Job-work is capability matching (machines, operations, capacity, quality system) and per-job quoting; weak fit for attribute-schema search.

### 3.4 Repeat purchase

(a), (b), (c) are consumables bought monthly or on every production run. (b) is the strongest because boxes are consumed per dispatch and re-ordered at near-identical spec. (d) repeat exists but is seasonal and relationship-driven.

### 3.5 Bengaluru-reachable seller clusters

- **Peenya Industrial Area**: about 13,000 MSMEs, 1,461 acres, 5 lakh+ workers [S22]; corrugated box makers sit at Peenya 1st and 2nd stage [S23].
- **Jigani** (Jigani-I about 4,250 units, Jigani-II about 4,680 per the DC-MSME profile) [S22][S23]; Optimum Packaging Solutions is a Jigani corrugated maker [S23].
- **Bommasandra** (Electronic City / Anekal belt, 1,119 hectares acquired) [S22].
- **Nelamangala-Dabaspete (Dobbaspet)** along NH-48 [S23] and **Doddaballapura** (integrated textile and apparel park) [S8].
- **Hosur** (Tamil Nadu, about 40 km from Bengaluru, 3,000+ MSMEs, recognised engineering auto-component cluster) [S24].
- **Tumakuru** (Vasanthanarasapura, Karnataka's second industrial belt): named in the brief; the search returned nothing usable, so its seller counts are **[unverified]**.
- Apparel (d): Peenya, Mysore Road, Bommanahalli; workforce about 80% migrants from Bengaluru Rural, Chikkaballapur, Kolar, Ramanagara and Tumakuru districts [S8]. Tiruppur is roughly 450 km away, so "Tiruppur-Bengaluru" is two clusters joined by logistics, not one reachable cluster.

Per-cluster counts of packaging units specifically were not found; the 22,000 national figure [S5] and the named makers [S23] only prove presence. The seller-acquisition target (200 verified sellers, ADR-016) needs a ground census in Peenya, Jigani, Nelamangala and Bommasandra (interview step 1).

### 3.6 Regulatory risk

| Vertical | Position (as of the dates in the sources) |
|---|---|
| (a) | **High.** IS 2925 industrial safety helmets: BIS licence mandatory under the 2023 QCO with MSME deadlines through 2024 [S17]. Safety footwear (IS 15298 Part 2) is under the footwear QCO regime [S17]. Gloves: status not confirmed in the search **[unverified]**. Counterfeit ISI marks are common [S16]. A platform listing uncertified helmets would be exposed |
| (b) | **Low to medium.** No BIS QCO found for corrugated boxes (IS 2771 is a voluntary standard) **[unverified, confirm with BIS before launch]**. Polymer raw-material QCOs were rescinded in Nov 2025 [S25]. Real exposure sits in: FSSAI food-contact packaging rules and IS 10146/12252/1397 style requirements [S26]; the 40% recycled-content rule for food-grade plastic packaging with IS 14534 [S26]; single-use plastic and thin carry-bag bans and EPR under the Plastic Waste Management Rules **[unverified in this search; widely known, confirm text]**; jute reservation norms for foodgrain and sugar packing **[unverified]** |
| (c) | **High and unstable.** Steel fasteners QCO (IS 1363/1364 parts) took effect around 2025-03-20 and caused import shortages [S19]; the Steel Ministry is consulting on easing or removing it, and a Nov 2025 notification deferred enforcement for some steel products by 1-3 years [S19][S27]. Compliance state could change under a live marketplace |
| (d) | **Medium.** No BIS issue; labour-law and wage-compliance exposure when brokering job-work [S20]; MSME delayed-payment law applies [S21] |

QCO rollback trend: the Centre withdrew QCOs on 14 polymer/fibre items from 2025-11-12 and about 69 in total by late 2025 [S25], which lowers risk for packaging inputs and shows the regime moves fast.

### 3.7 Language mix of sellers

No source gave a language census of packaging, MRO or fastener sellers. What the evidence supports: Peenya's workforce is largely rural Karnataka (Kannada) [S22][S8]; Hosur serves Tamil Nadu and Karnataka [S24]; owners and traders in packaging and hardware in Bengaluru are commonly Hindi/Hinglish-speaking (Marwari and North Indian trading communities) and Kannada-, Telugu- and Tamil-speaking industrialists **[unverified, hypothesis]**. Our own eval fixtures already carry Hinglish listing text for this vertical (`gatta dabba 5 ply`). ADR-004 keeps web at en/hi; seller app has 8 locales, so ordering affects seller app and WhatsApp copy.

## 4. Why not the others

- **MRO and safety**: biggest incumbent (Moglix), regulatory exposure on helmets/footwear, and the strongest unmet trust problem (counterfeit ISI) requires a certificate-verification flow we should build first. Good second vertical; the playbook mechanism (certificate-gated subcategories) is built in this change so it is ready.
- **Fasteners**: the best specs but the QCO is the least predictable regulatory object in the set, and Ludhiana/Rajkot, not Bengaluru, are the home clusters.
- **Apparel job-work**: the sharpest trust pain (payment) but weak embeddability, a payments/escrow dependency that is Phase 2 (ADR-012), seasonal demand and a corridor that is not Bengaluru-reachable for the Tiruppur half.

## 5. Risks to the recommendation

1. Packaging is price-led and heavy; buyers may prefer a known local converter by phone, which makes the trust and spec-verification angle (not price discovery) the product. Interviews must test willingness to pay for verified spec.
2. Corrugated boxes are low-value per kg and shipping-bound, which concentrates demand into a roughly 100-150 km radius of each plant; Bengaluru-only liquidity may cap early GMV [unverified].
3. GST 2.0 raised raw-board GST to 18% while boxes are 5% [S15]; this inverted duty structure squeezes small converters and could push them to unbilled sales, lowering GST-verified seller counts.
4. FSSAI-linked food-contact claims are the likeliest compliance incident; the playbook flags them as certificate-gated.
5. Evidence is desk-only. See flip conditions in the ADR.

## 6. Sources

| ID | URL |
|---|---|
| S1 | https://www.imarcgroup.com/india-maintenance-repair-operations-market |
| S2 | https://www.niti.gov.in/sites/default/files/2022-10/MRO_Report-FINAl.pdf |
| S3 | https://www.imarcgroup.com/india-personal-protective-equipment-market , https://www.grandviewresearch.com/horizon/outlook/personal-protective-equipment-ppe-market/india |
| S4 | https://www.kenresearch.com/industry-reports/india-packaging-market |
| S5 | https://www.imarcgroup.com/india-corrugated-boxes-market , https://www.imarcgroup.com/india-paper-packaging-market |
| S6 | https://www.imarcgroup.com/india-fasteners-market , https://www.marketsandmarkets.com/Market-Reports/geography/industrial-fasteners-market/india |
| S7 | https://www.business-standard.com/industry/news/knitwear-capital-tiruppur-scales-record-rs-40k-cr-exports-in-fy25-125041601057_1.html , https://www.deccanherald.com/amp/story/business%2Ftiruppur-knitwear-teeter-towards-layoffs-as-us-tariffs-stall-goods-worth-up-to-rs-2000-crore-3770505 |
| S8 | https://investkarnataka.co.in/key-industrie/textile-and-apparel/ , https://en.wikipedia.org/wiki/Doddaballapura , https://scroll.in/article/834986/for-bengalurus-garment-hub-workers-the-minimum-wage-is-actually-the-maximum-wage |
| S9 | https://inc42.com/buzz/moglix-fy25-revenue-inches-closer-to-700-mn-mark-loss-halves/ , https://startuptalky.com/moglix-success-story/ |
| S10 | https://inc42.com/company/ofbusiness/financials/ |
| S11 | https://investor.indiamart.com/files/IndiaMART_Annual_Report_FY_2024-25.pdf , https://india.entrepreneur.com/news-and-trends/indiamart-closes-fy25-with-a-net-profit-of-inr-181-crore/490851 |
| S12 | https://dir.indiamart.com/bengaluru/garment-job-work.html |
| S13 | https://startuptalky.com/udaan-business-revenue-model/ , https://www.vanik.com/blogs/udaan-b2b-wholesale-ecommerce-india/ |
| S14 | https://lntsufin.com/product/3-ply-12-x-12-x-18-inch-5-kg-brown-corrugated-boxes/16246-376 |
| S15 | https://eicbma.com/new-gst-rates-wef-220925.pdf , https://www.icicidirect.com/research/equity/trending-news/the-gst-rate-rationalisation-which-will-come-into-effect-from-september-22-2025 , https://blog.saginfotech.com/high-gst-rate-kraft-paper-raises-corrugated-packaging-industry |
| S16 | https://moneylife.in/article/bis-cracks-down-on-amazon-and-flipkart-sellers-for-fake-isi-mark-substandard-goods/76755.html , https://www.deccanchronicle.com/southern-states/andhra-pradesh/bis-seizes-non-isi-helmets-in-vijayawada-raid-1972866 |
| S17 | https://axiscomplience.in/bis-qco-specification-for-industrial-safety-helmets-is-2925/ , https://www.bis.gov.in/wp-content/uploads/2025/01/Revised-PM-IS-15298-Part-4.pdf |
| S18 | https://epubs.icar.org.in/index.php/FT/article/download/27400/12462/60568 |
| S19 | https://www.deccanchronicle.com/business/economics/qco-on-steel-fasteners-to-disrupt-production-across-industries-1866476 , https://www.steelorbis.com/steel-news/latest-news/gtri-indian-government-should-withdraw-quality-control-order-on-steel-fasteners-imports-likely-to-come-to-a-halt-1383590.htm |
| S20 | https://scroll.in/article/834855/the-bengaluru-workers-who-stitched-your-branded-clothes-have-probably-still-not-been-paid |
| S21 | https://www.iifl.com/blogs/other/msme-samadhaan-portal-how-to-file-delayed-payment-complaint |
| S22 | https://theindustrialbusiness.com/peenya-industrial-area-bengaluru/ , https://www.dcmsme.gov.in/dips/2016-17/Bengaluru%20Urban.pdf , https://en.wikipedia.org/wiki/Jigani |
| S23 | https://www.tatanexarc.com/company/vaishnavi-packaging-industries-utn3526vai49kue/ , https://m.indiamart.com/optimumpackaging-solutions , https://m.indiamart.com/a-onepackagingco , https://addressadvisors.com/blog/top-5-warehousing-hubs-in-bangalore-for-logistics |
| S24 | https://www.autocarpro.in/news-national/hosur-vendors-charge-destiny-1154 , https://deccanherald.com/india/on-bengalurus-doorstep-hosurs-meteoric-rise-1101382.html |
| S25 | https://www.business-standard.com/industry/news/no-bis-certification-required-qcos-for-plastics-synthetic-fibres-scrapped-125111301885_1.html , https://www.chemradar.com/en/news/detail/f5fv97h6hurk , https://www.elitasrcs.com/articles/qcos-withdrawn-by-central-government-complete-updated-list |
| S26 | https://www.fssai.gov.in/upload/uploadfiles/files/Compendium_Packaging_Labelling_Regulations_04_08_2021.pdf , https://www.wasterecyclingmag.com/news/plastic-recycling/indian-government-notifies-final-guidelines-mandating-use-of-40-recycled-content-in-food-grade-packaging |
| S27 | https://knnindia.co.in/news/newsdetails/msme/steel-ministry-seeks-feedback-on-easing-bis-norms-for-fastener-industry , https://www.business-standard.com/industry/news/steel-import-bis-certification-rule-delayed-india-quality-control-125070801332_1.html |
