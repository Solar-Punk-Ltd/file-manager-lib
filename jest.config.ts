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
      displayName: 'unit-node',
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
      displayName: 'integration-node',
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
    {
      displayName: 'unit-browser',
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        'std-env': '<rootDir>/tests/mocks/std-env.ts',
      },
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
    },
    {
      displayName: 'integration-browser',
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(std-env|cafe-utility|bee-js)/)'],
      setupFilesAfterFramework: ['<rootDir>/tests/mocks/bee-stream-polyfills.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        'std-env': '<rootDir>/tests/mocks/std-env.ts',
      },
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/tests/integration/test-node-setup/jestSetup.ts',
      globalTeardown: '<rootDir>/tests/integration/test-node-setup/jestTeardown.ts',
    },
  ],
};
