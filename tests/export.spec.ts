import { describe, expect, it } from 'vitest';
import { buildZip, crc32, fitDataCsv } from '../src/lib/export.ts';

describe('fitDataCsv', () => {
  const csv = fitDataCsv({
    timeUnit: 'min',
    times: [0, 5],
    columns: [
      { name: 'Starting Material', display: 'S1', values: [0.1, 0.081] },
      { name: 'Mass Balance (%)', display: 'Mass Balance (%)', values: [100, 99.2] },
    ],
    curve: { t: [0, 2.5, 5], series: { S1: [0.1, 0.09, 0.081] } },
    constants: [
      { label: 'k S1 -> S2 (Starting Material -> Product 1)', value: 0.129, units: 'h⁻¹' },
    ],
  });

  it('carries raw data with display and full names joined', () => {
    expect(csv).toContain('# raw data');
    expect(csv).toContain('time (min),S1 = Starting Material,Mass Balance (%)');
    expect(csv).toContain('0,0.1,100');
  });

  it('carries the fitted curves as their own section', () => {
    expect(csv).toContain('# fitted curves');
    expect(csv).toContain('2.5,0.09');
  });

  it('carries every constant with its units', () => {
    expect(csv).toContain('# fitted constants');
    expect(csv).toContain('constant,value,units');
    expect(csv).toContain('k S1 -> S2 (Starting Material -> Product 1),0.129,h⁻¹');
  });

  it('quotes fields with commas per CSV rules', () => {
    const quoted = fitDataCsv({
      timeUnit: 'h',
      times: [1],
      columns: [{ name: 'Adduct, minor', display: 'S1', values: [2] }],
      curve: null,
      constants: [],
    });
    expect(quoted).toContain('"S1 = Adduct, minor"');
  });
});

describe('buildZip', () => {
  const zip = buildZip([
    { name: 'fit-data.csv', data: new TextEncoder().encode('hello,zip\n') },
    { name: 'fit-graph.svg', data: new TextEncoder().encode('<svg/>') },
  ]);

  it('starts with a local file header signature', () => {
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('ends with an end-of-central-directory record naming two entries', () => {
    const end = zip.slice(zip.length - 22);
    expect([...end.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    const view = new DataView(end.buffer, end.byteOffset);
    expect(view.getUint16(8, true)).toBe(2);
    expect(view.getUint16(10, true)).toBe(2);
  });

  it('stores the file names and bytes verbatim', () => {
    const asText = new TextDecoder('latin1').decode(zip);
    expect(asText).toContain('fit-data.csv');
    expect(asText).toContain('fit-graph.svg');
    expect(asText).toContain('hello,zip');
  });

  it('crc32 matches the known value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
