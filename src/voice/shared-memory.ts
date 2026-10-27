// Runtimes built with threads, Moonshine's and ONNX Runtime's, each reserve
// 4 GiB of shared memory up front, and Safari on the iPhone runs out of room
// after a few ("RangeError: Out of memory"). Neither lets its memory be
// set, so a worker caps every shared memory it creates, before its runtime
// loads.

const PAGES_PER_GIB = 16384;

/** Caps the shared memories this worker creates from now on at `gib`. */
export function capSharedMemory(gib: number): void {
	const pages = gib * PAGES_PER_GIB;
	const Memory = WebAssembly.Memory;
	WebAssembly.Memory = class extends Memory {
		constructor(descriptor: WebAssembly.MemoryDescriptor) {
			const capped =
				descriptor.shared && (descriptor.maximum ?? Infinity) > pages;
			super(capped ? { ...descriptor, maximum: pages } : descriptor);
		}
	};
}
