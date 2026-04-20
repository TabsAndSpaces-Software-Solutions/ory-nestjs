/**
 * Abstract base class for all library-defined errors.
 *
 * Every ory-nestjs error carries:
 *   - `code`: a stable machine-friendly discriminator (e.g. `'IAM_UNAUTHORIZED'`).
 *   - `message`: a short, GENERIC human string. Must NEVER contain tokens,
 *     cookies, PII, or upstream response payload fragments.
 *   - `cause` (optional): an opaque reference to the underlying failure. The
 *     `cause` is NOT serialized by `toJSON()` to prevent leaking upstream
 *     payloads through logs or HTTP error bodies.
 *   - `correlationId` (optional): a request-scoped correlation id used for
 *     server-side log stitching.
 *
 * Subclasses set a constant `code`. Constructing `IamError` directly is
 * disallowed — it is abstract-by-convention and guards against misuse with a
 * runtime check.
 */
export interface IamErrorInit {
  message: string;
  cause?: unknown;
  correlationId?: string;
}

export interface IamErrorJson {
  name: string;
  code: string;
  message: string;
  correlationId?: string;
}

export abstract class IamError extends Error {
  public readonly code: string;
  public readonly correlationId?: string;
  // `cause` is declared on ES2022 Error but is intentionally kept opaque and
  // never serialized — see the class comment.
  public override readonly cause?: unknown;

  protected constructor(init: IamErrorInit, code: string, name: string) {
    // Guard: prevent direct `new IamError(...)` via `any`-cast.
    if (new.target === IamError) {
      throw new Error('IamError is abstract; use a concrete subclass.');
    }
    super(init.message);
    this.name = name;
    this.code = code;
    this.correlationId = init.correlationId;
    this.cause = init.cause;
    // Restore prototype chain across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a redacted, serializable shape. Intentionally does NOT include
   * `cause` or any upstream data — only fields that are safe to log.
   */
  public toJSON(): IamErrorJson {
    const out: IamErrorJson = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.correlationId !== undefined) {
      out.correlationId = this.correlationId;
    }
    return out;
  }
}
