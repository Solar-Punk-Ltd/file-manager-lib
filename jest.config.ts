module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // Run tests under tests folder.
  rootDir: 'tests',
  testMatch: ['**/tests/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 5 * 60 * 1000,
  verbose: true,
  globals: {
    window: {},
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  moduleDirectories: ['node_modules'],
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
    },
    {
      // Integration setup/teardown – files placed in tests/integration/test-node-setup folder.
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/tests/integration/test-node-setup/jestSetup.ts',
      globalTeardown: '<rootDir>/tests/integration/test-node-setup/jestTeardown.ts',
    },
    {
      displayName: 'browser',
      preset: 'jest-puppeteer',
      testMatch: ['<rootDir>/tests/browser/**/*.spec.ts'],
      setupFiles: ['<rootDir>/tests/browser/setupGlobals.ts'],
    },
  ],
};
