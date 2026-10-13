import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** bits-ui / shadcn-svelte element-ref convention: every primitive accepts a
 *  `ref` that is bound to the underlying DOM node. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

/** Component prop types: HTML attributes minus the children slots (children is
 *  supplied via the component's snippet, not as an attribute). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children" | "$children" | "$slots" | "$$slots"> : T;