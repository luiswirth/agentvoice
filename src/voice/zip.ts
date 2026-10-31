// Files as one ZIP archive, stored without compression: the WAV it carries
// hardly compresses, and every system opens such an archive by itself.

const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** The archive of `files`, by their paths in it. */
export async function zip(files: Record<string, Blob>): Promise<Blob> {
	const parts: BlobPart[] = [];
	const central: BlobPart[] = [];
	let offset = 0;
	let centralSize = 0;
	const entries = Object.entries(files);
	for (const [path, blob] of entries) {
		const name = new TextEncoder().encode(path);
		const data = new Uint8Array(await blob.arrayBuffer());
		const crc = crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		// Bit 11: the name is UTF-8.
		local.setUint16(6, 0x0800, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, data.length, true);
		local.setUint32(22, data.length, true);
		local.setUint16(26, name.length, true);
		parts.push(local.buffer, name, data);
		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, 20, true);
		entry.setUint16(6, 20, true);
		entry.setUint16(8, 0x0800, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, data.length, true);
		entry.setUint32(24, data.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(42, offset, true);
		central.push(entry.buffer, name);
		offset += 30 + name.length + data.length;
		centralSize += 46 + name.length;
	}
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	return new Blob([...parts, ...central, end.buffer], {
		type: "application/zip",
	});
}
