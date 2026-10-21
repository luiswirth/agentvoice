// The system's media controls: media keys, headphone taps, the lock screen
// and Control Center, so that voice works without looking at the page.
// Browsers hand them only to a page playing a media element, and the speech
// plays through Web Audio, so a silent element loops while voice is on.

export type MediaActions = {
	/** Play and pause, as on headphones: one toggle. */
	toggle(): void;
	next(): void;
	previous(): void;
};

let silence: HTMLAudioElement | null = null;

/** Call it from a click, the first time, since it starts an element. */
export function holdMedia(held: boolean, actions: MediaActions): void {
	const session = navigator.mediaSession;
	if (session === undefined) return;
	if (!held) {
		silence?.pause();
		session.playbackState = "none";
		return;
	}
	if (silence === null) {
		silence = new Audio(silentWav());
		silence.loop = true;
	}
	// Safari plays again after a pause only once the element is reloaded.
	silence.load();
	void silence.play().catch(() => {});
	session.playbackState = "playing";
	session.setActionHandler("play", actions.toggle);
	session.setActionHandler("pause", actions.toggle);
	session.setActionHandler("nexttrack", actions.next);
	session.setActionHandler("previoustrack", actions.previous);
}

/** What the system shows as playing. */
export function showMedia(title: string, mode: string): void {
	if (navigator.mediaSession === undefined) return;
	navigator.mediaSession.metadata = new MediaMetadata({
		title,
		artist: mode,
		album: "voice.senses.sh",
	});
}

/** One second of silence as a WAV data URL, 8 kHz, 8-bit. */
function silentWav(): string {
	const rate = 8000;
	const bytes = new Uint8Array(44 + rate);
	const view = new DataView(bytes.buffer);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + rate, true);
	text(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	text(36, "data");
	view.setUint32(40, rate, true);
	bytes.fill(128, 44);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `data:audio/wav;base64,${btoa(binary)}`;
}
