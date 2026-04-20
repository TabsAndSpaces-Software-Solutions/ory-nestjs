/**
 * Jest globalSetup — boot the integration Ory stack once per `pnpm
 * test:integration` run.
 *
 * Strategy
 * --------
 * Uses Testcontainers' `DockerComposeEnvironment` to bring up the Kratos +
 * Postgres stack defined in `fixtures/docker-compose.integration.yml`.
 * Host-side port mappings are discovered after startup and persisted to
 * a handshake JSON file (`stack-handle.ts`) that every Jest worker reads.
 *
 * Why compose, not individual containers
 * --------------------------------------
 * The Kratos migration is expressed as a transient sibling service that
 * depends on `postgres` being healthy — reproducing that with standalone
 * `GenericContainer` calls is much more code than reading the two extra
 * lines of YAML. `DockerComposeEnvironment.withWaitStrategy` also gives
 * us a clean, typed way to wait on the `kratos` service's `/admin/health/ready`
 * endpoint before returning control.
 *
 * Timeouts
 * --------
 * The cold-start path downloads three Docker images (~200 MB) on first
 * run. We allow up to 180s; warm runs complete in ~10s.
 */
import * as path from 'node:path';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';

import { deleteHandle, writeHandle } from './stack-handle';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const COMPOSE_FILE = 'docker-compose.integration.yml';

// Eslint is happy with `var` on `globalThis` augmentations.
declare global {
  // eslint-disable-next-line no-var
  var __ORY_NESTJS_INT_STACK__: StartedDockerComposeEnvironment | undefined;
}

export default async function globalSetup(): Promise<void> {
  // Force a unique compose project name per run so parallel CI jobs don't
  // collide on the default `fixtures` project.
  const projectName = `orynestjs-int-${process.pid}-${Date.now().toString(36)}`;

  const env = await new DockerComposeEnvironment(FIXTURES_DIR, COMPOSE_FILE)
    .withProjectName(projectName)
    .withWaitStrategy(
      'kratos',
      Wait.forHttp('/admin/health/ready', 4434).forStatusCode(200),
    )
    .up(['kratos']); // Brings up postgres + kratos-migrate transitively.

  const kratos = env.getContainer('kratos-1');
  const kratosPublicPort = kratos.getMappedPort(4433);
  const kratosAdminPort = kratos.getMappedPort(4434);
  const host = kratos.getHost();

  writeHandle({
    kratosPublicUrl: `http://${host}:${kratosPublicPort}`,
    kratosAdminUrl: `http://${host}:${kratosAdminPort}`,
    composeProjectName: projectName,
  });

  // Stash on global so teardown can stop it without re-reading docker state.
  globalThis.__ORY_NESTJS_INT_STACK__ = env;

  // Dev ergonomics — surface the URLs so a human debugging a flaky test
  // can curl the stack while it's up.
  // eslint-disable-next-line no-console
  console.log(
    `[ory-nestjs/int] kratos ready:` +
      ` public=http://${host}:${kratosPublicPort}` +
      ` admin=http://${host}:${kratosAdminPort}` +
      ` project=${projectName}`,
  );

  // Clean up the handshake file if a prior run crashed mid-teardown.
  process.on('exit', () => {
    deleteHandle();
  });
}
