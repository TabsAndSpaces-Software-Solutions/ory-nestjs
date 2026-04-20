/**
 * Integration: SessionGuard against a live Kratos.
 *
 * Matrix:
 *   - Cookie transport: real browser login → cookie → 200 `/me`.
 *   - Bearer transport: real API login → `X-Session-Token` → 200 `/me`.
 *   - Missing credential → 401 on both transports.
 *   - Bad credential (tampered cookie / token) → 401.
 *
 * These assertions exercise the full request path the consumer hits:
 *   request → SessionGuard → TransportFactory → CookieTransport/BearerTransport
 *          → axios → Kratos public API → mapper → Guard populates req.user.
 * Nothing is mocked.
 */
import axios from 'axios';

import type { IntegrationAppHandle } from '../harness/make-app';
import { makeIntegrationApp } from '../harness/make-app';
import { KratosAdmin } from '../harness/kratos-admin';

async function get(
  handle: IntegrationAppHandle,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  const res = await axios.get(`${handle.baseUrl}${path}`, {
    headers,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

describe('SessionGuard — live Kratos', () => {
  let kratos: KratosAdmin;

  beforeAll(() => {
    kratos = new KratosAdmin();
  });

  afterEach(async () => {
    await kratos.deleteAllIdentities();
  });

  describe('cookie transport', () => {
    let handle: IntegrationAppHandle;

    beforeEach(async () => {
      handle = await makeIntegrationApp({
        tenantOverrides: { transport: 'cookie' },
      });
    });

    afterEach(async () => {
      await handle.close();
    });

    it('200 with req.user populated for a valid session cookie', async () => {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordBrowser(
        identity.email,
        identity.password,
      );

      const res = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(res.status).toBe(200);
      const body = res.data as { identityId: string; sessionId: string };
      expect(body.identityId).toBe(identity.id);
      expect(body.sessionId).toBe(login.sessionId);

      const success = handle.sink.findByType('auth.success');
      expect(success).toHaveLength(1);
      expect(success[0].actorId).toBe(identity.id);
    });

    it('401 when the cookie is missing', async () => {
      const res = await get(handle, '/me');
      expect(res.status).toBe(401);
      expect(handle.sink.findByType('auth.failure.missing_credential')).toHaveLength(1);
    });

    it('401 when the cookie value is tampered', async () => {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordBrowser(
        identity.email,
        identity.password,
      );
      const tampered = login.sessionCookieHeader.replace(/.$/, 'x');

      const res = await get(handle, '/me', { Cookie: tampered });
      expect(res.status).toBe(401);
    });
  });

  describe('bearer transport', () => {
    let handle: IntegrationAppHandle;

    beforeEach(async () => {
      handle = await makeIntegrationApp({
        tenantOverrides: { transport: 'bearer' },
      });
    });

    afterEach(async () => {
      await handle.close();
    });

    it('200 with req.user populated for a valid session token', async () => {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordApi(
        identity.email,
        identity.password,
      );

      const res = await get(handle, '/me', {
        Authorization: `Bearer ${login.sessionToken}`,
      });
      expect(res.status).toBe(200);
      const body = res.data as { identityId: string; sessionId: string };
      expect(body.identityId).toBe(identity.id);
      expect(body.sessionId).toBe(login.sessionId);
    });

    it('401 when Authorization header is absent', async () => {
      const res = await get(handle, '/me');
      expect(res.status).toBe(401);
    });

    it('401 when the bearer token is garbage', async () => {
      const res = await get(handle, '/me', { Authorization: 'Bearer not-a-real-token' });
      expect(res.status).toBe(401);
    });
  });

  describe('@Public() short-circuit', () => {
    it('200 on /public without any credential', async () => {
      const handle = await makeIntegrationApp();
      try {
        const res = await get(handle, '/public');
        expect(res.status).toBe(200);
        // Public routes do NOT call the transport, so no auth audit event.
        expect(handle.sink.findByType('auth.success')).toHaveLength(0);
        expect(
          handle.sink.findByType('auth.failure.missing_credential'),
        ).toHaveLength(0);
      } finally {
        await handle.close();
      }
    });
  });
});
