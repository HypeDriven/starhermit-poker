// The look of the menus, the lobby, the table's HUD and the replay viewer: the
// browser build's css/style.css ("obsidian casino UI"), rewritten class-based
// in tools/ui-style.css and converted once with `starhermit css` into
// assets/ui-style.json (`npm run css`), registered at start with the theme
// the runtime's own widgets (scroll bars, focus rings, selects, sliders, text
// fields) take. High contrast, larger text and reduced motion are the
// runtime's options.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 9,
    text: "#f2f0e9", muted: "#929bac", panel: "#101722", control: "#1d2738", hovered: "#253348",
    pressed: "#182232", field: "#16202f", accent: "#e4bd5e", focus: "#65b8ff", outline: "#2a3a52",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$fg" } },
    paragraph: { text: { color: "$fg" } },
    heading: { text: { color: "$fg" } },
    widget: { focusRing: { color: "#65b8ff", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#929bac", radius: 4 } } },
    // .bet-slider: the gold accent (accent-color: #e4bd5e).
    slider: { parts: { track: { background: "#3a3a3a", radius: 3 }, thumb: { background: "#e4bd5e", radius: 99 } } },
    textField: { background: "#16202f", border: { width: 1, color: "#2a3a52" }, radius: 6, padding: 6, text: { color: "$fg" } },
    select: { parts: { field: { background: "#16202f", border: { width: 1, color: "#2f4260" }, radius: 8 } } },
    tooltip: { background: "#101722", text: { color: "$fg" }, radius: 6, padding: 6 },
    dialog: { background: { type: "linear", angle: 160, stops: ["#182232fa", "#090e17fa"] }, border: { width: 1, color: "#94b0d34d" }, radius: 16, padding: 16,
      parts: { backdrop: { background: "#03060c9e" } } },
  });
}
