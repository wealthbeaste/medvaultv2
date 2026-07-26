'use strict';
// ============================================================
// E-Prescription PDF/QR generator — produces a self-contained,
// portable prescription: human-readable text any pharmacist can
// read, plus a QR code encoding the same data as JSON. Works
// whether or not the receiving pharmacy uses MedVault at all.
// ============================================================
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

async function generateErxPdf(rx, pharmacyName, verifyBaseUrl) {
  const verifyUrl = `${verifyBaseUrl}/rx/${rx.code}`;

  // QR encodes a public verify URL (not raw patient data) — anyone
  // scanning it lands on a lookup page rather than getting a JSON
  // blob of PII in their scanner history.
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 220 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  const doc = new PDFDocument({ margin: 40, size: 'A5' });

  doc.fontSize(14).font('Helvetica-Bold').text('ELECTRONIC PRESCRIPTION', { align: 'center' });
  doc.fontSize(9).font('Helvetica').fillColor('#666').text(pharmacyName || 'MedVault Facility', { align: 'center' });
  doc.moveDown(1);
  doc.fillColor('#000');

  const line = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9).text(label + ': ', { continued: true });
    doc.font('Helvetica').text(value || '—');
  };

  line('Prescription Code', rx.code);
  line('Patient', rx.patient_display_name);
  line('Prescribing Doctor', rx.doctor_name);
  if (rx.doctor_license_no) line('Doctor License No.', rx.doctor_license_no);
  line('Issued', new Date(rx.issued_at).toISOString().slice(0, 10));
  line('Valid Until', new Date(rx.expires_at).toISOString().slice(0, 10));
  doc.moveDown(0.8);

  doc.font('Helvetica-Bold').fontSize(10).text('Prescribed Items');
  doc.moveDown(0.3);
  const items = Array.isArray(rx.items) ? rx.items : [];
  items.forEach((item, i) => {
    doc.font('Helvetica').fontSize(9).text(
      `${i + 1}. ${item.drug_name || '—'} — ${item.dosage || ''} ${item.frequency || ''}, ` +
      `for ${item.duration || '—'}, qty: ${item.quantity || '—'}`
    );
    if (item.notes) doc.fontSize(8).fillColor('#666').text('   ' + item.notes).fillColor('#000');
  });

  doc.moveDown(1);

  // QR code + verify footer
  const qrSize = 90;
  const qrX = doc.page.width - doc.page.margins.right - qrSize;
  const qrY = doc.y;
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

  doc.fontSize(7).fillColor('#666').text(
    'Scan to verify or fulfill this prescription at any pharmacy:',
    doc.page.margins.left, qrY + 10, { width: qrX - doc.page.margins.left - 10 }
  );
  doc.fontSize(7).fillColor('#0645AD').text(verifyUrl, doc.page.margins.left, qrY + 24, {
    width: qrX - doc.page.margins.left - 10,
  });
  doc.fillColor('#000');

  doc.moveDown(6);
  doc.fontSize(7).fillColor('#999').text(
    'This is an electronic prescription. It is valid for fulfillment at any pharmacy, ' +
    'whether or not that pharmacy uses MedVault. Verification code: ' + rx.code,
    { align: 'center' }
  );

  return doc;
}

module.exports = { generateErxPdf };
