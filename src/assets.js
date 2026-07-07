// The app's brand mark: a solid bookmark ribbon in the brand blue (#2563eb, the
// same accent used for buttons in ui.js). One standalone SVG string serves two
// jobs: it's the body of the /favicon.svg response (index.js) and it's inlined
// beside the "Read Later" heading in the page chrome (ui.js). The xmlns makes it
// valid as a standalone document and is harmless when inlined into HTML. Solid
// blue on a transparent background reads correctly in both light and dark themes.
export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#2563eb" aria-hidden="true">' +
  '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"/>' +
  "</svg>";
