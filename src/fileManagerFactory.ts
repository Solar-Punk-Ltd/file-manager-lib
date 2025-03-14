import { Bee } from '@upcoming/bee-js';

import { FileManagerBrowser } from './fileManager/fileManager.browser';
import { FileManagerNode } from './fileManager/fileManager.node';
import { FactoryError } from './utils/errors';
import { EventEmitterBase } from './utils/eventEmitter';
import { FileManager } from './utils/types';

export enum FileManagerType {
  Node,
  Browser,
}

export class FileManagerFactory {
  static async create(type: FileManagerType, bee: Bee, emitter?: EventEmitterBase): Promise<FileManager> {
    let fileManager: FileManager;

    switch (type) {
      case FileManagerType.Node:
        fileManager = new FileManagerNode(bee, emitter);
        break;
      case FileManagerType.Browser:
        fileManager = new FileManagerBrowser(bee, emitter);
        break;
      default:
        throw new FactoryError(`Invalid file manager type: ${type}`);
    }

    await fileManager.initialize();
    return fileManager;
  }
}
