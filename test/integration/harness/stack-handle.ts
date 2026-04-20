/**
 * Handshake file exchanged between the Jest globalSetup (which boots the
 * Ory stack) and the worker processes (which run individual specs).
 *
 * Why a file: Jest spawns each test worker in its own child process, so
 * in-process module state set from globalSetup does NOT reach them. The
 * documented contract is (a) export handles onto `globalThis` (which Jest
 * serializes for `testEnvironmentOptions`, with caveats) or (b) write a
 * file and read it back. The file approach is simpler and survives cross-
 * worker parallelism — every worker reads the same handshake.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StackHandle {
  readonly kratosPublicUrl: string;
  readonly kratosAdminUrl: string;
  readonly composeProjectName: string;
}

const HANDSHAKE_FILE = path.join(__dirname, '.stack-handle.json');

export function writeHandle(handle: StackHandle): void {
  fs.writeFileSync(HANDSHAKE_FILE, JSON.stringify(handle, null, 2), 'utf8');
}

export function readHandle(): StackHandle {
  if (!fs.existsSync(HANDSHAKE_FILE)) {
    throw new Error(
      `Integration stack handshake file not found at ${HANDSHAKE_FILE}. ` +
        `Did Jest globalSetup run? If you're invoking a single spec, use ` +
        `\`pnpm test:integration\` so the harness spins up first.`,
    );
  }
  const raw = fs.readFileSync(HANDSHAKE_FILE, 'utf8');
  return JSON.parse(raw) as StackHandle;
}

export function deleteHandle(): void {
  if (fs.existsSync(HANDSHAKE_FILE)) {
    fs.unlinkSync(HANDSHAKE_FILE);
  }
}
