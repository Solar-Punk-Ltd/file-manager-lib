import { Bee } from '@ethersphere/bee-js';

import { FileManagerBase } from '../../src/fileManager/fileManager';
import { FileManagerBrowser } from '../../src/fileManager/fileManager.browser';
import { FileManagerNode } from '../../src/fileManager/fileManager.node';
import { FileManagerFactory, FileManagerType } from '../../src/fileManagerFactory';
import { FactoryError } from '../../src/utils/errors';
import { EventEmitter } from '../../src/utils/eventEmitter';
import { FileManagerEvents } from '../../src/utils/events';
import { createInitMocks, createMockGetFeedDataResult } from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

jest.mock('../../src/utils/common');

describe('FileManagerFactory', () => {
  let bee: Bee;
  beforeEach(() => {
    jest.resetAllMocks();

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { getFeedData } = require('../../src/utils/common');
    getFeedData.mockResolvedValue(createMockGetFeedDataResult(0, 1));

    bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
  });

  describe('create', () => {
    it('should create Node file manager', async () => {
      createInitMocks();

      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const fileManager = await FileManagerFactory.create(FileManagerType.Node, bee, emitter);

      expect(fileManager).toBeDefined();
      expect(fileManager).toBeInstanceOf(FileManagerBase);
      expect(fileManager).toBeInstanceOf(FileManagerNode);
      expect(fileManager.getFileInfoList()).toHaveLength(0);
      expect(fileManager.getSharedWithMe()).toHaveLength(0);
      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should create Browser file manager', async () => {
      createInitMocks();
      const logSpy = jest.spyOn(console, 'error');
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      const fileManager = await FileManagerFactory.create(FileManagerType.Browser, bee, emitter);

      expect(fileManager).toBeDefined();
      expect(fileManager).toBeInstanceOf(FileManagerBase);
      expect(fileManager).toBeInstanceOf(FileManagerBrowser);
      expect(fileManager.getFileInfoList()).toHaveLength(0);
      expect(fileManager.getSharedWithMe()).toHaveLength(0);
      expect(eventHandler).toHaveBeenCalledWith(false);
      expect(logSpy).toHaveBeenCalledWith('Failed to initialize FileManager: ReferenceError: window is not defined');
    });

    it('should throw an error for invalid type', async () => {
      createInitMocks();
      await expect(FileManagerFactory.create(2 as FileManagerType, bee)).rejects.toThrow(
        new FactoryError('Invalid file manager type: 2'),
      );
    });
  });
});
