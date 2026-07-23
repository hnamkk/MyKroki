import assert from "node:assert/strict";
import test from "node:test";

import { resolveGatewayCredential } from "../src/auth-provider.ts";

function dependencies(getIdToken: (audience: string) => Promise<string>) {
  const secrets: string[] = [];
  const warnings: string[] = [];
  return {
    value: {
      getIdToken,
      setSecret: (value: string) => secrets.push(value),
      warning: (message: string) => warnings.push(message),
    },
    secrets,
    warnings,
  };
}

test("auto auth prefers GitHub OIDC when an audience is configured", async () => {
  const context = dependencies(async (audience) => {
    assert.equal(audience, "diagram-gateway");
    return "header.payload.signature";
  });
  const credential = await resolveGatewayCredential({
    authMode: "auto",
    oidcAudience: "diagram-gateway",
    apiKey: "dg_fallback",
  }, context.value);
  assert.equal(credential, "header.payload.signature");
  assert.deepEqual(context.secrets, ["dg_fallback", "header.payload.signature"]);
  assert.deepEqual(context.warnings, []);
});

test("auto auth falls back explicitly to API key when OIDC is unavailable", async () => {
  const context = dependencies(async () => {
    throw new Error("id-token permission denied");
  });
  const credential = await resolveGatewayCredential({
    authMode: "auto",
    oidcAudience: "diagram-gateway",
    apiKey: "dg_fallback",
  }, context.value);
  assert.equal(credential, "dg_fallback");
  assert.equal(context.warnings.length, 1);
});

test("strict OIDC never silently falls back to API key", async () => {
  const context = dependencies(async () => {
    throw new Error("id-token permission denied");
  });
  await assert.rejects(
    resolveGatewayCredential({
      authMode: "oidc",
      oidcAudience: "diagram-gateway",
      apiKey: "dg_fallback",
    }, context.value),
    /id-token: write/,
  );
});

test("api-key and none modes are deterministic", async () => {
  const context = dependencies(async () => "unused");
  assert.equal(await resolveGatewayCredential({
    authMode: "api-key",
    oidcAudience: undefined,
    apiKey: "dg_key",
  }, context.value), "dg_key");
  assert.equal(await resolveGatewayCredential({
    authMode: "none",
    oidcAudience: undefined,
    apiKey: undefined,
  }, context.value), undefined);
  await assert.rejects(resolveGatewayCredential({
    authMode: "api-key",
    oidcAudience: undefined,
    apiKey: undefined,
  }, context.value), /api-key.*required/);
});
