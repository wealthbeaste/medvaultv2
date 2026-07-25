'use strict';
const PDFDocument = require('pdfkit');

function generateAdrPdf(report, pharmacyName) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });

  doc.fontSize(14).font('Helvetica-Bold').text('CONFIDENTIAL', { align: 'center' });
  doc.fontSize(12).text('SUSPECTED ADVERSE DRUG REACTION (ADR) / AEFI REPORT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).font('Helvetica').text('Uganda National Drug Authority — National Pharmacovigilance Centre', { align: 'center' });
  doc.moveDown(1);

  const line = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9).text(label + ': ', { continued: true });
    doc.font('Helvetica').text(value || '—');
  };

  doc.font('Helvetica-Bold').fontSize(10).text('Type of Report');
  line('Report type', report.report_type);
  line('Seriousness', report.seriousness);
  line('Product type', report.product_type);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10).text('Patient Information');
  line('Patient ID/Initials', report.patient_initials);
  line('Gender', report.patient_gender);
  line('Weight (kg)', report.patient_weight_kg);
  line('Pregnancy status', report.pregnancy_status);
  line('Date of birth', report.patient_dob);
  line('Age at onset', report.patient_age_at_onset);
  line('Medical history', report.medical_history);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10).text('Medical Product Details');
  const meds = Array.isArray(report.medicines) ? report.medicines : [];
  if (!meds.length) {
    doc.font('Helvetica').fontSize(9).text('No medicines recorded.');
  } else {
    meds.forEach((m, i) => {
      doc.font('Helvetica').fontSize(9).text(
        `${i + 1}. ${m.generic || '—'} (${m.brand || '—'}) — ${m.route || '—'}, ${m.dose || '—'}, ` +
        `${m.start || '—'} to ${m.stop || '—'}, for ${m.indication || '—'}${m.suspected ? '  [SUSPECTED]' : ''}`
      );
    });
  }
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10).text('Reaction Details');
  line('Description', report.reaction_description);
  line('Onset date', report.onset_date);
  line('Onset time', report.onset_time);
  line('Date stopped', report.stopped_date);
  line('Relevant lab results', report.lab_results);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10).text('Seriousness / Outcome');
  const reasons = Array.isArray(report.seriousness_reason) ? report.seriousness_reason.join(', ') : '';
  line('Reason for seriousness', reasons);
  line('Action taken', report.action_taken);
  line('Outcome', report.outcome);
  line('Causality assessment', report.causality);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10).text('Reporter Details');
  line('Name', report.reporter_name);
  line('Contact', report.reporter_contact);
  line('Designation', report.reporter_designation);
  line('Institution', report.institution || pharmacyName);
  line('District', report.district);
  line('Date of reporting', new Date(report.created_at).toISOString().slice(0, 10));
  doc.moveDown(1);

  doc.fontSize(8).font('Helvetica-Oblique').text(
    'Submit to: NDA toll-free 0800101999, WhatsApp 0791-415555, your Regional Pharmacovigilance Centre, ' +
    'or online at primaryreporting.who-umc.org/Reporting/Reporter?OrganizationID=UG',
    { align: 'center' }
  );

  return doc;
}

module.exports = { generateAdrPdf };
