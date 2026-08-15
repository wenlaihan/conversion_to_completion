#!/usr/bin/env node
/**
 * Fails if a U+2014 EM DASH appears anywhere in the source tree.
 *
 * The character is banned in UI copy, headings, tooltips, code comments, tests, docs and
 * commit messages. Replace it with a comma, a colon, parentheses, a semicolon or a
 * sentence break, whichever is grammatically correct in that spot. Numeric ranges are
 * written "20 to 200".
 *
 * U+2013 EN DASH stays legal in joint proper names (Avrami-Erofeev and Box-Muller are
 * set with it) but is rejected between two digits, which is a range.
 *
 * This file must never contain the characters it bans, so they are built from their code
 * points rather than written literally.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const NUMERIC_RANGE = new RegExp(`\\d\\s*${EN_DASH}\\s*\\d`);

const ROOTS = ['src', 'web', 'tests', 'docs', 'scripts'];
const LOOSE_FILES = ['CLAUDE.md', 'README.md'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.html', '.css', '.md', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'fonts', 'vendor']);

const walk = async (dir) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
};

/** Every violation in the tree, as `path:line: reason`. Empty means clean. */
export const findBannedPunctuation = async () => {
  const paths = [...(await Promise.all(ROOTS.map(walk))).flat(), ...LOOSE_FILES];
  const findings = [];
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, index) => {
      const at = `${path}:${index + 1}`;
      if (line.includes(EM_DASH)) {
        findings.push(`${at}: em dash (U+2014): ${line.trim().slice(0, 90)}`);
      }
      if (NUMERIC_RANGE.test(line)) {
        findings.push(`${at}: en dash between digits, write "a to b": ${line.trim().slice(0, 90)}`);
      }
    });
  }
  return { findings, checked: paths.length };
};

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const { findings, checked } = await findBannedPunctuation();
  if (findings.length > 0) {
    console.error(`no-em-dash: ${findings.length} violation(s)\n`);
    for (const finding of findings) console.error(`  ${finding}`);
    console.error('\nSee the punctuation rule in CLAUDE.md.');
    process.exit(1);
  }
  console.log(`no-em-dash: clean (${checked} files checked)`);
}
