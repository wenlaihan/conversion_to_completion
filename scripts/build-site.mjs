/**
 * Assemble the static site for hosting.
 *
 * The pages import the compiled engine as a sibling: ../dist/... from web/. A static
 * host that serves web/ as its root therefore needs the engine at web/dist/, which
 * this script provides by copying the tsc output there after a build. The copy is
 * gitignored; it exists only as a deploy artifact.
 */
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = `${root}dist`;
const to = `${root}web/dist`;

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('site assembled: dist copied to web/dist');
