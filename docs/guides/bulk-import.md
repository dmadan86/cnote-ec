# Bulk import and export (sellers)

Add or update many products at once from an Excel or CSV file, or from a ZIP that also holds your product photos. You can also download all your listings in the same format, edit them and upload them again.

Find both under **Listings > Import** and **Listings > Export**.

## Quick start

1. Open **Listings > Import** and download **Template (Excel)**, **Template (CSV)** or the **Starter kit (ZIP with examples)**.
2. Fill one product per row. The three grey `EXAMPLE` rows are skipped automatically.
3. Choose **create new only** or **create and update by SKU**, and whether to **submit for review** after importing.
4. Upload the file. We check every row first (a dry run) and list every problem with its row and column. **Nothing is imported until you confirm.**
5. Fix problems and re-upload, or download the error report (your failing rows plus an `errors` column), fix just those rows and upload that file. You can also import only the valid rows and skip the rest, but only if you say so explicitly.
6. Confirm. Progress updates live; you can leave the page.

## Columns

Headers are not case sensitive. `*`, and anything in brackets, in a header is ignored, so `sku*` and `SKU` are the same column. Column order does not matter.

| Column | Required | Rules |
|---|---|---|
| `sku` | yes | Your own product code. Letters, digits, `.` `_` `-`, up to 64 characters, unique in the file and among your listings. Rows whose SKU starts with `EXAMPLE` are skipped. |
| `title` | yes | 3 to 200 characters. |
| `category` | yes | Category slug from the template's Categories sheet (the category name also works). Prohibited categories are rejected. |
| `description` | no | Up to 5000 characters. At least 10 characters when you submit for review. |
| `price_rupees` | no | Rupees per `price_unit`, at most 2 decimals, for example `12.50`. Empty means "ask for price". |
| `price_unit` | no | For example `piece`, `kg`, `meter`. |
| `moq` | no | Minimum order quantity, whole number, 1 or more. |
| `moq_unit` | no | Unit of the minimum order. |
| `hsn` | no | 4 to 8 digits. Format the column as text in Excel to keep leading zeros. |
| `language` | no | `en`, `hi`, `kn`, `ta`, `te`, `mr`, `gu`, `bn`. Default `en`. |
| `image_files` | no | ZIP uploads only. Comma-separated file names from the `images/` folder, for example `box-1.jpg, box-2.jpg`. Up to 8. |
| `image_urls` | no | `https://` links, comma-separated, kept as reference images (we do not download them). |
| `attr:<name>` | depends | One column per category attribute, for example `attr:gsm`. The header shows the label and unit, for example `attr:gsm* (GSM, g/m2)`. Numbers must be numbers; selects must match one of the allowed options (case does not matter). Required attributes must be filled when you submit for review. |

An attribute column only applies to products in a category that has that attribute; a value in any other row is reported as an error.

### Examples

| sku | title | category | price_rupees | price_unit | moq | moq_unit | hsn | attr:gsm |
|---|---|---|---|---|---|---|---|---|
| BOX-12x9x6 | Corrugated shipping box 12x9x6 in, 5-ply | packaging-boxes | 18.50 | piece | 500 | piece | 48191010 | 300 |
| TS-180-M | Men's round-neck cotton T-shirt, 180 GSM | cotton-tshirts | 145 | piece | 100 | piece | 61091000 | 180 |
| PIPE-2IN | MS ERW round pipe 2 inch, IS 1239 | ms-pipes | 84000 | tonne | 5 | tonne | 73063090 | |

## File types

* **Excel (.xlsx)**: the `Products` sheet, or the first sheet if there is none.
* **CSV (.csv)**: UTF-8 (with or without BOM) or Windows-1252; comma, semicolon or tab separated.
* **ZIP (.zip)**: exactly one `products.csv` or `products.xlsx` at the top level (or inside one folder) and an `images/` folder:

```
my-products.zip
  products.xlsx
  images/
    box-1.jpg
    box-2.jpg
    tshirts/red-front.png
```

Reference nested images by their path inside `images/`, for example `tshirts/red-front.png`. A plain file name works when it is unique.

## Limits

* 5,000 products per file (split bigger catalogues).
* ZIP: 200 MB, 500 MB unzipped, 2,000 files, 5 MB per image, at most 8 images per product. CSV / Excel: 50 MB.
* Images: JPEG, PNG or WebP, 200 to 6000 px.
* 10 imports per hour; one import running at a time. Starting a new upload replaces an earlier one you never confirmed.
* Uploaded files, reports and exports are deleted 7 days after the job finishes.

## What happens to imported products

* Products are created or updated as **drafts** (your working copy). Buyers do not see anything until a version is submitted and approved.
* With **submit for review**, each product is submitted right after it is saved and follows the normal checks: automatic screening and, unless you are a trusted seller, staff review.
* **Photos go through staff approval**, exactly like photos added one by one. They appear on the live listing only after they are approved. Re-importing the same photo does nothing.
* **Update by SKU**: existing SKUs are updated, new ones created. An empty cell leaves the existing value unchanged (to clear a value, edit the listing in the editor). Attributes are merged with existing ones.
* Archived listings cannot be updated.

## Export

**Listings > Export** creates an Excel or CSV file of all your non-archived listings, optionally with a ZIP of photos (`images/<sku>-<n>.<ext>`, rejected photos left out). The columns are the same as the import template, plus read-only `status`, `review_state` and `live_version` columns that are ignored on import. Listings without a SKU are given one (like `L-3F9A1C2B`) so the file can be edited and imported again with "update by SKU".

## FAQ

**Can I import from another marketplace's export?** Rename the headers to the template's, or copy your rows into the template.

**My file says "Missing required column".** The header row must contain `sku`, `title` and `category`. Use the template.

**Some rows have errors. Do I lose everything?** No. You choose: fix and re-upload, or import the valid rows and skip the rest. The error report contains only the failing rows so you can upload them again after fixing.

**The import stopped or my browser closed.** Imports run on our servers. Open Listings > Import to see the recent imports. If a job is retried it continues where it left off and does not create duplicates.

**Why is my image not visible on my listing?** Photos are approved by our team first. Check the listing's photo status.

**Excel changed my HSN or SKU (leading zeros gone).** Format those columns as Text before typing, or use the CSV template.

## API

Sellers with an API key (scopes `listings:write` / `listings:read`) can automate this. See `docs/api/openapi.json`, tag "Bulk import and export":

* `POST /v1/seller/bulk/imports` (multipart: `file`, `mode`, `submit_for_review`)
* `GET /v1/seller/bulk/jobs/{id}`, then `POST /v1/seller/bulk/jobs/{id}/confirm` (`{ "skipInvalid": false }`) or `.../cancel`
* `POST /v1/seller/bulk/exports` (`{ "format": "xlsx", "includeImages": false }`)
* `GET /v1/seller/bulk/jobs/{id}/download?which=result|errors|source`
