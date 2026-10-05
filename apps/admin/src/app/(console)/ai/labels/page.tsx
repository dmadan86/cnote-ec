import { PageHeader } from "@cnote/ui";
import { FilterActions, FilterBar, FilterField, FilterInput, FilterSelect } from "@/components/filters";
import { LABEL_CAPABILITIES } from "@/features/ai/label-export";
import { requireStaff } from "@/lib/auth";

export const metadata = { title: "Ops labels export" };

export default async function OpsLabelsPage() {
  await requireStaff("/ai/labels", "ai.labels.export");
  return (
    <>
      <PageHeader title="Ops labels export" description="Approve/reject decisions from the review queue, with the model's redacted input and output, model id, prompt version and the labeller's role, as training data for classifiers and evals (ADR-008)." />
      <p className="text-sm text-muted">
        No names, emails, phone numbers, person ids or subject ids are exported: inputs are the redacted audit copies, the labeller appears as a role, and the label time as a day. Items whose input was already purged by retention are skipped.
        CSV cells that could run as spreadsheet formulas are neutralised; JSONL is exact. Every export is audited. Dates are IST days.
      </p>
      <FilterBar label="Export labelled decisions" action="/ai/labels/export" search={false}>
        <FilterField label="From" width="md"><FilterInput type="date" name="from" /></FilterField>
        <FilterField label="To" width="md"><FilterInput type="date" name="to" /></FilterField>
        <FilterField label="Capability" width="lg">
          <FilterSelect name="capability" defaultValue="">
            <option value="">All</option>
            {LABEL_CAPABILITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </FilterSelect>
        </FilterField>
        <FilterField label="Format" width="sm">
          <FilterSelect name="format" defaultValue="jsonl">
            <option value="jsonl">JSONL</option>
            <option value="csv">CSV</option>
          </FilterSelect>
        </FilterField>
        <FilterActions submitLabel="Download" />
      </FilterBar>
    </>
  );
}
