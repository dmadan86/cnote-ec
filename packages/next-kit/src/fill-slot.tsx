import type { ReactNode } from "react";

/** Splits `text` around `{token}` and puts `node` there (translations may reorder the sentence). */
export function fillSlot(text: string, token: string, node: ReactNode): ReactNode {
  const marker = `{${token}}`;
  const i = text.indexOf(marker);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      {node}
      {text.slice(i + marker.length)}
    </>
  );
}
