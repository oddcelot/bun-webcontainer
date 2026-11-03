/**
 * Where a popup opened from `el` should portal to: the top-layer element `el` sits in (a [popover] or <dialog>, like
 * Starlight's mobile menu), which covers anything outside it whatever its z-index; else nothing (Kobalte's default,
 * <body>).
 */
export const topLayerOf = (el: Element | undefined) => el?.closest<HTMLElement>("[popover], dialog") ?? undefined;
