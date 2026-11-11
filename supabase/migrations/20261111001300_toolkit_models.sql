-- Module 8 §8.11 specialist models: Built-to-Suit (bts-1.0) and investment analysis (inv-1.0).
-- Only widens deal_analysis.kind; re-runnable.
alter table mudar.deal_analysis drop constraint if exists deal_analysis_kind_check;
alter table mudar.deal_analysis add constraint deal_analysis_kind_check check (kind in (
  'brief','property_comparison','lease_economics','occupancy','conventional_vs_managed','renewal_vs_relocation',
  'fitout','financing','negotiation','deliverable','bts','investment'));
-- Rollback: delete from mudar.deal_analysis where kind in ('bts','investment'); then re-add the constraint without them.
