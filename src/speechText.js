// Keep the visible transcript intact; only normalize the copy sent to TTS.
export function toSpokenText(value) {
  return String(value ?? "")
    .replace(/(\d+)\s*\*\s*(\d+)/g, "$1 times $2")
    .replace(/(^|\s)-(?=\d)/g, "$1minus ")
    .replace(/(\d+)\s*%/g, "$1 percent")
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/(^|\n)\s*[-+]\s+/g, "$1")
    .replace(/[*#_`~•]/g, "")
    .replace(/[()[\]{}<>|\\^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
