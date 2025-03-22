import { execSync } from 'child_process';
import Path from 'path';

export default async function globalSetup(): Promise<void> {
  console.log('Starting Bee Nodes...');
  // This script now runs the modified shell script that starts two nodes.
  const scriptPath = Path.resolve(__dirname, 'runBeeNode.sh');

  try {
    execSync(`chmod +x ${scriptPath}`); // Ensure the script is executable
    execSync(scriptPath, { stdio: 'inherit' });
    console.log('Bee Nodes started successfully');
  } catch (error) {
    console.error('Error starting Bee Nodes:', error);
    process.exit(1);
  }
}
