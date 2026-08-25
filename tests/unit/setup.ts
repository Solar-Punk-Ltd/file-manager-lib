jest.mock('@/utils/bee', () => ({
  ...jest.requireActual('@/utils/bee'),
  getFeedData: jest.fn(),
  fetchStamp: jest.fn(),
  writeActFeed: jest.fn(),
}));

jest.mock('@/utils/mantaray', () => ({
  ...jest.requireActual('@/utils/mantaray'),
  loadMantaray: jest.fn(),
  getAllNodeEntries: jest.fn(),
}));

export {};
