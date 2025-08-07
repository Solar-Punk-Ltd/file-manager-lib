import { execSync } from 'child_process';
import Path from 'path';

export default async function globalSetup(): Promise<void> {
  console.debug('Starting Bee Nodes...');
  const scriptPath = Path.resolve(__dirname, 'runBeeNode.sh');

  try {
    execSync(`chmod +x ${scriptPath}`);
    execSync(scriptPath, { stdio: 'inherit' });
    console.debug('Bee Nodes started successfully');
  } catch (error) {
    console.error('Error starting Bee Nodes:', error);
    process.exit(1);
  }
}
