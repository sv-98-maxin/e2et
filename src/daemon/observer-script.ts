/** MutationObserver 注入脚本：DOM 变化时递增 window.__e2etChangeCount。
 * 通过 Page.addScriptToEvaluateOnNewDocument 注册，reload / 导航后自动注入新 document。 */
export const OBSERVER_SCRIPT = `(() => {
  window.__e2etChangeCount = window.__e2etChangeCount || 0;
  function attach(root) {
    if (window.__e2etObserver && window.__e2etObsRoot === root) return;
    if (window.__e2etObserver) window.__e2etObserver.disconnect();
    const obs = new MutationObserver(() => { window.__e2etChangeCount++; });
    obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    window.__e2etObserver = obs;
    window.__e2etObsRoot = root;
  }
  function tryAttach() {
    const doc = document;
    const root = doc.documentElement;
    if (root) {
      attach(root);
    } else {
      document.addEventListener('DOMContentLoaded', function handler() {
        const r = doc.documentElement;
        if (r && document === doc) attach(r);
      }, { once: true });
    }
  }
  tryAttach();
})()`;
