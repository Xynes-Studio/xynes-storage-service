const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: bun run scripts/run-with-env.ts <bun-subcommand...>

Examples:
  bun run scripts/run-with-env.ts run --watch src/index.ts
  bun run scripts/run-with-env.ts test
  bun run scripts/run-with-env.ts run scripts/test-coverage-gate.ts

Env:
  XYNES_ENV_FILE (default: .env.dev)
`);
  process.exit(0);
}

const envFile = process.env.XYNES_ENV_FILE || '.env.dev';
const hasExplicitEnvFile = args.some(
  (arg) => arg === '--env-file' || arg.startsWith('--env-file='),
);

const forwardedArgs = args;
const env = { ...process.env };

const bunArgs = [
  process.execPath,
  ...(hasExplicitEnvFile ? [] : [`--env-file=${envFile}`]),
  ...forwardedArgs,
];

const child = Bun.spawn({
  cmd: bunArgs,
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});

const exitCode = await child.exited;
process.exit(exitCode);
