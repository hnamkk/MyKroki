import type { ActionInputs } from "./core.js";

export interface ActionAuthDependencies {
  getIdToken(audience: string): Promise<string>;
  setSecret(value: string): void;
  warning(message: string): void;
}

export async function resolveGatewayCredential(
  inputs: Pick<ActionInputs, "authMode" | "oidcAudience" | "apiKey">,
  dependencies: ActionAuthDependencies,
): Promise<string | undefined> {
  if (inputs.apiKey) dependencies.setSecret(inputs.apiKey);
  if (inputs.authMode === "none") return undefined;
  if (inputs.authMode === "api-key") {
    if (!inputs.apiKey) throw new Error("Input 'api-key' is required when 'auth-mode' is 'api-key'.");
    return inputs.apiKey;
  }

  const oidcRequested = inputs.authMode === "oidc" || inputs.oidcAudience !== undefined;
  if (oidcRequested) {
    if (!inputs.oidcAudience) {
      throw new Error("Input 'oidc-audience' is required when 'auth-mode' is 'oidc'.");
    }
    try {
      const token = await dependencies.getIdToken(inputs.oidcAudience);
      dependencies.setSecret(token);
      return token;
    } catch (error) {
      if (inputs.authMode === "auto" && inputs.apiKey) {
        dependencies.warning("GitHub OIDC token was unavailable; falling back to the configured Gateway API key.");
        return inputs.apiKey;
      }
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `Could not obtain a GitHub OIDC token. Grant 'id-token: write' and verify 'oidc-audience'.${detail}`,
      );
    }
  }

  return inputs.apiKey;
}
