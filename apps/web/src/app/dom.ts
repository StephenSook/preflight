/** Tiny DOM helpers: elements are built, never parsed, so nothing from the host can become markup. */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Child[] | string = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (typeof children === "string") node.textContent = children;
  else for (const c of children) if (c) node.append(c);
  return node;
}

export function text(node: Element, value: string): void {
  node.textContent = value;
}

export const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
};

export const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ");
};

export const stateClass = (decision: string): string => (decision === "block" ? "is-blocked" : decision === "hold" ? "is-held" : "is-passed");
export const stateWord = (decision: string): string => (decision === "block" ? "BLOCKED" : decision === "hold" ? "HELD" : "PLACED");
