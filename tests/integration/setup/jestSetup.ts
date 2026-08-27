import { execFileSync } from 'child_process';

const BEE_FACTORY_TAG = process.env.BEE_FACTORY_TAG ?? 'v2.8.0';

export default async function globalSetup(): Promise<void> {
  console.debug(`Starting bee-factory stack (tag: ${BEE_FACTORY_TAG})...`);

  try {
    execFileSync('npx', ['bee-factory', 'start', '--tag', BEE_FACTORY_TAG], { stdio: 'inherit' });
    console.debug('bee-factory stack started successfully');
  } catch (error) {
    console.error('Error starting bee-factory stack:', error);
    process.exit(1);
  }
}
