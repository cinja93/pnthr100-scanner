// PNTHR Accounting — Excel renderers (forensic fidelity to NAV's working papers).
//
// Reproduces NAV's Excel workbooks tab-for-tab from our data: same sheet names,
// headers, column order, cell values (full precision), and — critically for an
// auditor — the same Excel NUMBER FORMATS, including NAV's quirks (e.g. the
// Management Fee column uses a minus-sign negative format while other money columns
// use parentheses). Data-driven: the accounting engine fills the data objects.

import ExcelJS from 'exceljs';

// NAV's exact number-format strings (locale [$-010409] = English).
export const FMT = {
  INT:   '[$-010409]##0;-##0;-',
  MONEY: '[$-010409]#,##0.00;(#,##0.00);-',          // negatives in parentheses, zero -> dash
  MONEY_MINUS: '[$-010409]#,##0.00;-#,##0.00;-',     // negatives with a minus sign (NAV uses this for Management Fee)
  PCT:   '[$-010409]#,##0.00%;(#,##0.00%);-',
};

function setCell(ws, ref, value, { numFmt, bold } = {}) {
  const cell = ws.getCell(ref);
  cell.value = value;
  if (numFmt) cell.numFmt = numFmt;
  if (bold) cell.font = { bold: true };
  return cell;
}

const COL_LETTERS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];

// ── Generic grid workbook writer ────────────────────────────────────────────────
// Emits any multi-tab workbook from a grid spec: { sheets: [{ name, colWidths{col:w},
// merges[], cells:[{ ref, value, numFmt, bold, formula, isDate }] }] }. This is the
// reusable bottom layer ALL Excel documents use; the per-tab SEMANTIC mappers (engine
// data -> grid spec) sit on top and are built with the accounting engine. Preserves
// exact values, number formats, bold, merges, and formulas (e.g. NAV's SUBTOTAL total
// rows) so the output is byte-faithful to NAV's working papers.
export async function renderGridWorkbook(spec) {
  const wb = new ExcelJS.Workbook();
  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const [col, width] of Object.entries(sheet.colWidths || {})) {
      ws.getColumn(col).width = width;
    }
    for (const c of sheet.cells) {
      const cell = ws.getCell(c.ref);
      if (c.formula) {
        cell.value = { formula: String(c.value).replace(/^=/, '') };
      } else if (c.isDate) {
        // Treat naive dates as UTC midnight so exceljs doesn't shift them by the local
        // TZ offset (an MST machine was writing 00:00 dates as 07:00). Tax-lot/trade
        // dates must land on the exact calendar day NAV reports.
        const s = String(c.value);
        cell.value = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
      } else {
        cell.value = c.value;
      }
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.bold) cell.font = { bold: true };
    }
    for (const m of sheet.merges || []) {
      try { ws.mergeCells(m); } catch { /* overlapping/duplicate merge — skip */ }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Investor Capital Roll History (single tab) ──────────────────────────────────
export async function renderCapitalRollHistory(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Investor Capital Roll History');

  // Column widths (match NAV).
  const widths = [13.7,13.7,13.7,13.7,38.4,16.5,48.0,16.5,16.5,16.5,16.5,16.5,16.5,16.5,16.5,41.1,34.3,34.3,27.4,27.4,34.3,27.4];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Title rows (merged across all 22 columns).
  ws.mergeCells('A1:V1');
  ws.mergeCells('A2:V2');
  ws.mergeCells('A3:V3');
  setCell(ws, 'A1', '');
  setCell(ws, 'A2', data.fundName, { bold: true });
  setCell(ws, 'A3', data.title, { bold: true });

  // Header row 4.
  const headers = ['Month','Sub Month','Year','Sub Month Day','Fund Name','Investor Number','Investor Name',
    'Beginning Balance','Additions Amount','Total Income','Management Fee','Incentive Fee','Redemptions Amount',
    'Ending Balance Amount','Rate of Return','Address1','Address2','Address3','Address4','Address5','Entity Type','Class Description'];
  headers.forEach((h, i) => setCell(ws, `${COL_LETTERS[i]}4`, h, { bold: true }));

  // Data rows from row 5.
  const inv = data.investor;
  data.rows.forEach((r, idx) => {
    const row = 5 + idx;
    setCell(ws, `A${row}`, r.month,        { numFmt: FMT.INT });
    setCell(ws, `B${row}`, r.subMonth,     { numFmt: FMT.INT });
    setCell(ws, `C${row}`, r.year,         { numFmt: FMT.INT });
    setCell(ws, `D${row}`, r.subMonthDay,  { numFmt: FMT.INT });
    setCell(ws, `E${row}`, data.fundName);
    setCell(ws, `F${row}`, inv.number);                 // text, e.g. '1001'
    setCell(ws, `G${row}`, inv.name);
    setCell(ws, `H${row}`, r.beginning,    { numFmt: FMT.MONEY });
    setCell(ws, `I${row}`, r.additions,    { numFmt: FMT.MONEY });
    setCell(ws, `J${row}`, r.totalIncome,  { numFmt: FMT.MONEY });
    setCell(ws, `K${row}`, r.managementFee,{ numFmt: FMT.MONEY_MINUS });
    setCell(ws, `L${row}`, r.incentiveFee, { numFmt: FMT.MONEY });
    setCell(ws, `M${row}`, r.redemptions,  { numFmt: FMT.MONEY });
    setCell(ws, `N${row}`, r.ending,       { numFmt: FMT.MONEY });
    setCell(ws, `O${row}`, r.ror,          { numFmt: FMT.PCT });
    setCell(ws, `P${row}`, inv.address1);
    setCell(ws, `Q${row}`, inv.address2);
    setCell(ws, `R${row}`, inv.address3);
    setCell(ws, `S${row}`, inv.address4);
    setCell(ws, `T${row}`, inv.address5);
    setCell(ws, `U${row}`, inv.entityType);
    setCell(ws, `V${row}`, inv.classDescription);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
