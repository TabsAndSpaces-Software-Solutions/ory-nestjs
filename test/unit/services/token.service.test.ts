/**
 * Unit tests for `TokenService` (spec unit `tks`).
 *
 * Covers the full TokenService contract:
 *   - `TokenService.forTenant(name)` returns a stable, memoized wrapper per
 *     tenant (same reference on repeated calls; distinct references across
 *     tenants).
 *   - `clientCredentials(scope)`:
 *       * Missing `hydraOauth2` on the tenant bundle -> IamConfigurationError.
 *       * Missing `clientId` / `clientSecret` in the tenant's hydra config
 *         -> IamConfigurationError.
 *       * Happy path: calls `oauth2TokenExchange` with grant_type=client_credentials,
 *         tenant clientId/clientSecret, and scope joined by ' ', then returns
 *         a `IamToken` produced by `tokenMapper.fromOryTokenExchange`.
 *       * Upstream axios 5xx -> ServiceUnavailableException via ErrorMapper.
 *   - `introspect(token)`:
 *       * Missing `hydraOauth2` -> IamConfigurationError.
 *       * Active token -> IamTokenIntrospection with active=true.
 *       * Inactive token -> IamTokenIntrospection with active=false
 *         (NOT an error — the caller decides what inactive means).
 *       * Upstream axios 5xx -> ServiceUnavailableException via ErrorMapper.
 *
 * The Ory OAuth2Api is stubbed entirely via Jest spies; this test file
 * does NOT import `@ory/client`.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { TokenService } from '../../../src/services/token.service';
import type { TenantClients } from '../../../src/clients';
import type { ValidatedTenantConfig } from '../../../src/config';
import type { TenantName } from '../../../src/dto';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';

// ---------- helpers ----------

function makeTenantConfig(overrides: Partial<ValidatedTenantConfig> = {}): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'bearer',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    ...overrides,
  } as unknown as ValidatedTenantConfig;
}

function makeHydraConfig(
  overrides: {
    clientId?: string;
    clientSecret?: string;
  } = {},
): ValidatedTenantConfig {
  return makeTenantConfig({
    hydra: {
      publicUrl: 'http://hydra.test',
      adminUrl: 'http://hydra-admin.test',
      clientId: overrides.clientId,
      clientSecret: overrides.clientSecret,
    },
  } as Partial<ValidatedTenantConfig>);
}

function makeTenantClients(
  name: TenantName,
  config: ValidatedTenantConfig,
  overrides: Partial<TenantClients> = {},
): TenantClients {
  return {
    tenant: name,
    config,
    axios: {} as never,
    kratosFrontend: {} as never,
    ...overrides,
  } as unknown as TenantClients;
}

function makeRegistry(opts: {
  tenants: Record<TenantName, TenantClients>;
}): TenantRegistry {
  return {
    get: (name: TenantName): TenantClients => {
      const c = opts.tenants[name];
      if (c === undefined) {
        throw new IamConfigurationError({ message: `unknown tenant: ${name}` });
      }
      return c;
    },
    tryGet: (name: TenantName): TenantClients | undefined =>
      opts.tenants[name],
    defaultTenant: (): TenantName | undefined => undefined,
    list: (): TenantName[] => Object.keys(opts.tenants),
  } as unknown as TenantRegistry;
}

function axios5xx(message: string): unknown {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    response: { status: 503 },
  });
}

// ---------- tests ----------

describe('TokenService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('forTenant(name)', () => {
    it('returns a stable, memoized wrapper for the same tenant name', () => {
      const cfg = makeHydraConfig({
        clientId: 'id',
        clientSecret: 'secret',
      });
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      const a = service.forTenant('demo');
      const b = service.forTenant('demo');
      expect(a).toBe(b);
    });

    it('returns distinct wrappers for distinct tenant names', () => {
      const cfg = makeHydraConfig({
        clientId: 'id',
        clientSecret: 'secret',
      });
      const a = makeTenantClients('a', cfg);
      const b = makeTenantClients('b', cfg);
      const registry = makeRegistry({ tenants: { a, b } });

      const service = new TokenService(registry);
      expect(service.forTenant('a')).not.toBe(service.forTenant('b'));
    });
  });

  describe('clientCredentials(scope)', () => {
    it('throws IamConfigurationError when the tenant has no hydraOauth2 client', async () => {
      const cfg = makeHydraConfig({
        clientId: 'id',
        clientSecret: 'secret',
      });
      // NO hydraOauth2 on the client bundle
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').clientCredentials(['read']),
      ).rejects.toBeInstanceOf(IamConfigurationError);
    });

    it('throws IamConfigurationError when tenant hydra config is missing clientId', async () => {
      const cfg = makeHydraConfig({
        clientSecret: 'secret',
        // clientId intentionally absent
      });
      const oauth2TokenExchange = jest.fn();
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          oauth2TokenExchange,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').clientCredentials(['read']),
      ).rejects.toBeInstanceOf(IamConfigurationError);
      expect(oauth2TokenExchange).not.toHaveBeenCalled();
    });

    it('throws IamConfigurationError when tenant hydra config is missing clientSecret', async () => {
      const cfg = makeHydraConfig({
        clientId: 'id',
        // clientSecret intentionally absent
      });
      const oauth2TokenExchange = jest.fn();
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          oauth2TokenExchange,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').clientCredentials(['read']),
      ).rejects.toBeInstanceOf(IamConfigurationError);
      expect(oauth2TokenExchange).not.toHaveBeenCalled();
    });

    it('throws IamConfigurationError when tenant has no hydra block at all', async () => {
      const cfg = makeTenantConfig(); // no hydra
      const oauth2TokenExchange = jest.fn();
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          oauth2TokenExchange,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').clientCredentials(['read']),
      ).rejects.toBeInstanceOf(IamConfigurationError);
      expect(oauth2TokenExchange).not.toHaveBeenCalled();
    });

    it('happy path: returns IamToken from oauth2TokenExchange response', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      const oauth2TokenExchange = jest.fn().mockResolvedValue({
        data: {
          access_token: 'tok-abc',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read write',
        },
      });
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          oauth2TokenExchange,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      const token = await service
        .forTenant('demo')
        .clientCredentials(['read', 'write']);

      expect(oauth2TokenExchange).toHaveBeenCalledTimes(1);
      const arg = oauth2TokenExchange.mock.calls[0][0];
      expect(arg.grantType).toBe('client_credentials');
      expect(arg.clientId).toBe('cid');
      expect(arg.clientSecret).toBe('csecret');
      expect(arg.scope).toBe('read write');

      expect(token.accessToken).toBe('tok-abc');
      expect(token.tokenType).toBe('Bearer');
      expect(token.expiresIn).toBe(3600);
      expect(token.scope).toEqual(['read', 'write']);
      expect(token.tenant).toBe('demo');
    });

    it('upstream axios 5xx → ServiceUnavailableException via ErrorMapper', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      const oauth2TokenExchange = jest.fn().mockRejectedValue(axios5xx('hydra down'));
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          oauth2TokenExchange,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').clientCredentials(['read']),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('introspect(token)', () => {
    it('throws IamConfigurationError when tenant has no hydraOauth2 client', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      // No hydraOauth2
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').introspect('some-token'),
      ).rejects.toBeInstanceOf(IamConfigurationError);
    });

    it('active token → IamTokenIntrospection with active=true', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      const introspectOAuth2Token = jest.fn().mockResolvedValue({
        data: {
          active: true,
          sub: 'client-x',
          client_id: 'client-x',
          scope: 'read write',
          exp: 1700000000,
          iat: 1699990000,
        },
      });
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          introspectOAuth2Token,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      const result = await service.forTenant('demo').introspect('tok-abc');

      expect(introspectOAuth2Token).toHaveBeenCalledWith({ token: 'tok-abc' });
      expect(result.active).toBe(true);
      expect(result.subject).toBe('client-x');
      expect(result.clientId).toBe('client-x');
      expect(result.scope).toEqual(['read', 'write']);
      expect(result.exp).toBe(1700000000);
      expect(result.iat).toBe(1699990000);
      expect(result.tenant).toBe('demo');
    });

    it('inactive token → IamTokenIntrospection with active=false (NOT an error)', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      const introspectOAuth2Token = jest.fn().mockResolvedValue({
        data: { active: false },
      });
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          introspectOAuth2Token,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      const result = await service.forTenant('demo').introspect('revoked');
      expect(result.active).toBe(false);
      expect(result.tenant).toBe('demo');
    });

    it('upstream axios 5xx → ServiceUnavailableException via ErrorMapper', async () => {
      const cfg = makeHydraConfig({
        clientId: 'cid',
        clientSecret: 'csecret',
      });
      const introspectOAuth2Token = jest
        .fn()
        .mockRejectedValue(axios5xx('hydra-admin 503'));
      const clients = makeTenantClients('demo', cfg, {
        hydraOauth2: {
          introspectOAuth2Token,
        } as unknown as TenantClients['hydraOauth2'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new TokenService(registry);
      await expect(
        service.forTenant('demo').introspect('tok'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
