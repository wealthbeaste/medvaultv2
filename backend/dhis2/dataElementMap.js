'use strict';
// ============================================================
// DHIS2 Data Element Mapping — DEFAULT TEMPLATE
// ============================================================
// MedVault is a multi-tenant platform: each pharmacy/facility has
// its own DHIS2 instance, org unit, and credentials, stored in the
// `dhis2_settings` table and configured via the DHIS2 Settings
// panel in frontend/dhis2.html (or PUT /api/dhis2/settings).
//
// This file only defines the SHAPE of the mapping (which fields
// exist, their labels) and CHANGE_ME placeholders as the fallback
// when a pharmacy hasn't configured its own UIDs yet. Nothing here
// is pharmacy-specific — routes/dhis2.js merges each pharmacy's
// saved element_map over this template at request time.
//
// How to find the real UIDs:
//   GET {DHIS2_BASE_URL}/api/dataElements.json?filter=name:like:OPD&fields=id,name
//   GET {DHIS2_BASE_URL}/api/categoryOptionCombos.json?filter=name:like:Default&fields=id,name
//   GET {DHIS2_BASE_URL}/api/organisationUnits.json?filter=name:like:YOUR_FACILITY&fields=id,name
//
// Each entry's `id` is the dataElement UID; `coc` is the
// categoryOptionCombo UID (use the "default" COC unless the
// element is disaggregated, e.g. by sex or age band).
// ============================================================

module.exports = {
  // ── HMIS 105 — OPD Attendance & Morbidity ─────────────────
  hmis105: {
    orgUnit: 'CHANGE_ME_ORG_UNIT_UID', // this facility's DHIS2 organisationUnit UID
    dataElements: {
      opd_total_attendance:   { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Total Attendance' },
      opd_new_cases:          { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD New Cases' },
      opd_reattendance:       { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Re-attendance' },
      opd_male:               { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — Male' },
      opd_female:              { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — Female' },
      opd_age_under1:         { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — Under 1yr' },
      opd_age_1to4:           { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 1-4yrs' },
      opd_age_5to14:          { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 5-14yrs' },
      opd_age_15to17:         { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 15-17yrs' },
      opd_age_18to49:         { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 18-49yrs' },
      opd_age_50to59:         { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 50-59yrs' },
      opd_age_60plus:         { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'OPD Attendance — 60yrs+' },
    },
    // Top diagnoses aren't fixed DHIS2 data elements — Ghana's HMIS 105
    // morbidity section maps free-text/ICD-10 diagnoses to a disease
    // list defined per-instance. Fill in the diagnoses your facility
    // actually reports against; anything not listed here still shows
    // up in the report under "Other / unmapped diagnoses".
    diagnosisMap: {
      // 'malaria':          { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID' },
      // 'hypertension':     { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID' },
      // 'uri':              { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID' },
    },
  },

  // ── HMIS 106 — Pharmacy / Commodity Logistics ─────────────
  hmis106: {
    orgUnit: 'CHANGE_ME_ORG_UNIT_UID',
    dataElements: {
      commodity_closing_stock: { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'Closing Stock' },
      commodity_consumed:      { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'Quantity Consumed' },
      commodity_stockout_days: { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID', label: 'Stockout (days)' },
    },
    // Per-drug DHIS2 UIDs — most DHIS2 instances model each tracked
    // commodity as its own data element. Map your drug catalogue's
    // `drugs.name` (lowercased) to the DHIS2 UID for that commodity.
    drugMap: {
      // 'paracetamol 500mg': { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID' },
      // 'amoxicillin 250mg': { id: 'CHANGE_ME_DE_UID', coc: 'CHANGE_ME_COC_UID' },
    },
  },
};
