/**
 * `FakeOAuth2Guard` — test-only replacement for `OAuth2Guard`.
 *
 * Behaviour:
 *   - Read `Authorization: Bearer <token>` off the request.
 *   - Missing / malformed header → `UnauthorizedException` (401).
 *   - Token not present in the `TestingState.introspections` map → 401.
 *   - Introspection with `active: false` → 401.
 *   - Active introspection → attach a `IamMachinePrincipal` derived from
 *     the introspection to `req.user`, return true.
 *
 * Zero Ory imports, zero network I/O.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { TenantName, IamMachinePrincipal } from '../../dto';
import { TESTING_STATE, TestingState } from '../testing-state';

interface MutableRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: unknown;
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const v = headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    return v[0];
  }
  return undefined;
}

function extractBearer(req: MutableRequest): string | undefined {
  const raw = readHeader(req.headers, 'authorization');
  if (raw === undefined) return undefined;
  if (!raw.startsWith('Bearer ')) return undefined;
  const token = raw.slice('Bearer '.length).trim();
  if (token.length === 0) return undefined;
  return token;
}

@Injectable()
export class FakeOAuth2Guard implements CanActivate {
  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<MutableRequest>();
    const token = extractBearer(req);
    if (token === undefined) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'missing or malformed bearer token',
      });
    }

    const intro = this.state.introspections.get(token);
    if (intro === undefined || intro.active !== true) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'token inactive',
      });
    }

    const principal: IamMachinePrincipal = {
      kind: 'machine',
      clientId: intro.clientId ?? intro.subject ?? '',
      scope: Array.isArray(intro.scope) ? [...intro.scope] : [],
      tenant: intro.tenant as TenantName,
    };
    req.user = principal;
    return true;
  }
}
