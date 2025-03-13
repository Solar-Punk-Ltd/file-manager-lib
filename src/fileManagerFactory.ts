import { Bee } from '@upcoming/bee-js';

import { FactoryError } from './utils/errors';
import { FileManager } from './fileManager';
import { FileManagerBrowser } from './fileManager.browser';
import { FileManagerNode } from './fileManager.node';

export enum FileManagerType {
  Node,
  Browser,
}

export const fileManagerFactory = (type: FileManagerType, bee: Bee): FileManager => {
  switch (type) {
    case FileManagerType.Node:
      return new FileManagerNode(bee);
    case FileManagerType.Browser:
      return new FileManagerBrowser(bee);
    default:
      throw new FactoryError(`Invalid file manager type: ${type}`);
  }
};
