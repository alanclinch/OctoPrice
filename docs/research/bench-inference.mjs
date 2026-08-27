/**
 * How much CPU does forecast inference actually cost?
 *
 * Workers Free allows 10 ms of CPU per invocation. `docs/forecasting.md`
 * originally asserted that inference "runs in microseconds" without measuring
 * it, which is the kind of claim that quietly turns out to be wrong at the
 * worst moment.
 *
 * This measures the two candidate model shapes over a full 72-hour forecast
 * (144 half-hour periods). Node is not a Worker - V8 is the same engine but
 * the isolate and limits differ - so treat this as an order of magnitude, not
 * a pass mark. The real check is a deployed Worker reporting its own CPU time.
 *
 *   node docs/research/bench-inference.mjs
 */

const PERIODS = 144; // 72 hours of half-hour settlement periods
const FEATURES = 12;

/** A linear model: one coefficient per feature. */
function makeLinear() {
  return {
    weights: Array.from({ length: FEATURES }, () => Math.random() * 2 - 1),
    bias: Math.random(),
  };
}

function predictLinear(model, row) {
  let sum = model.bias;
  for (let i = 0; i < FEATURES; i += 1) sum += model.weights[i] * row[i];
  return sum;
}

/**
 * A gradient-boosted ensemble exported as JSON: an array of binary trees, each
 * node either a split (feature, threshold, left, right) or a leaf.
 */
function makeTree(depth) {
  if (depth === 0) return { leaf: Math.random() * 10 };
  return {
    feature: Math.floor(Math.random() * FEATURES),
    threshold: Math.random(),
    left: makeTree(depth - 1),
    right: makeTree(depth - 1),
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

const rows = Array.from({ length: PERIODS }, () =>
  Array.from({ length: FEATURES }, () => Math.random()),
);

function time(label, fn, budgetMs = 10) {
  fn(); // warm up so JIT compilation is not in the measurement
  const runs = 200;
  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) fn();
  const perRun = Number(process.hrtime.bigint() - start) / 1e6 / runs;
  const share = ((perRun / budgetMs) * 100).toFixed(1);
  console.log(
    `${label.padEnd(46)} ${perRun.toFixed(3)} ms   ${share.padStart(6)}% of a ${budgetMs} ms budget`,
  );
  return perRun;
}

console.log(`Forecasting ${PERIODS} periods with ${FEATURES} features each.\n`);

const linear = makeLinear();
time('linear model', () => rows.map((r) => predictLinear(linear, r)));

for (const [trees, depth] of [
  [100, 6],
  [300, 6],
  [500, 8],
  [1000, 8],
]) {
  const forest = Array.from({ length: trees }, () => makeTree(depth));
  const bytes = JSON.stringify(forest).length;
  time(
    `gradient-boosted: ${trees} trees, depth ${depth} (${(bytes / 1024 / 1024).toFixed(1)} MB JSON)`,
    () => rows.map((r) => predictForest(forest, r)),
  );
}

console.log(
  [
    '',
    'Caveats, so this is not over-read:',
    '  - Node, not a Worker. Same engine, different isolate and limits.',
    '  - Excludes JSON parse of the model, D1 round trips and response',
    '    building, which also count against the 10 ms.',
    '  - A large forest costs memory and parse time as well as CPU; parsing',
    '    a multi-megabyte model per invocation would dominate everything here.',
    '',
  ].join('\n'),
);
