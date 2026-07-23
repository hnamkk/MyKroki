import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import { RENDER_SCOPE, type Principal } from "./auth.js";

const githubClaimsSchema = z.object({
  sub: z.string().min(1),
  repository_id: z.string().regex(/^\d+$/),
  repository: z.string().min(1),
  repository_visibility: z.enum(["public", "private", "internal"]),
  workflow_ref: z.string().min(1),
  event_name: z.enum(["pull_request", "push", "workflow_dispatch"]),
  ref: z.string().min(1),
  base_ref: z.string().optional(),
  head_ref: z.string().optional(),
}).passthrough();

export interface OidcEventPolicy {
  refs: readonly string[];
  baseRefs?: readonly string[];
  headRefs?: readonly string[];
}

export interface GitHubRepositoryPolicy {
  repositoryId: string;
  status: "active" | "revoked";
  scopes: readonly string[];
  cachePartition: string;
  workflowRefs: readonly string[];
  events: Partial<Record<"pull_request" | "push" | "workflow_dispatch", OidcEventPolicy>>;
}

export interface GitHubOidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  clockToleranceSeconds: number;
  jwksCacheMaxAgeMs: number;
  jwksCooldownMs: number;
  jwksTimeoutMs: number;
  repositoryPolicies: readonly GitHubRepositoryPolicy[];
}

export interface OidcAuditContext {
  repositoryId?: string;
  workflowRef?: string;
  eventName?: string;
  ref?: string;
  policyDecision: "denied" | "unavailable";
}

export class GitHubOidcError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 503,
    readonly code: "OIDC_TOKEN_INVALID" | "OIDC_POLICY_DENIED" | "OIDC_PROVIDER_UNAVAILABLE",
    readonly audit: OidcAuditContext,
  ) {
    super(message);
    this.name = "GitHubOidcError";
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  return pattern.endsWith("*")
    ? value.startsWith(pattern.slice(0, -1))
    : value === pattern;
}

function matchesAny(value: string | undefined, patterns: readonly string[] | undefined): boolean {
  return value !== undefined && patterns !== undefined && patterns.some((pattern) => matchesPattern(value, pattern));
}

function isProviderUnavailable(error: unknown): boolean {
  return error instanceof errors.JWKSTimeout
    || (error instanceof TypeError && /fetch|network|socket|connect/i.test(error.message));
}

export class GitHubOidcAuthenticator {
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(
    private readonly config: GitHubOidcConfig,
    keyResolver?: JWTVerifyGetKey,
  ) {
    this.keyResolver = keyResolver ?? createRemoteJWKSet(new URL(config.jwksUrl), {
      cacheMaxAge: config.jwksCacheMaxAgeMs,
      cooldownDuration: config.jwksCooldownMs,
      timeoutDuration: config.jwksTimeoutMs,
    });
  }

  async authenticate(token: string): Promise<Principal> {
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(token, this.keyResolver, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
        clockTolerance: this.config.clockToleranceSeconds,
      }));
    } catch (error) {
      if (isProviderUnavailable(error)) {
        throw new GitHubOidcError(
          "GitHub OIDC signing keys are temporarily unavailable.",
          503,
          "OIDC_PROVIDER_UNAVAILABLE",
          { policyDecision: "unavailable" },
        );
      }
      throw new GitHubOidcError(
        "GitHub OIDC token signature or standard claims are invalid.",
        401,
        "OIDC_TOKEN_INVALID",
        { policyDecision: "denied" },
      );
    }

    const parsed = githubClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GitHubOidcError(
        "GitHub OIDC token is missing required workflow claims.",
        401,
        "OIDC_TOKEN_INVALID",
        { policyDecision: "denied" },
      );
    }
    const claims = parsed.data;
    const audit = {
      repositoryId: claims.repository_id,
      workflowRef: claims.workflow_ref,
      eventName: claims.event_name,
      ref: claims.ref,
      policyDecision: "denied" as const,
    };
    const policy = this.config.repositoryPolicies.find((candidate) =>
      candidate.repositoryId === claims.repository_id
    );
    const eventPolicy = policy?.events[claims.event_name];
    const workflowAllowed = policy?.workflowRefs.some((pattern) =>
      matchesPattern(claims.workflow_ref, pattern)
    ) ?? false;
    const refAllowed = matchesAny(claims.ref, eventPolicy?.refs);
    const baseRefAllowed = eventPolicy?.baseRefs === undefined
      || matchesAny(claims.base_ref, eventPolicy.baseRefs);
    const headRefAllowed = eventPolicy?.headRefs === undefined
      || matchesAny(claims.head_ref, eventPolicy.headRefs);

    if (
      policy?.status !== "active"
      || eventPolicy === undefined
      || !workflowAllowed
      || !refAllowed
      || !baseRefAllowed
      || !headRefAllowed
    ) {
      throw new GitHubOidcError(
        "GitHub workflow identity is not allowed by repository policy.",
        403,
        "OIDC_POLICY_DENIED",
        audit,
      );
    }

    return {
      subject: `github-repository:${claims.repository_id}`,
      authMethod: "github-oidc",
      scopes: policy.scopes.includes(RENDER_SCOPE) ? [...policy.scopes] : [],
      cachePartition: policy.cachePartition,
      repositoryId: claims.repository_id,
      repositoryVisibility: claims.repository_visibility,
      workflowRef: claims.workflow_ref,
      eventName: claims.event_name,
      ref: claims.ref,
      policyDecision: "allowed",
    };
  }
}
