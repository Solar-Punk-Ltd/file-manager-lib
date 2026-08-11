const browserSetup = '<rootDir>/tests/platform-browser.ts';

const tsProject = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};

const unitTestMatch = ['<rootDir>/tests/unit/**/*.spec.ts'];

module.exports = {
  rootDir: '.',
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js'],
  testPathIgnorePatterns: ['/node_modules/'],
  transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
  testTimeout: 5 * 60 * 1000,
  globals: {
    window: {},
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  coverageProvider: 'v8',
  collectCoverage: false,
  coverageDirectory: '<rootDir>/tests/coverage',
  coverageReporters: ['lcov'],
  collectCoverageFrom: ['./src/**'],
  coveragePathIgnorePatterns: ['/node_modules/', './tests/**'],
  moduleDirectories: ['node_modules'],
  projects: [
    {
      ...tsProject,
      displayName: 'unit-node',
      testMatch: unitTestMatch,
      setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.ts'],
    },
    {
      ...tsProject,
      displayName: 'unit-browser',
      testMatch: unitTestMatch,
      setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.ts', browserSetup],
    },
    {
      ...tsProject,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/tests/integration/setup/jestSetup.ts',
      globalTeardown: '<rootDir>/tests/integration/setup/jestTeardown.ts',
    },
  ],
};
