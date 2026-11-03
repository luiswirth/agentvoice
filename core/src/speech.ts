// What of a message is read aloud.

/**
 * A message as it is read aloud: its paragraphs, without the markup that
 * would be read literally. Code blocks and images are left out.
 */
export function speech(text: string): string[] {
	return (
		text
			.replace(/```[\s\S]*?(```|$)/g, "\n\n")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// A list item or a heading ends as a sentence, so that it is heard as one.
			.replace(/^\s*(#+|[-*+]|\d+[.)])\s+(.*?)\s*$/gm, (_, _marker, line) =>
				/[\p{L}\p{N})][*_`~]*$/u.test(line) ? `${line}.` : line,
			)
			.replace(/^\s*>\s+/gm, "")
			.replace(/[*_`~]+/g, "")
			.split(/\n\s*\n/)
			.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
			.filter((paragraph) => /\w/.test(paragraph))
	);
}
