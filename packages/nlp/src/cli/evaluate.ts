#!/usr/bin/env node
/** Prints the cross-validated evaluation report for the seed model: `pnpm nlp:evaluate`. */
import { loadSeedDataset } from '../dataset.ts';
import { evaluate } from '../evaluate.ts';

const report = evaluate(loadSeedDataset(), 5);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(
  `\nComment model — ${report.folds}-fold cross-validation on ${report.examples} examples\n`,
);
console.log('SENTIMENT');
console.log(
  `  macro-F1   ${report.sentiment.macroF1.toFixed(3)}   (majority baseline ${report.sentiment.majorityBaseline.macroF1.toFixed(3)})`,
);
console.log(
  `  accuracy   ${pct(report.sentiment.accuracy)}   (majority baseline ${pct(report.sentiment.majorityBaseline.accuracy)})`,
);
console.log(
  `  calibration ECE ${report.sentiment.calibration.ece.toFixed(3)}   (uncalibrated ${report.sentiment.calibration.eceUncalibrated.toFixed(3)}; mean confidence ${pct(report.sentiment.calibration.meanConfidence)})`,
);
for (const [label, m] of Object.entries(report.sentiment.perClass)) {
  console.log(
    `    ${label.padEnd(9)} P ${m.precision.toFixed(2)}  R ${m.recall.toFixed(2)}  F1 ${m.f1.toFixed(2)}  (n=${m.support})`,
  );
}
console.log('  by language:');
for (const [lang, v] of Object.entries(report.sentiment.byLanguage)) {
  console.log(`    ${lang.padEnd(8)} ${pct(v.accuracy).padStart(6)}  (n=${v.n})`);
}
console.log('\nNEEDS (multi-label)');
for (const [name, r] of Object.entries(report.needs)) {
  console.log(
    `  ${name.padEnd(12)} micro-F1 ${r.microF1.toFixed(3)}   macro-F1 ${r.macroF1.toFixed(3)}`,
  );
}
console.log('\nSUGGESTION ("what needs to be done")');
for (const [name, m] of Object.entries(report.suggestion)) {
  console.log(
    `  ${name.padEnd(12)} P ${m.precision.toFixed(2)}  R ${m.recall.toFixed(2)}  F1 ${m.f1.toFixed(2)}`,
  );
}
console.log(`\n${report.caveat}\n`);
