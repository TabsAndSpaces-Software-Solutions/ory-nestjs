/**
 * Thin HTTP helper for driving the integration Kratos via its admin and
 * public APIs.
 *
 * Not an Ory SDK wrapper — we call the REST endpoints directly with axios
 * so the test code stays legible and independent of the `@ory/client`
 * version the library uses. Integration tests are where we want to verify
 * the real HTTP shape, after all.
 *
 * Two login flavors are exposed:
 *   - `loginWithPasswordApi`: non-browser channel. Returns a `session_token`
 *     suitable for the bearer transport (`Authorization: Bearer <token>`
 *     or `X-Session-Token: <token>`). Kratos does NOT issue a cookie on
 *     this channel.
 *   - `loginWithPasswordBrowser`: browser-channel flow. Returns the
 *     `ory_kratos_session` cookie value suitable for the cookie transport.
 *     Kratos does NOT issue a session_token on this channel.
 *
 * Tests that need to exercise both transports on the same identity call
 * both login methods (Kratos creates two sessions for the same identity —
 * that's fine for transport-level verification; revocation tests pick one).
 */
import axios, { type AxiosInstance } from 'axios';

import { readHandle } from './stack-handle';

export interface CreatedIdentity {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export interface ApiLoginResult {
  readonly sessionId: string;
  readonly sessionToken: string;
}

export interface BrowserLoginResult {
  readonly sessionId: string;
  readonly sessionCookieValue: string;
  /** Ready-to-send `Cookie` header value: `ory_kratos_session=<value>`. */
  readonly sessionCookieHeader: string;
}

export class KratosAdmin {
  private readonly admin: AxiosInstance;
  private readonly publicApi: AxiosInstance;

  public constructor() {
    const handle = readHandle();
    this.admin = axios.create({
      baseURL: handle.kratosAdminUrl,
      timeout: 10_000,
      validateStatus: () => true,
    });
    this.publicApi = axios.create({
      baseURL: handle.kratosPublicUrl,
      timeout: 10_000,
      validateStatus: () => true,
      // Don't auto-follow: the session cookie is on the 303 response; a
      // follow would discard it.
      maxRedirects: 0,
    });
  }

  // ---------- admin-side identity management ----------

  public async createIdentityWithPassword(
    overrides: { email?: string; password?: string; name?: string } = {},
  ): Promise<CreatedIdentity> {
    const email = overrides.email ?? uniqueEmail();
    const password = overrides.password ?? 'correct-horse-battery-staple';
    const name = overrides.name ?? 'Integration Test User';

    const res = await this.admin.post('/admin/identities', {
      schema_id: 'default',
      traits: { email, name },
      credentials: {
        password: { config: { password } },
      },
    });
    if (res.status !== 201) {
      throw new Error(
        `createIdentityWithPassword failed: ${res.status} ${JSON.stringify(res.data)}`,
      );
    }
    return { id: res.data.id as string, email, password };
  }

  public async disableSession(sessionId: string): Promise<void> {
    const res = await this.admin.patch(`/admin/sessions/${sessionId}/disable`);
    if (res.status !== 204) {
      throw new Error(
        `disableSession failed: ${res.status} ${JSON.stringify(res.data)}`,
      );
    }
  }

  public async deleteAllIdentities(): Promise<void> {
    const res = await this.admin.get('/admin/identities?per_page=250');
    if (res.status !== 200) {
      throw new Error(
        `list identities failed: ${res.status} ${JSON.stringify(res.data)}`,
      );
    }
    for (const id of (res.data as Array<{ id: string }>).map((i) => i.id)) {
      await this.admin.delete(`/admin/identities/${id}`);
    }
  }

  // ---------- login channels ----------

  public async loginWithPasswordApi(
    email: string,
    password: string,
  ): Promise<ApiLoginResult> {
    const flowRes = await this.publicApi.get('/self-service/login/api');
    if (flowRes.status !== 200) {
      throw new Error(
        `initLoginFlow(api) failed: ${flowRes.status} ${JSON.stringify(flowRes.data)}`,
      );
    }
    const flowId = flowRes.data.id as string;

    const submitRes = await this.publicApi.post(
      `/self-service/login?flow=${encodeURIComponent(flowId)}`,
      { method: 'password', identifier: email, password },
      { headers: { Accept: 'application/json' } },
    );
    if (submitRes.status !== 200) {
      throw new Error(
        `loginWithPasswordApi failed: ${submitRes.status} ${JSON.stringify(submitRes.data)}`,
      );
    }
    return {
      sessionId: submitRes.data.session.id as string,
      sessionToken: submitRes.data.session_token as string,
    };
  }

  public async loginWithPasswordBrowser(
    email: string,
    password: string,
  ): Promise<BrowserLoginResult> {
    // 1. Initialize browser flow. Accept: application/json returns the flow
    //    as JSON and sets a `csrf_token_*` cookie on the response.
    const initRes = await this.publicApi.get('/self-service/login/browser', {
      headers: { Accept: 'application/json' },
    });
    if (initRes.status !== 200) {
      throw new Error(
        `initLoginFlow(browser) failed: ${initRes.status} ${JSON.stringify(initRes.data)}`,
      );
    }
    const flowId = initRes.data.id as string;
    const flowCsrfCookie = extractCsrfCookie(initRes.headers['set-cookie']);
    const csrfToken = extractCsrfTokenFromFlow(initRes.data);
    if (flowCsrfCookie === undefined || csrfToken === undefined) {
      throw new Error(
        'browser login flow: missing csrf token cookie or body field',
      );
    }

    // 2. Submit credentials. Carry the CSRF cookie back; include the
    //    csrf_token body field matching the cookie. Accept: application/json
    //    tells Kratos to return the session as JSON instead of redirecting.
    const submitRes = await this.publicApi.post(
      `/self-service/login?flow=${encodeURIComponent(flowId)}`,
      {
        method: 'password',
        identifier: email,
        password,
        csrf_token: csrfToken,
      },
      {
        headers: {
          Accept: 'application/json',
          Cookie: flowCsrfCookie,
        },
      },
    );
    if (submitRes.status !== 200) {
      throw new Error(
        `loginWithPasswordBrowser failed: ${submitRes.status} ${JSON.stringify(submitRes.data)}`,
      );
    }

    const sessionCookieValue = extractSessionCookieValue(
      submitRes.headers['set-cookie'],
    );
    if (sessionCookieValue === undefined) {
      throw new Error(
        'browser login succeeded but no ory_kratos_session cookie in Set-Cookie',
      );
    }

    return {
      sessionId: submitRes.data.session.id as string,
      sessionCookieValue,
      sessionCookieHeader: `ory_kratos_session=${sessionCookieValue}`,
    };
  }
}

let emailCounter = 0;

function uniqueEmail(): string {
  emailCounter += 1;
  return `int-${process.pid}-${Date.now().toString(36)}-${emailCounter}@example.com`;
}

/** Pull the `csrf_token_*=value` directive out of a Set-Cookie header array. */
function extractCsrfCookie(setCookie: string[] | string | undefined): string | undefined {
  const list = toArray(setCookie);
  for (const entry of list) {
    if (/^csrf_token_/.test(entry)) {
      const firstSegment = entry.split(';')[0];
      return firstSegment.trim();
    }
  }
  return undefined;
}

/** Pull the `ory_kratos_session=value` value out of a Set-Cookie array. */
function extractSessionCookieValue(
  setCookie: string[] | string | undefined,
): string | undefined {
  const list = toArray(setCookie);
  for (const entry of list) {
    const match = /^ory_kratos_session=([^;]+)/.exec(entry);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * Dig the CSRF token value out of a Kratos flow payload's `ui.nodes` array.
 * Shape: `nodes: [{ attributes: { name: 'csrf_token', value: '...' } }]`.
 */
function extractCsrfTokenFromFlow(flow: unknown): string | undefined {
  const ui = (flow as { ui?: { nodes?: unknown[] } }).ui;
  if (!ui || !Array.isArray(ui.nodes)) return undefined;
  for (const node of ui.nodes) {
    const attrs = (node as { attributes?: { name?: string; value?: string } })
      .attributes;
    if (attrs && attrs.name === 'csrf_token' && typeof attrs.value === 'string') {
      return attrs.value;
    }
  }
  return undefined;
}

function toArray(v: string[] | string | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
