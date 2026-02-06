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
  collectCoverage: true,
  coverageDirectory: '<rootDir>/tests/coverage',
  coverageReporters: ['lcov'],
  collectCoverageFrom: ['./src/**'],
  coveragePathIgnorePatterns: ['/node_modules/', './tests/**'],
  moduleDirectories: ['node_modules'],
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/tests/integration/test-node-setup/jestSetup.ts',
      globalTeardown: '<rootDir>/tests/integration/test-node-setup/jestTeardown.ts',
    },
  ],
};
