import { existsSync, lstatSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Only known generated frontend output. Never delete evidence, session state or source.
const output = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(output)) {
  const stat = lstatSync(output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing unsafe dist path');
  rmSync(output, { recursive: true });
}
