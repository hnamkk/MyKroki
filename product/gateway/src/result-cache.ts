export interface ResultCache {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer): Promise<boolean>;
}

interface CacheEntry {
  body: Buffer;
  expiresAt: number;
  weight: number;
}

export interface InMemoryResultCacheOptions {
  maxEntries: number;
  maxWeightBytes: number;
  maxItemWeightBytes: number;
  ttlMs: number;
  now?: () => number;
}

export class InMemoryResultCache implements ResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private totalWeight = 0;

  constructor(private readonly options: InMemoryResultCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.body;
  }

  async set(key: string, value: Buffer): Promise<boolean> {
    const weight = value.byteLength;
    if (weight > this.options.maxItemWeightBytes || weight > this.options.maxWeightBytes) return false;

    const previous = this.entries.get(key);
    if (previous) this.delete(key, previous);
    this.entries.set(key, {
      body: value,
      expiresAt: this.now() + this.options.ttlMs,
      weight,
    });
    this.totalWeight += weight;

    while (this.entries.size > this.options.maxEntries || this.totalWeight > this.options.maxWeightBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.delete(oldest[0], oldest[1]);
    }
    return this.entries.has(key);
  }

  private delete(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return;
    this.totalWeight -= entry.weight;
  }
}
