import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function uint32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

export function createStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const checksum = crc32(content);
    const header = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), name,
    ]);
    local.push(header, content);
    central.push(Buffer.concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]));
    offset += header.length + content.length;
  }
  const centralDirectory = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    centralDirectory,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ]);
}

export async function createServerBundle({ productRoot, releaseDirectory, version, images }) {
  const sources = [
    ["diagram-server.ps1", "windows-installer/diagram-server.ps1"],
    ["DiagramServer.psm1", "windows-installer/DiagramServer.psm1"],
    ["README.md", "windows-installer/README.md"],
    ["docker-compose.yml", "deploy/docker-compose.release.yml"],
    ["docker-compose.windows.yml", "deploy/docker-compose.windows.yml"],
  ];
  const entries = await Promise.all(sources.map(async ([name, source]) => ({
    name,
    content: await readFile(path.join(productRoot, source)),
  })));
  entries.push({
    name: "server-manifest.json",
    content: Buffer.from(`${JSON.stringify({ schemaVersion: 1, productVersion: version, gatewayUrl: "http://127.0.0.1:9000", images }, null, 2)}\n`),
  });
  const destination = path.join(releaseDirectory, `diagram-as-code-server-${version}.zip`);
  await writeFile(destination, createStoredZip(entries));
  return destination;
}
