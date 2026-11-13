// ==UserScript==
// @name         mini-gravitiqi
// @namespace    https://github.com/Trungquan2021/mini-gravitiqi
// @version      2.0.0
// @description  mini-gravitiqi: Hỗ trợ tự động giải bài tập EduNext AI Constructive Learning.
// @author       mini-gravitiqi
// @match        https://fsc-edunext.fpt.edu.vn/*
// @match        https://fu-edunext.fpt.edu.vn/*
// @match        https://edunext.vn/*
// @connect      api.groq.com
// @connect      generativelanguage.googleapis.com
// @connect      googleapis.com
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @connect      *
// @icon         https://fsc-edunext.fpt.edu.vn/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @require      https://raw.githubusercontent.com/Trungquan2021/mini-gravitiqi/main/mini-gravitiqi.js
// ==/UserScript==

(function () {
  'use strict';
  if (typeof window.__INIT_GRAVITIQI === 'function') {
    window.__INIT_GRAVITIQI('7ad252918bb57c40905e39b6c1431727');
  }
})();
