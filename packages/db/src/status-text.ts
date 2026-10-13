/** The word with its indefinite article, for a refusal that names a status: "an expired", "a held". */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}
