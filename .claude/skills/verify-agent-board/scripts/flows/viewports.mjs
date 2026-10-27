// The five screens the owner reads the board on (27 Oct 2026), in CSS px. Every visual check shoots all five by default;
// a flow takes one by name or by width when a check needs only one.
//   desktop-1920         half his LG 38" ultrawide (3840x1600), after browser chrome
//   small-desktop-1080   his Dell monitor in portrait
//   ipad-portrait-744    iPad mini 6, portrait
//   ipad-landscape-1133  iPad mini 6, landscape
//   phone-390            phone
export const VIEWPORTS = Object.freeze([
  { name: 'desktop-1920', width: 1920, height: 1440, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: 'small-desktop-1080', width: 1080, height: 1800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: 'ipad-portrait-744', width: 744, height: 1133, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
  { name: 'ipad-landscape-1133', width: 1133, height: 744, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
  { name: 'phone-390', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
].map(Object.freeze));

// One viewport by name (`ipad-portrait-744`) or width (`744`); undefined for anything else.
export function viewport(nameOrWidth) {
  const key = String(nameOrWidth);
  return VIEWPORTS.find((v) => v.name === key || String(v.width) === key);
}

// Playwright `browser.newPage()` / `newContext()` options for a viewport.
export function pageOptions({ width, height, deviceScaleFactor, isMobile, hasTouch }) {
  return { viewport: { width, height }, deviceScaleFactor, isMobile, hasTouch };
}
