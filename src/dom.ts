/**
 * Typed DOM helpers. Elements are looked up once by id; inputs are read as
 * BigNumber (full precision) and written back rounded to significant digits
 * only for display.
 */
import { BigNumber, type BN, type BNIn } from './numeric';

export const els: Record<string, HTMLElement> = {};

export function initEls(ids: string[]): void {
  for (const id of ids) {
    const e = document.getElementById(id);
    if (e) els[id] = e;
  }
}

/** Element as an input (for .value / .placeholder / .readOnly). */
export const inp = (id: string): HTMLInputElement => els[id] as HTMLInputElement;

/** Raw string value of an input. */
export const valOf = (id: string): string => inp(id).value;

/** Input value as a BigNumber (NaN BigNumber if blank/unparseable). */
export const num = (id: string): BN => new BigNumber(inp(id).value);

/** Set an input's value, rounded to `n` significant digits (display only). */
export function setSig(id: string, v: BNIn, n = 8): void {
  const b = new BigNumber(v);
  inp(id).value = b.isFinite() ? b.precision(n).toString() : '';
}

/** Set an input's value, rounded to `d` decimal places (display only). */
export function setFixed(id: string, v: BNIn, d: number): void {
  const b = new BigNumber(v);
  inp(id).value = b.isFinite() ? b.toFixed(d) : '';
}

export const text = (id: string, s: string): void => {
  els[id].textContent = s;
};
export const html = (id: string, s: string): void => {
  els[id].innerHTML = s;
};
export const show = (id: string, on: boolean, cls = 'show'): void => {
  els[id].classList.toggle(cls, on);
};

/** Is the input currently focused (so we shouldn't clobber what they're typing)? */
export const isActive = (id: string): boolean => document.activeElement === els[id];

/** A finite, strictly-positive BigNumber? */
export const gt0 = (b: BN | null | undefined): b is BN => !!b && b.isFinite() && b.gt(0);
/** A finite, non-negative BigNumber? */
export const gte0 = (b: BN | null | undefined): b is BN => !!b && b.isFinite() && b.gte(0);

export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}
