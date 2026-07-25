'use strict';
const defaultMap = require('./dataElementMap');

function resolvePeriod(start) {
  return start.slice(0, 7).replace('-', '');
}

function mergeElementMap(pharmacyMap) {
  const merged = JSON.parse(JSON.stringify(defaultMap));
  if (!pharmacyMap) return merged;
  for (const section of ['hmis105', 'hmis106']) {
    if (pharmacyMap[section]?.orgUnit) merged[section].orgUnit = pharmacyMap[section].orgUnit;
    if (pharmacyMap[section]?.dataElements) {
      for (const key of Object.keys(merged[section].dataElements)) {
        if (pharmacyMap[section].dataElements[key]) {
          merged[section].dataElements[key] = { ...merged[section].dataElements[key], ...pharmacyMap[section].dataElements[key] };
        }
      }
    }
    if (pharmacyMap[section]?.diagnosisMap) merged[section].diagnosisMap = { ...merged[section].diagnosisMap, ...pharmacyMap[section].diagnosisMap };
    if (pharmacyMap[section]?.drugMap) merged[section].drugMap = { ...merged[section].drugMap, ...pharmacyMap[section].drugMap };
  }
  return merged;
}

function isConfigured(entry) {
  return entry && entry.id && entry.id !== 'CHANGE_ME_DE_UID' && entry.coc && entry.coc !== 'CHANGE_ME_COC_UID';
}

async function buildDataValueSet(query, pharmacyId, start, end) {
  const period = resolvePeriod(start);
  const settingsRow = await query(`SELECT org_unit_uid, element_map FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
  const settings = settingsRow.rows[0] || {};
  const map = mergeElementMap(settings.element_map);
  const orgUnit = settings.org_unit_uid || map.hmis105.orgUnit;

  const unconfigured = [];
  const dataValues = [];

  const attendance = await query(
    `SELECT
       COUNT(*)::int AS total_attendance,
       COUNT(*) FILTER (WHERE p.gender ILIKE 'male')::int   AS male,
       COUNT(*) FILTER (WHERE p.gender ILIKE 'female')::int AS female,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) < INTERVAL '1 year')::int AS age_under1,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '1 year'  AND AGE(c.created_at, p.dob) < INTERVAL '5 years')::int  AS age_1to4,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '5 years'  AND AGE(c.created_at, p.dob) < INTERVAL '15 years')::int AS age_5to14,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '15 years' AND AGE(c.created_at, p.dob) < INTERVAL '18 years')::int AS age_15to17,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '18 years' AND AGE(c.created_at, p.dob) < INTERVAL '50 years')::int AS age_18to49,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '50 years' AND AGE(c.created_at, p.dob) < INTERVAL '60 years')::int AS age_50to59,
       COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '60 years')::int AS age_60plus,
       COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM consultations c2 WHERE c2.patient_id = c.patient_id AND c2.created_at < c.created_at))::int AS new_cases
     FROM consultations c JOIN patients p ON p.id = c.patient_id
     WHERE c.pharmacy_id = $1 AND c.created_at::date BETWEEN $2 AND $3`,
    [pharmacyId, start, end]
  );
  const opd = attendance.rows[0];
  opd.reattendance = opd.total_attendance - opd.new_cases;

  const opdFieldMap = {
    opd_total_attendance: opd.total_attendance, opd_new_cases: opd.new_cases, opd_reattendance: opd.reattendance,
    opd_male: opd.male, opd_female: opd.female, opd_age_under1: opd.age_under1, opd_age_1to4: opd.age_1to4,
    opd_age_5to14: opd.age_5to14, opd_age_15to17: opd.age_15to17, opd_age_18to49: opd.age_18to49,
    opd_age_50to59: opd.age_50to59, opd_age_60plus: opd.age_60plus,
  };
  for (const [key, value] of Object.entries(opdFieldMap)) {
    const entry = map.hmis105.dataElements[key];
    if (!isConfigured(entry)) { unconfigured.push(`hmis105.${key}`); continue; }
    dataValues.push({ dataElement: entry.id, period, orgUnit, categoryOptionCombo: entry.coc, value: String(value) });
  }

  const diagnoses = await query(
    `SELECT LOWER(TRIM(diagnosis)) AS diagnosis, COUNT(*)::int AS count FROM consultations
     WHERE pharmacy_id = $1 AND created_at::date BETWEEN $2 AND $3 AND diagnosis IS NOT NULL AND TRIM(diagnosis) <> '' GROUP BY 1`,
    [pharmacyId, start, end]
  );
  for (const row of diagnoses.rows) {
    const entry = map.hmis105.diagnosisMap[row.diagnosis];
    if (!isConfigured(entry)) continue;
    dataValues.push({ dataElement: entry.id, period, orgUnit, categoryOptionCombo: entry.coc, value: String(row.count) });
  }

  const consumed = await query(
    `SELECT si.drug_name, SUM(si.quantity)::int AS quantity_consumed FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.pharmacy_id = $1 AND s.voided_at IS NULL AND s.created_at::date BETWEEN $2 AND $3 GROUP BY si.drug_name`,
    [pharmacyId, start, end]
  );
  const stock = await query(`SELECT name, quantity FROM drugs WHERE pharmacy_id = $1`, [pharmacyId]);
  const consumedByName = new Map(consumed.rows.map(r => [r.drug_name?.toLowerCase(), r.quantity_consumed]));

  let totalClosingStock = 0, totalConsumed = 0, stockedOut = 0;
  for (const row of stock.rows) {
    totalClosingStock += row.quantity;
    totalConsumed += consumedByName.get(row.name?.toLowerCase()) || 0;
    if (row.quantity <= 0) stockedOut++;
  }

  const hmis106FieldMap = { commodity_closing_stock: totalClosingStock, commodity_consumed: totalConsumed, commodity_stockout_days: stockedOut };
  for (const [key, value] of Object.entries(hmis106FieldMap)) {
    const entry = map.hmis106.dataElements[key];
    if (!isConfigured(entry)) { unconfigured.push(`hmis106.${key}`); continue; }
    dataValues.push({ dataElement: entry.id, period, orgUnit, categoryOptionCombo: entry.coc, value: String(value) });
  }

  for (const row of stock.rows) {
    const key = row.name?.toLowerCase();
    const entry = map.hmis106.drugMap[key];
    if (!isConfigured(entry)) continue;
    dataValues.push({ dataElement: entry.id, period, orgUnit, categoryOptionCombo: entry.coc, value: String(consumedByName.get(key) || 0) });
  }

  return {
    period,
    dataValueSet: { dataValues },
    unconfigured,
    readyToPush: unconfigured.length === 0 && !!orgUnit && orgUnit !== 'CHANGE_ME_ORG_UNIT_UID',
  };
}

module.exports = { buildDataValueSet };
