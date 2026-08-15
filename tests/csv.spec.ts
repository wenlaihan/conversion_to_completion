import { describe, expect, it } from 'vitest';
import { smartCells, splitDelimited } from '../src/lib/csv.ts';
import { parseScheme, quoteSpecies } from '../src/lib/network.ts';

describe('smartCells', () => {
  it('keeps spaces inside comma-delimited headings', () => {
    expect(smartCells('time (min),Starting Material,Product 1,Mass Balance (%)')).toEqual([
      'time (min)',
      'Starting Material',
      'Product 1',
      'Mass Balance (%)',
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    expect(smartCells('t,"Adduct, minor",B')).toEqual(['t', 'Adduct, minor', 'B']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(splitDelimited('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('falls back to whitespace splitting when no delimiter is present', () => {
    expect(smartCells('0      1.000')).toEqual(['0', '1.000']);
    expect(smartCells('t A B')).toEqual(['t', 'A', 'B']);
  });

  it('splits tab-separated lines on tabs alone', () => {
    expect(smartCells('time\tStarting Material\tProduct 1')).toEqual([
      'time',
      'Starting Material',
      'Product 1',
    ]);
  });

  it('trims leading and trailing whitespace only', () => {
    expect(smartCells('  0 , 99.5 ,  0 ')).toEqual(['0', '99.5', '0']);
  });
});

describe('quoted species in the scheme grammar', () => {
  it('parses multi-word quoted names', () => {
    const parsed = parseScheme('"Starting Material" -> "Product 1"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scheme.species).toEqual(['Starting Material', 'Product 1']);
  });

  it('parses digit-leading quoted names and reversible arrows', () => {
    const parsed = parseScheme('"Starting Material" <-> "5-bromo-2-methylpyridine adduct"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scheme.steps).toHaveLength(2);
    expect(parsed.scheme.species).toContain('5-bromo-2-methylpyridine adduct');
  });

  it('carries catalysts with quoted names', () => {
    const parsed = parseScheme('"Starting Material" + Cat -> "Product 1" + Cat');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scheme.catalysts).toEqual(['Cat']);
  });

  it('quoteSpecies quotes exactly the names the grammar cannot carry bare', () => {
    expect(quoteSpecies('A')).toBe('A');
    expect(quoteSpecies("B2'")).toBe("B2'");
    expect(quoteSpecies('Starting Material')).toBe('"Starting Material"');
    expect(quoteSpecies('5-bromo')).toBe('"5-bromo"');
  });
});
