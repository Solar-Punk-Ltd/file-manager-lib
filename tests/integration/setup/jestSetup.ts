import { Bee } from '@ethersphere/bee-js';
import { execFileSync } from 'child_process';

import { ADMIN_DRIVE_NAME } from '../../../src/utils/constants';

const BEE_FACTORY_TAG = process.env.BEE_FACTORY_TAG ?? 'v2.8.1';

export default async function globalSetup(): Promise<void> {
  console.debug(`Starting bee-factory stack (tag: ${BEE_FACTORY_TAG})...`);

  try {
    execFileSync('npx', ['bee-factory', 'start', '--tag', BEE_FACTORY_TAG], { stdio: 'inherit' });
    console.debug('bee-factory stack started successfully');
  } catch (error) {
    console.error('Error starting bee-factory stack:', error);
    process.exit(1);
  }

  // Every worker needs the shared admin stamp; buying it once here keeps them from racing for it.
  const bee = new Bee('http://127.0.0.1:1633');
  await bee.stamp.create('500000000', 21, { label: ADMIN_DRIVE_NAME, waitForUsable: true });
}
