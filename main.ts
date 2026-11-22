// Driver harness (dipertahankan dari baseline makefun-site 1.0.0): baca tiap
// case dari /input/cases.json, jawab dengan run() dari solve.js, tulis
// /output/answers.json. Di luar container, MAKEFUN_INPUT_DIR dan
// MAKEFUN_OUTPUT_DIR menggantikan /input dan /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 incremental marking dimatikan, disetel sebelum solve.js diimpor supaya
// seluruh kerjanya berjalan di bawah flag itu (baseline berjalan dengan
// --no-incremental-marking, dan entry boleh menyetel flag V8 yang sama).
setFlagsFromString('--no-incremental-marking');

/** solve.js, diimpor lewat URL-nya (modul .js tanpa tipe) dan diketik lewat kontraknya. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
