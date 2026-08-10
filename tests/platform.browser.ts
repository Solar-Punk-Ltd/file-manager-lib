jest.mock('std-env', () => ({ ...jest.requireActual('std-env'), isNode: false }));

export {};
