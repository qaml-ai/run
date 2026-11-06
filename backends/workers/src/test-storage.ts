type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

/** Fault injection requires a local-test binding, even if stored keys survive a restart. */
export class TestStorage {
  private readonly enabled: boolean;
  private readonly storage: Storage;
  constructor(enabled: boolean, storage: Storage) {
    this.enabled = enabled;
    this.storage = storage;
  }
  async get<T = unknown>(key: `test:${string}`): Promise<T | undefined> {
    return this.enabled ? this.storage.get<T>(key) : undefined;
  }
  async put<T>(key: `test:${string}`, value: T, storage: Storage = this.storage): Promise<void> {
    if (this.enabled) await storage.put(key, value);
  }
  async delete(key: `test:${string}`, storage: Storage = this.storage): Promise<void> {
    if (this.enabled) await storage.delete(key);
  }
}
