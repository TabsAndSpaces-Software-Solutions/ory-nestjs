/**
 * Unit tests for `OryClientFactory.build(tenant, deps)` — assembles a
 * `TenantClients` bundle from a TenantConfig and a pre-built axios
 * instance.
 */
import axios, { AxiosInstance } from 'axios';
import {
  FrontendApi,
  IdentityApi,
  OAuth2Api,
  PermissionApi,
  RelationshipApi,
} from '@ory/client';

import { OryClientFactory } from '../../../src/clients/ory-client.factory';
import type { TenantConfig } from '../../../src/config';

function mkAxios(): AxiosInstance {
  return axios.create();
}

function selfHostedKratosOnly(): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'bearer',
    kratos: {
      publicUrl: 'https://kratos.test/public',
      sessionCookieName: 'ory_kratos_session',
    },
  } as TenantConfig;
}

function selfHostedFull(): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie-or-bearer',
    kratos: {
      publicUrl: 'https://kratos.test/public',
      adminUrl: 'https://kratos.test/admin',
      adminToken: 'secret-kratos-admin',
      sessionCookieName: 'ory_kratos_session',
    },
    keto: {
      readUrl: 'https://keto.test/read',
      writeUrl: 'https://keto.test/write',
    },
    hydra: {
      publicUrl: 'https://hydra.test/public',
      adminUrl: 'https://hydra.test/admin',
      adminToken: 'secret-hydra-admin',
    },
    trustProxy: true,
  } as TenantConfig;
}

function cloudTenant(): TenantConfig {
  return {
    mode: 'cloud',
    transport: 'bearer',
    kratos: {
      publicUrl: 'https://unused.test',
      sessionCookieName: 'ory_kratos_session',
    },
    cloud: {
      projectSlug: 'myslug',
      apiKey: 'ory_pat_xxx',
    },
  } as TenantConfig;
}

describe('OryClientFactory.build', () => {
  it('self-hosted with Kratos only → kratosFrontend present, others undefined', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedKratosOnly(), {
      axios: ax,
    });
    expect(clients.tenant).toBe('default');
    expect(clients.axios).toBe(ax);
    expect(clients.kratosFrontend).toBeInstanceOf(FrontendApi);
    expect(clients.kratosIdentity).toBeUndefined();
    expect(clients.ketoPermission).toBeUndefined();
    expect(clients.ketoRelationship).toBeUndefined();
    expect(clients.hydraOauth2).toBeUndefined();
  });

  it('self-hosted Kratos admin → kratosIdentity exists with accessToken = adminToken', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedFull(), {
      axios: ax,
    });
    expect(clients.kratosIdentity).toBeInstanceOf(IdentityApi);
    // Configuration is protected on BaseAPI; inspect via casting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (clients.kratosIdentity as any).configuration;
    expect(cfg.accessToken).toBe('secret-kratos-admin');
    expect(cfg.basePath).toBe('https://kratos.test/admin');
  });

  it('self-hosted Kratos public basePath is kratos.publicUrl', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedFull(), {
      axios: ax,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (clients.kratosFrontend as any).configuration;
    expect(cfg.basePath).toBe('https://kratos.test/public');
  });

  it('self-hosted keto configured → ketoPermission and ketoRelationship present with correct basePaths', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedFull(), {
      axios: ax,
    });
    expect(clients.ketoPermission).toBeInstanceOf(PermissionApi);
    expect(clients.ketoRelationship).toBeInstanceOf(RelationshipApi);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.ketoPermission as any).configuration.basePath).toBe(
      'https://keto.test/read',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.ketoRelationship as any).configuration.basePath).toBe(
      'https://keto.test/write',
    );
  });

  it('self-hosted hydra configured → hydraOauth2 present with admin basePath and accessToken', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedFull(), {
      axios: ax,
    });
    expect(clients.hydraOauth2).toBeInstanceOf(OAuth2Api);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (clients.hydraOauth2 as any).configuration;
    expect(cfg.basePath).toBe('https://hydra.test/admin');
    expect(cfg.accessToken).toBe('secret-hydra-admin');
  });

  it('cloud mode → basePath is https://{slug}.projects.oryapis.com and accessToken = cloud.apiKey', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', cloudTenant(), {
      axios: ax,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frontendCfg = (clients.kratosFrontend as any).configuration;
    expect(frontendCfg.basePath).toBe('https://myslug.projects.oryapis.com');
    // Cloud auto-provisions admin / keto / hydra (all via the same cloud
    // project), each carrying the cloud api key.
    expect(clients.kratosIdentity).toBeInstanceOf(IdentityApi);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idCfg = (clients.kratosIdentity as any).configuration;
    expect(idCfg.basePath).toBe('https://myslug.projects.oryapis.com');
    expect(idCfg.accessToken).toBe('ory_pat_xxx');
  });

  it('wires the shared axios instance into each API configuration.baseOptions', () => {
    const ax = mkAxios();
    const clients = OryClientFactory.build('default', selfHostedFull(), {
      axios: ax,
    });
    // BaseAPI stores axios via constructor argument — read it off the
    // protected `axios` slot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.kratosFrontend as any).axios).toBe(ax);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.kratosIdentity as any).axios).toBe(ax);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.ketoPermission as any).axios).toBe(ax);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.ketoRelationship as any).axios).toBe(ax);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clients.hydraOauth2 as any).axios).toBe(ax);
  });
});
