/**
 * Integration: live Hydra — OAuth2 client CRUD, client_credentials grant,
 * introspection, revocation, and JWK set CRUD.
 *
 * Skips automatically when the harness booted Kratos-only.
 */
import { maybeMakeFullStackApp, type FullStackHandle } from '../harness/ory-app';

describe('Hydra — live integration', () => {
  let stack: FullStackHandle | null;

  beforeAll(async () => {
    stack = await maybeMakeFullStackApp();
  });

  afterAll(async () => {
    if (stack) await stack.close();
  });

  it('create → get → list → delete OAuth2 client', async () => {
    if (!stack) return;
    const { oauth2Clients } = stack;
    const created = await oauth2Clients.forTenant('demo').create({
      clientName: `int-${Date.now()}`,
      grantTypes: ['client_credentials'],
      scope: 'int:test',
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(created.clientId).toBeTruthy();
    expect(created.clientSecret).toBeTruthy();

    const fetched = await oauth2Clients
      .forTenant('demo')
      .get(created.clientId);
    expect(fetched.clientId).toBe(created.clientId);

    const { items } = await oauth2Clients.forTenant('demo').list();
    expect(items.some((c) => c.clientId === created.clientId)).toBe(true);

    await oauth2Clients.forTenant('demo').delete(created.clientId);
  });

  it('client_credentials grant + introspection + revoke', async () => {
    if (!stack) return;
    const { oauth2Clients, tokens } = stack;
    const client = await oauth2Clients.forTenant('demo').create({
      clientName: `int-cc-${Date.now()}`,
      grantTypes: ['client_credentials'],
      scope: 'int:test',
      tokenEndpointAuthMethod: 'client_secret_basic',
    });

    // Build a one-off TokenService bound to this client's credentials by
    // reaching into the service via its config escape hatch — the public
    // `clientCredentials()` reads the tenant config's clientId/secret, and
    // we don't override it here. Instead we exercise the lower-level path:
    // authorizationCode/refresh use the same token endpoint, so we verify
    // client_credentials by calling Hydra directly via axios on the public
    // URL the library discovered.
    const axios = (await import('axios')).default;
    const res = await axios.post(
      `${stack.handle.hydraPublicUrl}/oauth2/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'int:test',
      }),
      {
        auth: { username: client.clientId, password: client.clientSecret! },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    const accessToken = res.data.access_token as string;
    expect(typeof accessToken).toBe('string');
    expect(accessToken.length).toBeGreaterThan(0);

    // Introspection via the library service.
    const info = await tokens.forTenant('demo').introspect(accessToken);
    expect(info.active).toBe(true);
    expect(info.clientId).toBe(client.clientId);

    // Bogus token → active:false (no throw).
    const invalid = await tokens.forTenant('demo').introspect('nonsense');
    expect(invalid.active).toBe(false);

    // Revoke. Hydra requires the client's credentials on the request.
    await tokens.forTenant('demo').revoke(accessToken, {
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    });

    await oauth2Clients.forTenant('demo').delete(client.clientId);
  });

  it('JWK set CRUD', async () => {
    if (!stack) return;
    const { jwks } = stack;
    const setName = `int-set-${Date.now()}`;

    const created = await jwks.forTenant('demo').createSet(setName, {
      alg: 'RS256',
      use: 'sig',
    });
    expect(created.keys.length).toBeGreaterThanOrEqual(1);

    const fetched = await jwks.forTenant('demo').getSet(setName);
    expect(fetched.keys.length).toBeGreaterThanOrEqual(1);

    await jwks.forTenant('demo').deleteSet(setName);
  });
});
