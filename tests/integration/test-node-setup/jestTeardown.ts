import { execSync } from 'child_process';

export default async function globalTeardown(): Promise<void> {
  console.debug('Stopping bee-factory stack...');

  try {
    execSync('npx bee-factory stop', { stdio: 'inherit' });
    console.debug('bee-factory stack stopped successfully');
  } catch (error) {
    console.error('Error stopping bee-factory stack:', error);
    process.exit(1);
  }
}
