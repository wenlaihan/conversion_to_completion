/**
 * Fit export: the data as a sectioned CSV, and a dependency-free zip.
 *
 * The CSV mirrors what is on screen: the raw points, the fitted curves, and the
 * constants with the units they carry. Species columns wear both the display name
 * used in the UI and the full CSV heading, so nothing exported is ambiguous. The
 * zip is STORE-only (no compression): a fit export is small, and writing the
 * format directly keeps the runtime dependency count at zero.
 */

export interface ExportColumn {
  /** Full column heading as it appeared in the user's file. */
  readonly name: string;
  /** Display name used in the UI (may equal name). */
  readonly display: string;
  readonly values: readonly number[];
}

export interface ExportCurve {
  readonly t: readonly number[];
  readonly series: Readonly<Record<string, readonly number[]>>;
}

export interface ExportConstant {
  readonly label: string;
  readonly value: number;
  readonly units: string;
}

const field = (text: string): string =>
  /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

const columnHeading = (column: ExportColumn): string =>
  column.display === column.name ? column.name : `${column.display} = ${column.name}`;

/** The full export as one sectioned CSV. */
const num = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) ? '' : String(Number(value.toPrecision(7)));

export const fitDataCsv = (input: {
  readonly timeUnit: string;
  readonly times: readonly number[];
  readonly columns: readonly ExportColumn[];
  readonly curve: ExportCurve | null;
  readonly constants: readonly ExportConstant[];
  readonly meta?: readonly string[];
}): string => {
  const lines: string[] = [];
  lines.push('# RxnClock fit export');
  for (const line of input.meta ?? []) lines.push(`# ${line}`);
  lines.push('# raw data');
  lines.push(
    [`time (${input.timeUnit})`, ...input.columns.map(columnHeading)].map(field).join(','),
  );
  input.times.forEach((t, i) => {
    lines.push([num(t), ...input.columns.map((c) => num(c.values[i]))].join(','));
  });

  if (input.curve !== null) {
    const curve = input.curve;
    const curveNames = Object.keys(curve.series);
    lines.push('');
    lines.push('# fitted curves');
    lines.push([`time (${input.timeUnit})`, ...curveNames].map(field).join(','));
    curve.t.forEach((t, i) => {
      lines.push([num(t), ...curveNames.map((n) => num(curve.series[n]?.[i]))].join(','));
    });
  }

  lines.push('');
  lines.push('# fitted constants');
  lines.push('constant,value,units');
  for (const constant of input.constants) {
    lines.push([field(constant.label), num(constant.value), field(constant.units)].join(','));
  }
  return `${lines.join('\n')}\n`;
};

/* ------------------------------------------------------------------ *
 * Zip (STORE)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** A minimal, valid zip: local headers, central directory, end record. */
export const buildZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
