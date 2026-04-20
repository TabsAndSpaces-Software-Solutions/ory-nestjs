/**
 * Jest globalTeardown — stop + remove the integration stack.
 *
 * Runs once, after every spec has finished. If the global handle is missing
 * (globalSetup crashed before stashing it), we still clean up the handshake
 * file so the next run starts from a known state.
 */
import type { StartedDockerComposeEnvironment } from 'testcontainers';

import { deleteHandle } from './stack-handle';

declare global {
  // eslint-disable-next-line no-var
  var __ORY_NESTJS_INT_STACK__: StartedDockerComposeEnvironment | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const env = globalThis.__ORY_NESTJS_INT_STACK__;
  if (env !== undefined) {
    try {
      await env.down({ removeVolumes: true });
    } catch (err) {
      // Surface but do NOT rethrow — teardown failure should not mask a
      // passing suite.
      // eslint-disable-next-line no-console
      console.warn(
        '[ory-nestjs/int] stack teardown failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  deleteHandle();
}
