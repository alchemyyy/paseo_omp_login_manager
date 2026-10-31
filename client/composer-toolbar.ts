// NOTE: The 0.13 plugin SDK offers composer pills, which float above the composer, but no slot in
// the composer's control row (model, thinking, mode, features). These helpers move a pill's
// contents into that row on web by DOM lookup. They read app internals (testIDs from
// packages/app/src/composer/agent-controls) and may break on a Paseo upgrade; every lookup
// returns null when its target is missing, and callers then show nothing.
import type { ReactNode } from "react";
import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface DomStyle {
  display: string;
  setProperty(name: string, value: string): void;
}
export interface DomElement {
  readonly isConnected: boolean;
  readonly parentElement: DomElement | null;
  readonly style: DomStyle;
  closest(selector: string): DomElement | null;
  contains(other: unknown): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getBoundingClientRect(): { left: number; top: number; bottom: number; width: number; height: number };
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): void;
  remove(): void;
}
interface DomComputedStyle {
  color: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
}
interface DomEventTarget {
  addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
}
declare const document: DomEventTarget & { body: DomElement; createElement(tag: string): DomElement };
declare const window: DomEventTarget & {
  readonly innerHeight: number;
  readonly innerWidth: number;
  getComputedStyle(element: DomElement): DomComputedStyle;
};

const MODEL_SELECTOR = '[data-testid="combined-model-selector"]';
/** Controls that sit beside the model selector in the same row */
const SIBLING_CONTROL_SELECTORS = ['[data-testid="agent-thinking-selector"]', '[data-testid="mode-control"]'];
/** React Native Web renders <Text> as an element with dir="auto" */
const TEXT_SELECTOR = '[dir="auto"]';
const SLOT_ATTRIBUTE = "data-omp-account-control";
const MAX_CLIMB = 40;
const REACT_PORTAL_TYPE = Symbol.for("react.portal");

/** Text and glyph metrics of the row's own controls, so a plugin control matches them */
export interface ToolbarMetrics {
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number | undefined;
  glyphSize: number;
}

/** The toolbar slot and the sample control the slot's contents should look like */
export interface ToolbarSlot {
  slot: DomElement;
  metrics: ToolbarMetrics | null;
}

/** Narrows a React Native Web host node (a DOM element on web) for the lookups here */
export function asDomElement(node: unknown): DomElement | null {
  if (Platform.OS !== "web" || typeof node !== "object" || node === null) return null;
  return "closest" in node && "querySelector" in node ? (node as DomElement) : null;
}

/** Hides the composer pill that holds `node`, keeping it mounted so its contents stay alive */
export function hideEnclosingPill(node: DomElement): void {
  const pill = node.closest('[role="button"]');
  if (pill && pill.style.display !== "none") pill.style.setProperty("display", "none");
}

/**
 * Appends a slot at the end of the control row of the composer that holds `node` (a pill inside
 * that composer). Null when the row is not rendered, such as before the agent's controls load.
 */
export function createToolbarSlot(node: DomElement): ToolbarSlot | null {
  let composer: DomElement | null = node.parentElement;
  let model: DomElement | null = null;
  for (let depth = 0; composer && depth < MAX_CLIMB && !model; depth++) {
    model = composer.querySelector(MODEL_SELECTOR);
    if (!model) composer = composer.parentElement;
  }
  if (!composer || !model) return null;
  let sibling: DomElement | null = null;
  for (const selector of SIBLING_CONTROL_SELECTORS) sibling ??= composer.querySelector(selector);
  if (!sibling) return null;
  // The row is the nearest element holding both the model selector and a sibling control
  let row: DomElement | null = model.parentElement;
  while (row && !row.contains(sibling)) row = row.parentElement;
  if (!row) return null;
  row.querySelector(`[${SLOT_ATTRIBUTE}]`)?.remove();
  const slot = document.createElement("div");
  slot.setAttribute(SLOT_ATTRIBUTE, "");
  slot.style.setProperty("display", "flex");
  slot.style.setProperty("min-width", "0");
  slot.style.setProperty("flex-shrink", "1");
  row.appendChild(slot);
  return { slot, metrics: readMetrics(sibling) };
}

function readMetrics(control: DomElement): ToolbarMetrics | null {
  const text = control.querySelector(TEXT_SELECTOR);
  const glyph = control.querySelector("svg");
  if (!text || !glyph) return null;
  const style = window.getComputedStyle(text);
  const lineHeight = Number.parseFloat(style.lineHeight);
  return {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: Number.parseFloat(style.fontSize),
    fontWeight: style.fontWeight,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : undefined,
    glyphSize: Math.round(glyph.getBoundingClientRect().width),
  };
}

/** Where a menu opened from `anchor` goes: above it, left-aligned, kept inside the window */
export function menuPosition(anchor: DomElement, menuWidth: number): { left: number; bottom: number } {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
  return { left, bottom: window.innerHeight - rect.top + 6 };
}

/** A container on document.body for a floating menu; remove it when the menu closes */
export function createOverlayContainer(): DomElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** Calls `onOutside` for presses outside every node in `inside`, and on Escape */
export function onDismiss(inside: () => readonly (DomElement | null)[], onOutside: () => void): () => void {
  const press = (event: { target: unknown }) => {
    if (!inside().some((node) => node?.contains(event.target))) onOutside();
  };
  const key = (event: { key: string }) => {
    if (event.key === "Escape") onOutside();
  };
  document.addEventListener("pointerdown", press, true);
  window.addEventListener("keydown", key, true);
  return () => {
    document.removeEventListener("pointerdown", press, true);
    window.removeEventListener("keydown", key, true);
  };
}

/** react-dom's createPortal result; the host bundle offers plugins no react-dom import */
export function createDomPortal(children: ReactNode, container: DomElement, key: string): ReactNode {
  return {
    $$typeof: REACT_PORTAL_TYPE,
    key,
    children,
    containerInfo: container,
    implementation: null,
  } as unknown as ReactNode;
}
