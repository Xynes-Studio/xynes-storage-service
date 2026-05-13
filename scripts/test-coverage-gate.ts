const MIN_FUNCS = Number.parseFloat(process.env.COVERAGE_MIN_FUNCS ?? '80');
const MIN_LINES = Number.parseFloat(process.env.COVERAGE_MIN_LINES ?? '80');

function parseAllFilesLine(output: string): { funcs: number; lines: number } | null {
  // Bun prints a coverage table with an "All files" row like:
  // All files |   89.33 |   96.49 |
  const match = output.match(
    /\n\s*All files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|/,
  );
  if (!match) return null;
  return { funcs: Number.parseFloat(match[1]), lines: Number.parseFloat(match[2]) };
}

const proc = Bun.spawn({
  cmd: [process.execPath, 'test', '--coverage'],
  stdout: 'pipe',
  stderr: 'pipe',
  env: process.env,
});

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
process.stdout.write(stdout);
process.stderr.write(stderr);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

const parsed = parseAllFilesLine(stdout + '\n' + stderr);
if (!parsed) {
  console.error('[CoverageGate] Could not parse Bun coverage output (missing "All files" row).');
  process.exit(2);
}

const failures: string[] = [];
if (Number.isFinite(MIN_FUNCS) && parsed.funcs < MIN_FUNCS) {
  failures.push(`functions ${parsed.funcs.toFixed(2)}% < ${MIN_FUNCS}%`);
}
if (Number.isFinite(MIN_LINES) && parsed.lines < MIN_LINES) {
  failures.push(`lines ${parsed.lines.toFixed(2)}% < ${MIN_LINES}%`);
}

if (failures.length > 0) {
  console.error(`[CoverageGate] Coverage below minimum: ${failures.join(', ')}`);
  process.exit(1);
}

console.log(
  `[CoverageGate] OK (funcs=${parsed.funcs.toFixed(2)}%, lines=${parsed.lines.toFixed(2)}%)`,
);
