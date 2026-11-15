// Where the core keeps what outlasts it, such as the voices it heard, so
// that a host that starts it again, as a page on a reload, finds them.

/** Text kept by key. */
export type Store = {
	get(key: string): string | null;
	set(key: string, value: string): void;
};

/** A store that keeps nothing beyond the core's life. */
export function memory(): Store {
	const kept = new Map<string, string>();
	return {
		get: (key) => kept.get(key) ?? null,
		set: (key, value) => void kept.set(key, value),
	};
}
