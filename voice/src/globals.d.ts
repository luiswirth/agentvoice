// What the library uses of its runtime beyond the language: every JavaScript
// runtime it runs in, a browser, Node or Bun, has these.
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare function setInterval(handler: () => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;
declare const performance: { now(): number };

// What a tier of the library's own reaches the network with.
declare function fetch(
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}>;
declare class URLSearchParams {
	constructor(init: Record<string, string>);
	set(name: string, value: string): void;
	append(name: string, value: string): void;
}
declare function btoa(data: string): string;
declare function atob(data: string): string;
type CloseEvent = { code: number; reason: string };
type MessageEvent = { data: unknown };
type SocketEvents = { open: unknown; message: MessageEvent; close: CloseEvent };
declare class WebSocket {
	static readonly OPEN: number;
	constructor(url: string);
	readonly readyState: number;
	send(data: string): void;
	close(code?: number): void;
	addEventListener<K extends keyof SocketEvents>(
		type: K,
		listener: (event: SocketEvents[K]) => void,
		options?: { once?: boolean },
	): void;
	removeEventListener<K extends keyof SocketEvents>(
		type: K,
		listener: (event: SocketEvents[K]) => void,
	): void;
}
