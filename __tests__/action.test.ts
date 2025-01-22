import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';
import { expect } from '@jest/globals';

test('action runs successfully', () => {
  // Set up environment variables
  process.env['INPUT_TOKEN'] = 'your-token';
  process.env['INPUT_TAG'] = 'your-tag';

  // Path to the action script
  const actionPath = path.join(__dirname, '..', 'lib', 'main.js');

  // Execute the action
  const options: cp.ExecSyncOptions = {
    env: process.env,
  };
  const result = cp.execSync(`node ${actionPath}`, options).toString();

  // Validate the result
  expect(result).toContain('expected result');
});