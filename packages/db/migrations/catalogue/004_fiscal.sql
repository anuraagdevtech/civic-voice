-- Public finances: taxes collected by category, other receipts, and spending by sector — per
-- government (the Union at the country region, a state at its region), financial year and stage.
SET search_path TO civic_catalogue;

CREATE TABLE IF NOT EXISTS fiscal_line (
  region_id    bigint        NOT NULL REFERENCES region (id),
  fy           text          NOT NULL CHECK (fy ~ '^\d{4}-\d{2}$'),
  -- Budget estimate, revised estimate, audited actual: the same year's figure differs by stage, so a
  -- figure is never stored or shown without one.
  stage        text          NOT NULL CHECK (stage IN ('BE', 'RE', 'actual')),
  category     text          NOT NULL CHECK (category IN (
                 'income_tax', 'corporate_tax', 'gst', 'customs', 'excise', 'stamp_registration',
                 'sales_tax_vat', 'vehicle_tax', 'other_tax',
                 'non_tax_revenue', 'non_debt_capital', 'tax_devolution_received', 'grants_received',
                 'borrowing',
                 'infrastructure', 'housing_urban', 'health', 'education', 'defence',
                 'rural_development', 'agriculture', 'water_sanitation', 'subsidies_welfare',
                 'labour_employment', 'police_justice', 'administration_other', 'interest', 'pensions',
                 'transfers_to_states', 'transfers_to_local_bodies')),
  amount_crore numeric(14, 2) NOT NULL CHECK (amount_crore >= 0),
  -- Every monetary figure carries provenance. No number appears in this system without a source.
  source_name  text          NOT NULL,
  source_url   text          NOT NULL,
  provenance   text          NOT NULL CHECK (provenance IN ('official', 'news', 'sample')),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, fy, stage, category)
);
