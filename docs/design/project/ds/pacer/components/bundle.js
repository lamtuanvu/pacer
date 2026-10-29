/* @ds-bundle: {"format":4,"namespace":"Pacer","components":[{"name":"Button"},{"name":"Pill"},{"name":"UsageMeter"},{"name":"Card"},{"name":"Mark"}]} */
(function () {
  var h = window.React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
  function clamp(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }

  function Button(props) {
    var variant = props.variant || "secondary", size = props.size || "md";
    var rest = Object.assign({}, props);
    delete rest.variant; delete rest.size; delete rest.className; delete rest.children;
    return h("button", Object.assign({ type: "button" }, rest, {
      className: cx("pc-btn", "pc-btn--" + variant, "pc-btn--" + size, props.className),
    }), props.children);
  }

  var TONES = { good: 1, warn: 1, bad: 1, info: 1, neutral: 1 };
  function Pill(props) {
    var tone = TONES[props.tone] ? props.tone : "neutral";
    return h("span", { className: cx("pc-pill", "pc-pill--" + tone, props.className) }, props.children);
  }

  function UsageMeter(props) {
    var used = clamp(props.used), hasPace = props.pace !== undefined && props.pace !== null;
    var pace = hasPace ? clamp(props.pace) : null;
    var tone = props.tone || (used >= 97 ? "bad" : hasPace && used - pace > 10 ? "warn" : "good");
    var label = (props.label || "Usage") + " " + Math.round(used) + " percent" + (hasPace ? ", pace " + Math.round(pace) + " percent" : "");
    return h("div", {
      role: "progressbar", "aria-label": label, "aria-valuenow": Math.round(used), "aria-valuemin": 0, "aria-valuemax": 100,
      className: cx("pc-meter", props.size === "slim" ? "pc-meter--slim" : null, props.className),
    },
      h("div", { className: "pc-meter__fill pc-meter__fill--" + tone, style: { width: used + "%" } }),
      hasPace ? h("div", { className: "pc-meter__pace", style: { left: "calc(" + pace + "% - 1px)" } }) : null);
  }

  function Card(props) {
    var tone = props.tone || "default";
    return h("div", { className: cx("pc-card", "pc-card--" + tone, props.className) }, props.children);
  }

  function MarkSvg(size, onDark) {
    return h("svg", { width: size, height: size, viewBox: "0 0 48 48", "aria-hidden": "true", className: onDark ? "pc-mark pc-mark--on-dark" : "pc-mark" },
      h("rect", { className: "pc-mark__lane", x: 4, y: 20, width: 40, height: 8, rx: 4 }),
      h("rect", { className: "pc-mark__used", x: 4, y: 20, width: 22, height: 8, rx: 4 }),
      h("rect", { className: "pc-mark__tick", x: 29, y: 12, width: 4, height: 24, rx: 2 }));
  }
  function Mark(props) {
    var size = props.size || 24;
    if (props.tile) {
      return h("span", { className: "pc-mark-tile", role: "img", "aria-label": "pacer", style: { width: size * 1.45, height: size * 1.45 } }, MarkSvg(size, true));
    }
    if (props.wordmark === false) return h("span", { role: "img", "aria-label": "pacer", className: "pc-mark-only" }, MarkSvg(size, false));
    return h("span", { className: "pc-lockup", style: { fontSize: Math.round(size * 0.83) + "px" } }, MarkSvg(size, false), h("span", { className: "pc-wordmark" }, "pacer"));
  }

  window.Pacer = { Button: Button, Pill: Pill, UsageMeter: UsageMeter, Card: Card, Mark: Mark };
})();
