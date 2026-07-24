import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServerBundle } from "./create-server-bundle.mjs";
import YAML from "yaml";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(productRoot, relativePath), "utf8"));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const packagePaths = [
  "package.json",
  "packages/contracts/package.json",
  "packages/diagram-config/package.json",
  "gateway/package.json",
  "vscode-extension/package.json",
  "github-action/package.json",
];
const packages = await Promise.all(packagePaths.map(readJson));
const versions = new Set(packages.map((manifest) => manifest.version));
if (versions.size !== 1) {
  throw new Error(`Product package versions must match: ${[...versions].join(", ")}`);
}

const [version] = versions;
const tag = `product-v${version}`;
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag) {
  throw new Error(`Release tag ${process.env.RELEASE_TAG} does not match package version ${tag}`);
}

const extensionManifest = packages[4];
const repositoryUrl = extensionManifest.repository?.url ?? "";
const ownerMatch = repositoryUrl.match(/github\.com[/:]([^/]+)\//i);
if (!ownerMatch) throw new Error("Cannot determine the GitHub owner from the extension repository URL");

const rendererLock = YAML.parse(await readFile(path.join(productRoot, ".diagram-renderer.lock"), "utf8"));
const exampleConfig = YAML.parse(await readFile(path.join(productRoot, ".diagram.example.yml"), "utf8"));
if (String(rendererLock.gateway) !== version) {
  throw new Error(`Gateway lock ${rendererLock.gateway} does not match product version ${version}`);
}
if (rendererLock.configurationSchema !== exampleConfig.version) {
  throw new Error(
    `Configuration schema lock ${rendererLock.configurationSchema} does not match example version ${exampleConfig.version}`,
  );
}

const registry = `ghcr.io/${ownerMatch[1].toLowerCase()}`;
const imageRepositories = {
  gateway: `${registry}/diagram-as-code-gateway`,
  kroki: `${registry}/diagram-as-code-kroki`,
  mermaid: `${registry}/diagram-as-code-mermaid`,
};
const digestEnvironment = {
  gateway: "GATEWAY_IMAGE_DIGEST",
  kroki: "KROKI_IMAGE_DIGEST",
  mermaid: "MERMAID_IMAGE_DIGEST",
};
const images = Object.fromEntries(Object.entries(imageRepositories).map(([name, repository]) => {
  const digest = process.env[digestEnvironment[name]];
  if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${digestEnvironment[name]} must be a sha256 container digest`);
  }
  return [name, {
    repository,
    tag,
    reference: digest ? `${repository}@${digest}` : `${repository}:${tag}`,
    ...(digest ? { digest } : {}),
  }];
}));
const dockerImage = images.gateway.reference;
const releaseDirectory = path.join(productRoot, "release", tag);
await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const files = [
  {
    source: "vscode-extension/dist/diagram-as-code-vscode.vsix",
    destination: `diagram-as-code-vscode-${version}.vsix`,
  },
  {
    source: "github-action/dist/index.cjs",
    destination: `diagram-as-code-action-${version}.cjs`,
  },
  { source: "deploy/docker-compose.release.yml", destination: "docker-compose.yml" },
  { source: ".diagram.example.yml", destination: "diagram.example.yml" },
  { source: ".diagram-renderer.lock", destination: "diagram-renderer.lock" },
  { source: "test-results/product-npm.spdx.json", destination: "product-npm.spdx.json" },
  { source: `docs/releases/${version}.md`, destination: "RELEASE_NOTES.md" },
];

for (const name of ["gateway", "kroki", "mermaid"]) {
  const source = `test-results/diagram-${name}.spdx.json`;
  try {
    await stat(path.join(productRoot, source));
    files.push({ source, destination: `diagram-${name}.spdx.json` });
  } catch {
    // Container SBOMs are supplied by the tagged release workflow.
  }
}

for (const file of files) {
  await copyFile(path.join(productRoot, file.source), path.join(releaseDirectory, file.destination));
}
await createServerBundle({ productRoot, releaseDirectory, version, images });

const environmentExample = `# Generate a random client key, store only its SHA-256 verifier here, and keep the plaintext in the client secret store.\nDIAGRAM_API_KEY_RECORDS=[{"id":"repo-ci","verifier":"sha256:<64-lowercase-hex>","scopes":["diagram:render"],"cachePartition":"repo-ci","status":"active"}]\nGATEWAY_PORT=9000\nRATE_LIMIT_PER_MINUTE=60\nRATE_LIMIT_BURST=10\nRENDER_MAX_CONCURRENT=4\nRENDER_MAX_QUEUE=20\nMAX_OUTPUT_BYTES=10485760\nCACHE_MAX_ENTRIES=500\nCACHE_MAX_BYTES=268435456\nCACHE_MAX_ITEM_BYTES=5242880\nCACHE_TTL_MS=86400000\nGATEWAY_PIDS_LIMIT=256\nGATEWAY_MEMORY_LIMIT=512m\nGATEWAY_CPU_LIMIT=1.0\nKROKI_PIDS_LIMIT=256\nKROKI_MEMORY_LIMIT=1g\nKROKI_CPU_LIMIT=2.0\nMERMAID_PIDS_LIMIT=256\nMERMAID_MEMORY_LIMIT=1g\nMERMAID_CPU_LIMIT=1.0\n\nGATEWAY_IMAGE=${images.gateway.reference}\nKROKI_IMAGE=${images.kroki.reference}\nMERMAID_IMAGE=${images.mermaid.reference}\n`;
await writeFile(path.join(releaseDirectory, "diagram-as-code.env.example"), environmentExample, "utf8");

const artifactNames = (await readdir(releaseDirectory)).sort();
const artifacts = await Promise.all(artifactNames.map(async (name) => {
  const filePath = path.join(releaseDirectory, name);
  return { name, bytes: (await stat(filePath)).size, sha256: await sha256(filePath) };
}));

const manifest = {
  schemaVersion: 1,
  version,
  tag,
  dockerImage,
  configurationSchemaVersion: rendererLock.configurationSchema,
  images,
  renderers: {
    kroki: String(rendererLock.kroki),
    mermaid: String(rendererLock.mermaid),
    canonicalFormat: rendererLock.canonicalFormat,
  },
  artifacts,
};
await writeFile(path.join(releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const checksumNames = [...artifactNames, "manifest.json"].sort();
const checksumLines = await Promise.all(checksumNames.map(async (name) =>
  `${await sha256(path.join(releaseDirectory, name))}  ${name}`));
await writeFile(path.join(releaseDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

console.log(`Prepared ${tag} in ${releaseDirectory}`);
for (const name of [...checksumNames, "SHA256SUMS"]) console.log(`- ${name}`);
