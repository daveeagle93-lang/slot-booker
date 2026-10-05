/** Every code point in Unicode general category Cf (format characters), found by scanning the whole range. */
export const FORMAT_CODE_POINTS: number[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (/^\p{Cf}$/u.test(String.fromCodePoint(cp))) FORMAT_CODE_POINTS.push(cp);
}

export const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** Names that must stay acceptable: accents, apostrophe, hyphen, CJK, Arabic letters with no marks, a plain emoji. */
export const ORDINARY_NAMES = ["Zoë", "Siân", "O'Brien", "Mary-Jane", "ミニー", "小狗", "كلب", "🐕"];
