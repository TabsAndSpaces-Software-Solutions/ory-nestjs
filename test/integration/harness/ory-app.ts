/**
 * Alternate integration app builder that wires the full Kratos + Keto +
 * Hydra stack (in contrast to `make-app.ts`, which is Kratos-only). Returns
 * a Nest test module handle plus direct service references so Keto/Hydra
 * specs can exercise them without going through HTTP.
 *
 * Skips tests automatically when the harness brought up Kratos-only.
 */
import { Test, TestingModule } from '@nestjs/testing';

import {
  IamModule,
  OAuth2ClientService,
  PermissionService,
  TokenService,
  JwkService,
  type IamOptions,
  type ValidatedTenantConfig,
} from '../../../src';

import { readHandle, type StackHandle } from './stack-handle';

export interface FullStackHandle {
  readonly module: TestingModule;
  readonly handle: StackHandle;
  readonly oauth2Clients: OAuth2ClientService;
  readonly permissions: PermissionService;
  readonly tokens: TokenService;
  readonly jwks: JwkService;
  close(): Promise<void>;
}

export async function maybeMakeFullStackApp(): Promise<FullStackHandle | null> {
  const handle = readHandle();
  if (
    !handle.ketoReadUrl ||
    !handle.ketoWriteUrl ||
    !handle.hydraPublicUrl ||
    !handle.hydraAdminUrl
  ) {
    return null;
  }
  const tenantConfig = {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: handle.kratosPublicUrl,
      adminUrl: handle.kratosAdminUrl,
      adminToken: 'integration-test-unused',
      sessionCookieName: 'ory_kratos_session',
    },
    keto: {
      readUrl: handle.ketoReadUrl,
      writeUrl: handle.ketoWriteUrl,
    },
    hydra: {
      publicUrl: handle.hydraPublicUrl,
      adminUrl: handle.hydraAdminUrl,
    },
  } as unknown as ValidatedTenantConfig;

  const iamOptions: IamOptions = {
    tenants: { demo: tenantConfig },
    defaultTenant: 'demo',
    global: false,
  };

  const module = await Test.createTestingModule({
    imports: [IamModule.forRoot(iamOptions)],
  }).compile();

  const oauth2Clients = module.get(OAuth2ClientService);
  const permissions = module.get(PermissionService);
  const tokens = module.get(TokenService);
  const jwks = module.get(JwkService);

  return {
    module,
    handle,
    oauth2Clients,
    permissions,
    tokens,
    jwks,
    close: async () => {
      await module.close();
    },
  };
}
