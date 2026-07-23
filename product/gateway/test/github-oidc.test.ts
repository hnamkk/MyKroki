import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTHeaderParameters,
  type JWTPayload,
} from "jose";

import {
  GitHubOidcAuthenticator,
  GitHubOidcError,
  type GitHubOidcConfig,
  type GitHubRepositoryPolicy,
} from "../dist/github-oidc.js";

const issuer = "https://token.actions.githubusercontent.com";
const audience = "diagram-gateway";
const repositoryId = "123456";
const workflowRef = "octo/diagrams/.github/workflows/diagram-check.yml@refs/heads/main";

const policy: GitHubRepositoryPolicy = {
  repositoryId,
  status: "active",
  scopes: ["diagram:render"],
  cachePartition: `github:${repositoryId}`,
  workflowRefs: ["octo/diagrams/.github/workflows/diagram-check.yml@refs/*"],
  events: {
    pull_request: {
      refs: ["refs/pull/*"],
      baseRefs: ["main"],
      headRefs: ["feature/*"],
    },
    push: { refs: ["refs/heads/main"] },
    workflow_dispatch: { refs: ["refs/heads/main"] },
  },
};

function oidcConfig(repositoryPolicies: GitHubRepositoryPolicy[] = [policy]): GitHubOidcConfig {
  return {
    issuer,
    audience,
    jwksUrl: "https://unused.example.test/jwks",
    clockToleranceSeconds: 30,
    jwksCacheMaxAgeMs: 600_000,
    jwksCooldownMs: 0,
    jwksTimeoutMs: 1_000,
    repositoryPolicies,
  };
}

async function sign(
  privateKey: CryptoKey,
  kid: string,
  overrides: Partial<JWTPayload & Record<string, unknown>> = {},
): Promise<string> {
  const claims = {
    repository_id: repositoryId,
    repository: "octo/diagrams",
    repository_visibility: "public",
    workflow_ref: workflowRef,
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
    base_ref: "main",
    head_ref: "feature/diagram",
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid } satisfies JWTHeaderParameters)
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : issuer)
    .setAudience(typeof overrides.aud === "string" ? overrides.aud : audience)
    .setSubject("repo:octo/diagrams:pull_request")
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(privateKey);
}

async function fixture(repositoryPolicies: GitHubRepositoryPolicy[] = [policy]) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "key-1", alg: "RS256", use: "sig" }] });
  return {
    privateKey,
    authenticator: new GitHubOidcAuthenticator(oidcConfig(repositoryPolicies), resolver),
  };
}

test("accepts public and private repositories through the same immutable repository policy", async () => {
  const { privateKey, authenticator } = await fixture();
  for (const visibility of ["public", "private"] as const) {
    const principal = await authenticator.authenticate(await sign(privateKey, "key-1", {
      repository_visibility: visibility,
    }));
    assert.equal(principal.subject, `github-repository:${repositoryId}`);
    assert.equal(principal.authMethod, "github-oidc");
    assert.equal(principal.repositoryId, repositoryId);
    assert.equal(principal.repositoryVisibility, visibility);
    assert.equal(principal.policyDecision, "allowed");
  }
});

test("rejects wrong issuer, audience, expiry and incomplete claims", async () => {
  const { privateKey, authenticator } = await fixture();
  const tokens = [
    await sign(privateKey, "key-1", { iss: "https://issuer.example.test" }),
    await sign(privateKey, "key-1", { aud: "wrong-audience" }),
    await sign(privateKey, "key-1", { exp: Math.floor(Date.now() / 1000) - 120 }),
    await sign(privateKey, "key-1", { workflow_ref: undefined }),
  ];
  for (const token of tokens) {
    await assert.rejects(
      authenticator.authenticate(token),
      (error: unknown) => error instanceof GitHubOidcError
        && error.status === 401
        && error.code === "OIDC_TOKEN_INVALID",
    );
  }
});

test("rejects wrong workflow, event/ref policy and revoked repositories", async () => {
  const { privateKey, authenticator } = await fixture();
  const deniedTokens = [
    await sign(privateKey, "key-1", {
      workflow_ref: "octo/diagrams/.github/workflows/untrusted.yml@refs/heads/main",
    }),
    await sign(privateKey, "key-1", { event_name: "push", ref: "refs/heads/feature" }),
    await sign(privateKey, "key-1", { repository_id: "999999" }),
  ];
  for (const token of deniedTokens) {
    await assert.rejects(
      authenticator.authenticate(token),
      (error: unknown) => error instanceof GitHubOidcError
        && error.status === 403
        && error.code === "OIDC_POLICY_DENIED",
    );
  }

  const revoked = await fixture([{ ...policy, status: "revoked" }]);
  await assert.rejects(
    revoked.authenticator.authenticate(await sign(revoked.privateKey, "key-1")),
    (error: unknown) => error instanceof GitHubOidcError && error.status === 403,
  );
});

test("models a fork pull request without trusting mutable repository names or credentials", async () => {
  const { privateKey, authenticator } = await fixture();
  const principal = await authenticator.authenticate(await sign(privateKey, "key-1", {
    repository: "renamed-owner/renamed-repository",
    head_ref: "feature/from-public-fork",
  }));
  assert.equal(principal.repositoryId, repositoryId);
  assert.deepEqual(principal.scopes, ["diagram:render"]);
});

test("classifies transient JWKS failures separately from invalid tokens", async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const unavailableResolver = async () => {
    throw new TypeError("fetch failed");
  };
  const authenticator = new GitHubOidcAuthenticator(oidcConfig(), unavailableResolver);
  await assert.rejects(
    authenticator.authenticate(await sign(privateKey, "unknown")),
    (error: unknown) => error instanceof GitHubOidcError
      && error.status === 503
      && error.code === "OIDC_PROVIDER_UNAVAILABLE",
  );
});

test("refreshes JWKS on key rotation and keeps cached keys through a transient outage", async () => {
  const first = await generateKeyPair("RS256");
  const second = await generateKeyPair("RS256");
  const third = await generateKeyPair("RS256");
  const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  const secondJwk = { ...(await exportJWK(second.publicKey)), kid: "key-2", alg: "RS256", use: "sig" };
  let keys = [firstJwk];
  let fetchCount = 0;
  const server = createServer((_request, response) => {
    fetchCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const authenticator = new GitHubOidcAuthenticator({
    ...oidcConfig(),
    jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
    jwksCooldownMs: 0,
  });

  assert.equal((await authenticator.authenticate(await sign(first.privateKey, "key-1"))).repositoryId, repositoryId);
  keys = [firstJwk, secondJwk];
  assert.equal((await authenticator.authenticate(await sign(second.privateKey, "key-2"))).repositoryId, repositoryId);
  assert.ok(fetchCount >= 2);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal((await authenticator.authenticate(await sign(second.privateKey, "key-2"))).repositoryId, repositoryId);
  await assert.rejects(
    authenticator.authenticate(await sign(third.privateKey, "key-3")),
    (error: unknown) => error instanceof GitHubOidcError
      && error.status === 503
      && error.code === "OIDC_PROVIDER_UNAVAILABLE",
  );
});
