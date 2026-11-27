/** What pacer types into an agent's terminal: text only. No control character can end a
 *  bracketed paste or press a key; line breaks and tabs stay. */
export const typedText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
