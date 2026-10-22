// RollGuard · RIOT 2 shared behaviour for the extension pages.
// The ticker markup holds one copy of its items. This repeats them until one
// half covers the ticker, then duplicates that half, so the -50% marquee in
// riot.css loops without a gap at any window width.
(() => {
  "use strict";

  const PX_PER_SECOND = 18;

  function build(track, copies) {
    const half = [];
    for (let i = 0; i < copies; i += 1) {
      half.push(...track.rgBase.map((node) => node.cloneNode(true)));
    }
    track.replaceChildren(...half, ...half.map((node) => node.cloneNode(true)));
    track.rgCopies = copies;
    track.style.animationDuration = `${Math.round((copies * track.rgUnit) / PX_PER_SECOND)}s`;
  }

  function copiesFor(track) {
    const width = track.parentElement?.clientWidth || window.innerWidth;
    return Math.max(1, Math.ceil(width / track.rgUnit));
  }

  function measure(track) {
    track.replaceChildren(...track.rgBase.map((node) => node.cloneNode(true)));
    // One copy is items + gaps + trailing padding, so k copies are k × this.
    track.rgUnit = Math.max(1, track.offsetWidth);
    build(track, copiesFor(track));
  }

  function setup(track) {
    track.rgBase = [...track.children].map((node) => node.cloneNode(true));
    if (!track.rgBase.length) return;
    measure(track);
    document.fonts?.ready.then(() => measure(track));
    if (typeof ResizeObserver === "function" && track.parentElement) {
      new ResizeObserver(() => {
        const copies = copiesFor(track);
        if (copies !== track.rgCopies) build(track, copies);
      }).observe(track.parentElement);
    }
  }

  document.querySelectorAll(".rg-ticker-track").forEach(setup);
})();
