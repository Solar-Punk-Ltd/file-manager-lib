import { execSync } from 'child_process';
import path from 'path';

export default async function globalTeardown(): Promise<void> {
  console.debug('Stopping Bee Nodes...');
  const scriptPath = path.resolve(__dirname, 'stopBeeNode.sh');

  // Check if we should keep the bee-dev directory
  const keepDirs = process.env.KEEP_BEE_DIRS === 'true' ? 'keep' : '';

  try {
    execSync(`chmod +x ${scriptPath}`);
    execSync(`${scriptPath} ${keepDirs}`, { stdio: 'inherit' });
    console.debug('Bee Nodes stopped successfully');
  } catch (error) {
    console.error('Error stopping Bee Nodes:', error);
    process.exit(1);
  }
}
