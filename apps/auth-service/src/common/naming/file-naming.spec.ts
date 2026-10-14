import {
  DEPARTMENTS, DOC_CATEGORIES, MAX_FILE_NAME, categoryFolderLabel, controlledDocFileName, controlledDocNumber,
  controlledDocTitle, dateRangeScope, departmentFolderLabel, descriptor, exportFileName, isConventionSafe,
  isoStamp, uploadFileName,
} from './file-naming';

/** Bravo naming standard — the ISO 9001:2015 deck adopted 2026-10-15. */
const AT = new Date(Date.UTC(2026, 9, 15, 9, 30, 41));

describe('file naming standard', () => {
  it('the 13 main folders and 4 sub-folders from the deck', () => {
    expect(DEPARTMENTS.map(d => d.code).join(' ')).toBe('EX MS SS GR EC TR BC HR SC LG IT FN QH');
    expect(DOC_CATEGORIES.map(c => c.code)).toEqual([100, 200, 300, 400]);
    expect(departmentFolderLabel('FN')).toBe('012. FINANCE');
    expect(categoryFolderLabel(300)).toBe('300. Forms');
  });

  it('ISO 8601 basic stamp, 24-hour, UTC', () => {
    expect(isoStamp(AT)).toBe('20261015T0930');
    expect(isoStamp(new Date(Date.UTC(2026, 0, 2, 23, 5)))).toBe('20260102T2305');
  });

  it('descriptors are CamelCase with no spaces or special characters', () => {
    expect(descriptor('Tangible fixed-asset policy (draft)')).toBe('TangibleFixedAssetPolicyDraft');
    expect(descriptor('HR & Training')).toBe('HRTraining');
    expect(descriptor('Résumé 2026!')).toBe('Resume2026');
    expect(descriptor('~!@#$%')).toBe('');
  });

  it('controlled documents: "BRV-FN 100-001 Expense Tracking Procedure", file without spaces, versioned', () => {
    expect(controlledDocNumber('FN', 100, 1)).toBe('BRV-FN 100-001');
    expect(controlledDocTitle('FN', 100, 1, ' Expense Tracking Procedure ')).toBe('BRV-FN 100-001 Expense Tracking Procedure');
    expect(controlledDocFileName({dept: 'FN', category: 100, seq: 1, title: 'Expense Tracking Procedure', version: 2, ext: 'PDF'}))
      .toBe('BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf');
    expect(controlledDocFileName({dept: 'FN', category: 300, seq: 12, title: 'Cash Voucher', version: 1, ext: '.xlsx'}))
      .toBe('BRV-FN-300-012_CashVoucher_v1.xlsx');
  });

  it('exports: date first, BRV-<dept>, subject, scope', () => {
    expect(exportFileName({dept: 'FN', subject: 'Wallet ledger', ext: 'csv', at: AT})).toBe('20261015T0930_BRV-FN_WalletLedger.csv');
    expect(exportFileName({dept: 'HR', subject: 'Attendance', scope: dateRangeScope('2026-10-01', '2026-10-15'), ext: 'csv', at: AT}))
      .toBe('20261015T0930_BRV-HR_Attendance_20261001-20261015.csv');
    expect(dateRangeScope('2026-10-01', '2026-10-01')).toBe('20261001');
    expect(dateRangeScope('', null)).toBeNull();
  });

  it('uploads: date first, the person\'s own words, a version', () => {
    expect(uploadFileName('Passport scan (front).JPG', AT)).toBe('20261015T0930_PassportScanFront_v1.jpg');
    expect(uploadFileName('licence.pdf', AT, 3)).toBe('20261015T0930_Licence_v3.pdf');
    expect(uploadFileName('???', AT)).toBe('20261015T0930_File_v1');
  });

  it('every generated name is convention-safe and capped, shortening the words and never the codes', () => {
    const long = 'A very long statement title that goes on and on about quarterly security operations';
    const names = [
      exportFileName({dept: 'FN', subject: long, scope: 'GardaWorld Africa Holdings 20261001-20261015', ext: 'csv', at: AT}),
      uploadFileName(`${long}.docx`, AT),
      controlledDocFileName({dept: 'QH', category: 400, seq: 999, title: long, version: 12, ext: 'pdf'}),
    ];
    for (const n of names) {
      expect(`${n}:${n.length <= MAX_FILE_NAME}`).toBe(`${n}:true`);
      expect(isConventionSafe(n)).toBe(true);
    }
    expect(names[0].startsWith('20261015T0930_BRV-FN_')).toBe(true);
    expect(names[2]).toMatch(/^BRV-QH-400-999_.+_v12\.pdf$/);
  });
});
