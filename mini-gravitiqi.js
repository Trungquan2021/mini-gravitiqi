(function () {
  'use strict';
  window.__INIT_GRAVITIQI = function (route) {
    if (!route || typeof route !== 'string') {
      console.warn('[mini-gravitiqi] No script route specified.');
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://gist.githubusercontent.com/Trungquan2021/' + route.trim() + '/raw/core.js?t=' + Date.now(),
      onload: function (res) {
        if (res.status === 200 && res.responseText) {
          const runCore = new Function(
            'GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest', 'unsafeWindow',
            res.responseText
          );
          runCore(GM_setValue, GM_getValue, GM_xmlhttpRequest, unsafeWindow);
        } else {
          console.error('[mini-gravitiqi] Route load failed:', res.status);
        }
      },
      onerror: function () {
        console.error('[mini-gravitiqi] Network error while loading route.');
      }
    });
  };
})();
