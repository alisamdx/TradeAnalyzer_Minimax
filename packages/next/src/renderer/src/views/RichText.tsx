import { Fragment } from 'react';

/**
 * Renders the small amount of inline markdown the dictionary's descriptions use:
 * `**bold**` and `` `code` ``.
 *
 * The descriptions are written to be read by an operator, and they are the same
 * strings that go into `meta_dictionary`. Rendering the markers literally makes
 * the most carefully written part of the schema look like a bug — and the
 * alternative, stripping the emphasis out of the source, would lose the one
 * signal that says which half of a sentence matters.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
