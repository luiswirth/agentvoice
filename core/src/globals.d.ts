// What the core uses of its runtime beyond the language: every JavaScript
// runtime it runs in, a browser, Node or Bun, has these.
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare const performance: { now(): number };
