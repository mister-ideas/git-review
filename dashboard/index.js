// The pane lives in desktop/plugin.js. This bundle only gives the hidden
// dashboard tab a placeholder so the dashboard loader registers the plugin.
(function () {
  var plugins = window.__HERMES_PLUGINS__;
  if (plugins && typeof plugins.register === "function") {
    plugins.register("git-review", function () { return null; });
  }
})();
