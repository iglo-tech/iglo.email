// A synchronous server-side JSX renderer; components and trusted markup stay opaque.
declare const elementBrand: unique symbol;
export interface Element {
  readonly [elementBrand]: true;
}
export type Child = Element | string | number | boolean | null | undefined | readonly Child[];
export type Component = (props: any) => Child;

class TrustedMarkup implements Element {
  declare readonly [elementBrand]: true;
  #markup: string;
  constructor(markup: string) {
    this.#markup = markup;
    Object.freeze(this);
  }
  static read(value: object): string | undefined {
    return #markup in value ? value.#markup : undefined;
  }
}
class ElementNode implements Element {
  declare readonly [elementBrand]: true;
  #data: { type: string | Component; props: Record<string, unknown> };
  constructor(type: string | Component, props: Record<string, unknown> | null) {
    this.#data = { type, props: Object.freeze({ ...props }) };
    Object.freeze(this);
  }
  static read(value: object) {
    return #data in value ? value.#data : undefined;
  }
}

export function raw(value: string): Element {
  if (typeof value !== "string") throw new TypeError("Trusted markup must be a string");
  return new TrustedMarkup(value);
}
export function jsx(type: string | Component, props: Record<string, unknown> | null): Element {
  if (typeof type !== "string" && typeof type !== "function")
    throw new TypeError("Invalid JSX type");
  return new ElementNode(type, props);
}

export function Fragment({ children }: { children?: Child }): Child {
  return children;
}

const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const booleanAttributes = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);
const tagName = /^[A-Za-z][A-Za-z0-9:-]*$/;
const attributeName = /^(?:[A-Za-z_][A-Za-z0-9_.:-]*|[@:][A-Za-z_][A-Za-z0-9_.:-]*)$/;

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function hasContent(child: unknown): boolean {
  return Array.isArray(child)
    ? child.some(hasContent)
    : child !== null && child !== undefined && typeof child !== "boolean";
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string") return escape(value);
  if (typeof value === "number" && Number.isFinite(value)) return escape(String(value));
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (typeof value !== "object") throw new TypeError("Unsupported JSX child");
  const markup = TrustedMarkup.read(value);
  if (markup !== undefined) return markup;
  const node = ElementNode.read(value);
  if (!node) throw new TypeError("Unsupported JSX child");
  if (typeof node.type === "function") return renderValue(node.type(node.props));
  const tag = node.type;
  if (!tagName.test(tag)) throw new TypeError("Invalid HTML tag name");
  let attributes = "";
  for (const [name, attribute] of Object.entries(node.props)) {
    if (name === "children" || name === "key") continue;
    if (!attributeName.test(name)) throw new TypeError("Invalid HTML attribute name");
    if (attribute === null || attribute === undefined) continue;
    const lower = name.toLowerCase();
    if (booleanAttributes.has(lower)) {
      if (typeof attribute !== "boolean") throw new TypeError("Invalid boolean attribute value");
      if (attribute) attributes += ` ${name}`;
      continue;
    }
    if (typeof attribute === "boolean") {
      if (!lower.startsWith("data-") && !lower.startsWith("aria-"))
        throw new TypeError("Invalid attribute value");
    } else if (
      typeof attribute !== "string" &&
      !(typeof attribute === "number" && Number.isFinite(attribute))
    ) {
      throw new TypeError("Invalid attribute value");
    }
    attributes += ` ${name}="${escape(String(attribute))}"`;
  }
  if (voidTags.has(tag.toLowerCase())) {
    if (hasContent(node.props.children)) throw new TypeError("Void element cannot have children");
    return `<${tag}${attributes}>`;
  }
  return `<${tag}${attributes}>${renderValue(node.props.children)}</${tag}>`;
}

export function render(value: unknown): string {
  return renderValue(value);
}
