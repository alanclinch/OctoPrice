/**
 * Issues an access link from the command line.
 *
 * This exists for the one case the web interface cannot serve: the owner needs
 * a link before anybody can sign in, and there is no session yet to authorise
 * creating one. Doing it here rather than through a public "bootstrap"
 * endpoint means the only person who can claim ownership is someone who
 * already has access to the database.
 *
 * Everyone else gets their link from the Settings screen, which is easier.
 *
 * Usage:
 *   npm run issue-link -- --url https://your-worker.workers.dev
 *   npm run issue-link -- --local
 *
 * The link is written to a git-ignored file rather than printed, so it does
 * not end up in shell history or a screen share.
 */

import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const OUTPUT_FILE = '.octoprice-link.txt';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main(): Promise<void> {
  const local = process.argv.includes('--local');
  const siteUrl = argument('url') ?? process.env.SITE_URL ?? '';
  // Defaults to the owner, which is the whole point of the script.
  const target = argument('user');

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = toBase64Url(bytes);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const where = target ? `id = '${target.replace(/'/g, "''")}'` : 'is_owner = 1';
  const sql = `UPDATE users SET token_hash = '${hash}', claimed_at = NULL WHERE ${where};`;

  const sqlitePath = argument('sqlite');
  if (sqlitePath) {
    // Local Node development, which uses a SQLite file rather than D1.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(sqlitePath);
    db.exec(sql);
    db.close();
    process.stdout.write(`Issued a link in ${sqlitePath}.\n`);
  } else {
    // The statement goes through a file rather than --command. Passing SQL as
    // an argument means the shell has to quote a string containing spaces and
    // quote marks, which silently mangles it on Windows.
    const sqlFile = '.octoprice-issue-link.sql';
    writeFileSync(sqlFile, sql, 'utf8');

    process.stdout.write(`Issuing a link against the ${local ? 'local' : 'remote'} database...\n`);
    try {
      execFileSync(
        'npx',
        [
          'wrangler',
          'd1',
          'execute',
          'octoprice',
          local ? '--local' : '--remote',
          '--file',
          sqlFile,
          '--yes',
        ],
        { stdio: 'inherit', shell: process.platform === 'win32' },
      );
    } finally {
      rmSync(sqlFile, { force: true });
    }
  }

  const link = siteUrl ? `${siteUrl.replace(/\/$/, '')}/?invite=${token}` : `/?invite=${token}`;
  writeFileSync(OUTPUT_FILE, `${link}\n`, 'utf8');

  process.stdout.write(
    [
      '',
      `Done. The link has been written to ${OUTPUT_FILE}.`,
      'Open that file, use the link once, then delete the file.',
      siteUrl ? '' : 'Tip: pass --url https://your-site to get a complete link.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to issue a link: ${String(error)}\n`);
  process.exit(1);
});
