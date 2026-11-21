// The automatic JSX runtime entry required by Bun and TypeScript.
import { Fragment, jsx } from "@/jsx/render";
import type { Child, Element as RenderElement } from "@/jsx/render";
export { Fragment, jsx };
export const jsxs = jsx;
export namespace JSX {
  export type Element = RenderElement;
  export type ElementType = string | ((props: any) => Child);
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}
