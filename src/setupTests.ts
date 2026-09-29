import "@testing-library/jest-dom/vitest"

// jsdom in some vitest 4.x configurations starts without a working localStorage
// (the --localstorage-file flag is passed with an empty path, making storage
// a non-functional stub). Provide a Map-backed in-memory implementation so
// Zustand's persist middleware can call setItem/getItem without throwing.
const buildStorageMock = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  } as Storage;
};

Object.defineProperty(globalThis, "localStorage", {
  value: buildStorageMock(),
  writable: true,
});

Object.defineProperty(globalThis, "sessionStorage", {
  value: buildStorageMock(),
  writable: true,
});
