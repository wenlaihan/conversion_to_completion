import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM helper, shipped without type declarations by design.
import { findBannedPunctuation } from '../scripts/no-em-dash.mjs';

/**
 * The punctuation rule as a test, so `npm test` fails on a violation rather than only
 * the pre-commit hook, which a fresh clone will not have enabled until someone runs
 * `git config core.hooksPath .githooks`.
 *
 * This file may not contain the characters it checks for, so they are built from their
 * code points. That is also why the detector gets its own test below: a guard that
 * quietly stopped matching would leave this suite green and the rule unenforced.
 */

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

describe('punctuation rule', () => {
  it('finds no banned punctuation anywhere in the tree', async () => {
    const { findings, checked } = (await findBannedPunctuation()) as {
      findings: string[];
      checked: number;
    };
    expect(checked).toBeGreaterThan(30);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('still recognises the shapes it bans', () => {
    const numericRange = new RegExp(`\\d\\s*${EN_DASH}\\s*\\d`);
    expect(`a sentence ${EM_DASH} with a dash`.includes(EM_DASH)).toBe(true);
    expect(numericRange.test(`20${EN_DASH}200`)).toBe(true);
    expect(numericRange.test(`25.7 ${EN_DASH} 203.1`)).toBe(true);
    // A joint proper name keeps its en dash and must not trip the range check.
    expect(numericRange.test(`Avrami${EN_DASH}Erofeev`)).toBe(false);
    expect(numericRange.test('20 to 200')).toBe(false);
  });
});
