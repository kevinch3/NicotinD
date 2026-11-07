import type { HomeView } from '@nicotind/core';

/**
 * Where the switch sits (#1667): in flow, on the header's content edge
 * (`px-4 md:px-6`), 12px below `<main>`'s top in both views. On the mosaic
 * the wrapper overlays the `absolute inset-0` stage (`pointer-events-none`
 * keeps its padding from eating drags); on the shelves it pushes the page
 * down. The mosaic hides the header below md, so only it adds the safe area
 * there. Full literal strings so Tailwind's scanner emits every class.
 */
export function homeSwitchAnchorClass(view: HomeView): string {
  return view === 'mosaic'
    ? 'relative z-10 w-fit px-4 md:px-6 pt-3 pointer-events-none max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]'
    : 'relative z-10 w-fit px-4 md:px-6 pt-3 pointer-events-none';
}
