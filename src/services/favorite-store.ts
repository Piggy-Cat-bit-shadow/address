import {
  FAVORITES_SCHEMA_VERSION, MAX_FAVORITES, favoriteFromBundle, isFavoriteAddress,
  favoriteIdFor, moveFavoriteWithinCountry, normalizedFavoritePositions, type FavoriteAddress
} from '../domain/favorites';
import type { CountryCode, GeneratedBundle } from '../domain/types';

const DATABASE_NAME = 'address-favorites';
const STORE_NAME = 'favorites';
const REVISION_KEY = 'address-favorites-revision';
const memory = new Map<string, FavoriteAddress>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

const requestValue = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error || new Error('INDEXED_DB_REQUEST_FAILED')), { once: true });
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.addEventListener('complete', () => resolve(), { once: true });
  transaction.addEventListener('abort', () => reject(transaction.error || new Error('INDEXED_DB_TRANSACTION_ABORTED')), { once: true });
  transaction.addEventListener('error', () => reject(transaction.error || new Error('INDEXED_DB_TRANSACTION_FAILED')), { once: true });
});

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, FAVORITES_SCHEMA_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!store.indexNames.contains('countryCode')) store.createIndex('countryCode', 'countryCode');
      if (!store.indexNames.contains('continent')) store.createIndex('continent', 'continent');
      if (!store.indexNames.contains('countryPosition')) store.createIndex('countryPosition', ['countryCode', 'position']);
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => resolve(null), { once: true });
    request.addEventListener('blocked', () => resolve(null), { once: true });
  });
  return databasePromise;
};

const broadcast = (): void => {
  const revision = `${Date.now()}-${Math.random()}`;
  try { localStorage.setItem(REVISION_KEY, revision); } catch {}
  try {
    const channel = new BroadcastChannel(DATABASE_NAME);
    channel.postMessage(revision);
    channel.close();
  } catch {}
};

const listFromMemory = (): FavoriteAddress[] => normalizedFavoritePositions([...memory.values()]);

export const listFavorites = async (): Promise<{ values: FavoriteAddress[]; persistent: boolean }> => {
  const database = await openDatabase();
  if (!database) return { values: listFromMemory(), persistent: false };
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const values = (await requestValue(transaction.objectStore(STORE_NAME).getAll())).filter(isFavoriteAddress);
    await transactionDone(transaction);
    return { values: normalizedFavoritePositions(values), persistent: true };
  } catch {
    return { values: listFromMemory(), persistent: false };
  }
};

export const saveFavorite = async (bundle: GeneratedBundle): Promise<{ favorite: FavoriteAddress; persistent: boolean }> => {
  const current = await listFavorites();
  const id = favoriteIdFor(bundle);
  const existing = current.values.find((value) => value.id === id);
  if (!existing && current.values.length >= MAX_FAVORITES) throw new Error('FAVORITES_LIMIT_REACHED');
  const position = existing?.position || current.values.filter((value) => value.countryCode === bundle.address.countryCode).length + 1;
  const favorite = favoriteFromBundle(bundle, position);
  if (existing) favorite.createdAt = existing.createdAt;
  const database = await openDatabase();
  if (!database) {
    memory.set(favorite.id, favorite); broadcast();
    return { favorite, persistent: false };
  }
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(favorite);
  await transactionDone(transaction);
  broadcast();
  return { favorite, persistent: true };
};

export const removeFavorite = async (id: string): Promise<boolean> => {
  const current = await listFavorites();
  const source = current.values.find((value) => value.id === id);
  if (!source) return false;
  const remaining = normalizedFavoritePositions(current.values.filter((value) => value.id !== id))
    .filter((value) => value.countryCode === source.countryCode);
  const database = await openDatabase();
  if (!database) {
    memory.delete(id); remaining.forEach((value) => memory.set(value.id, value)); broadcast(); return true;
  }
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.delete(id);
  remaining.forEach((value) => store.put(value));
  await transactionDone(transaction);
  broadcast();
  return true;
};

export const reorderFavorite = async (id: string, position: number): Promise<void> => {
  const current = await listFavorites();
  const values = moveFavoriteWithinCountry(current.values, id, position);
  const source = values.find((value) => value.id === id);
  if (!source) return;
  const changed = values.filter((value) => value.countryCode === source.countryCode);
  const database = await openDatabase();
  if (!database) { changed.forEach((value) => memory.set(value.id, value)); broadcast(); return; }
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  changed.forEach((value) => store.put({ ...value, updatedAt: new Date().toISOString() }));
  await transactionDone(transaction);
  broadcast();
};

export const subscribeToFavorites = (listener: () => void): (() => void) => {
  const storage = (event: StorageEvent) => { if (event.key === REVISION_KEY) listener(); };
  window.addEventListener('storage', storage);
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(DATABASE_NAME); channel.addEventListener('message', listener); } catch {}
  return () => { window.removeEventListener('storage', storage); channel?.close(); };
};

export const countryFavoriteCount = (values: readonly FavoriteAddress[], countryCode: CountryCode): number =>
  values.filter((value) => value.countryCode === countryCode).length;
