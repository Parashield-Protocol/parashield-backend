import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

describe('production entrypoint', () => {
  it('starts the application without running migrations', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'parashield-startup-'));
    const entrypoint = resolve(__dirname, '../../entrypoint.sh');

    try {
      for (const executable of ['node', 'npx']) {
        const fakeCommand = join(tempDir, executable);
        writeFileSync(fakeCommand, `#!/bin/sh\nprintf '${executable} invoked: %s\\n' "$*"\n`);
        chmodSync(fakeCommand, 0o755);
      }

      const output = execFileSync('sh', [entrypoint], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` },
      });

      expect(output).toContain('Starting application...');
      expect(output).toContain('node invoked: dist/main');
      expect(output).not.toContain('npx invoked');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});