/**
 * How much CPU might forecast inference cost? A *sizing experiment*.
 *
 * This is deliberately not called a benchmark. It is synthetic, it runs in
 * local Node rather than a Worker, and it excludes model parsing, D1 round
 * trips and response building — all of which also count against the CPU
 * budget. Its only job is to answer "which model sizes are obviously fine and
 * which are obviously not", to an order of magnitude.
 *
 * An earlier version was worse than this: unseeded, so every run built
 * differently shaped trees, and it reported a single mean. A rerun on the same
 * machine produced 500-tree timings ~55% higher than the figure quoted in the
 * documentation, which is exactly the kind of number that should not have been
 * written down as though it were precise. It is now seeded, reports a
 * distribution, and records what it ran on.
 *
 * Free-tier feasibility is only settled by measuring the chosen model in a
 * deployed Worker, which reports its own CPU time.
 *
 *   node docs/research/bench-inference.mjs
 */

import { cpus, totalmem } from 'node:os';

const PERIODS = 144; // 72 hours of half-hour settlement periods
const FEATURES = 12;
const SEED = 20260827;
const REPEATS = 15;
const RUNS_PER_REPEAT = 50;
const BUDGET_MS = 10; // Workers Free, per invocation, HTTP *and* Cron alike

/** Deterministic PRNG, so tree shape is identical between runs and machines. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLinear(random) {
  return {
    weights: Array.from({ length: FEATURES }, () => random() * 2 - 1),
    bias: random(),
  };
}

function predictLinear(model, row) {
  let sum = model.bias;
  for (let i = 0; i < FEATURES; i += 1) sum += model.weights[i] * row[i];
  return sum;
}

function makeTree(random, depth) {
  if (depth === 0) return { leaf: random() * 10 };
  return {
    feature: Math.floor(random() * FEATURES),
    threshold: random(),
    left: makeTree(random, depth - 1),
    right: makeTree(random, depth - 1),
  };
}

function predictTree(node, row) {
  while (node.leaf === undefined) {
    node = row[node.feature] < node.threshold ? node.left : node.right;
  }
  return node.leaf;
}

function predictForest(forest, row) {
  let sum = 0;
  for (const tree of forest) sum += predictTree(tree, row);
  return sum;
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

function measure(label, fn) {
  for (let i = 0; i < 5; i += 1) fn(); // warm up the JIT

  const samples = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const start = process.hrtime.bigint();
    for (let run = 0; run < RUNS_PER_REPEAT; run += 1) fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6 / RUNS_PER_REPEAT);
  }
  samples.sort((a, b) => a - b);

  const median = quantile(samples, 0.5);
  const p95 = quantile(samples, 0.95);
  const verdict = p95 > BUDGET_MS ? 'OVER BUDGET' : p95 > BUDGET_MS * 0.5 ? 'tight' : 'fits';

  console.log(
    `${label.padEnd(40)} median ${median.toFixed(2).padStart(6)} ms   ` +
      `p95 ${p95.toFixed(2).padStart(6)} ms   ` +
      `${((p95 / BUDGET_MS) * 100).toFixed(0).padStart(4)}% of budget   ${verdict}`,
  );
}

const random = mulberry32(SEED);
const rows = Array.from({ length: PERIODS }, () =>
  Array.from({ length: FEATURES }, () => random()),
);

console.log('Sizing experiment — NOT a Worker benchmark. See the header.\n');
console.log(`runtime   Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`cpu       ${cpus()[0]?.model?.trim() ?? 'unknown'} x${cpus().length}`);
console.log(`memory    ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
console.log(`method    seed ${SEED}, ${REPEATS} repeats x ${RUNS_PER_REPEAT} runs`);
console.log(`workload  ${PERIODS} periods x ${FEATURES} features, ${BUDGET_MS} ms budget\n`);

const linear = makeLinear(random);
measure('linear model', () => rows.map((r) => predictLinear(linear, r)));

for (const [trees, depth] of [
  [100, 6],
  [300, 6],
  [500, 8],
  [1000, 8],
]) {
  const forest = Array.from({ length: trees }, () => makeTree(random, depth));
  const mb = JSON.stringify(forest).length / 1024 / 1024;
  measure(`${trees} trees, depth ${depth} (${mb.toFixed(1)} MB JSON)`, () =>
    rows.map((r) => predictForest(forest, r)),
  );
}

console.log(
  [
    '',
    'Reading this correctly:',
    '  - Local Node, not a Worker. Same engine, different isolate and limits.',
    '  - Excludes JSON parse of the model, D1 round trips and response',
    '    building, which also count against the same budget.',
    '  - Timings vary by machine and by run; treat the verdict column, not the',
    '    milliseconds, as the finding.',
    '  - Model size binds as tightly as CPU: parsing a multi-megabyte artefact',
    '    per invocation would dominate everything measured here.',
    '',
  ].join('\n'),
);
