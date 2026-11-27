import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../scripts/configure-youtube-api-key.sh', import.meta.url));

function createFakeCommands(home) {
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const systemctlPath = path.join(bin, 'systemctl');
  const curlPath = path.join(bin, 'curl');
  writeFileSync(systemctlPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/commands.log"\n');
  writeFileSync(curlPath, '#!/bin/sh\nprintf \'{"status":"ok","providers":{"youtubeSearch":true}}\\n\'\n');
  chmodSync(systemctlPath, 0o700);
  chmodSync(curlPath, 0o700);
  return bin;
}

function runSetup(home, key) {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', `bash "${scriptPath}"`, '/dev/null'], {
      env: { ...process.env, HOME: home, PATH: `${createFakeCommands(home)}:${process.env.PATH}` }
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('setup script did not prompt for the key'));
    }, 3000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!sent && stdout.includes('API key YouTube')) {
        sent = true;
        child.stdin.write(`${key}\n`);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', status => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

describe('local YouTube API key setup', () => {
  it('stores the key privately without echoing it, then reloads and restarts Rync', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rync-key-'));
    const key = 'AIzaTest_1234567890abcdef';
    try {
      const result = await runSetup(home, key);
      const envFile = path.join(home, '.config/rync432/youtube.env');
      const dropin = path.join(home, '.config/systemd/user/rync432.service.d/25-youtube-api-key.conf');
      const commands = readFileSync(path.join(home, 'commands.log'), 'utf8');

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(key);
      expect(readFileSync(envFile, 'utf8')).toBe(`YOUTUBE_DATA_API_KEY=${key}\n`);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(dropin, 'utf8')).toContain('EnvironmentFile=%h/.config/rync432/youtube.env');
      expect(commands).toContain('--user daemon-reload');
      expect(commands).toContain('--user restart rync432.service');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an invalid key before changing service files', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rync-key-'));
    try {
      const result = await runSetup(home, 'bad key');

      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(home, 'commands.log'))).toBe(false);
      expect(existsSync(path.join(home, '.config/rync432/youtube.env'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
