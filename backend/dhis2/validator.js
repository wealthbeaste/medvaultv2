'use strict';
function validateIndicators(indicators) {
  const errors = [];
  const warnings = [];
  const byCode = Object.fromEntries(indicators.map(i => [i.code, i.value]));

  for (const ind of indicators) {
    if (typeof ind.value !== 'number' || Number.isNaN(ind.value)) {
      errors.push(`${ind.label} (${ind.code}) is missing or not a number.`);
    } else if (ind.value < 0) {
      errors.push(`${ind.label} (${ind.code}) is negative (${ind.value}).`);
    }
  }

  const total = byCode.OPD_ATTENDANCE_TOTAL;
  const male = byCode.OPD_ATTENDANCE_MALE;
  const female = byCode.OPD_ATTENDANCE_FEMALE;
  if ([total, male, female].every(v => typeof v === 'number') && male + female !== total) {
    warnings.push(`Male + female attendance (${male + female}) doesn't match total attendance (${total}).`);
  }

  const newCases = byCode.OPD_ATTENDANCE_NEW_CASES;
  const reattendance = byCode.OPD_ATTENDANCE_REATTENDANCE;
  if ([total, newCases, reattendance].every(v => typeof v === 'number') && newCases + reattendance !== total) {
    warnings.push(`New cases + re-attendance (${newCases + reattendance}) doesn't match total attendance (${total}).`);
  }

  const stockoutRate = byCode.COMMODITY_STOCKOUT_RATE;
  if (typeof stockoutRate === 'number' && stockoutRate > 50) {
    warnings.push(`Stockout rate is unusually high (${stockoutRate}%) — double check drug quantities before submitting.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateIndicators };
