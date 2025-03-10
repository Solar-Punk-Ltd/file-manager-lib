import { execSync } from 'child_process';
import path from 'path';

export default async function globalTeardown(): Promise<void> {
  console.log('Stopping Bee Nodes...');
  const scriptPath = path.resolve(__dirname, 'stopBeeNode.sh');

  try {
    execSync(`chmod +x ${scriptPath}`); // Ensure the script is executable
    execSync(scriptPath, { stdio: 'inherit' });
    console.log('Bee Nodes stopped successfully');
  } catch (error) {
    console.error('Error stopping Bee Nodes:', error);
    process.exit(1);
  }
}
