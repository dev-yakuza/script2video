import { defineConfig } from 'vitest/config';

// S8: the lock tests that start many processes (races, ending holders, the CLI) run after the
// rest (not beside other files: they slowed unrelated tests down).
const PROCESS_HEAVY = [
  'packages/cli/test/heavy-race.test.ts',
  'packages/cli/test/heavy-exit.test.ts',
  'packages/cli/test/heavy-cli.test.ts',
];

export default defineConfig({
  test: {
    // S8: a state folder per test file (the machine lock never touches ~/.s2v)
    setupFiles: ['packages/cli/test/setup-state-dir.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: PROCESS_HEAVY,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'processes',
          include: PROCESS_HEAVY,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
