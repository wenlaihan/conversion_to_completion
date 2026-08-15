/**
 * The Fit page's example gallery, checked at the source. Every example must parse,
 * be distinct from every other (two cards with the same scheme once shipped and
 * confused people), carry data whose columns all wire into its own mechanism, and,
 * for the cyclic example, actually fit back to its stated constants.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitNetwork, parseScheme } from '../src/lib/network.ts';

const source = readFileSync(new URL('../web/fit.js', import.meta.url), 'utf8');

interface Example {
  readonly key: string;
  readonly scheme: string;
  readonly data: string;
}

const examples: Example[] = [];
const entry = /(E\d+): \{[^]*?scheme: '([^']*)'[^]*?data: `([^`]*)`/g;
for (const match of source.matchAll(entry)) {
  examples.push({
    key: match[1] as string,
    scheme: (match[2] as string).replace(/\\n/g, '\n'),
    data: match[3] as string,
  });
}

const parseCsv = (data: string) => {
  const lines = data
    .trim()
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  const header = (lines[0] ?? '')
    .split(',')
    .map((cell) => cell.trim())
    .slice(1);
  const times: number[] = [];
  const series: Record<string, number[]> = Object.fromEntries(header.map((name) => [name, []]));
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map(Number);
    times.push(cells[0] as number);
    header.forEach((name, i) => (series[name] as number[]).push(cells[i + 1] as number));
  }
  return { header, times, series };
};

describe('example gallery', () => {
  it('finds the full set of examples in the page source', () => {
    expect(examples.map((e) => e.key)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
  });

  it('every example scheme parses', () => {
    for (const example of examples) {
      const parsed = parseScheme(example.scheme);
      expect(parsed.ok, `${example.key}: ${example.scheme}`).toBe(true);
    }
  });

  it('no two examples share a scheme', () => {
    const normalized = examples.map((e) => e.scheme.replace(/\s+/g, ' ').trim());
    expect(new Set(normalized).size).toBe(examples.length);
  });

  it('every data column wires into its own mechanism', () => {
    for (const example of examples) {
      const parsed = parseScheme(example.scheme);
      if (!parsed.ok) continue;
      const { header, times } = parseCsv(example.data);
      expect(times.length, example.key).toBeGreaterThanOrEqual(10);
      for (const name of header) {
        expect(parsed.scheme.species, `${example.key} column ${name}`).toContain(name);
      }
    }
  });

  it('E6, the photocycle, contains a cycle and a hub and fits back to its constants', () => {
    const e6 = examples.find((e) => e.key === 'E6');
    expect(e6).toBeDefined();
    if (!e6) return;
    const parsed = parseScheme(e6.scheme);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Cycle: A -> B -> C -> A. Hub: C touches B, A and D.
    const arrows = parsed.scheme.steps.map((step) => `${step.from}>${step.to}`);
    expect(arrows).toContain('A>B');
    expect(arrows).toContain('B>C');
    expect(arrows).toContain('C>A');
    expect(arrows).toContain('C>D');
    const cDegree = parsed.scheme.steps.filter(
      (step) => step.from === 'C' || step.to === 'C',
    ).length;
    expect(cDegree).toBeGreaterThanOrEqual(3);

    const { times, series } = parseCsv(e6.data);
    const fit = fitNetwork([{ times, series }], e6.scheme);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.r2).toBeGreaterThan(0.99);
    const truth: Record<string, number> = { 'A>B': 0.45, 'B>C': 0.4, 'C>A': 0.35, 'C>D': 0.05 };
    for (const step of fit.steps) {
      const expected = truth[`${step.from}>${step.to}`];
      expect(expected, `unexpected step ${step.from} -> ${step.to}`).toBeDefined();
      expect(Math.abs(step.k - (expected as number)) / (expected as number)).toBeLessThan(0.2);
    }
  });
});
