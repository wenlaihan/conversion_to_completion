/**
 * Cell splitting for pasted or uploaded time-course text.
 *
 * The old splitter treated spaces as delimiters everywhere, so a real CSV heading
 * like "Starting Material" shattered into two columns. The rule now: when a line
 * carries a structural delimiter (tab, comma, semicolon), that delimiter alone
 * separates cells, with RFC 4180 double-quote handling for embedded commas; only a
 * line with no delimiter at all falls back to whitespace splitting, which keeps the
 * quick "0   1.000" paste working.
 */

/** Split one line on the given delimiter, honouring double quotes ("" escapes one). */
export const splitDelimited = (line: string, delimiter: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"' && current.trim() === '') {
      inQuote = true;
      current = '';
    } else if (ch === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
};

/** True when the line has a comma outside any quoted field. */
const hasBareComma = (line: string): boolean => {
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) return true;
  }
  return false;
};

/**
 * Cells of one line: delimiter-split when a delimiter is present, whitespace-split
 * otherwise. Empty cells are dropped, matching the tolerant paste behaviour.
 */
export const smartCells = (line: string): string[] => {
  const cells = line.includes('\t')
    ? splitDelimited(line, '\t')
    : hasBareComma(line) || line.includes('"')
      ? splitDelimited(line, ',')
      : line.includes(';')
        ? splitDelimited(line, ';')
        : line.trim().split(/\s+/);
  return cells.filter((cell) => cell !== '');
};
