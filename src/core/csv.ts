/** CSV for spreadsheets (RFC 4180). Pure. Every cell is user-controlled text, so every cell is protected. */

/** Excel and Sheets read a cell starting with one of these as a formula (OWASP CSV injection list). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One quoted field. Text a spreadsheet would run as a formula gets a leading `'`, which it shows as plain text. */
export const csvCell = (value: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Rows of text as CSV: CRLF after every row, and a UTF-8 byte order mark first so Excel reads accents correctly. */
export const toCsv = (rows: readonly (readonly string[])[]): string =>
  `﻿${rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("")}`;
